"""Finite original-input process E2E; real native owner proof is separate."""
import argparse
import copy
from fractions import Fraction as F
import hashlib
import importlib.util
import itertools
import json
from pathlib import Path
import subprocess
import sys
import time


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--evidence-dir", required=True)
    parser.add_argument("--family", type=int, action="append")
    parser.add_argument("--cases", type=int, default=8)
    parser.add_argument("--budget-ms", type=int, default=20000)
    parser.add_argument("--qualification-registration", type=Path)
    parser.add_argument("--reference-root", type=Path)
    parser.add_argument("--critical-expectations", type=Path)
    args = parser.parse_args()
    if not 1 <= args.cases <= 8 or not 1 <= args.budget_ms <= 120000:
        parser.error("--cases must be 1..8 and --budget-ms must be 1..120000")
    if args.family and any(not 1 <= family <= 32 for family in args.family):
        parser.error("--family must be 1..32")
    if args.qualification_registration:
        if not args.reference_root or not args.critical_expectations:
            parser.error("qualification requires --reference-root and --critical-expectations")
        qualification = load("z2_fresh_original_qualification",
                             Path(__file__).with_name("structural-qualification.py"))
        return qualification.run(args)
    if args.reference_root or args.critical_expectations:
        parser.error("--reference-root and --critical-expectations require --qualification-registration")
    repo, out = Path(args.repo).resolve(), Path(args.evidence_dir).resolve()
    out.mkdir(parents=True, exist_ok=False)
    scripts = repo/"finnor-os/scripts/project-z/z2"
    engine = repo/"finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions"
    native = repo/"finnor-os/packages/private-equity/src/interaction-synthesis"
    fixtures = load("z2_public_structures", scripts/"structural-fixtures.py")
    oracle = load("z2_independent_original_oracle", scripts/"original-oracle.py")
    equipment = load("z2_native_assessment_equipment", native/"producer.py")
    reference = load("z2_original_exhaustive_reference", native/"reference.py")
    registration = fixtures.registration()
    (out/"registration.json").write_text(json.dumps(registration, sort_keys=True, indent=2)+"\n")
    pins = {str(p.relative_to(repo)): sha(p) for directory in (engine, native, scripts)
            for p in sorted(directory.iterdir()) if p.is_file() and p.suffix in (".py", ".ts", ".json", ".mjs")}
    rows, negatives, steps = [], [], []
    started = time.monotonic()
    families = args.family or list(range(1, 33))

    def run(target, label, path, request):
        directory = target/label
        directory.mkdir()
        (directory/"input.json").write_text(json.dumps(request, sort_keys=True)+"\n")
        begin = time.monotonic()
        try:
            child = subprocess.run(["/usr/bin/python3", "-I", "-B", str(path)],
                input=json.dumps(request), capture_output=True, text=True, timeout=args.budget_ms/1000+10,
                env={"NODE_ENV": "test", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"})
            (directory/"stdout.json").write_text(child.stdout)
            (directory/"stderr.log").write_text(child.stderr)
            value = json.loads(child.stdout)
            exit_code = child.returncode
        except (subprocess.TimeoutExpired, ValueError) as error:
            value = {"status": "HARNESS_FAILURE", "reason": type(error).__name__}
            exit_code = None
        steps.append({"id": str(directory.relative_to(out)), "command": ["/usr/bin/python3", "-I", "-B", str(path)],
                      "exitCode": exit_code, "wallMs": round(1000*(time.monotonic()-begin)),
                      "status": value.get("status"), "reason": value.get("reason")})
        return value, exit_code

    def adverse(problem):
        controls = equipment.checker.control_keys(problem)
        policy = {k: "unverified" if "unverified" in v["options"] else v["options"][0] for k, v in controls.items()}
        games = [equipment.checker.compile_original(problem, model, policy) for model in problem["models"]]
        strategy = {}
        for game in games:
            for k, info in game["infos"].items():
                preferred = next((a for a in ("withhold", "stay", "decline", "silent", "opt-out", "confirm", "left")
                                  if a in info["actionIds"]), info["actionIds"][0])
                strategy[k] = {a: str(int(a == preferred)) for a in info["actionIds"]}
        return equipment.propose(problem, games, policy, strategy, equipment.checker.objective_bound(problem))

    def check_negative(target, name, request, expected):
        value, exit_code = run(target, name, engine/"checker.py", request)
        passed = exit_code == 0 and (value.get("status"), value.get("reason")) == expected
        negatives.append({"id": str((target/name).relative_to(out)), "passed": passed,
                          "expected": list(expected), "actual": [value.get("status"), value.get("reason")]})

    for family in families:
        for case in range(args.cases):
            problem = fixtures.build(family, case)
            target = out/(str(family).zfill(2)+"-"+fixtures.NAMES[family-1]+"-"+str(case))
            target.mkdir()
            expected = "CHECKED_INFEASIBLE" if family == 30 else "CHECKED_CANDIDATE"
            row = {"family": family, "case": case, "name": fixtures.NAMES[family-1], "expected": expected, "passed": False}
            begin = time.monotonic()
            construction, producer_exit = run(target, "construct", engine/"producer.py",
                                               {"problem": problem, "budgetMs": args.budget_ms})
            checked, checker_exit = run(target, "check", engine/"checker.py",
                                        {"problem": problem, "construction": construction})
            row.update(actual=checked.get("status"), reason=checked.get("reason"),
                       producerExit=producer_exit, checkerExit=checker_exit)
            try:
                if expected == "CHECKED_CANDIDATE" and checked.get("status") == expected:
                    reports = oracle.inspect(problem, construction["candidate"])
                    (target/"independent-original-oracle.json").write_text(json.dumps(reports, indent=2)+"\n")
                    assert len(reports) == len(problem["models"])*(2**len(problem["participants"])-1)
                    assert not any(r["profitable"] for r in reports)
                    # These original routes already admit a stable all-ready
                    # equilibrium. Opt-out yields zero, not a forced defection.
                    if family not in (19, 20, 26):
                        assert "authorized" in construction["candidate"]["policy"].values()
                    exhaustive = reference.run(problem, construction["candidate"])
                    (target/"independent-continuation-reference.json").write_text(json.dumps(exhaustive, indent=2)+"\n")
                    assert all(r["maxRegret"] == "0" for r in exhaustive["models"])
                    row["passed"] = producer_exit == checker_exit == 0
                elif family == 30 and checked.get("status") == expected:
                    # Original PD table: own defection gains 1 for every fixed
                    # other action; confirmation beats withdrawal by 1. The
                    # only sequential behavior is all-defect. Joint all-ready
                    # improves both from 1 to 2 in every authorized route.
                    row["independentInfeasibilityOracle"] = {
                        "ownDefectionPointwiseGain": "1", "confirmationPointwiseGain": "1",
                        "forcedUtilities": ["1", "1"], "jointReadyUtilities": ["2", "2"],
                        "allOriginalPoliciesCovered": 2
                    }
                    assert construction["infeasibility"]["kind"] == "STRICT_DOMINANCE_EXHAUSTION"
                    row["passed"] = producer_exit == checker_exit == 0
                if case == 0 and row["passed"] and family != 30:
                    request = {"problem": copy.deepcopy(problem), "construction": copy.deepcopy(construction)}
                    request["construction"]["certificates"].pop()
                    check_negative(target, "omitted-grand-coalition", request,
                                   ("COUNTEREXAMPLE", "Z2_CERTIFICATE_COVERAGE"))
                    request = {"problem": copy.deepcopy(problem), "construction": copy.deepcopy(construction)}
                    request["problem"]["fixedOperatorRefs"][0]["version"] = "2"
                    check_negative(target, "original-operator-revision", request,
                                   ("COUNTEREXAMPLE", "Z2_CONSTRUCTION_BINDING"))
                    request = {"problem": copy.deepcopy(problem), "construction": copy.deepcopy(construction)}
                    request["problem"]["models"][0]["nodes"][0]["resources"]["capacity"] = "2"
                    changed_digest = oracle.digest(request["problem"])
                    request["construction"]["problemDigest"] = changed_digest
                    request["construction"]["candidate"]["problemDigest"] = changed_digest
                    check_negative(target, "all-history-resource-bound", request,
                                   ("COUNTEREXAMPLE", "Z2_NATIVE_FULL_Y3_FLOOR"))
                    try:
                        candidate = adverse(problem)
                    except equipment.checker.Rejected as error:
                        assert family in (14, 31)
                        (target/"ineligible-adverse-original-policy.json").write_text(json.dumps(
                            {"reason": str(error), "originalConstraintRetained": True})+"\n")
                    else:
                        floor, _ = run(target, "adverse-native-floor", native/"checker.py",
                                       {"problem": problem, "candidate": candidate})
                        if family == 27:
                            assert floor.get("status") == "REJECTED" and floor.get("reason") == "Y3_OUTSIDE_OPTION_NOT_MET"
                        elif floor.get("status") == "CHECKED":
                            adverse_reports = oracle.inspect(problem, candidate)
                            (target/"adverse-independent-oracle.json").write_text(json.dumps(adverse_reports, indent=2)+"\n")
                            if family == 19:
                                assert all(not r["profitable"] for r in adverse_reports if len(r["coalition"]) < 3)
                                assert any(r["profitable"] for r in adverse_reports if len(r["coalition"]) == 3)
                            if family == 18:
                                (target/"whole-family-outside-grid-oracle.json").write_text(
                                    json.dumps(oracle.outside_grid_report(problem, candidate), indent=2)+"\n")
                            profitable = next((r for r in adverse_reports if r["profitable"]), None)
                            if profitable:
                                witness = {"kind": "PROFITABLE_MIXTURE", "modelId": profitable["modelId"],
                                           "coalition": profitable["coalition"], **profitable["profitable"]}
                                raw = {"schema": "finnor.project-z.z2.construction.v1", "status": "CANDIDATE",
                                       "problemDigest": oracle.digest(problem), "profileDigest": sha(engine/"profile.json"),
                                       "candidate": candidate, "certificates": [], "counterstrategy": witness}
                                check_negative(target, "original-correlated-witness",
                                    {"problem": problem, "construction": raw},
                                    ("COUNTEREXAMPLE", "Z2_CHECKED_PROFITABLE_CORRELATED_MIXTURE"))
                                forged = copy.deepcopy(raw)
                                forged["counterstrategy"]["terms"][0]["plan"]["I:pooled-other-private-state"] = "ready"
                                check_negative(target, "private-pooling-forged-plan",
                                    {"problem": problem, "construction": forged},
                                    ("COUNTEREXAMPLE", "Z2_LOCAL_PLAN_DOMAIN"))
                            else:
                                row["adverseCoalitionOracle"] = "NO_PROFITABLE_MIXTURE_ORIGINAL_VARIANT"
                        else:
                            row["adverseFloorDisposition"] = floor.get("reason")
                if family in (21, 22):
                    for model in problem["models"]:
                        for node in model["nodes"]:
                            assert sum(map(F, node["payments"])) == 0
                            assert all(abs(F(v)) <= F(limit["value"]) for v, limit in
                                       zip(node["payments"], problem["financialLimits"]["absolutePayments"]))
                    row["legalTransfersRetained"] = True
            except (AssertionError, KeyError, ValueError) as error:
                row.update(passed=False, oracleFailure=type(error).__name__, oracleDetail=str(error)[:160])
            row["wallMs"] = round(1000*(time.monotonic()-begin))
            rows.append(row)
            (out/"progress.json").write_text(json.dumps({"cases": rows, "negatives": negatives}, indent=2)+"\n")
    unchanged = all(sha(repo/path) == value for path, value in pins.items())
    useful = [r for r in rows if r["expected"] == "CHECKED_CANDIDATE"]
    report = {
        "schema": "finnor.project-z.z2.public-structural-process-replay.v1", "cases": rows,
        "negatives": negatives, "passed": sum(r["passed"] for r in rows), "failed": sum(not r["passed"] for r in rows),
        "criticalNegativeFailures": sum(not r["passed"] for r in negatives),
        "usefulSupportedPositiveCount": len(useful), "usefulSupportedPositivePassed": sum(r["passed"] for r in useful),
        "sourceUnchanged": unchanged, "sourceHashes": pins, "steps": steps,
        "registeredFamilyLabels": registration["familyCount"], "structuralFamiliesQualified": None,
        "structuralQualification": "NOT_ESTABLISHED_BY_PASSING_PROCESS_ROWS",
        "familiesExercised": families, "freshCasesPerFamilyRequested": args.cases,
        "scope": "PUBLIC_EXACT_PROCESS_ENGINEERING_NOT_NATIVE_OR_PROTECTED_QUALIFICATION",
        "nativeEightObligationCoverage": {
            "usefulPositive": "PROCESS_ONLY", "alternatePositive": "PROCESS_ONLY",
            "counterstrategy": "PER_FAMILY_OBSERVED_DISPOSITIONS", "infeasibility": "FAMILY_30_COMPLETE_PLUS_EXISTING_BOUND_CASES",
            "localInformationMutation": "PROCESS_ONLY", "currentnessRevision": "PROCESS_BINDING_ONLY",
            "resourceArithmetic": "PROCESS_ONLY", "physicalNativeRecovery": "NOT_RUN_AUTHORITY_REQUIRED"
        },
        "wallMs": round(1000*(time.monotonic()-started)), "moneyUsd": None, "humanSeconds": None,
        "aggregatePeakMemoryBytes": None, "costStatus": "PARTIALLY_METERED",
        "authenticatedOwner": "NOT_RUN", "nativePhysicalRecovery": "NOT_RUN", "mountedWork": "NOT_RUN",
        "protectedAdmission": False, "equippedIncrement": "NOT_RUN", "financialQualification": "NOT_RUN"
    }
    (out/"report.json").write_text(json.dumps(report, sort_keys=True, indent=2)+"\n")
    inventory = {str(p.relative_to(out)): sha(p) for p in sorted(out.rglob("*")) if p.is_file()}
    (out/"sha256.json").write_text(json.dumps(inventory, sort_keys=True, indent=2)+"\n")
    print(json.dumps({k: report[k] for k in ("passed", "failed", "criticalNegativeFailures", "sourceUnchanged", "wallMs")}))
    return int(bool(report["failed"] or report["criticalNegativeFailures"] or not unchanged))


if __name__ == "__main__":
    raise SystemExit(main())
