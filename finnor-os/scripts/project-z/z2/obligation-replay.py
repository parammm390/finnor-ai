"""Eight explicit public obligations per original family, with native gaps visible.

This drives real producer/checker subprocesses. It does not simulate native
transactions, authentication, physical worker recovery, or protected custody.
"""
import argparse
import copy
from fractions import Fraction as F
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import time


OBLIGATIONS = [
    "USEFUL_SUPPORTED_POSITIVE", "FRESH_SUPPORTED_BOUNDARY",
    "EXACT_FALSE_CANDIDATE_COUNTERSTRATEGY", "COMPLETE_IMPOSSIBLE_TARGET",
    "LAWFUL_AND_UNAUTHORIZED_LOCAL_INFORMATION", "ORIGINAL_CURRENTNESS_MUTATION",
    "FINITE_RESOURCE_ARITHMETIC_DEADLINE", "DURABLE_NATIVE_INTERRUPTION_DUPLICATE",
]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--evidence-dir", required=True)
    parser.add_argument("--family", type=int, action="append")
    parser.add_argument("--budget-ms", type=int, default=20000)
    args = parser.parse_args()
    repo, out = Path(args.repo).resolve(), Path(args.evidence_dir).resolve()
    assert 1 <= args.budget_ms <= 120000
    families = args.family or list(range(1, 33))
    assert len(set(families)) == len(families) and all(1 <= f <= 32 for f in families)
    out.mkdir(parents=True, exist_ok=False)
    scripts = repo/"finnor-os/scripts/project-z/z2"
    engine = repo/"finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions"
    native = repo/"finnor-os/packages/private-equity/src/interaction-synthesis"
    fixture = load("z2_obligation_original_inputs", scripts/"structural-fixtures.py")
    oracle = load("z2_obligation_independent_original", scripts/"original-oracle.py")
    equipment = load("z2_obligation_assessment_equipment", native/"producer.py")
    reference = load("z2_obligation_continuation_reference", native/"reference.py")
    pins = {str(p.relative_to(repo)): sha(p) for folder in (scripts, engine, native,
            repo/"finnor-os/packages/private-equity/src/project-z/z2-coalitions",
            repo/"finnor-os/packages/orchestration/src/project-z/z2-coalitions")
            for p in sorted(folder.iterdir()) if p.is_file() and p.suffix in (".ts", ".py", ".mjs", ".json")}
    rows, steps = [], []
    started = time.monotonic()

    def write(path, value):
        path.write_text(json.dumps(value, sort_keys=True, indent=2)+"\n")

    def run(directory, name, program, request):
        target = directory/name
        target.mkdir()
        write(target/"input.json", request)
        begin = time.monotonic()
        try:
            child = subprocess.run(["/usr/bin/python3", "-I", "-B", str(program)],
                input=json.dumps(request), text=True, capture_output=True,
                timeout=args.budget_ms/1000+10,
                env={"NODE_ENV": "test", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"})
            stdout, stderr, code, termination = child.stdout, child.stderr, child.returncode, None
        except subprocess.TimeoutExpired as error:
            stdout, stderr, code, termination = error.stdout or "", error.stderr or "", None, "TIMEOUT"
        (target/"stdout.json").write_text(stdout.decode() if isinstance(stdout, bytes) else stdout)
        (target/"stderr.log").write_text(stderr.decode() if isinstance(stderr, bytes) else stderr)
        try:
            value = json.loads(stdout)
        except ValueError:
            value = {"status": "HARNESS_FAILURE", "reason": termination or "NON_JSON_OUTPUT"}
        record = {"id": str(target.relative_to(out)), "exitCode": code, "termination": termination,
                  "wallMs": round(1000*(time.monotonic()-begin)),
                  "status": value.get("status"), "reason": value.get("reason")}
        steps.append(record)
        assert code == 0, record
        return value

    def checked(directory, name, problem, construction, expected):
        value = run(directory, name, engine/"checker.py", {"problem": problem, "construction": construction})
        assert (value.get("status"), value.get("reason")) == expected, value
        return value

    def construction(directory, name, problem, expected):
        produced = run(directory, name+"-producer", engine/"producer.py",
                       {"problem": problem, "budgetMs": args.budget_ms})
        checked(directory, name+"-checker", problem, produced, expected)
        return produced

    def original_witness(problem, candidate, report):
        game = oracle.local_game(problem, next(m for m in problem["models"] if m["id"] == report["modelId"]),
                                 candidate["policy"])
        coalition, witness = report["coalition"], report["profitable"]
        domain = {k: i["actions"] for k, i in game["infos"].items() if i["party"] in coalition}
        baseline = oracle.value(game, candidate["strategy"], {})
        weights = [F(t["probability"]) for t in witness["terms"]]
        assert min(weights) > 0 and sum(weights) == 1
        gains = [F(0)]*len(coalition)
        for term, weight in zip(witness["terms"], weights):
            assert set(term["plan"]) == set(domain)
            assert all(a in domain[k] for k, a in term["plan"].items())
            actual = oracle.value(game, candidate["strategy"], term["plan"])
            for i, party in enumerate(coalition):
                gains[i] += weight*(actual[int(party[1:])]-baseline[int(party[1:])])
        assert min(gains) >= 0 and sum(gains) > 0 and list(map(str, gains)) == witness["gains"]
        return {"kind": "PROFITABLE_MIXTURE", "modelId": report["modelId"], "coalition": coalition, **witness}

    for family in families:
        directory = out/(str(family).zfill(2)+"-"+fixture.NAMES[family-1])
        directory.mkdir()
        problem = fixture.build(family, 0)
        write(directory/"original-problem.json", problem)
        good = None
        baseline = None
        for index, obligation in enumerate(OBLIGATIONS, 1):
            case = directory/(str(index)+"-"+obligation.lower())
            case.mkdir()
            row = {"family": family, "obligation": index, "kind": obligation, "status": "FAILED",
                   "nativeOwnerCoverage": "NOT_RUN"}
            try:
                if index in (1, 2):
                    variant = problem if index == 1 else fixture.build(family, 7)
                    expected = ("CHECKED_INFEASIBLE", "Z2_ORIGINAL_FAMILY_INFEASIBILITY_CHECKED") if family == 30 else \
                        ("CHECKED_CANDIDATE", "Z2_EXACT_ALL_ORIGINAL_CORRELATED_COALITIONS")
                    result = construction(case, "fresh-original", variant, expected)
                    if index == 1:
                        baseline = result
                    if family == 30:
                        row.update(status="NOT_APPLICABLE", reason="ORIGINAL_FAMILY_30_HAS_NO_STABLE_CANDIDATE_BY_DEFINITION",
                                   exclusionBasis=result["infeasibility"]["kind"],
                                   positiveDenominatorIncluded=False, impossibleProcessCheck="PASSED")
                    else:
                        reports = oracle.inspect(variant, result["candidate"])
                        assert len(reports) == len(variant["models"])*(2**len(variant["participants"])-1)
                        assert all(not r["profitable"] for r in reports)
                        exhaustive = reference.run(variant, result["candidate"])
                        assert all(r["maxRegret"] == "0" for r in exhaustive["models"])
                        write(case/"independent-all-original-coalitions.json", reports)
                        write(case/"independent-all-continuations.json", exhaustive)
                        if index == 1:
                            good = result
                        row.update(status="PASSED_PROCESS", positiveDenominatorIncluded=True,
                                   originalProblemDigest=oracle.digest(variant))
                elif index == 3:
                    assert baseline
                    if family == 30:
                        candidate = baseline["infeasibility"]["policies"][0]["candidate"]
                        reports = oracle.inspect(problem, candidate)
                    else:
                        candidate = None
                        for key, distribution in good["candidate"]["strategy"].items():
                            for action in distribution:
                                if distribution[action] == "1":
                                    continue
                                strategy = copy.deepcopy(good["candidate"]["strategy"])
                                strategy[key] = {a: str(int(a == action)) for a in distribution}
                                policy = good["candidate"]["policy"]
                                games = [equipment.checker.compile_original(problem, m, policy) for m in problem["models"]]
                                proposed = equipment.propose(problem, games, policy, strategy, equipment.checker.objective_bound(problem))
                                observed = oracle.inspect(problem, proposed)
                                if any(r["profitable"] for r in observed):
                                    candidate, reports = proposed, observed
                                    break
                            if candidate is not None:
                                break
                        assert candidate is not None, "NO_ORIGINAL_FALSE_STRATEGY_WITH_EXACT_WITNESS"
                    report = next(r for r in reports if r["profitable"])
                    witness = original_witness(problem, candidate, report)
                    raw = {"schema": "finnor.project-z.z2.construction.v1", "status": "CANDIDATE",
                           "problemDigest": oracle.digest(problem), "profileDigest": sha(engine/"profile.json"),
                           "candidate": candidate, "certificates": [], "counterstrategy": witness}
                    floor = run(case, "native-original-floor", native/"checker.py", {"problem": problem, "candidate": candidate})
                    expected = ("COUNTEREXAMPLE", "Z2_CHECKED_PROFITABLE_CORRELATED_MIXTURE") if floor["status"] == "CHECKED" else \
                        ("COUNTEREXAMPLE", "Z2_NATIVE_FULL_Y3_FLOOR")
                    checked(case, "false-candidate-rejected", problem, raw, expected)
                    write(case/"independent-exact-local-counterstrategy.json",
                          {"candidate": candidate, "witness": witness, "allOriginalReports": reports,
                           "z2PrimalReached": floor["status"] == "CHECKED"})
                    if family == 30:
                        good = raw  # Native-feasible baseline for forged-plan/refusal checks, never a stable positive.
                    row.update(status="PASSED_PROCESS", counterstrategyDigest=oracle.digest(witness),
                               nativeFloor=floor["status"], exactOriginalGains=witness["gains"])
                elif index == 4:
                    impossible = copy.deepcopy(problem)
                    maximum = max(F(n["ownerValue"]) for m in impossible["models"] for n in m["nodes"] if n["kind"] == "TERMINAL")
                    impossible["goal"]["minimumOwnerValue"]["value"] = str(maximum+1)
                    result = construction(case, "all-original-owner-bound", impossible,
                                          ("CHECKED_INFEASIBLE", "Z2_ORIGINAL_FAMILY_INFEASIBILITY_CHECKED"))
                    assert result["infeasibility"] == {"kind": "WHOLE_ORIGINAL_OWNER_BOUND", "upperBound": str(maximum)}
                    write(case/"independent-complete-bound.json", {"allOriginalTerminalOwnerMaximum": str(maximum),
                        "requiredOwnerMinimum": str(maximum+1), "allPoliciesAndAllStrategiesExcluded": True})
                    row.update(status="PASSED_PROCESS", completeScope="ALL_ORIGINAL_POLICIES_AND_BEHAVIOR")
                elif index == 5:
                    assert good
                    candidate = good["candidate"]
                    game = oracle.local_game(problem, problem["models"][0], candidate["policy"])
                    parties = [p["id"] for p in problem["participants"]]
                    original = oracle.columns(game, candidate["strategy"], parties)
                    plan = original[0][0]
                    raw = {"schema": "finnor.project-z.z2.construction.v1", "status": "CANDIDATE",
                           "problemDigest": oracle.digest(problem), "profileDigest": sha(engine/"profile.json"),
                           "candidate": candidate, "certificates": [], "counterstrategy": {
                               "kind": "PROFITABLE_MIXTURE", "modelId": problem["models"][0]["id"], "coalition": parties,
                               "terms": [{"plan": plan, "probability": "1"}], "gains": ["0"]*len(parties)}}
                    for name, extra in (("pooled-private-state", "I:other-private-state"), ("future-anticipation", "I:future-chance")):
                        forged = copy.deepcopy(raw)
                        forged["counterstrategy"]["terms"][0]["plan"][extra] = "ready"
                        checked(case, name, problem, forged, ("COUNTEREXAMPLE", "Z2_LOCAL_PLAN_DOMAIN"))
                    forged = copy.deepcopy(raw)
                    forged["counterstrategy"]["terms"][0]["plan"][next(iter(plan))] = "unadmitted-reverse-channel-or-transfer"
                    checked(case, "unlawful-channel-action", problem, forged, ("COUNTEREXAMPLE", "Z2_LOCAL_PLAN_ALPHABET"))
                    write(case/"lawful-original-plan-domain.json", {"modelId": problem["models"][0]["id"],
                        "originalPlanCount": len(original), "originalDomain": game["infos"],
                        "originalAllPlansDigest": oracle.digest([p for p, _ in original]),
                        "lawfulCommunicationAndPaymentsNotPruned": True})
                    row.update(status="PASSED_PROCESS", lawfulOriginalPlanCount=len(original))
                elif index == 6:
                    for name in ("fixed-operator-revision", "admitted-model-utility-revision"):
                        revised = copy.deepcopy(problem)
                        if name == "fixed-operator-revision":
                            revised["fixedOperatorRefs"][0]["version"] = "2"
                        else:
                            terminal = next(n for n in revised["models"][-1]["nodes"] if n["kind"] == "TERMINAL")
                            terminal["payoff"][0] = str(F(terminal["payoff"][0])+1)
                        checked(case, name, revised, baseline, ("COUNTEREXAMPLE", "Z2_CONSTRUCTION_BINDING"))
                    row.update(status="PASSED_PROCESS", sourceBinding="EXACT_ORIGINAL_BYTES",
                               actualRightsTermsBeforeNativeUse="NOT_RUN_AUTHORITY_REQUIRED")
                elif index == 7:
                    expired = run(case, "zero-remaining-producer", engine/"producer.py", {"problem": problem, "budgetMs": 0})
                    assert (expired["status"], expired["reason"]) == ("INCOMPLETE", "Z2_REMAINING_PROCESS_DEADLINE")
                    checked(case, "zero-remaining-no-candidate", problem, expired, ("INCOMPLETE", "Z2_NO_CHECKED_CANDIDATE"))
                    arithmetic = copy.deepcopy(good)
                    if family == 30:
                        arithmetic["candidate"]["objective"] = str(2**512)
                    else:
                        arithmetic["certificates"][0]["nu"] = str(-(2**512))
                    checked(case, "rational-component-exhaustion", problem, arithmetic, ("INCOMPLETE", "Z2_ARITHMETIC_BOUND"))
                    resource, raw = copy.deepcopy(problem), copy.deepcopy(good)
                    resource["models"][0]["nodes"][0]["resources"]["capacity"] = "2"
                    raw["problemDigest"] = raw["candidate"]["problemDigest"] = oracle.digest(resource)
                    checked(case, "all-history-shared-capacity", resource, raw, ("COUNTEREXAMPLE", "Z2_NATIVE_FULL_Y3_FLOOR"))
                    row.update(status="PASSED_PROCESS", fallback="NO_CHECKED_CANDIDATE_NO_NEW_BUDGET",
                               actualParentBudgetRecovery="NOT_RUN_AUTHORITY_REQUIRED")
                else:
                    assert index == 8
                    equipment_paths = ["finnor-os/scripts/project-z/z2/native-replay.mjs",
                        "finnor-os/packages/private-equity/src/project-z/z2-coalitions/worker.ts"]
                    write(case/"native-recovery-requirements.json", {
                        "status": "NOT_RUN", "family": family, "equipment": {p: pins[p] for p in equipment_paths},
                        "boundaries": ["CLAIM", "CHECKPOINT", "ARTIFACT", "PARTIAL_CONSENT"],
                        "required": ["AUTHORIZED_EXISTING_DISPOSABLE_DB_AND_REAL_AUTH", "CANONICAL_ORIGINAL_WORK_AND_SOURCES",
                                     "EXACT_PARENT_RESERVATION_AND_REMAINING_DEADLINE", "OWNED_SAME_BUILD_WORKER",
                                     "PHYSICAL_EXIT_RESTART_AND_DUPLICATE_NATIVE_CONSUMPTION"],
                        "processRestartIsNotNativeRecovery": True, "qualificationCredit": False})
                    row.update(status="NOT_RUN", reason="EXPLICIT_DISPOSABLE_NATIVE_AUTHORITY_REQUIRED",
                               physicalNativeRecovery="NOT_RUN", qualificationCredit=False)
            except (AssertionError, KeyError, ValueError, StopIteration, TypeError) as error:
                row.update(status="FAILED", failureType=type(error).__name__, failureDetail=str(error)[:300])
            rows.append(row)
            write(out/"progress.json", {"cases": rows, "steps": steps})
    unchanged = all(sha(repo/p) == expected for p, expected in pins.items())
    counts = {status: sum(r["status"] == status for r in rows)
              for status in ("PASSED_PROCESS", "NOT_APPLICABLE", "NOT_RUN", "FAILED")}
    report = {"schema": "finnor.project-z.z2.eight-obligation-process-replay.v1", "cases": rows, "steps": steps,
        "driverSha256": sha(Path(__file__)), "driverPath": str(Path(__file__).resolve()),
        "counts": counts, "sourceHashes": pins, "sourcesUnchanged": unchanged, "families": families,
        "obligationsPerFamily": 8, "usefulPositiveDenominator": sum(r.get("positiveDenominatorIncluded", False) for r in rows),
        "engineeringStatus": "PASSED_PROCESS_EQUIPMENT" if not counts["FAILED"] and unchanged else "FAILED",
        "qualificationStatus": "INCOMPLETE", "nativeEightObligationsPassed": False,
        "authenticatedOwner": "NOT_RUN", "mountedWork": "NOT_RUN", "physicalNativeRecovery": "NOT_RUN",
        "protectedAdmission": False, "financialQualification": "NOT_RUN",
        "scope": "PUBLIC_ORIGINAL_SEMANTICS_PROCESS_EQUIPMENT_NOT_NATIVE_OR_PROTECTED_QUALIFICATION",
        "wallMs": round(1000*(time.monotonic()-started)), "moneyUsd": None, "humanSeconds": None,
        "aggregatePeakMemoryBytes": None, "costStatus": "PARTIALLY_METERED"}
    write(out/"report.json", report)
    write(out/"sha256.json", {str(p.relative_to(out)): sha(p) for p in sorted(out.rglob("*")) if p.is_file()})
    print(json.dumps({"engineeringStatus": report["engineeringStatus"], "counts": counts,
                      "sourcesUnchanged": unchanged, "qualificationStatus": report["qualificationStatus"]}))
    return int(bool(counts["FAILED"] or not unchanged))


if __name__ == "__main__":
    raise SystemExit(main())
