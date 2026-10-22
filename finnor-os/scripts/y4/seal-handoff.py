"""Seal task-local source and allowlisted public evidence, never private state."""
import argparse
import gzip
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import tarfile
from pathlib import Path

BASE = "b7b74b48efcb51bd6f1297a71f39cb9b4f117024"
REPO = Path(__file__).resolve().parents[3]
SCOPE = "scope-postx/y4-confidential-economic-compiler/"
ASSETS = "finnor-os/packages/private-equity/src/confidential-computation/"
TRACKED = {
    "finnor-os/apps/api/app/api/company-brain/[operation]/route.ts",
    "finnor-os/apps/worker/src/index.ts", "finnor-os/apps/worker/src/queue.ts", "finnor-os/openapi.json",
    "finnor-os/packages/capability-evolution/src/consumer-transport.ts",
    "finnor-os/packages/capability-evolution/src/lifecycle.ts",
    "finnor-os/packages/capability-evolution/src/source-closure.ts",
    "finnor-os/packages/db/compute-contract.ts", "finnor-os/packages/db/migrations-bundle.ts",
    "finnor-os/packages/db/schema.ts", "finnor-os/packages/orchestration/src/fast-read-lane.ts",
    "finnor-os/packages/orchestration/src/objective-loop.ts",
    "finnor-os/packages/orchestration/src/objective-success.ts",
    "finnor-os/packages/orchestration/src/operational-query-runtime.ts",
    "finnor-os/packages/orchestration/src/plugin-registry.ts",
    "finnor-os/packages/private-equity/src/enterprise-applications/store.ts",
    "finnor-os/packages/private-equity/src/allocation-store.ts",
    "finnor-os/packages/private-equity/src/enterprise-allocation.ts",
    "finnor-os/packages/private-equity/src/enterprise-control.ts",
    "finnor-os/packages/private-equity/src/enterprise-obligations.ts",
    "finnor-os/packages/private-equity/src/deliberation/contracts.ts",
    "finnor-os/packages/private-equity/src/decision-slice/contracts.ts",
    "finnor-os/packages/private-equity/src/evidence-execution/consumer.ts",
    "finnor-os/packages/private-equity/src/live-controls/native.ts",
    "finnor-os/packages/private-equity/src/live-controls/store.ts",
    "finnor-os/packages/private-equity/src/live-controls/fields.ts",
    "finnor-os/packages/private-equity/src/underwriting-repository.ts",
    "finnor-os/packages/shared-types/src/operational-queries.ts",
    "finnor-os/packages/underwriting/src/snapshot.ts", "finnor-os/packages/underwriting/src/types.ts",
    "finnor-os/scripts/bundle-migrations.ts", "finnor-os/scripts/generate-openapi.ts",
    "finnor-os/scripts/release/run-pe5-water-retirement-certification.ts",
    "finnor-os/scripts/release/verify-pe-domain-boundary.ts",
    "finnor-os/scripts/s5/owner-fixture.mts",
    "scripts/centropy/generate-capability-manifest.mjs",
    "src/components/centropy/world/WorldExplorer.tsx",
    "src/components/centropy/world/WorldWorkRecord.tsx",
    "src/lib/centropy/capability-manifest.generated.json",
}
PREFIXES = ("e2e/y4/", ASSETS, "finnor-os/scripts/y4/", SCOPE)
EXTRA = {
    "finnor-os/packages/db/migrations/postx_y4_confidential_economic_computation.sql",
    "finnor-os/packages/db/migrations/postx_y4_confidential_owner_consumption.sql",
    "finnor-os/packages/capability-evolution/src/confidential-consumer.ts",
    "finnor-os/packages/capability-evolution/src/confidential-port.ts",
    "src/components/centropy/world/ConfidentialComputationPanel.tsx",
    "finnor-os/packages/private-equity/src/bounded-reference.ts",
}
PUBLIC_NAMES = {
    "result.json", "campaign.json", "browser-observations.json",
    "browser-http-metadata.json", "installed-http-metadata.json",
    "migration-upgrade-replay.json", "native-work-completion.json",
    "heldout-public-functions.json", "database-lifecycle.json",
    "postgres-library-closure.json", "native-runtime-002.json", "native-runtime-003.json",
    "episode-driver-custody.json", "adverse-progress.json",
    "retention-custody.json", "engineering-driver.py", "reference_oracle.py",
    "fault_observer.py", "release_episode.py", "recovery_episode.py",
    "canonical-recovery.json", "fresh-authorization.json", "effect-preservation.json",
    "cancellation-disposal.json",
    "owner-consumption.json", "s8-construction-review.json", "owner-revocation.json",
    "s8-revocation.json", "engineering-gates.json", "review-dispositions.json",
    "source-manifest.json", "numerical-evidence-index.json", "validation.json",
    "python-parse.log", "generated-contracts.log", "gate-refusal-e2e.json",
}
PRIVATE_KEYS = {
    "releaseNonce", "release_nonce", "secret_json", "recordDigests", "records",
    "password", "access_token", "refresh_token", "serviceKey", "browserPassword",
    "privateKey", "mantissa", "inputValue", "openingNonce", "confidentialCommitmentSalt",
}


def sha(body):
    return hashlib.sha256(body).hexdigest()


def file_sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def git(*args):
    return subprocess.check_output(["git", "-C", str(REPO), *args])


def dump(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def public_only(value):
    if isinstance(value, dict):
        if PRIVATE_KEYS.intersection(value):
            raise ValueError("PRIVATE_FIELDS_NOT_ALLOWED_IN_HANDOFF")
        for item in value.values():
            public_only(item)
    elif isinstance(value, list):
        for item in value:
            public_only(item)


def relative_name(value):
    if not isinstance(value, str) or not value:
        raise ValueError("CONTAINED_PUBLIC_ARTIFACT_NAME_REQUIRED")
    path = Path(value)
    if not path.parts or path.is_absolute() or ".." in path.parts \
            or "PRIVATE-NOT-FOR-HANDOFF" in path.parts:
        raise ValueError("CONTAINED_PUBLIC_ARTIFACT_NAME_REQUIRED")
    return path


def input_receipt(value):
    path = Path(value)
    if not path.is_absolute() or "PRIVATE-NOT-FOR-HANDOFF" in path.parts:
        raise ValueError("ABSOLUTE_PUBLIC_RECEIPT_REQUIRED")
    if path.resolve(strict=True) != path:
        raise ValueError("REGULAR_PUBLIC_RECEIPT_WITHOUT_LINKS_REQUIRED")
    if "PRIVATE-NOT-FOR-HANDOFF" in path.parts or not stat.S_ISREG(path.lstat().st_mode) \
            or path.stat().st_size > 16 * 1024 * 1024 \
            or not (str(path).startswith("/home/factory-user/y4-delivery/")
                    or str(path).startswith("/dev/shm/finnor-y4-")):
        raise ValueError("ONLY_TASK_PUBLIC_RECEIPTS_ALLOWED")
    if path.name not in PUBLIC_NAMES and not re.fullmatch(
            r"(?:typecheck-backend|typecheck-episode|typecheck-browser|typecheck-frontend|frontend-typecheck|browser-typecheck|pe-domain-boundary)-\d+\.log", path.name):
        raise ValueError("PUBLIC_RECEIPT_NOT_ALLOWLISTED")
    body = path.read_bytes()
    if path.suffix == ".json":
        public_only(json.loads(body))
    return body


def contract_delta():
    path = "finnor-os/openapi.json"
    old, new = json.loads(git("show", BASE + ":" + path)), json.loads((REPO / path).read_bytes())
    result = {}
    for name, before, after in (
        ("paths", old["paths"], new["paths"]),
        ("schemas", old["components"]["schemas"], new["components"]["schemas"]),
    ):
        result[name] = {"added": sorted(set(after) - set(before)),
                        "removed": sorted(set(before) - set(after)),
                        "changedExisting": sorted(k for k in before if k in after and before[k] != after[k])}
    path = "src/lib/centropy/capability-manifest.generated.json"
    old, new = json.loads(git("show", BASE + ":" + path)), json.loads((REPO / path).read_bytes())
    result["capabilities"] = {
        "prior": len(old["capabilities"]), "current": len(new["capabilities"]),
        "priorEntriesMissing": sum(item not in new["capabilities"] for item in old["capabilities"]),
    }
    return result


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if not args.manifest.is_absolute() or not args.output.is_absolute() or args.output.exists():
        raise ValueError("ABSOLUTE_MANIFEST_AND_UNUSED_OUTPUT_REQUIRED")
    config = json.loads(args.manifest.read_bytes())
    public_only(config)
    required = {"sourceBase", "publicEvidence", "installation", "completionGate", "reviewManifest"}
    if not required.issubset(config) or set(config) - required - {"metadata"}:
        raise ValueError("EXACT_HANDOFF_CONFIGURATION_FIELDS_REQUIRED")
    if config["completionGate"] not in ("INCOMPLETE_ENGINEERING", "E2E_DEV_VERIFIED"):
        raise ValueError("LOCAL_ENGINEERING_GATE_ONLY")
    if config["sourceBase"] != BASE:
        raise ValueError("EXACT_ISOLATED_BASE_REQUIRED")
    git("merge-base", "--is-ancestor", BASE, "HEAD")
    changed = set(git("diff", "--name-only", BASE, "-z").decode().split("\0")) - {""}
    if {p for p in changed if p not in TRACKED and p not in EXTRA and not p.startswith(PREFIXES)}:
        raise ValueError("UNREVIEWED_TRACKED_CHANGE_PRESERVED_NOT_SEALED")
    untracked = set(git("ls-files", "--others", "--exclude-standard", "-z").decode().split("\0")) - {""}
    untracked = {p for p in untracked if p in EXTRA or p.startswith(PREFIXES)}
    paths = sorted(p for p in changed | untracked
                   if "/evidence/" not in p and "__pycache__" not in Path(p).parts
                   and "PRIVATE-NOT-FOR-HANDOFF" not in Path(p).parts
                   and not any(part.startswith(".") for part in Path(p).parts)
                   and Path(p).suffix in {".py", ".mjs", ".mts", ".ts", ".tsx", ".md", ".json", ".sql"})
    sources = {}
    for name in paths:
        path = REPO / name
        if path.resolve(strict=True) != path or not stat.S_ISREG(path.lstat().st_mode):
            raise ValueError("ONLY_CONTAINED_REGULAR_SOURCE_BYTES_ALLOWED")
        sources[name] = path.read_bytes()
    review_path = Path(config["reviewManifest"])
    if not review_path.is_absolute() or review_path.resolve(strict=True) != review_path \
            or review_path.parent != Path("/home/factory-user/y4-delivery") \
            or not re.fullmatch(r"review-\d{3}-source-manifest\.json", review_path.name):
        raise ValueError("EXPLICIT_TASK_SOURCE_REVIEW_MANIFEST_REQUIRED")
    review = json.loads(review_path.read_bytes())
    reviewed = {item["path"]: item["sha256"] for item in review["files"]}
    if review["base"] != BASE or len(reviewed) != len(review["files"]) \
            or reviewed != {name: sha(body) for name, body in sources.items()}:
        raise ValueError("EXACT_REVIEWED_SOURCE_INVENTORY_REQUIRED")
    evidence = {}
    for item in config["publicEvidence"]:
        name = relative_name(item["name"])
        if str(name) in evidence:
            raise ValueError("DUPLICATE_PUBLIC_RECEIPT")
        evidence[str(name)] = input_receipt(item["source"])
    installation = Path(config["installation"])
    if not installation.is_absolute() or installation.parent != Path("/home/factory-user/y4-delivery") \
            or not re.fullmatch(r"installation-\d{3}", installation.name) \
            or installation.resolve(strict=True) != installation \
            or not stat.S_ISDIR(installation.lstat().st_mode):
        raise ValueError("RETAINED_REGULAR_TASK_INSTALLATION_REQUIRED")
    raw_installation = (installation / "installation.json").read_bytes()
    installation_digest = (installation / "installation.sha256").read_text().strip()
    if sha(raw_installation) != installation_digest:
        raise ValueError("RETAINED_INSTALLATION_MANIFEST_CHANGED")
    installed = json.loads(raw_installation)
    if installed["schema"] != "finnor.y4.installed-runtime.v1" or installed["head"] != BASE:
        raise ValueError("EXACT_BASE_INSTALLED_RUNTIME_REQUIRED")
    records = {item["path"]: item for item in installed["files"]}
    if len(records) != len(installed["files"]):
        raise ValueError("UNIQUE_INSTALLED_FILE_PATHS_REQUIRED")
    for name in records:
        relative_name(name)
    mismatches = []
    source_names = set(installed["sourceModules"])
    source_names.update(name.removeprefix("runtime/") for name, record in records.items()
                        if record["kind"] == "source"
                        and (name.startswith("runtime/src/") or name.startswith("runtime/e2e/y4/")
                             or name in {"runtime/package.json", "runtime/package-lock.json",
                                         "runtime/tsconfig.json", "runtime/next.config.mjs"}))
    for name in source_names:
        relative_name(name)
        actual = REPO / name
        if actual.resolve(strict=True) != actual or not actual.is_file() \
                or file_sha(actual) != records["runtime/" + name]["sha256"]:
            mismatches.append(name)
    asset_names = sorted(p for p in records if p.startswith("runtime/" + ASSETS))
    for name in asset_names:
        actual = REPO / name.removeprefix("runtime/")
        if not actual.is_file() or file_sha(actual) != records[name]["sha256"]:
            mismatches.append(name.removeprefix("runtime/"))
    if mismatches:
        raise ValueError("DEPENDENT_PRODUCT_EVIDENCE_INVALIDATED_BY_SOURCE_CHANGE")
    gate_validation = {"status": "NOT_REQUESTED_INCOMPLETE_ENGINEERING"}
    if config["completionGate"] == "E2E_DEV_VERIFIED":
        from engineering_gates import validate_engineering_gates
        gate_validation = validate_engineering_gates(
            json.loads(evidence.get("engineering-gates.json", b"{}")), evidence, sources,
            review, file_sha(review_path), installed, installation_digest)
    args.output.mkdir(parents=True, mode=0o700)
    archive = args.output / "changed-source.tar.gz"
    with archive.open("xb") as stream:
        with gzip.GzipFile(fileobj=stream, mode="wb", mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode="w|") as tar:
                for name, body in sorted(sources.items()):
                    info = tarfile.TarInfo(name)
                    info.size, info.mode, info.mtime = len(body), 0o644, 0
                    tar.addfile(info, io.BytesIO(body))
    reconstructed = {}
    with tarfile.open(archive, "r:gz") as tar:
        for item in tar:
            if not item.isfile() or item.name in reconstructed:
                raise ValueError("EXACT_REGULAR_SOURCE_ARCHIVE_REQUIRED")
            with tar.extractfile(item) as stream:
                reconstructed[item.name] = sha(stream.read())
    if reconstructed != {name: sha(body) for name, body in sources.items()}:
        raise ValueError("SOURCE_ARCHIVE_RECONSTRUCTION_MISMATCH")
    for name, body in evidence.items():
        path = args.output / "public-evidence" / name
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with path.open("xb") as stream:
            stream.write(body)
    patch = git("diff", BASE, "--binary", "--", *sorted(changed)) if changed else b""
    (args.output / "tracked-source.patch").write_bytes(patch)
    delta = contract_delta()
    (args.output / "generated-contract-delta.json").write_bytes(dump(delta))
    base_archive = args.output / "base-source.tar.gz"
    archive_cache = config.get("metadata", {}).get("archiveCache")
    if archive_cache:
        cache = Path(archive_cache)
        if cache.parent != Path("/home/factory-user/y4-delivery") \
                or not re.fullmatch(r"handoff-candidate-\d{3}", cache.name) or cache.resolve(strict=True) != cache:
            raise ValueError("EXPLICIT_RETAINED_BASE_ARCHIVE_CACHE_REQUIRED")
        cached = cache / base_archive.name
        digest = hashlib.sha256()
        process = subprocess.Popen(["git", "-C", str(REPO), "archive", "--format=tar.gz", BASE], stdout=subprocess.PIPE)
        with process.stdout as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        if process.wait() or cached.is_symlink() or file_sha(cached) != digest.hexdigest():
            raise ValueError("CACHED_ARCHIVE_DIFFERS_FROM_COMPLETE_ORIGINAL_GIT_BASE")
        os.link(cached, base_archive)
    else:
        with base_archive.open("xb") as stream:
            subprocess.run(["git", "-C", str(REPO), "archive", "--format=tar.gz", BASE],
                           stdout=stream, check=True)
    base_commit = git("cat-file", "commit", BASE)
    (args.output / "base-commit.raw").write_bytes(base_commit)
    native_root = Path(config.get("metadata", {}).get("nativeBackend", ""))
    if not native_root.is_absolute() or native_root.parent != Path("/home/factory-user/y4-tools") \
            or not re.fullmatch(r"native-runtime-\d{3}", native_root.name):
        raise ValueError("EXPLICIT_TASK_NATIVE_ASSETS_REQUIRED")
    identity = json.loads((REPO / ASSETS / "backend-identity.json").read_text())
    native_files = {name: identity[name] for name in (
        "mascot-party.x", "libSPDZ.so", "Programs/Circuits/sha256.txt",
        "local/lib/liblibOTe.a", "local/lib/libcryptoTools.a")}
    native_files.update(identity["compilerFiles"])
    native_files.update({"local/runtime-libs/" + name: digest
                         for name, digest in identity["runtimeLibraries"].items()})
    native_sources = {name: native_root / name for name in native_files}
    # Preserve exact upstream attribution and distro notices alongside binaries.
    notices = {
        "MP-SPDZ": Path("/home/factory-user/y4-tools/mp-spdz/License.txt"),
        "libOTe": Path("/home/factory-user/y4-tools/mp-spdz/deps/libOTe/LICENSE"),
        "cryptoTools": Path("/home/factory-user/y4-tools/mp-spdz/deps/libOTe/cryptoTools/LICENSE"),
    }
    for package in ("libgmp10", "libgmpxx4ldbl", "libsodium23", "libboost-filesystem1.83.0", "libboost-iostreams1.83.0"):
        notices[package] = Path("/home/factory-user/y4-tools/native/usr/share/doc") / package / "copyright"
    for package in ("libc6", "libstdc++6", "libgcc-s1", "libssl3t64", "zlib1g", "libbz2-1.0", "liblzma5", "libzstd1"):
        notices[package] = Path("/usr/share/doc") / package / "copyright"
    for name in ("GPL-2", "GPL-3", "LGPL-2.1", "LGPL-3"):
        notices[name] = Path("/usr/share/common-licenses") / name
    for name, path in notices.items():
        archive_name = "LICENSES/" + name + ".txt"
        native_sources[archive_name], native_files[archive_name] = path, file_sha(path)
    native_archive = args.output / "native-runtime.tar.gz"
    native_stream = io.BytesIO() if archive_cache else native_archive.open("xb")
    if archive_cache:
        # The complete pinned native closure is bounded and about 10 MiB
        # compressed. Regenerate exact bytes before reusing retained storage.
        native_stream.name = str(native_archive)
    with native_stream as stream:
        with gzip.GzipFile(fileobj=stream, mode="wb", mtime=0) as zipped:
            with tarfile.open(fileobj=zipped, mode="w|") as tar:
                for name, fingerprint in sorted(native_files.items()):
                    relative_name(name)
                    path = native_sources[name]
                    if not path.is_file() or file_sha(path) != fingerprint:
                        raise ValueError("PINNED_NATIVE_ASSET_PACKAGE_CHANGED")
                    info = tarfile.TarInfo(name)
                    info.size, info.mode, info.mtime = path.stat().st_size, 0o755 if name.endswith(".x") or "/runtime-libs/" in name else 0o644, 0
                    with path.open("rb") as body:
                        tar.addfile(info, body)
        if archive_cache:
            cached = Path(archive_cache) / native_archive.name
            if not cached.is_symlink() and file_sha(cached) == sha(stream.getbuffer()):
                os.link(cached, native_archive)
            else:
                # A prior cache can predate newly required license notices.
                # Retain it and write only the freshly verified complete bytes.
                with native_archive.open("xb") as output:
                    output.write(stream.getbuffer())
    offline = config.get("metadata", {}).get("offlineRuntimePackage")
    offline_receipt = None
    frontend_materialization = None
    backend_materialization = None
    if offline:
        path = Path(offline)
        inventory = Path(offline + ".json")
        if path.parent != Path("/home/factory-user/y4-delivery") \
                or not re.fullmatch(r"offline-node-closure-\d{3}\.tar\.gz", path.name) \
                or path.resolve(strict=True) != path or inventory.resolve(strict=True) != inventory:
            raise ValueError("PINNED_TASK_OFFLINE_RUNTIME_PACKAGE_REQUIRED")
        digest = file_sha(path)
        if json.loads(inventory.read_bytes())["archiveSha256"] != digest:
            raise ValueError("OFFLINE_RUNTIME_PACKAGE_INVENTORY_CHANGED")
        closure = json.loads(inventory.read_bytes())["files"]
        for name, record in records.items():
            if name.startswith("runtime/node_modules/"):
                packaged = closure.get("backend/" + name.removeprefix("runtime/node_modules/"))
                if not packaged or packaged.get("sha256") != record["sha256"] or packaged.get("bytes") != record["bytes"]:
                    raise ValueError("FINAL_INSTALLED_DEPENDENCY_MISSING_FROM_OFFLINE_CLOSURE")
        frontend_materialization = set()
        for name, body in evidence.items():
            if Path(name).name != "browser-observations.json":
                continue
            observed = json.loads(body)
            if observed.get("status") != "PASS":
                continue
            for item in observed.get("sourceCut", []):
                if "/node_modules/" not in item["path"]:
                    continue
                member = "frontend/" + item["path"].split("/node_modules/", 1)[1]
                if member not in closure or closure[member].get("sha256") != item["sha256"]:
                    raise ValueError("ACTUAL_BROWSER_DEPENDENCY_NOT_IN_OFFLINE_ARCHIVE")
                frontend_materialization.add(member)
        if not frontend_materialization:
            raise ValueError("ACTUAL_VERIFIED_BROWSER_CLOSURE_REQUIRED")
        frontend_materialization.update(name for name, item in closure.items() if name.startswith("frontend/")
            and (Path(name).name == "package.json" or item["kind"] == "link"
                 or re.search(r"license|copying|copyright|notice", Path(name).name, re.I)))
        backend_materialization = {name for name, item in closure.items() if name.startswith("backend/")
            and (not name.endswith(".map") or item["kind"] == "link"
                 or re.search(r"license|copying|copyright|notice", Path(name).name, re.I))}
        offline_receipt = {"source": str(path), "archiveSha256": digest,
                           "inventorySource": str(inventory), "inventorySha256": sha(inventory.read_bytes())}
    scientific = config.get("metadata", {}).get("scientificRuntimePackage")
    scientific_receipt = None
    if scientific:
        path, inventory = Path(scientific), Path(scientific + ".json")
        if path.parent != Path("/home/factory-user/y4-delivery") \
                or not re.fullmatch(r"offline-scientific-closure-\d{3}\.tar\.gz", path.name) \
                or path.resolve(strict=True) != path or inventory.resolve(strict=True) != inventory:
            raise ValueError("PINNED_TASK_SCIENTIFIC_RUNTIME_REQUIRED")
        digest = file_sha(path)
        if json.loads(inventory.read_bytes())["archiveSha256"] != digest:
            raise ValueError("SCIENTIFIC_RUNTIME_INVENTORY_CHANGED")
        scientific_receipt = {"source": str(path), "archiveSha256": digest,
                              "inventorySource": str(inventory), "inventorySha256": file_sha(inventory)}
    receipt = {
        "schema": "finnor.y4.local-handoff.v1", **config,
        "sourceHead": git("rev-parse", "HEAD").decode().strip(),
        "sourceHeadTree": git("rev-parse", "HEAD^{tree}").decode().strip(),
        "sourceDirtyAtSeal": bool(git("status", "--porcelain").strip()),
        "offlineRuntimePackage": offline_receipt,
        "scientificRuntimePackage": scientific_receipt,
        "runtimeFrontendMaterialization": sorted(frontend_materialization) if frontend_materialization else None,
        "runtimeBackendMaterialization": sorted(backend_materialization) if backend_materialization else None,
        "frontendProfile": "ACTUAL_MOUNTED_WORLD_BUILD_INPUTS_PLUS_PACKAGE_METADATA_AND_NOTICES",
        "backendProfile": "COMPLETE_RUNTIME_AND_TYPES_WITH_OPTIONAL_DEBUG_MAPS_RETAINED_IN_ARCHIVE",
        "sourceReviewManifestSha256": file_sha(review_path),
        "exactReviewedSourceInventoryMatched": True,
        "engineeringGateValidation": gate_validation,
        "baseSourceArchive": {"name": base_archive.name, "sha256": file_sha(base_archive),
                              "tree": git("rev-parse", BASE + "^{tree}").decode().strip()},
        "baseCommitObject": {"name": "base-commit.raw", "sha256": sha(base_commit),
                             "gitCommit": BASE, "ancestorHistoryIncluded": False},
        "nativeRuntimeArchive": {"name": native_archive.name, "sha256": file_sha(native_archive),
                                 "files": native_files, "rebuiltFromUpstreamInReconstruction": False},
        "sourceArchive": {"name": archive.name, "sha256": file_sha(archive),
                          "individuallyReconstructedMembersMatch": True},
        "sources": [{"path": name, "bytes": len(body), "sha256": sha(body)}
                    for name, body in sources.items()],
        "publicEvidenceInventory": [{"path": "public-evidence/" + name, "bytes": len(body), "sha256": sha(body)}
                                    for name, body in sorted(evidence.items())],
        "trackedPatchSha256": sha(patch), "generatedContractDelta": delta,
        "installationManifestSha256": installation_digest,
        "installedNonDependencyAllocatedBytes": sum((record["bytes"] + 4095) // 4096 * 4096
                                                    for name, record in records.items()
                                                    if not name.startswith("runtime/node_modules/")),
        "reconstructionWorkingTreeSources": sorted(name.removeprefix("runtime/") for name, record in records.items()
                                                   if record["kind"] == "source"),
        "nativeRedistributionNoticesIncluded": sorted(notices),
        "outwardBinaryRedistributionLegalClearance": False,
        "installedEntrypointDigests": {name: record["sha256"] for name, record in records.items()
                                      if name.startswith("runtime/y4-runtime/")},
        "installedEntrypointAndY4AssetSourcesStillMatch": True,
        "retainedFrontendSourcesAndWorkspaceLocksStillMatch": True,
        "separatelyRetainedEpisodeDriverSourceNotAssumedFromInstallation": True,
        "installedSourceModuleCount": len(installed["sourceModules"]),
        "installedY4AssetCount": len(asset_names),
        "privateEvidenceReadOrCopied": False, "independentReconstruction": False,
        "protectedAdmission": False, "productionActive": False, "realEconomicEffects": False,
    }
    body = dump(receipt)
    (args.output / "handoff.json").write_bytes(body)
    (args.output / "handoff.sha256").write_text(sha(body) + "\n")
    print(json.dumps({"output": str(args.output), "handoffSha256": sha(body),
                      "sourceFiles": len(sources), "publicEvidenceFiles": len(evidence),
                      "status": config["completionGate"], "privateEvidenceReadOrCopied": False}))


if __name__ == "__main__":
    main()
