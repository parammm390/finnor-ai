"""Read-only serial integration guard. Never installs a patch or migration."""
import argparse
import hashlib
import json
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--repo", required=True)
args = parser.parse_args()
repo = pathlib.Path(args.repo).resolve(strict=True)
packet = json.loads(pathlib.Path(__file__).with_name("packet.json").read_text())
sha = lambda value: hashlib.sha256(value).hexdigest()


def inside(relative):
    path = (repo / relative).resolve(strict=True)
    if not path.is_relative_to(repo):
        raise ValueError("Proposal target escapes the repository")
    return path


ancestry = subprocess.run(
    ["git", "-C", str(repo), "merge-base", "--is-ancestor",
     packet["baseCommit"], "HEAD"], capture_output=True, text=True
).returncode
checks = []
for change in packet["changes"]:
    row = {"target": change["target"], "status": "OWNER_REBASE_REQUIRED"}
    try:
        before = inside(change["target"]).read_bytes()
        row["observedSha256"] = sha(before)
        if sha(before) == change["preimageSha256"]:
            after = before.decode()
            for replacement in change["replacements"]:
                if after.count(replacement["before"]) != replacement["expectedOccurrences"]:
                    raise ValueError("Proposal anchor count changed")
                after = after.replace(replacement["before"], replacement["after"], 1)
            if sha(after.encode()) != change["proposedSha256"]:
                raise ValueError("Proposal postimage changed")
            row["status"] = "MATCHED_UNAPPLIED_PREIMAGE"
    except (OSError, ValueError, UnicodeError) as error:
        row["error"] = str(error)
    checks.append(row)

patch_ok = sha(inside(packet["patch"]["path"]).read_bytes()) == packet["patch"]["sha256"]
sql_ok = sha(inside(packet["migration"]["dataPath"]).read_bytes()) == packet["migration"]["sha256"]
matched = ancestry == 0 and patch_ok and sql_ok and all(
    row["status"] == "MATCHED_UNAPPLIED_PREIMAGE" for row in checks
)
print(json.dumps({
    "schema": "finnor.r8.integration-preimage-check.v1",
    "repo": str(repo), "baseCommit": packet["baseCommit"],
    "baseIsAncestor": ancestry == 0, "patchHashMatched": patch_ok,
    "sqlDataHashMatched": sql_ok, "checks": checks,
    "status": "MATCHED_UNAPPLIED_PROPOSALS_ONLY" if matched else "OWNER_REBASE_REQUIRED",
    "sharedFilesWritten": 0, "migrationOrdinal": None,
    "qualification": "READ_ONLY_NOT_SCHEMA_INSTALLATION_OWNER_EXECUTION_OR_JOINED_COMPATIBILITY",
}, indent=2))
raise SystemExit(0 if matched else 1)
