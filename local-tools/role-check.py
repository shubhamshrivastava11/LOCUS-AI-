"""Takes on each test account in turn and asks the real API what it can see.

This is the check whose absence caused the 16 Sep 2026 outage. Everything else
- unit tests, SQL run as postgres, unauthenticated probes - was green while the
product returned nothing to everyone, because none of it went through the path
a real user goes through. This does:

    real session  ->  /auth/session  ->  tenant JWT  ->  /api/v1/decisions

No passwords and no credentials file. Sessions are minted through the admin
API, so the only thing needed to run this is Supabase admin access, which is
the whole point: a check nobody can run is a check nobody runs.

    python local-tools/role-check.py
"""

import json
import sys
import urllib.error
import urllib.request

BASE = "https://imazdfzxinltbgktrgmv.supabase.co"

# What each account SHOULD see. Same numbers the health canary asserts every
# ten minutes; if these drift from reality, one of the two is wrong and that is
# the finding.
EXPECTED = {
    "ada.owner@aggregate-test.invalid":   ("Owner",  5, 26),
    "bo.admin@aggregate-test.invalid":    ("Admin",  4, 38),
    "cy.lead@aggregate-test.invalid":     ("Lead",   3, 30),
    "dia.member@aggregate-test.invalid":  ("Member", 2, 28),
    "elis.member@aggregate-test.invalid": ("Member", 2, 25),
    "fen.guest@aggregate-test.invalid":   ("External",  1, 2),
}


def api_keys():
    """Both keys, from the CLI so neither is ever written down here."""
    import subprocess
    raw = subprocess.run(
        ["npx", "supabase", "projects", "api-keys", "--project-ref", "imazdfzxinltbgktrgmv"],
        capture_output=True, shell=True,
    ).stdout.decode()
    keys = json.loads(raw[raw.index("{"):])["keys"]
    by_id = {k.get("id"): k["api_key"] for k in keys}
    missing = [n for n in ("anon", "service_role") if n not in by_id]
    if missing:
        sys.exit("CLI did not return the %s key. Run `npx supabase login` first."
                 % " and ".join(missing))
    return by_id["anon"], by_id["service_role"]


def session_for(email, anon, service):
    """A real user session for `email`, without anyone knowing a password.

    This used to be a password grant, which meant six throwaway accounts each
    needed a password set by hand and kept in a file on somebody's Desktop -
    credentials created solely so a test could exist, which is a bad trade.

    The admin API mints a magic-link token, and exchanging its token_hash
    returns exactly the session a real sign-in returns. What comes back is
    indistinguishable downstream, and downstream is the part that matters:
    the 16 September outage was in loadCallerAuthz at /auth/session, not in
    the sign-in. Verifying the token uses the anon key, exactly as a browser
    following the emailed link would.

    The one thing this does NOT cover is the password grant endpoint itself.
    That is a deliberate trade: no passwords exist to leak, and anyone with
    Supabase admin can run the check with nothing to set up.
    """
    code, link = request("/auth/v1/admin/generate_link",
                         {"type": "magiclink", "email": email},
                         {"apikey": service, "Authorization": "Bearer " + service,
                          "content-type": "application/json"})
    if code != 200:
        return None, "LINK FAILED (%s)" % code

    props = link.get("properties", link)
    token_hash = props.get("hashed_token")
    if not token_hash:
        return None, "NO TOKEN IN LINK"

    code, sess = request("/auth/v1/verify",
                         {"type": "magiclink", "token_hash": token_hash},
                         {"apikey": anon, "content-type": "application/json"})
    if code != 200:
        return None, "VERIFY FAILED (%s)" % code
    return sess.get("access_token"), None


def request(path, payload, headers, timeout=90):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def main():
    print("Fetching the project keys...")
    anon, service = api_keys()

    print()
    print("%-9s %-9s %-4s %10s %10s   %s" % ("ACCOUNT", "ROLE", "LVL", "EXPECTED", "ACTUAL", "RESULT"))
    print("-" * 70)

    failures = 0
    for email, (role, level, expected) in EXPECTED.items():
        short = email.split("@")[0].split(".")[0]

        # 1. A real session for this account, minted rather than signed into.
        access_token, problem = session_for(email, anon, service)
        if problem:
            print("%-9s %-9s %-4s %10s %10s   %s" % (short, role, level, expected, "-", problem))
            failures += 1
            continue

        # 2. Trade the Supabase token for a tenant token, which is where the
        #    role and clearance are actually resolved.
        code, sess = request("/functions/v1/api/auth/session",
                             {"supabase_token": access_token},
                             {"apikey": anon, "Authorization": "Bearer " + anon,
                              "content-type": "application/json"})
        if code != 200:
            print("%-9s %-9s %-4s %10s %10s   SESSION FAILED (%s)" % (short, role, level, expected, "-", code))
            failures += 1
            continue

        # 3. Ask the product what it will show this person.
        code, body = request("/api/v1/decisions?limit=200", None,
                             {"apikey": anon, "Authorization": "Bearer " + sess["token"],
                              "content-type": "application/json"})
        # The api function is mounted under /functions/v1/api, so the path above
        # needs that prefix; retry rather than fail on the shape.
        if code != 200:
            code, body = request("/functions/v1/api/api/v1/decisions?limit=200", None,
                                 {"apikey": anon, "Authorization": "Bearer " + sess["token"],
                                  "content-type": "application/json"})
        if code != 200:
            print("%-9s %-9s %-4s %10s %10s   DECISIONS FAILED (%s)" % (short, role, level, expected, "-", code))
            failures += 1
            continue

        actual = body.get("total", len(body.get("decisions", [])))
        ok = actual == expected
        if not ok:
            failures += 1
        print("%-9s %-9s %-4s %10d %10d   %s"
              % (short, sess.get("role", role), level, expected, actual,
                 "pass" if ok else ("FAIL  (%+d)" % (actual - expected))))

    print()
    if failures == 0:
        print("All six accounts see exactly what the model says they should.")
        print("Note the Owner sees FEWER records than the Admin. That is the point:")
        print("rank buys clearance, not reach, and the Admin is in more channels.")
    else:
        print("%d account(s) did not match. Either the access rule changed or the" % failures)
        print("corpus did - check which before adjusting anything.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
