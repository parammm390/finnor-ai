#!/usr/bin/env python3
"""Publish a reconstructible local restricted generation, never a gate admission."""
import hashlib
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PARENT = "d8d72f8f37f20761e7cd7d8517b80acaa124115a"
CONTROL = Path("/Users/paramdave/.codex/visualizations/2026/10/04/"
               "01a10828-82e3-7572-8d13-530b28a346bf/finnor-pm-control")
DEST = CONTROL / "completion-prompts-2026-10-07/coordination/track-c"


def git(*args, env=None):
    return subprocess.check_output(["git", "-C", str(ROOT), *args],
                                   env=env, timeout=120)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def reconstruct(base, commit, tree):
    patch = git("diff", "--binary", "--full-index", "--no-renames", base, commit)
    with tempfile.TemporaryDirectory(prefix="completion-c-reconstruct-") as temporary:
        patch_path = Path(temporary) / "source.patch"
        patch_path.write_bytes(patch)
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(temporary) / "index")}
        git("read-tree", base, env=env)
        git("apply", "--cached", "--binary", str(patch_path), env=env)
        if git("write-tree", env=env).decode().strip() != tree:
            raise RuntimeError("Exact-parent patch reconstruction failed")
    return patch


def predecessor(commit):
    pointer_path = DEST / "current.json"
    if not pointer_path.exists():
        if git("rev-parse", "HEAD^").decode().strip() != PARENT:
            raise RuntimeError("First checkpoint requires the exact declared parent")
        return None
    pointer = json.loads(pointer_path.read_text())
    path = Path(pointer["receipt"])
    if path.is_absolute() or ".." in path.parts:
        raise RuntimeError("Invalid predecessor receipt path")
    data = (DEST / path).read_bytes()
    if sha(data) != pointer["receiptSha256"]:
        raise RuntimeError("Predecessor receipt hash mismatch")
    receipt = json.loads(data)
    if any(receipt[key] != pointer[key] for key in ["commit", "tree", "generation"]):
        raise RuntimeError("Predecessor pointer identity mismatch")
    if receipt["parent"] != PARENT or receipt["commit"] == commit:
        raise RuntimeError("Checkpoint must advance the declared published history")
    git("merge-base", "--is-ancestor", receipt["commit"], commit)
    if git("rev-parse", receipt["commit"] + "^{tree}").decode().strip() != receipt["tree"]:
        raise RuntimeError("Predecessor tree mismatch")
    directory = (DEST / path).parent
    for record in receipt["orderedPatches"] + [receipt["bundle"]]:
        artifact = Path(record["path"])
        if artifact.is_absolute() or ".." in artifact.parts:
            raise RuntimeError("Invalid predecessor artifact path")
        if sha((directory / artifact).read_bytes()) != record["sha256"]:
            raise RuntimeError("Predecessor artifact hash mismatch")
    return {"generation": pointer["generation"], "commit": pointer["commit"],
            "tree": pointer["tree"], "receiptSha256": pointer["receiptSha256"]}


def current_source(source):
    if not source["unchanged"] or not source.get("sourceComplete", True):
        raise RuntimeError("Selected source proof incomplete or changed")
    if source["before"] != source["after"] or not source["after"]:
        raise RuntimeError("Selected source observations disagree or are empty")
    for record in source["after"]:
        path = Path(record["path"])
        if path.is_absolute() or ".." in path.parts or not record["sha256"]:
            raise RuntimeError("Invalid selected source record")
        if sha((ROOT / path).read_bytes()) != record["sha256"]:
            raise RuntimeError("Selected proof is historical, not current: " + str(path))


def main():
    commit = git("rev-parse", "HEAD").decode().strip()
    tree = git("rev-parse", "HEAD^{tree}").decode().strip()
    if commit == PARENT:
        raise RuntimeError("Missing reviewed checkpoint delta")
    git("merge-base", "--is-ancestor", PARENT, commit)
    previous = predecessor(commit)
    if git("diff", "HEAD", "--name-only").strip():
        raise RuntimeError("Tracked source differs from the reviewed commit")
    selection = json.loads((HERE / "checkpoint-evidence.json").read_text())
    integration = json.loads((HERE / "integration-recipe.json").read_text())
    evidence = {}
    forbidden = re.compile(r'"(?:access_token|refresh_token|password|secret|apiKey)"\s*:|'
                           r'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----')
    for name in selection["files"]:
        path = Path(name)
        if path.is_absolute() or ".." in path.parts or path.suffix not in [".json", ".md"]:
            raise RuntimeError("Invalid reviewed evidence path")
        data = (ROOT / path).read_bytes()
        if forbidden.search(data.decode()):
            raise RuntimeError("Credential-like material in selected evidence: " + name)
        if path.suffix == ".json":
            def no_tokens(value):
                if isinstance(value, dict):
                    for key, item in value.items():
                        if key.lower().replace("_", "") == "token" and item not in [None, "REDACTED"]:
                            raise RuntimeError("Unredacted token in selected evidence: " + name)
                        no_tokens(item)
                elif isinstance(value, list):
                    for item in value:
                        no_tokens(item)
            no_tokens(json.loads(data))
        evidence[name] = data
    for proof in selection["currentProofs"]:
        prefix = proof["prefix"]
        result_file = proof.get("resultsFile", "results.json")
        document = json.loads(evidence[prefix + "/" + result_file])
        results = document["results"]
        if "_publicEvidence" in document:
            raw = (ROOT / prefix / "results.json").read_bytes()
            metadata = document["_publicEvidence"]
            if sha(raw) != metadata["rawArtifactSha256"] or len(raw) != metadata["rawArtifactBytes"]:
                raise RuntimeError("Redacted proof does not bind its preserved private original")
            identities = lambda rows: [(row["id"], row["status"]) for row in rows]
            if identities(json.loads(raw)["results"]) != identities(results):
                raise RuntimeError("Redacted proof changed result identities or statuses")
        if len(results) != proof["storyCount"] or any(r["status"] != "PASS" for r in results):
            raise RuntimeError("Selected story proof failed or count changed: " + prefix)
        current_source(json.loads(evidence[prefix + "/source-check.json"]))
        if proof["kind"] == "P5":
            driver = json.loads(evidence[prefix + "/driver-receipt.json"])
            if driver["exitCode"] != 0 or not driver["sourceUnchanged"] or not driver["sourceComplete"]:
                raise RuntimeError("Selected P5 driver proof failed: " + prefix)
        elif proof["kind"] == "P7":
            if not json.loads(evidence[prefix + "/cleanup.json"])["databaseStopped"]:
                raise RuntimeError("Selected P7 owned database cleanup incomplete")
        else:
            raise RuntimeError("Unknown selected current proof kind")
    if not selection["currentProofs"]:
        raise RuntimeError("At least one reviewed current proof is required")
    patch = reconstruct(PARENT, commit, tree)
    incremental = reconstruct(previous["commit"], commit, tree) if previous else None
    migrations = sorted((ROOT / "finnor-os/packages/db/migrations").glob("*.sql"))
    contracts = [
        "finnor-os/packages/private-equity/src/live-recompilation/contracts.ts",
        "finnor-os/packages/private-equity/src/live-recompilation/api.ts",
        "finnor-os/packages/private-equity/src/interface-synthesis/contracts.ts",
        "finnor-os/packages/private-equity/src/interface-synthesis/api.ts",
        "finnor-os/packages/shared-types/src/evidence-execution.ts",
        "finnor-os/packages/db/compute-contract.ts",
        "finnor-os/openapi.json", "src/lib/centropy/openapi-types.ts",
    ]
    node = json.loads(subprocess.check_output([
        "node", "-p",
        "JSON.stringify({version:process.version,platform:process.platform,arch:process.arch,"
        "execPath:process.execPath,nodeAbi:process.versions.modules})"]))
    runtime_paths = [
        Path(node["execPath"]),
        ROOT / "finnor-os/node_modules/fs-ext/build/Release/fs_ext.node",
        ROOT / ("finnor-os/node_modules/@embedded-postgres/" + node["platform"] + "-"
                + node["arch"] + "/native/bin/postgres"),
    ]
    changed = git("diff", "--name-only", PARENT, commit).decode().splitlines()
    receipt = {
        "schema": "finnor.completion-c.restricted-generation.v1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "parent": PARENT, "commit": commit, "tree": tree,
        "predecessor": previous,
        "qualification": selection["qualification"],
        "source": [{"path": p, "sha256": sha((ROOT / p).read_bytes())} for p in changed],
        "contracts": [{"path": p, "sha256": sha((ROOT / p).read_bytes())} for p in contracts],
        "runtime": {
            **node,
            "binaries": [{"path": str(p), "sha256": sha(p.read_bytes())} for p in runtime_paths],
            "rootLock": sha((ROOT / "package-lock.json").read_bytes()),
            "backendLock": sha((ROOT / "finnor-os/package-lock.json").read_bytes()),
            "cleanFinalInstall": "NOT_RUN", "protectedLinuxConfinement": "NOT_RUN",
        },
        "migrations": [{"path": str(p.relative_to(ROOT)), "sha256": sha(p.read_bytes())} for p in migrations],
        "orderedPatches": [{"path": "source.patch", "sha256": sha(patch), "base": PARENT,
                            "reconstructedTree": tree}],
        "currentProofs": selection["currentProofs"],
        "evidence": [{"path": "evidence/" + p, "sha256": sha(data)} for p, data in evidence.items()],
        "ports": {
            "P7": {"module": "finnor-os/packages/private-equity/src/live-recompilation/api.ts",
                   "submit": "submitContinuation", "read": "readContinuation",
                   "domain": "ORDINARY_NATIVE_ANALYTICAL_ONLY",
                   "publicHttp": "/api/company-brain/continuation-{submit,read,projection}",
                   "canvas": "IMPLEMENTED_NOT_MOUNTED_QUALIFIED"},
            "P5": {"http": "/api/company-brain/interface-*", "owner": "P5",
                   "domain": "ORDINARY_DISPOSABLE", "consequentialAuthority": False,
                   "mounted": "FAIL_WORLD_ROOT_THEN_BLOCKED_KEYBOARD_FOCUS"},
        },
        "adoptedPeerGenerations": integration["adoptedPeerGenerations"],
        "observedPeerGenerations": integration["observedPeerGenerations"],
        "affectedOriginalRegressions": integration.get("affectedOriginalRegressions", []),
        "ownerRequests": integration["ownerRequests"],
        "originalClauseCount": 1976,
        "gates": {p: "UNQUALIFIED" for p in ["P4", "M1", "P3", "P1", "M3", "M4", "P2", "M2", "P7", "P5"]},
        "costs": {"usd": None, "qualified": False},
        "push": False, "deployment": None, "protectedAdmission": False,
    }
    generation = sha(encoded(receipt))
    if git("diff", "HEAD", "--name-only").strip() or git("rev-parse", "HEAD").decode().strip() != commit:
        raise RuntimeError("Source changed during checkpoint preparation")
    directory = DEST / "generations" / generation
    directory.mkdir(parents=True, exist_ok=False)
    (directory / "source.patch").write_bytes(patch)
    if incremental is not None:
        (directory / "incremental.patch").write_bytes(incremental)
        receipt["orderedPatches"].append({
            "path": "incremental.patch", "sha256": sha(incremental),
            "base": previous["commit"], "reconstructedTree": tree})
    for name, data in evidence.items():
        target = directory / "evidence" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    if git("rev-parse", "HEAD").decode().strip() != commit:
        raise RuntimeError("HEAD changed before bundle creation")
    git("bundle", "create", str(directory / "source.bundle"), PARENT + "..HEAD")
    git("bundle", "verify", str(directory / "source.bundle"))
    receipt["bundle"] = {"path": "source.bundle", "sha256": sha((directory / "source.bundle").read_bytes()),
                         "prerequisite": PARENT}
    receipt["generation"] = generation
    data = encoded(receipt)
    (directory / "receipt.json").write_bytes(data)
    for record in receipt["evidence"] + receipt["orderedPatches"] + [receipt["bundle"]]:
        if sha((directory / record["path"]).read_bytes()) != record["sha256"]:
            raise RuntimeError("Published file hash mismatch")
    if git("diff", "HEAD", "--name-only").strip() or git("rev-parse", "HEAD").decode().strip() != commit:
        raise RuntimeError("Source changed before atomic checkpoint publication")
    pointer = encoded({"schema": "finnor.completion-c.current-generation.v1",
                       "generation": generation, "receipt": "generations/" + generation + "/receipt.json",
                       "receiptSha256": sha(data), "commit": commit, "tree": tree})
    with tempfile.NamedTemporaryFile(dir=DEST, prefix="current-", delete=False) as stream:
        stream.write(pointer)
        temporary_pointer = Path(stream.name)
    os.replace(temporary_pointer, DEST / "current.json")
    print(json.dumps({"generation": generation, "commit": commit, "tree": tree,
                      "reconstruction": "PASS", "directory": str(directory),
                      "qualification": receipt["qualification"]}))


if __name__ == "__main__":
    main()
