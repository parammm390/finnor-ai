"""Freeze an exclusive, preimage-bound local owning custody candidate."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("number", type=int)
    parser.add_argument("--strict-typecheck-receipt", required=True)
    arguments = parser.parse_args()
    number = arguments.number
    if number < 12:
        raise RuntimeError("CANDIDATE_NUMBER_MUST_NOT_REUSE_BASELINES")
    tag = f"{number:04d}"
    root = Path(__file__).resolve().parents[3]
    scope = root / "scope-postz/w1-economic-orchestration"
    proposal = scope / "integration-proposals/objective-read-custody-parent-v2"

    def sha(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def relative_source(value: str) -> str:
        path = Path(value)
        if path.is_absolute() or ".." in path.parts or not (root / path).resolve().is_relative_to(root):
            raise RuntimeError("SOURCE_MUST_REMAIN_INSIDE_CHECKOUT")
        return str(path)

    def exclusive_json(path: Path, value: object) -> None:
        with path.open("x") as output:
            json.dump(value, output, indent=2)
            output.write("\n")

    historical = json.loads((scope / "native/review-native-0013-registration.json").read_text())
    # The accepted additions:F15 cleanup removes only this forwarding leaf.
    # Preserve its historical identity, but freeze the existing canonical owner.
    retired_path = "finnor-os/packages/private-equity/src/economic-reads/contracts.ts"
    retired = [entry for entry in historical["sourceFiles"] if entry["path"] == retired_path]
    if len(retired) != 1 or (root / retired_path).exists():
        raise RuntimeError("EXACT_HISTORICAL_FORWARDER_RETIREMENT_REQUIRED")
    originals = json.loads((proposal / "preimages.json").read_text())["files"]
    supplemental_targets = ("preimage-supplement-002.json", "preimage-supplement-003.json", "preimage-supplement-004.json")
    supplements = [entry for name in supplemental_targets
        for entry in json.loads((proposal / name).read_text())["files"]]
    targets = {relative_source(entry["target"]): entry for entry in [*originals, *supplements]}
    for target, entry in targets.items():
        before = proposal / "before" / target
        if entry.get("beforeSha256") is None:
            if before.exists():
                raise RuntimeError("Unexpected preimage for originally absent target: " + target)
        elif not before.is_file() or sha(before) != entry["beforeSha256"]:
            raise RuntimeError("Original preimage mismatch: " + target)
        if not (root / target).is_file():
            raise RuntimeError("Installed candidate target is missing: " + target)

    unchanged = []
    for name in ("plan-progress.ts",):
        target = "finnor-os/packages/orchestration/src/" + name
        before = proposal / "before" / target
        if sha(before) != sha(root / target):
            raise RuntimeError("Rejected generic-frontier draft remains: " + target)
        unchanged.append({"target": target, "sha256": sha(before)})
    kernel = "finnor-os/packages/orchestration/src/orchestration-kernel.ts"
    original_kernel = (proposal / "before" / kernel).read_text()
    declaration = "export async function reserveReadyPlanFrontier("
    prefix, body = original_kernel.split(declaration, 1)
    expected_kernel = (prefix + declaration + body.replace(
        "  return withTenant(params.tenantId, async (db) => {\n",
        "  return withTenant(params.tenantId, async (db) => {\n    await lockTenantMaterialCutTx(db, params.tenantId);\n", 1)
        ).replace("  integrationEvents,\n", "  integrationEvents,\n  lockTenantMaterialCutTx,\n", 1)
    if (root / kernel).read_text() != expected_kernel:
        raise RuntimeError("GENERIC_FRONTIER_MAY_CHANGE_ONLY_ITS_IMPORT_AND_MATERIAL_FENCE")
    unchanged.append({"target": kernel, "originalSha256": sha(proposal / "before" / kernel),
        "sha256": sha(root / kernel), "algorithmUnchanged": True,
        "onlyChange": "Canonical same-client material fence before row/cursor locks"})

    guard_original = root / "finnor-os/packages/db/migrations/0173_v3_autonomous_transaction_closure.sql"
    guard_candidate = root / "finnor-os/packages/db/migrations/postz_w1_objective_budget_guard.sql"
    original_body = re.search(r"CREATE FUNCTION finnor_os\.pe_v3_objective_grant_guard\(\).*?AS \$\$(.*?)\$\$;",
        guard_original.read_text(), re.S).group(1)
    candidate_body = re.search(r"CREATE OR REPLACE FUNCTION finnor_os\.pe_v3_objective_grant_guard\(\).*?AS \$\$(.*?)\$\$;",
        guard_candidate.read_text(), re.S).group(1)
    expected_body = original_body.replace(
        "IF (NEW.max_steps>96 OR NEW.max_actions>25 OR NEW.max_queries>50) AND NOT EXISTS(",
        "IF NEW.max_steps>96 OR NEW.max_actions>25 OR NEW.max_queries>50 THEN IF NOT EXISTS(", 1).replace(
        "RAISE EXCEPTION 'Larger finite grant requires the original accepted closing Work';\n  END IF;",
        "RAISE EXCEPTION 'Larger finite grant requires the original accepted closing Work'; END IF; END IF;", 1)
    if re.sub(r"\s+", " ", candidate_body).strip() != re.sub(r"\s+", " ", expected_body).strip():
        raise RuntimeError("OBJECTIVE_GRANT_POLICY_MAY_ONLY_FACTOR_ITS_ELEVATED_SQL_BRANCH")

    strict_path = relative_source(arguments.strict_typecheck_receipt)
    if not strict_path.startswith("scope-postz/w1-economic-orchestration/evidence/"):
        raise RuntimeError("STRICT_RECEIPT_MUST_BE_LOCAL_SCOPED_EVIDENCE")
    strict = json.loads((root / strict_path).read_text())
    strict_receipt_sha = sha(root / strict_path)
    type_spec = importlib.util.spec_from_file_location("strict_owner_custody", scope / "native/qualify-owner-types.py")
    type_custody = importlib.util.module_from_spec(type_spec)
    type_spec.loader.exec_module(type_custody)

    def assert_strict_custody():
        if strict["exitCode"] != 0 or strict["sourceChangedDuringCheck"] or not strict.get("compilerClosureQualified"):
            raise RuntimeError("SUCCESSFUL_UNCHANGED_ACTUAL_COMPILER_CLOSURE_REQUIRED")
        if sha(root / strict_path) != strict_receipt_sha:
            raise RuntimeError("STRICT_OWNER_RECEIPT_CHANGED")
        if strict["config"] != type_custody.CONFIGURATIONS[0] or sha(root / strict["config"]) != strict["configSha256"]:
            raise RuntimeError("STRICT_OWNER_CLOSURE_CONFIG_MISMATCH")
        if sha(root / relative_source(strict["log"])) != strict["logSha256"]:
            raise RuntimeError("STRICT_OWNER_CHECK_LOG_MISMATCH")
        for entry in strict["configurationFiles"]:
            if sha(root / relative_source(entry["path"])) != entry["sha256"]:
                raise RuntimeError("STRICT_OWNER_CONFIGURATION_CHANGED")
        current = type_custody.source_snapshot(root)
        if current != strict["sourceFiles"]:
            raise RuntimeError("OWNER_SOURCE_CHANGED_AFTER_STRICT_CHECK")
        closure = strict["compilerClosure"]
        listing = root / relative_source(closure["listing"])
        actual_paths = type_custody.compiler_paths(root / relative_source(strict["log"]))
        if sha(listing) != closure["listingSha256"] or type_custody.compiler_paths(listing) != actual_paths \
                or actual_paths != closure["sourcePaths"] or actual_paths != closure["actualCheckedSourcePaths"] \
                or type_custody.compiler_snapshot(root, actual_paths) != closure["files"]:
            raise RuntimeError("STRICT_ACTUAL_COMPILER_INPUT_CLOSURE_CHANGED")
        return [entry["path"] for entry in current]

    paths = {relative_source(entry["path"]) for entry in historical["sourceFiles"]
        if entry["path"] != retired_path}
    paths.update(targets)
    tracked = assert_strict_custody()
    paths.update(tracked)
    extra = {
        "scope-postz/w1-economic-orchestration/native/qualify-read-custody.py",
        "scope-postz/w1-economic-orchestration/native/register-read-custody.py",
        "scope-postz/w1-economic-orchestration/native/qualify-owner-types.py",
        "scope-postz/w1-economic-orchestration/native/with-resources.py",
        "scope-postz/w1-economic-orchestration/native/helper-supplement-failure-contract-v1.md",
        "scope-postz/w1-economic-orchestration/native/completion-failure-contract-v1.md",
        "scope-postz/w1-economic-orchestration/evidence/review-cleanup-preflight-0001.json",
        "scope-postz/w1-economic-orchestration/native/custody-parent-review-failure-contract.md",
        "scope-postz/w1-economic-orchestration/native/custody-review-owning-interleavings.md",
        "scope-postz/w1-economic-orchestration/native/custody-candidate-0012-failure.md",
        "scope-postz/w1-economic-orchestration/native/custody-candidate-0013-observer-failure.md",
        "scope-postz/w1-economic-orchestration/native/custody-candidate-0014-source-lock-failure.md",
        "scope-postz/w1-economic-orchestration/native/custody-candidate-0015-deadline-observation-failure.md",
        "scope-postz/w1-economic-orchestration/native/custody-candidate-0016-negative-envelope-oracle-failure.md",
        "scope-postz/w1-economic-orchestration/native/custody-candidate-0017-unavailable-query-oracle-failure.md",
        "scope-postz/w1-economic-orchestration/native/custody-candidate-0018-complete-oracle-failure.md",
        "scope-postz/w1-economic-orchestration/native/custody-candidate-0019-numeric-literal-failure.md",
        "scope-postz/w1-economic-orchestration/integration-proposals/custody-0018-oracle-diagnosis-v1/diagnostic-report.md",
        "scope-postz/w1-economic-orchestration/native-integrated-tsconfig.json",
        "scope-postz/w1-economic-orchestration/read-tsconfig.json",
        "scope-postz/w1-economic-orchestration/read-http-verification-v4.json",
    }
    paths.update(extra)
    entries = []
    for target in sorted(paths):
        path = root / target
        if not path.is_file():
            raise RuntimeError("Declared source disappeared: " + target)
        entries.append({"path": target, "bytes": path.stat().st_size, "sha256": sha(path)})
    inventory = {entry["path"]: entry for entry in entries}
    digest = hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    copies = {relative_source(path) for path in historical["retainedSourceCopies"]} | set(targets) | extra
    copies.discard(retired_path)
    copies.update(path for path in tracked if path.startswith("finnor-os/scripts/postz-w1/"))
    copy_bytes = sum((root / path).stat().st_size for path in copies)
    available = shutil.disk_usage(root).free
    if available < copy_bytes + 512 * 1024**2 + 1024**3:
        raise RuntimeError("DISPOSABLE_OWNING_RUN_STORAGE_RESERVE_NOT_ADMITTED")
    freeze = scope / f"integration-proposals/read-custody-{tag}-source-freeze"
    candidate = proposal / f"candidate-{tag}"
    evidence = scope / f"evidence/reads-native/http-{tag}-custody-candidate"
    registration_path = scope / f"native/review-read-custody-candidate-{tag}-registration.json"
    if any(path.exists() for path in (freeze, candidate, evidence, registration_path,
            Path(str(evidence) + ".qualification.json"))):
        raise RuntimeError("NEW_EXCLUSIVE_CANDIDATE_PATHS_REQUIRED")
    freeze.mkdir()
    for target in sorted(copies):
        destination = freeze / target
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / target, destination)
        if sha(destination) != inventory[target]["sha256"] or destination.stat().st_size != inventory[target]["bytes"]:
            raise RuntimeError("Source copy mismatch: " + target)

    def assert_frozen_inventory():
        for entry in entries:
            path = root / entry["path"]
            if not path.is_file() or path.stat().st_size != entry["bytes"] or sha(path) != entry["sha256"]:
                raise RuntimeError("Live source inventory mismatch: " + entry["path"])
        for target in copies:
            path = freeze / target
            if not path.is_file() or path.stat().st_size != inventory[target]["bytes"] or sha(path) != inventory[target]["sha256"]:
                raise RuntimeError("Retained source inventory mismatch: " + target)
        assert_strict_custody()

    assert_frozen_inventory()
    candidate.mkdir()
    manifest = {
        "schema": "finnor.w1.parent-custody-candidate.v1", "at": datetime.now(timezone.utc).isoformat(),
        "state": "INSTALLED_UNQUALIFIED",
        "retiredHistoricalSources": [{"originalIdentity": retired[0],
            "reason": "Accepted additions:F15 forwarding-only leaf removal; reader uses the canonical shared owner",
            "canonicalOwner": "finnor-os/packages/shared-types/src/economic-reads.ts"}],
        "originalProposalManifestSha256": sha(scope / "integration-proposals/objective-read-custody-v1/manifest.json"),
        "pass2DecisionsSha256": sha(scope / "reviews/0002/pass2/decisions.json"),
        "parentPreimagesSha256": sha(proposal / "preimages.json"),
        "preimageSupplements": [{"path": name, "sha256": sha(proposal / name)}
            for name in ("preimage-supplement-001.json", *supplemental_targets)],
        "files": [{"target": target, "beforeSha256": entry.get("beforeSha256"),
            "afterSha256": inventory[target]["sha256"], "bytes": inventory[target]["bytes"],
            "copy": str((freeze / target).relative_to(root)),
            "changed": entry.get("beforeSha256") != inventory[target]["sha256"]}
            for target, entry in sorted(targets.items())],
        "rejectedGenericFrontierDraftRestored": unchanged,
        "failureContracts": [{"path": target, "sha256": sha(root / target)}
            for target in sorted(extra) if target.endswith(".md")],
        "owningQualification": "NOT_RUN", "fullW001W060": "NOT_RUN",
    }
    exclusive_json(candidate / "manifest.json", manifest)
    registration = {
        "schema": "finnor.w1.read-custody-candidate-registration.v1",
        "registeredAt": datetime.now(timezone.utc).isoformat(), "state": "NOT_RUN",
        "productionInstalled": True, "productionQualified": False,
        "retiredHistoricalSources": manifest["retiredHistoricalSources"],
        "base": subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip(),
        "sourceFiles": entries, "sourceSubsetSha256": digest,
        "sourceDigestCanonicalization": "sha256(JSON UTF-8, sort_keys=True, separators=(',', ':'), sourceFiles ordered by path)",
        "sourceFreeze": str(freeze.relative_to(scope)), "retainedSourceCopies": sorted(copies),
        "candidateManifest": str((candidate / "manifest.json").relative_to(scope)),
        "candidateManifestSha256": sha(candidate / "manifest.json"),
        "command": ["/tmp/finnor-w1-native-python-82969ba5/bin/python",
            str(scope / "native/qualify-read-custody.py"), str(evidence)],
        "combinedLimitSeconds": 1200, "requiredPredicates": 65, "originalPredicatesPreserved": 47,
        "actualNativeSetupCount": 34, "noProductionEditsDuringExecution": True,
        "noNewLLMRole": False, "noNewProductLLMRole": True,
        "engineeringLLMDisclosure": "Review roles exist outside the product episode; global no-new-role or zero-cost conformance is not claimed.",
        "scriptedProposalsNotFinancialOutcomes": True, "expectedMigrations": 235,
        "priorFailedBaselines": ["http-0010-custody-baseline", "http-0011-custody-baseline"],
        "priorFailedCandidates": ["http-0012-custody-candidate", "http-0013-custody-candidate", "http-0014-custody-candidate",
            "http-0015-custody-candidate", "http-0016-custody-candidate", "http-0017-custody-candidate",
            "http-0018-custody-candidate", "http-0019-custody-candidate"],
        "retainedOwningFailures": ["evidence/reads-native/http-0012-custody-candidate/parent-checkpoint.json",
            "evidence/reads-native/http-0013-custody-candidate/parent-checkpoint.json",
            "evidence/reads-native/http-0014-custody-candidate/parent-checkpoint.json",
            "evidence/reads-native/http-0015-custody-candidate/parent-checkpoint.json",
            "evidence/reads-native/http-0016-custody-candidate/parent-checkpoint.json",
            "evidence/reads-native/http-0017-custody-candidate/parent-checkpoint.json",
            "evidence/reads-native/http-0018-custody-candidate/parent-checkpoint.json",
            "evidence/reads-native/http-0019-custody-candidate/parent-checkpoint.json",
            "evidence/reads-native/http-0019-custody-candidate/parent-checkpoint-supplement-001.json"],
        "strictTypecheck": strict["log"],
        "strictTypecheckSha256": strict["logSha256"],
        "strictTypecheckReceipt": strict_path,
        "strictTypecheckReceiptSha256": sha(root / strict_path),
        "postTypecheckChange": "All watched owner sources and actual compiler input closure revalidated before publication.",
        "canonicalLogs": [{"path": "evidence/" + name, "sha256": sha(scope / "evidence" / name)} for name in (
            "custody-0015-bundle-generation.log", "custody-0015-bundle-repeat.json",
            "custody-0015-openapi-generation.log", "custody-0015-client-generation.log",
            "custody-0015-authz-check.log", "custody-0015-manifest-generation.log")],
        "canonicalCheckLogs": [{"path": "evidence/" + name, "sha256": sha(scope / "evidence" / name)} for name in (
            "custody-0015-authz-check.log", "custody-0015-client-check.log", "custody-0015-manifest-check.log")],
        "resourcePreflight": {"availableBytesBeforeCopies": available, "snapshotBytes": copy_bytes,
            "fixtureCapacityReserveBytes": 1024**3, "fixtureWorkingAllowanceBytes": 512 * 1024**2,
            "freshInstallation": False, "completeDescendantUsage": "UNKNOWN",
            "billingUSD": None, "humanSeconds": None, "missingCostIsZero": False},
        "qualification": "Disposable owning signed HTTP/Core/native/queue custody only; no phase, admission, activation, field, comparison, or economics claim",
        "browser": "STOPPED_NO_LATER_VISIBILITY_CONFIRMATION", "coldReconstruction": "NOT_RUN",
        "physicalRecovery": "NOT_RUN", "fullW001W060": "NOT_RUN",
    }
    assert_frozen_inventory()
    exclusive_json(registration_path, registration)
    print(json.dumps({"registration": str(registration_path.relative_to(root)),
        "registrationSha256": sha(registration_path), "sourceCount": len(entries),
        "copyCount": len(copies), "snapshotBytes": copy_bytes, "sourceSubsetSha256": digest,
        "candidateTargets": len(targets), "availableBytesAfterCopies": shutil.disk_usage(root).free,
        "status": "REGISTERED_NOT_RUN"}))


if __name__ == "__main__":
    main()
