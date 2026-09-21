"""Signs in as each test account and asks the real API what it can see.

This is the check whose absence caused the 16 Sep 2026 outage. Everything else
- unit tests, SQL run as postgres, unauthenticated probes - was green while the
product returned nothing to everyone, because none of it went through the path
a real user goes through. This does:

    password grant  ->  /auth/session  ->  tenant JWT  ->  /api/v1/decisions

Reads passwords from the credentials file rather than embedding them, so there
is one place they exist on disk.

    python local-tools/role-check.py
"""

import io
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "https://imazdfzxinltbgktrgmv.supabase.co"
CRED = os.path.join(os.path.expanduser("~"), "Desktop", "FYP",
                    "aggregate_test_tenant_credentials.txt")

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


def anon_key():
    """The publishable key, from the CLI so it is never written down here."""
    import subprocess
    raw = subprocess.run(
        ["npx", "supabase", "projects", "api-keys", "--project-ref", "imazdfzxinltbgktrgmv"],
        capture_output=True, shell=True,
    ).stdout.decode()
    keys = json.loads(raw[raw.index("{"):])["keys"]
    return next(k["api_key"] for k in keys if k.get("id") == "anon")


def load_passwords():
    if not os.path.exists(CRED):
        sys.exit("Credentials file not found at %s" % CRED)
    out = {}
    for line in io.open(CRED, encoding="utf-8"):
        parts = line.rstrip("\n").split("\t")
        if len(parts) == 4 and "@" in parts[2]:
            out[parts[2]] = parts[3]
    return out


def request(path, payload, headers, timeout=90):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def main():
    print("Fetching the publishable key...")
    anon = anon_key()
    passwords = load_passwords()

    print()
    print("%-9s %-7s %-4s %10s %10s   %s" % ("ACCOUNT", "ROLE", "LVL", "EXPECTED", "ACTUAL", "RESULT"))
    print("-" * 68)

    failures = 0
    for email, (role, level, expected) in EXPECTED.items():
        short = email.split("@")[0].split(".")[0]

        if email not in passwords:
            print("%-9s %-7s %-4s %10s %10s   NO PASSWORD ON FILE" % (short, role, level, expected, "-"))
            failures += 1
            continue

        # 1. Sign in exactly as the app would.
        code, tok = request("/auth/v1/token?grant_type=password",
                            {"email": email, "password": passwords[email]},
                            {"apikey": anon, "content-type": "application/json"})
        if code != 200:
            print("%-9s %-7s %-4s %10s %10s   SIGN-IN FAILED (%s)" % (short, role, level, expected, "-", code))
            failures += 1
            continue

        # 2. Trade the Supabase token for a tenant token, which is where the
        #    role and clearance are actually resolved.
        code, sess = request("/functions/v1/api/auth/session",
                             {"supabase_token": tok["access_token"]},
                             {"apikey": anon, "Authorization": "Bearer " + anon,
                              "content-type": "application/json"})
        if code != 200:
            print("%-9s %-7s %-4s %10s %10s   SESSION FAILED (%s)" % (short, role, level, expected, "-", code))
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
            print("%-9s %-7s %-4s %10s %10s   DECISIONS FAILED (%s)" % (short, role, level, expected, "-", code))
            failures += 1
            continue

        actual = body.get("total", len(body.get("decisions", [])))
        ok = actual == expected
        if not ok:
            failures += 1
        print("%-9s %-7s %-4s %10d %10d   %s"
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
