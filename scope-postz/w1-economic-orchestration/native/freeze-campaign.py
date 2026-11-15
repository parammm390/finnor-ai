"""Bind all sixty original PRD identities to executable W1 slices and gaps."""
from datetime import datetime, timezone
import argparse
from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from campaign_runtime import host_facts, load_config, locked_vendor_assets, runtime_asset_population

ROOT = Path(__file__).resolve().parents[3]
SCOPE = ROOT / "scope-postz/w1-economic-orchestration"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, value):
    with path.open("x") as out:
        out.write(json.dumps(value, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("epoch")
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--check-config", action="store_true")
    args = parser.parse_args()
    epoch = args.epoch
    assert re.fullmatch(r"\d{4}", epoch)
    config = load_config(args.config, ROOT)
    PRD = config.requirements.path
    host = host_facts(ROOT)
    workspace_host = host_facts(config.workspaceParent)
    forecast = max(config.stageForecastBytes.values())
    capacity_available = all(facts["filesystem"]["freeBytes"] >= config.resourcePolicy.globalDiskFloorBytes + forecast
        for facts in (host, workspace_host))
    memory_available = host["memory"]["totalBytes"] >= config.resourcePolicy.minimumAvailableMemoryBytes
    if args.check_config:
        print(json.dumps({"status": "CONFIG_VALIDATED_CAPACITY_AVAILABLE" if capacity_available and memory_available else
            "CONFIG_VALIDATED_CAPACITY_NOT_AVAILABLE", "configurationSha256": config.digest,
            "host": host, "workspaceHost": workspace_host, "largestStageForecastBytes": forecast,
            "globalDiskFloorBytes": config.resourcePolicy.globalDiskFloorBytes,
            "campaignExecuted": False, "allOwningAndColdGates": "NOT_RUN"}))
        return 0 if capacity_available and memory_available else 1
    assert capacity_available and memory_available, "FROZEN_COMPLETE_CAMPAIGN_CAPACITY_UNAVAILABLE"
    plan_path = SCOPE / ("native/campaign-" + epoch + ".json")
    assert not plan_path.exists()
    tag = "campaign-" + epoch
    evidence = SCOPE / "evidence" / tag
    assert not evidence.exists()
    native = SCOPE / "native"
    python = config.runtimes["python"].path
    node = config.runtimes["node"].path
    loader = ROOT / "finnor-os/node_modules/tsx/dist/loader.mjs"
    backend = ROOT / "finnor-os"
    dirty = subprocess.check_output(["git", "-C", str(ROOT), "status", "--porcelain"], text=True)
    assert not dirty, "COMMIT_REVIEWED_HARNESS_AND_INPUTS_BEFORE_FREEZE"
    paths = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "--",
        "finnor-os/packages", "finnor-os/apps", "finnor-os/scripts", "src", "public", "scripts", "infra", "vendor",
        "scope-postz/w1-economic-orchestration/native",
        "scope-postz/w1-economic-orchestration/handoff"], text=True).splitlines()
    files = {path for path in paths if (ROOT / path).is_file()
             and not any(part in {"node_modules", "dist", ".next", "__pycache__", "integration-proposals",
                                  "continuation-v5", "evidence"} for part in Path(path).parts)
             and not any(part == ".env" or part.startswith(".env.") for part in Path(path).parts)
             and not re.search(r"/(?:bootstrap|review|campaign)-.*(?:registration|\.json$)", path)}
    for path in ("AGENTS.md", "package.json", "package-lock.json", "next.config.mjs", "tsconfig.json",
                 "finnor-os/package.json", "finnor-os/package-lock.json", "finnor-os/tsconfig.json", "finnor-os/Dockerfile.worker",
                 "finnor-os/scripts/r3/upstream-requirements.in",
                 "finnor-os/tsconfig.base.json", "scope-postz/w1-economic-orchestration/read-tsconfig.json",
                 "scope-postz/w1-economic-orchestration/native-integrated-tsconfig.json",
                 "scope-postz/w1-economic-orchestration/native/completion-failure-contract-v1.md",
                 "scope-postz/w1-economic-orchestration/native/campaign-continuation-budget-contract-v1.md",
                 "scope-postz/w1-economic-orchestration/native/headed-built-mount-contract-v2.md",
                 "scope-postz/w1-economic-orchestration/native/internal-nine-failure-contract-v1.md",
                 "scope-postz/w1-economic-orchestration/native/native-capability-source-contract-v1.md",
                 "scope-postz/w1-economic-orchestration/native/portable-campaign-failure-contract-v1.md",
                 "scope-postz/w1-economic-orchestration/handoff/installed-cold-contract-v1.md",
                 "scope-postz/w1-economic-orchestration/handoff/README.md"):
        files.add(path)
    files.update(str(path.relative_to(ROOT)) for path in (ROOT / config.structuralInputs).glob("*.json"))
    files.update(locked_vendor_assets(ROOT))
    for pair in config.recoveryPairs:
        files.update((pair.target, pair.brokenSource, pair.contract))
    source_files = [{"path": path, "bytes": (ROOT / path).stat().st_size, "sha256": sha(ROOT / path)}
                    for path in sorted(files)]
    runtimes = {name: pin.record() for name, pin in config.runtimes.items()}
    for name, pin in config.runtimes.items():
        command = [str(node), str(pin.path), "--version"] if name == "npmCli" else [str(pin.path), "--version"]
        runtimes[name]["version"] = subprocess.check_output(command, text=True, timeout=15).strip()
    npm_root = config.runtimes["npmCli"].path.resolve(strict=True).parents[1]
    assert json.loads((npm_root / "package.json").read_text())["name"] == "npm", "ACTUAL_NPM_DISTRIBUTION_REQUIRED"
    runtimes["npmCli"].update(distributionRoot=str(npm_root), assets=runtime_asset_population(npm_root))
    scientific_path = native / (tag + "-scientific-runtime.json")
    subprocess.run([str(python), "-I", "-B", str(SCOPE / "handoff/attest-scientific-runtime.py"),
        "--python", str(python), "--lock", str(backend / "scripts/r3/upstream-requirements.lock"),
        "--expected", str(config.scientificAttestation.path), "--output", str(scientific_path)], check=True, timeout=120)
    numerical = json.loads(scientific_path.read_text())
    assert numerical["status"] == "PASS", "COMPLETE_CURRENT_SCIENTIFIC_RUNTIME_REQUIRED"
    runtimes["python"].update(scientificAttestationPath=str(scientific_path), scientificAttestationSha256=sha(scientific_path),
        baseAssetPopulationSha256=hashlib.sha256(json.dumps(numerical["baseAssets"], sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        environmentAssetPopulationSha256=hashlib.sha256(json.dumps(numerical["environmentAssets"], sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        completeBaseDistributionAttestation=numerical["completeBaseDistributionAttestation"],
        numericalEnvironment={"identity": numerical["identity"], "observedDistributions": numerical["observedDistributions"],
            "lockSha256": numerical["lockSha256"]})
    cli, chrome = (config.runtimes[name].path for name in ("agentBrowser", "chrome"))
    runtimes["chrome"]["completeBrowserImageAttestation"] = "NOT_ESTABLISHED"
    tool = lambda name: str(backend / "scripts/postz-w1" / name)
    tsx = lambda name, *args: [str(node), "--import=" + tool("read-network-guard.mjs"),
                             "--import=" + str(loader), tool(name), *map(str, args)]
    stages = []
    def stage(identity, command, report, status, *, heavy=False, limit=None, count=None, phase="base", families=None, forecast=None):
        stages.append({"id": identity, "phase": phase, "command": command, "cwd": str(ROOT),
                       "heavy": heavy, "timeoutSeconds": limit if limit is not None else config.limits["fastSeconds"],
                       "forecastBytes": config.stageForecastBytes[forecast or ("heavy" if heavy else "fast")],
                       "reportGlob": str(report), "requiredStatus": status, "requiredCount": count,
                       "requiredFamilyIds": families,
                       "evidenceLog": str(evidence / (identity + ".log")),
                       "resourceReceipt": str(evidence / (identity + ".resources.json"))})
    stage("types", [str(python), str(native / "qualify-owner-types.py"), str(42 + int(epoch) - 1)],
          SCOPE / f"evidence/native-integrated-typecheck-{42 + int(epoch) - 1:04d}.json", None, heavy=True)
    stage("exact", tsx("run-exact.mts", evidence / "exact"), evidence / "exact/run-*.json", None, count=32)
    stage("response", tsx("run-response.mts", evidence / "response"), evidence / "response/run-*.json", None, count=20)
    stage("legacy-mechanics", tsx("native-mechanics.mts", evidence / "legacy-mechanics"),
          evidence / "legacy-mechanics/native-mechanics.json", None, count=8)
    stage("continuation", tsx("native-continuation-mechanics.mts", evidence / "continuation"),
          evidence / "continuation/mechanics.json", None, count=16)
    stage("structural", tsx("run-structural.mts", ROOT / config.structuralInputs, evidence / "structural"),
          evidence / "structural/results.json", "PASS_LOCAL_MECHANISM", count=128)
    stage("reads", [str(python), str(native / "qualify-read-custody.py"), str(evidence / "reads")],
          evidence / "reads.qualification.json", "PASS_LOCAL", heavy=True, limit=config.limits["integrationSeconds"])
    registration_path = native / (tag + "-native-registration.json")
    registration = {"sourceFiles": source_files, "nativeOracleSha256": sha(Path(tool("native-oracle.py"))),
        "environment": {"FINNOR_TEST_NODE": str(node), "FINNOR_TEST_PYTHON": str(python)},
        "migrationNames": sorted(path.name for path in (backend / "packages/db/migrations").glob("*.sql")),
        "command": [str(python), tool("native-run.py"), str(evidence / "native")],
        "engineeringReviewConcurrency": {"newExternalLLMCalls": 0, "modelEffortAttestation": "NOT_INFERRED_FROM_REQUEST"}}
    write(registration_path, registration)
    stage("native", [str(python), str(native / "qualify-native-current.py"), str(registration_path)],
          evidence / "native.parent-gate.json", "PASS_CONTROLLED_NATIVE_CURRENT_REGISTERED_CUT",
          heavy=True, limit=330)
    stage("owning-source", [str(python), tool("owning-suite-run.py"), str(evidence / "owning-source")],
          evidence / "owning-source/owning-suite-runner-receipt.json", "PASS_LOCAL_OWNING_SOURCE_SUITE",
          heavy=True, limit=config.limits["integrationSeconds"])
    for identity, mode, families in [
        ("internal-research-standing", "internal-read-standing", ["W003", "W012", "W013", "W004"]),
        ("internal-pressure", "internal-pressure", ["W006", "W015"]),
        ("internal-revocation", "internal-revocation", ["W007"]),
        ("internal-sequential", "internal-sequential", ["W011"]),
        ("internal-drift", "internal-drift", ["W014"])]:
        stage(identity, [str(python), tool("owning-suite-run.py"), str(evidence / identity), "--mode", mode],
              evidence / identity / "owning-suite-runner-receipt.json", "PASS_LOCAL_INTERNAL_OWNING_GROUP",
              heavy=True, limit=config.limits["integrationSeconds"], count=len(families), families=families)
    pairs = [dict(asdict(pair), repairedSha256=sha(ROOT / pair.target)) for pair in config.recoveryPairs]
    stage("recovery-pairs", [str(python), str(native / "run-current-recovery-pairs.py"), str(plan_path),
                             str(evidence / "recovery-pairs")],
          evidence / "recovery-pairs/results.json", "PASS_LOCAL_CURRENT_PAIRED_RECOVERY", heavy=True,
          limit=config.limits["recoveryPairSeconds"])
    stage("on-off", [str(python), tool("comparison-run.py"), str(evidence / "on-off")],
          evidence / "on-off/comparison-runner-receipt.json", "PASS_LOCAL_NATIVE_DIAGNOSTIC",
          heavy=True, limit=config.limits["integrationSeconds"], phase="on-off")
    stage("mounted", [str(python), tool("headed-mounted-run.py"), str(evidence / "mounted")],
          evidence / "mounted/headed-mounted-runner-receipt.json", "PASS_LOCAL_HEADED_BUILT_MOUNTED",
          heavy=True, limit=config.limits["integrationSeconds"], count=12, phase="mounted")
    for identity, mode, status, seconds in [
        ("emitted-owning", "emitted", "PASS_LOCAL_EMITTED_HANDOFF", config.limits["emittedSeconds"]),
        ("cold-owning", "cold", "PASS_LOCAL_COLD_HANDOFF", config.limits["coldSeconds"]),
        ("seal", "seal", "SEALED_LOCAL_W1_INTERNAL_EVIDENCE", config.limits["sealSeconds"])]:
        stage(identity, [str(python), str(native / "run-handoff-stage.py"), str(plan_path),
                        str(evidence / identity), "--stage", mode],
              evidence / identity / "results.json", status, heavy=True, limit=seconds,
              forecast=mode,
              phase="seal" if mode == "seal" else "handoff")
    mappings = {
        1: (["reads"], None), 2: (["reads"], None),
        3: (["internal-research-standing"], None),
        4: (["reads", "internal-research-standing"], None),
        5: (["reads", "native"], None),
        6: (["owning-source", "internal-pressure", "recovery-pairs"], None),
        7: (["reads", "native", "owning-source", "internal-revocation", "recovery-pairs"], None),
        8: (["reads", "exact"], None), 9: (["exact", "structural"], None),
        10: (["exact", "continuation", "native"], None),
        11: (["on-off", "owning-source", "internal-sequential"], None),
        12: (["internal-research-standing"], None),
        13: (["response", "continuation", "internal-research-standing"], None),
        14: (["response", "legacy-mechanics", "continuation", "native", "internal-drift"], None),
        15: (["owning-source", "internal-pressure"], None),
        16: (["recovery-pairs"], None),
        49: (["native"], "PEER_INTEGRATION_REQUIRED: no five-output unseen-company journey in this W1-only source cut"),
        50: (["reads", "native"], "PEER_INTEGRATION_REQUIRED: no complete five-output independent-company transfer in this W1-only source cut"),
        51: (["recovery-pairs"], None),
        52: (["mounted"], None),
        53: (["emitted-owning", "cold-owning"], None),
        54: ([], "COMPARATIVE_NOT_RUN: independently qualified runnable completed-Z and equipped category comparators"),
        55: (["on-off"], "PROGRAMME_COMPARISON_NOT_RUN: actual W1 ablation is a diagnostic slice, not five ablations/all-new-engines-off"),
        56: ([], "COMPARATIVE_NOT_RUN: independent business population, 30 institution/period blocks and simultaneous 100x capacity bounds"),
        57: ([], "COMPARATIVE_NOT_RUN: actual equipped competitor cohort and simultaneous 10x bounds with difficult-task floors"),
        58: ([], "ECONOMIC_NOT_RUN: independent frozen actual revenue/tax/entity/calendar/full-cost reconciliation"),
        59: ([], "ECONOMIC_NOT_RUN: registered actual counterfactual/horizon and attributable revenue/after-tax net-profit evidence"),
        60: ([], "ECONOMIC_NOT_RUN: inherited original S7 H0/H1/H2 owner-value/downside/reach protocol and actual mature observations"),
    }
    rows = []
    for line in PRD.read_text().splitlines():
        if not re.match(r"^\| W\d{3} \|", line):
            continue
        identity, owner, decisive, retained, level = [part.strip() for part in line.strip("|").split("|")]
        number = int(identity[1:])
        selected, gap = mappings.get(number, ([], "PEER_" + owner + "_NOT_RUN_IN_W1_SOURCE_CUT"))
        rows.append({"id": identity, "governingOwner": owner, "originalDecisiveCase": decisive,
                     "originalRequiredEvidence": retained, "evidenceLevel": level, "status": "NOT_RUN",
                     "scopeParameterization": "W1_CHANGED_BOUNDARY_ONLY" if number < 17 or number in (49, 50, 51, 52, 53, 55) else "ORIGINAL_OTHER_OWNER_OR_EXTERNAL_GATE",
                     "stages": selected, "gap": gap,
                     "wholeFamilyPassAllowed": gap is None,
                     "guidedContinuation": {"owner": owner, "requiredEvidence": retained,
                         "nextAction": gap or "Execute the bound commands and mandatory independent oracle on this exact cut",
                         "noExternalContactOrPublicationAuthorized": True}})
    assert [row["id"] for row in rows] == [f"W{n:03d}" for n in range(1, 61)]
    migration_names = sorted(path.name for path in (backend / "packages/db/migrations").glob("*.sql"))
    plan = {"schema": "finnor.postz.w1.verification-plan.v2", "state": "FROZEN_EXECUTABLE_W1_SCOPED_NOT_COMPLETE",
            "registeredAt": datetime.now(timezone.utc).isoformat(),
            "sourceCommit": subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip(),
            "sourceTree": subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD^{tree}"], text=True).strip(),
            "requirementsPath": str(PRD), "requirementsSha256": sha(PRD), "caseIdentitySource": "PRD section 9.4",
            "sourceFiles": source_files, "runtimes": runtimes,
            "runtimeConfiguration": {"path": str(config.path), "sha256": config.digest},
            "resourcePolicy": config.resourcePolicy.record(),
            "hostAtFreeze": host, "workspaceHostAtFreeze": workspace_host,
            "engineeringCapacityBasis": config.engineeringCapacityBasis,
            "lockedVendorAssets": [{"path": name, "sha256": sha(ROOT / name)} for name in locked_vendor_assets(ROOT)],
            "privateCustody": {"root": str(config.privateCustodyRoot), "controlSidecar": config.controlSidecar.record(),
                "neverPublicEvidenceOrColdDependencyInputs": True},
            "failureContracts": {str(path.relative_to(ROOT)): sha(path) for path in (
                native / "completion-failure-contract-v1.md",
                native / "campaign-continuation-budget-contract-v1.md",
                native / "headed-built-mount-contract-v2.md",
                native / "internal-nine-failure-contract-v1.md",
                native / "native-capability-source-contract-v1.md",
                native / "portable-campaign-failure-contract-v1.md",
                SCOPE / "handoff/installed-cold-contract-v1.md")},
            "migrationCount": len(migration_names), "migrationNames": migration_names,
            "migrationBundleSha256": sha(backend / "packages/db/migrations-bundle.ts"),
            "locks": {path: sha(ROOT / path) for path in ("package-lock.json", "finnor-os/package-lock.json")},
            "stages": stages, "recoveryPairs": pairs, "cases": rows, "evidence": str(evidence),
            "internalDevelopmentStages": [row["id"] for row in stages if row["id"] != "seal"],
            "internalNine": ["W003", "W004", "W006", "W007", "W011", "W012", "W013", "W014", "W015"],
            "handoff": {"workspace": str(config.workspaceParent / ("finnor-w1-handoff-" + tag)),
                "uv": str(config.runtimes["uv"].path), "npmCli": str(config.runtimes["npmCli"].path),
                "packageCaches": {name: str(path) for name, path in config.packageCaches.items()},
                "requestedScrutinyModel": "gpt-6.1-sol", "requestedScrutinyEffort": "max",
                "actualModelAttestationNotInferredFromSelection": True},
            "environment": {"FINNOR_TEST_NODE": str(node), "FINNOR_TEST_PYTHON": str(python),
                "FINNOR_AGENT_BROWSER": str(cli), "FINNOR_W1_CHROME": str(chrome),
                "NODE_OPTIONS": "--max-old-space-size=" + str(config.limits["nodeHeapMiB"]), "NODE_ENV": "test", "CI": "1",
                "PYTHONDONTWRITEBYTECODE": "1",
                "FINNOR_TEST_MANAGED_EXTENSIONS": "omit"},
            "secureConfiguration": "Ephemeral loopback auth/database role bindings created only by retained disposable bootstrap; no external credentials",
            "limits": {**config.limits,
                "sharedHostMemoryBytes": host["memory"]["totalBytes"],
                "globalDiskFloorBytes": config.resourcePolicy.globalDiskFloorBytes,
                "laneNetNewBudgetBytes": config.resourcePolicy.laneNetNewBudgetBytes,
                "diskBeforeBytes": host["filesystem"]["freeBytes"],
                "paidRuntimeProviderCalls": 0, "realHumanContacts": 0, "realExternalEffects": 0},
            "structuralPopulation": {"families": 16, "freshCasesPerFamily": 8,
                "inputs": str(ROOT / config.structuralInputs / "inputs.json"),
                "inputsSha256": sha(ROOT / config.structuralInputs / "inputs.json"), "protectedCustody": False,
                "scope": "FINITE_MODEL_MECHANISM_NOT_EMPIRICAL_NATIVE_OR_DOMAIN_QUALIFICATION"},
            "rerunRule": "Retain every failure unchanged; diagnose before a third identical failure; new source/driver bytes require a new frozen epoch; no deadline/floor/oracle relaxation",
            "gates": {key: "NOT_ESTABLISHED" for key in ("CODE_COMPLETE", "E2E_DEV_VERIFIED", "DOMAIN_QUALIFIED",
                "ADMITTED", "PRODUCTION_ACTIVE", "FIELD_VALIDATED")},
            "billingUSD": None, "engineeringHumanSeconds": None, "completeDescendantUsage": None,
            "missingCostIsZero": False}
    write(plan_path, plan)
    previous = SCOPE / "verification-plan.json"
    if previous.exists():
        (native / (tag + "-prior-verification-plan.json")).write_bytes(previous.read_bytes())
        previous.write_text(json.dumps(plan, indent=2) + "\n")
    print(json.dumps({"plan": str(plan_path), "caseCount": len(rows), "sourceCount": len(source_files),
                      "stages": [stage["id"] for stage in stages],
                      "internalWholeFamilyGaps": [row["id"] for row in rows if (row["gap"] or "").startswith("INTERNAL")]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
