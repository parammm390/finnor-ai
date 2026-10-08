"""Publish only B's immutable local early ports, with independent reconstruction."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone

repo = Path(__file__).resolve().parents[3]
base = "993860078282630b72144f2356f8257cef2221a5"
coordination = Path(
    "/Users/paramdave/.codex/visualizations/2026/10/04/"
    "01a10828-82e3-7572-8d13-530b28a346bf/finnor-pm-control/"
    "completion-prompts-2026-10-07/coordination/track-b")
scope = repo / "scope-pm/completion-b"
run = scope / "evidence/raw/run-20261007T032658-e38980ff"


def git(*args, directory=repo, env=None, input=None):
    return subprocess.check_output(
        ["git", "-C", str(directory), *args], env=env, input=input)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(json.dumps(value, sort_keys=True, indent=2).encode() + b"\n")


def compressed(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(gzip.compress(data, mtime=0))


if git("status", "--porcelain=v1").strip():
    raise SystemExit("Committed clean checkout required; no dirty source is published.")
head = git("rev-parse", "HEAD").decode().strip()
tree = git("rev-parse", "HEAD^{tree}").decode().strip()
git("merge-base", "--is-ancestor", base, head)
if head == base:
    raise SystemExit("No B delivery commits exist.")
results = json.loads((run / "results.json").read_text())
integrity = json.loads((run / "closure-integrity.json").read_text())
if (len(results["cases"]) != 15 or any(c["status"] != "PASS" for c in results["cases"])
        or results["unmatchedSelection"] or integrity["status"] != "PASS"):
    raise SystemExit("Exact complete local proof and unchanged closure required.")
for name, expected in results["evidenceDigests"].items():
    if digest((run / name).read_bytes()) != expected:
        raise SystemExit("Original evidence digest changed: " + name)

before = json.loads((run / "closure-before.json").read_text())
production_prefixes = ("finnor-os/packages/", "finnor-os/apps/", "finnor-os/scripts/p3/",
                       "finnor-os/scripts/m3/", "finnor-os/scripts/m4/")
for source in before["sources"]:
    if source["path"].startswith(production_prefixes):
        if digest((repo / source["path"]).read_bytes()) != source["sha256"]:
            raise SystemExit("Production source changed after the exact proof: " + source["path"])

coordination.mkdir(parents=True, exist_ok=True)
stage = Path(tempfile.mkdtemp(prefix=".staging-", dir=coordination))
validation = Path(tempfile.mkdtemp(prefix="b-delivery-validation-", dir=repo.parent))
objects = validation / "objects.git"
subprocess.run(["git", "init", "--bare", str(objects)], check=True, stdout=subprocess.DEVNULL)
git("fetch", "--no-tags", str(repo), base, directory=objects)
bundle = stage / "source/track-b-from-original-m3.bundle"
bundle.parent.mkdir(parents=True)
git("bundle", "create", str(bundle), "HEAD", "^" + base)
git("bundle", "verify", str(bundle), directory=objects)
git("fetch", "--no-tags", str(bundle), "HEAD:refs/heads/reconstructed-b", directory=objects)
if git("rev-parse", "refs/heads/reconstructed-b^{tree}", directory=objects).decode().strip() != tree:
    raise SystemExit("Independent bundle tree differs.")

commits = git("rev-list", "--reverse", base + ".." + head).decode().splitlines()
series = []
for ordinal, commit in enumerate(commits, 1):
    parent = git("rev-parse", commit + "^").decode().strip()
    expected_tree = git("rev-parse", commit + "^{tree}").decode().strip()
    name = "patches/%04d-%s.patch" % (ordinal, commit[:12])
    patch = git("format-patch", "-1", "--stdout", "--binary", commit)
    path = stage / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(patch)
    index_env = dict(os.environ, GIT_INDEX_FILE=str(validation / ("%04d.index" % ordinal)))
    git("read-tree", parent, directory=objects, env=index_env)
    git("apply", "--cached", "--whitespace=error", str(path), directory=objects, env=index_env)
    actual_tree = git("write-tree", directory=objects, env=index_env).decode().strip()
    if actual_tree != expected_tree:
        raise SystemExit("Independent exact-parent patch tree differs: " + name)
    series.append({"commit": commit, "parent": parent, "tree": expected_tree,
                   "patch": name, "sha256": digest(patch), "bytes": len(patch),
                   "validation": "PASS_SOURCE_ONLY"})
save(stage / "patches/series.json", series)

entries = []
for item in git("ls-tree", "-r", "-z", head).split(b"\0"):
    if not item:
        continue
    attributes, raw_path = item.split(b"\t", 1)
    mode, kind, blob = attributes.decode().split()
    if kind != "blob":
        raise SystemExit("Submodule/nonblob source requires explicit reconstruction.")
    path = raw_path.decode()
    if ("/scope-evidence/run-" in path or "/evidence/raw/" in path
            or "/node_modules/" in path or path.endswith((".key", ".pem", ".p12"))
            or Path(path).name.startswith(".env")):
        raise SystemExit("Private runtime/evidence source unexpectedly tracked: " + path)
    data = git("show", head + ":" + path)
    entries.append({"path": path, "mode": mode, "blob": blob,
                    "sha256": digest(data), "bytes": len(data)})
compressed(stage / "source/complete-source.json.gz", canonical(entries))
archive = git("archive", "--format=tar", head)
compressed(stage / "source/complete-source.tar.gz", archive)
by_path = {row["path"]: row for row in entries}
seen = set()
with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as content:
    for member in content.getmembers():
        if member.isdir():
            continue
        expected = by_path.get(member.name)
        if not expected:
            raise SystemExit("Unexpected source archive member.")
        if member.issym():
            data, mode = member.linkname.encode(), "120000"
        elif member.isfile():
            data = content.extractfile(member).read()
            mode = "100755" if member.mode & 0o111 else "100644"
        else:
            raise SystemExit("Nonregular source archive member.")
        if digest(data) != expected["sha256"] or mode != expected["mode"]:
            raise SystemExit("Source archive digest/mode differs: " + member.name)
        seen.add(member.name)
if seen != set(by_path):
    raise SystemExit("Source archive closure is incomplete.")
save(stage / "source/independent-reconstruction.json", {
    "status": "PASS_SOURCE_ONLY", "baseCommit": base, "commit": head, "tree": tree,
    "patchTreesVerified": len(series), "archiveEntriesVerified": len(seen),
    "validationDirectory": str(validation), "runtimeOrBehaviorAdopted": False})

for name in ("ports.json", "shared-proposals.json", "migration-plan.json", "requirements.json",
             "gates.json", "unresolved-inputs.json", "cost-liability-state.json"):
    shutil.copyfile(scope / name, stage / name)
compressed(stage / "runtime/run-closure-before.json.gz", (run / "closure-before.json").read_bytes())
compressed(stage / "runtime/run-closure-after.json.gz", (run / "closure-after.json").read_bytes())
shutil.copyfile(run / "closure-integrity.json", stage / "runtime/closure-integrity.json")
for name in ("runtime-materialization.json", "python-runtime.json", "python-base.json"):
    compressed(stage / "runtime" / (name + ".gz"), (scope / "evidence" / name).read_bytes())
save(stage / "runtime/manifest.json", {
    "state": "COPIED_LOCAL_RUNTIME_NOT_CLEAN_INSTALL_OR_HOST_ATTESTATION",
    "node": results["runtime"], "closureDigest": integrity["beforeDigest"],
    "sourceEntries": integrity["sourceFiles"], "runtimeEntries": integrity["runtimeFiles"],
    "files": ["run-closure-before.json.gz", "run-closure-after.json.gz",
              "closure-integrity.json", "runtime-materialization.json.gz",
              "python-runtime.json.gz", "python-base.json.gz"],
    "productionBytesMatchExecutedCut": True, "usd": None})
loop = json.loads((run / "repair-loop.json").read_text())
save(stage / "evidence/local-completion-summary.json", {
    "schema": "finnor.completion-b.local-proof-export.v1",
    "run": run.name, "startedAt": results["startedAt"], "finishedAt": results["finishedAt"],
    "cases": [{"id": c["id"], "status": c["status"], "expected": c["expected"],
               "elapsedMs": c["elapsedMs"]} for c in results["cases"]],
    "selection": results["selection"], "unmatchedSelection": results["unmatchedSelection"],
    "originalEvidenceDigests": results["evidenceDigests"], "closure": integrity,
    "repair": {key: loop[key] for key in ("initialAccepted", "challenged", "acceptedRepair",
                                        "rechallenged", "before", "after")},
    "challengeDeadlines": [loop["issued"]["deadlineAt"], loop["checked"]["deadlineAt"]],
    "challengeResults": [loop["issued"]["report"]["result"], loop["checked"]["report"]["result"]],
    "trials": [loop["issued"]["trials"], loop["checked"]["trials"]],
    "costs": results["costs"], "rerun": results["rerun"],
    "qualification": results["qualification"],
    "originalRawEvidenceKeptPrivately": True,
    "redactedExportIsNotOriginalSignedBytes": True,
    "originalAffectedSuitesOnCurrentCut": "PENDING"})
save(stage / "evidence/index.json", {
    "latestComplete": "local-completion-summary.json",
    "retainedPredecessors": [
        {"run": "run-20261007T022906-6cd26f34", "pass": 13, "fail": 0,
         "limit": "No full historical pre/post runtime closure; not inherited"},
        {"run": "run-20261007T024700-4909e2ce", "pass": 2, "fail": 1,
         "failure": "Real late autocommit release after independent unlock"},
        {"run": "run-20261007T025313-8dbe95dd", "pass": 13, "fail": 1,
         "failure": "Original repair child failed near inherited deadline"},
        {"run": "run-20261007T030400-a8eeee03", "pass": 13, "fail": 1,
         "failure": "Original repair child LIMIT_EXCEEDED"},
        {"run": "run-20261007T031636-2cdb9d53", "pass": 0, "fail": 1,
         "failure": "Diagnostic CPU-profile original repair LIMIT_EXCEEDED"}
    ],
    "privateOriginalLocation": str(scope / "evidence/raw"),
    "gates": "All original gates unqualified; repeated local runs are not independent samples"})

recipe = """# Exact early B reconstruction

Use the original M3 prerequisite commit 993860078282630b72144f2356f8257cef2221a5.
Verify every receipt artifact before adopting. Verify the Git bundle with that
prerequisite present. Fetch its HEAD into a new isolated checkout, or apply the
ordered binary patches at each exact parent and verify every recorded tree.
The independent validation reconstructs source only, not behavior or admission.

All shared patches and forward migration registry reconciliation belong to C.
Do not overwrite whole shared files from a different A/C parent. The candidate
tree is a restricted B composition, not an adopted cumulative checkpoint.

The source archive includes all tracked source. Runtime manifests describe the
actual copied local Node/Python/package bytes and links. A clean installation,
SBOM and published-history upgrade remain engineering work, not qualifications
conferred by these manifests.

On the materialized runtime, use Node 22.22.3 and the pinned private numerical
Python runtime at .runtime/m4-numerics-312/bin/python. Run the actual backend and
completion-script TypeScript checks, then:
`python3 finnor-os/scripts/completion-b/run-local.py`
from the repository root. The wrapper scrubs inherited credentials, creates an
owned disposable PostgreSQL/Work namespace, checks all 15 stories and captures
pre/post source/runtime closure. It does not provision, deploy or call live
services. Original affected suites and mounted/native workflow remain pending.

Private original raw evidence is preserved locally and is not exported with
claim/bearer tokens or keys. The reviewed summary and original artifact hashes
identify the proof. Redacted summaries cannot validate original signatures.
All three original phase missions and gates remain incomplete.
"""
(stage / "reconstruction.md").write_text(recipe)


def artifact(name):
    path = stage / name
    return {"path": name, "bytes": path.stat().st_size, "sha256": digest(path.read_bytes())}


all_artifacts = [artifact(str(path.relative_to(stage)))
                 for path in sorted(stage.rglob("*")) if path.is_file()]
receipt = {
    "track": "B", "phases": ["P3", "M3", "M4"], "baseCommit": base,
    "commit": head, "tree": tree,
    "state": "EARLY_CALLABLE_PORTS_ENGINEERING_IN_PROGRESS_ALL_GATES_UNPASSED",
    "sourceManifest": artifact("source/complete-source.json.gz"),
    "runtimeManifest": artifact("runtime/manifest.json"),
    "schemaContracts": json.loads((stage / "ports.json").read_text())["ports"],
    "ports": artifact("ports.json"), "sharedPatches": artifact("shared-proposals.json"),
    "migrationPlan": artifact("migration-plan.json"),
    "requirementLedger": artifact("requirements.json"), "evidenceIndex": artifact("evidence/index.json"),
    "costAndLiabilityState": artifact("cost-liability-state.json"),
    "gatePredicates": artifact("gates.json"), "unresolvedInputs": artifact("unresolved-inputs.json"),
    "reconstructionRecipe": artifact("reconstruction.md"), "allArtifacts": all_artifacts,
    "cumulativeWriter": "TRACK_C", "adoptedPeers": [],
    "qualification": "Restricted real callable ports and local original repair execution; source-only reconstruction. No complete original mission, cumulative qualification, clean install, funding, admission or H2 claim."
}
generation = digest(canonical(receipt))
receipt["generation"] = generation
save(stage / "receipt.json", receipt)
for record in all_artifacts:
    if artifact(record["path"]) != record:
        raise SystemExit("Artifact changed during packaging.")
if git("status", "--porcelain=v1").strip() or git("rev-parse", "HEAD").decode().strip() != head:
    raise SystemExit("Source moved during packaging.")
generations = coordination / "generations"
generations.mkdir(exist_ok=True)
final = generations / generation
if final.exists():
    raise SystemExit("Immutable generation already exists; never overwrite it.")
stage.rename(final)
pointer = {
    "track": "B", "generation": generation,
    "receipt": "generations/" + generation + "/receipt.json",
    "receiptSha256": digest((final / "receipt.json").read_bytes()),
    "commit": head, "tree": tree, "state": receipt["state"],
    "publishedAt": datetime.now(timezone.utc).isoformat()
}
temporary_pointer = coordination / (".current-" + generation + ".json")
save(temporary_pointer, pointer)
os.replace(temporary_pointer, coordination / "current.json")
print(json.dumps({"generation": generation, "commit": head, "tree": tree,
                  "artifacts": len(all_artifacts), "independentValidation": "PASS_SOURCE_ONLY",
                  "coordination": str(final)}))
