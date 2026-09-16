"""Push local commits to GitHub through the REST API.

git's HTTPS transport fails from this shell with 'Recv failure: Connection
was reset' - for authenticated and anonymous requests alike, under both the
schannel and openssl TLS backends, even against a public repo. gh's own HTTP
stack is unaffected, so commits are reconstructed through the git data API:
blob -> tree -> commit -> ref.

Content comes from `git show <sha>:<path>`, not the working tree, so what
lands is byte-for-byte what was committed rather than whatever the checkout's
line endings happen to be.

Reconciliation is by TREE, not by sha. A commit created through the API gets a
different sha than the local one (different committer headers), so after the
first API push the local branch and the remote permanently disagree on sha
while agreeing on every byte. Comparing trees is what actually answers "is the
remote where my parent says it should be", and it lets this run repeatedly
without ever needing a force push.
"""
import os
import base64, json, subprocess, sys

REPO = "LOCUS-AI-APP/LOCUS-AI-"
BRANCH = "main"
LOCAL = "clean-origin-main"


def sh(args):
    # shell=True routes through cmd.exe on Windows, where "^" is the escape
    # character - hence "~1" rather than "^" for the parent revision.
    r = subprocess.run(args, capture_output=True, shell=True)
    if r.returncode != 0:
        raise SystemExit("FAILED %s\n%s" % (args, r.stderr.decode("utf-8", "replace")[:500]))
    return r.stdout


def gh_json(args, payload=None):
    cmd = ["gh", "api"] + args
    if payload is not None:
        cmd += ["--input", "-"]
        r = subprocess.run(cmd, input=json.dumps(payload).encode(),
                           capture_output=True, shell=True)
    else:
        r = subprocess.run(cmd, capture_output=True, shell=True)
    if r.returncode != 0:
        raise SystemExit("gh api failed: %s\n%s"
                         % (args, r.stderr.decode("utf-8", "replace")[:600]))
    return json.loads(r.stdout.decode("utf-8"))


local_sha = sh(["git", "rev-parse", LOCAL]).decode().strip()
parent_sha = sh(["git", "rev-parse", LOCAL + "~1"]).decode().strip()
message = sh(["git", "log", "-1", "--format=%B", local_sha]).decode("utf-8").rstrip() + "\n"

remote_sha = gh_json(["repos/%s/git/ref/heads/%s" % (REPO, BRANCH)])["object"]["sha"]

local_tree = sh(["git", "show", "-s", "--format=%T", local_sha]).decode().strip()
parent_tree = sh(["git", "show", "-s", "--format=%T", parent_sha]).decode().strip()
remote_tree = gh_json(["repos/%s/git/commits/%s" % (REPO, remote_sha)])["tree"]["sha"]

print("local  %s  tree %s" % (local_sha[:10], local_tree[:10]))
print("parent %s  tree %s" % (parent_sha[:10], parent_tree[:10]))
print("remote %s  tree %s" % (remote_sha[:10], remote_tree[:10]))

if remote_tree == local_tree:
    print("\nremote already has this content, nothing to do.")
    sys.exit(0)
# Paths this script cannot push. GitHub refuses to create a tree touching
# .github/workflows/ when the token lacks the `workflow` scope, and reports it
# as a bare 404 on the tree endpoint rather than anything naming the cause.
# This token carries gist, read:org, repo - no workflow.
# Set PUSH_WORKFLOWS=1 once the token carries the workflow scope
# (gh auth refresh -h github.com -s workflow) to include them.
SKIP_PREFIXES = () if os.environ.get("PUSH_WORKFLOWS") == "1" else (".github/workflows/",)


def remote_tree_paths(sha):
    """path -> blob sha, for every file in a remote tree."""
    listing = gh_json(["repos/%s/git/trees/%s?recursive=1" % (REPO, sha)])
    return {e["path"]: e.get("sha") for e in listing["tree"] if e["type"] == "blob"}


if remote_tree != parent_tree:
    # Divergence is expected when an earlier run of THIS script skipped a
    # workflow file: the remote then legitimately lags the local parent by
    # exactly those paths. Anything else really is somebody else pushing, so
    # the difference is enumerated rather than assumed either way.
    local_paths = {}
    for tree_line in sh(["git", "ls-tree", "-r", parent_sha]).decode("utf-8").splitlines():
        meta, tree_path = tree_line.split("\t", 1)
        local_paths[tree_path] = meta.split()[2]
    remote_paths = remote_tree_paths(remote_tree)
    shared = set(local_paths) & set(remote_paths)
    differing = sorted(
        (set(local_paths) ^ set(remote_paths))
        | {q for q in shared if local_paths[q] != remote_paths[q]}
    )
    unexplained = [q for q in differing if not q.startswith(SKIP_PREFIXES)]
    if unexplained:
        raise SystemExit(
            "\nremote main is neither my parent nor mine - someone else pushed:\n  "
            + "\n  ".join(unexplained[:20])
            + "\nReconcile before retrying; this script will not force.")
    print("\nremote lags by skipped paths only: %s" % ", ".join(differing))

# The remote head is the same content as the local parent, so build on it.
base_commit = remote_sha

raw = sh(["git", "diff-tree", "--no-commit-id", "-r", "-M", "--name-status", local_sha])
changes = []
for line in raw.decode("utf-8").splitlines():
    parts = line.split("\t")
    status = parts[0]
    if status.startswith("R"):
        changes.append(("D", parts[1]))
        changes.append(("A", parts[2]))
    elif status[0] in ("A", "M"):
        changes.append(("A", parts[1]))
    elif status[0] == "D":
        changes.append(("D", parts[1]))

# GitHub refuses to create a tree touching .github/workflows/ when the token
# lacks the `workflow` scope, and reports it as a 404 on the tree endpoint
# rather than anything that names the real cause. This token carries
# gist, read:org, repo - no workflow - so a workflow edit has to go up by hand
# or with a re-scoped token. Skipped here so it cannot silently block
# everything else sharing the commit.
# (SKIP_PREFIXES defined above, next to the guard that understands it.)
skipped = [p for _, p in changes if p.startswith(SKIP_PREFIXES)]
changes = [c for c in changes if not c[1].startswith(SKIP_PREFIXES)]
for skipped_path in skipped:
    print("  SKIPPED (needs the workflow scope):", skipped_path)

print("\nchanges:", len(changes))
tree_entries = []
for status, path in changes:
    if status == "D":
        print("  delete", path)
        tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
        continue
    content = sh(["git", "show", "%s:%s" % (local_sha, path)])
    blob = gh_json(["repos/%s/git/blobs" % REPO, "-X", "POST"],
                   {"content": base64.b64encode(content).decode(), "encoding": "base64"})
    print("  add    %s  (%d bytes)" % (path, len(content)))
    tree_entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})

tree = gh_json(["repos/%s/git/trees" % REPO, "-X", "POST"],
               {"base_tree": remote_tree, "tree": tree_entries})
commit = gh_json(["repos/%s/git/commits" % REPO, "-X", "POST"],
                 {"message": message, "tree": tree["sha"], "parents": [base_commit]})
ref = gh_json(["repos/%s/git/refs/heads/%s" % (REPO, BRANCH), "-X", "PATCH"],
              {"sha": commit["sha"], "force": False})

print("\npushed %s -> %s" % (commit["sha"][:10], BRANCH))
