"""Pre-code CLI round-trip, independent exhaustive oracle and immutable evidence.

No DB/Auth/listener/provider is accessed. Native proof has a separate guarded
runner. Public fixtures are not owner identities or protected qualification.
"""
import argparse
import copy
import hashlib
import json
import pathlib
import subprocess
import sys
import time
from reference import exhaustive, small_population

ROOT = pathlib.Path(__file__).resolve().parents[3]
REPO = ROOT.parent
EVIDENCE = REPO / "scope-z/phase-evidence/z3"
FROZEN = EVIDENCE / "frozen-public-cases-v2.json"
KERNEL = ROOT / "packages/epistemic-runtime/src/project-z/z3-viability"
OBLIGATIONS = ["useful", "boundary", "false_candidate", "impossible",
               "information", "currentness", "resources", "replay"]


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def binding(i=0):
    return {"tenantId": "PUBLIC_FIXTURE_NOT_AUTH", "principalId": "PUBLIC_FIXTURE_NOT_OWNER",
            "workId": "PUBLIC_WORK_" + str(i), "workInputId": "PUBLIC_INPUT_" + str(i),
            "originalParentId": "PUBLIC_PARENT_" + str(i), "sourceRevision": "source-1",
            "rightsRevision": "rights-1", "mandateDigest": "0" * 64,
            "observationDigest": "1" * 64, "resourceDigest": "2" * 64,
            "deadlineAt": "2030-01-01T00:00:00.000Z", "codeDigest": "3" * 64}


def arena_for(family, variant):
    # Each family has a distinct original graph/label/observation invariant.
    # Mutations are case obligations within a family, never new families.
    graphs = [
        ("CC", [[0, 1], [0]], [], [[1]]),
        ("CEC", [[1], [0, 2], [0]], [], [[0]]),
        ("CEC", [[2, 1], [1, 2], [2]], [], [[2]]),
        ("CCCCE", [[1, 4], [2], [3], [1], [4]], [], [[3]]),
        ("CEEC", [[3, 1], [2], [2], [3]], [[3]], [[3]]),
        ("CEE", [[1, 2], [1], [2]], [], [[1]]),
        ("ECE", [[1, 2], [0], [0]], [], [[0]]),
        ("CCCC", [[0], [1], [3], [2]], [], [[0, 1, 3]]),
        ("CEE", [[1, 2], [1], [2]], [], [[1]]),
        ("CE", [[1], [1]], [], [[1]]),
        ("CC", [[1, 0], [0]], [], [[1]]),
        ("CEC", [[1], [2], [0]], [[1]], [[2]]),
        ("CECE", [[1], [2], [3], [0]], [[1], [3]], [[0]]),
        ("CCC", [[1, 2], [0], [0]], [], [[1], [2]]),
        ("CCCC", [[1, 2], [0], [3], [0]], [], [[1], [3]]),
        ("CEEEEEEE", [[0, 1], [2], [3], [4], [5], [6], [7], [7]], [], [[0]]),
        ("CCCCCCC", [[1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [6]], [], [[6]]),
        ("CCC", [[1, 2], [1], [2]], [], [[1]]),
        ("CE", [[1], [1]], [[]], [[0]]),
        ("CCC", [[2, 1], [1], [0]], [[2]], [[2]]),
        ("CCCC", [[3, 1], [2], [1], [0]], [[3]], [[3]]),
        ("CE", [[1], [0]], [], [[1]]),
        ("CCCCC", [[1], [2], [3], [4], [3]], [], [[3]]),
        ("CC", [[1], [0]], [], [[1]]),
        ("CE", [[1], [1, 0]], [[0]], [[0]]),
        ("CCEE", [[2, 3], [3, 2], [2], [3]], [], [[2]]),
        ("CCEE", [[2, 3], [3, 2], [2], [3]], [], [[2]]),
        ("CECC", [[1], [2], [3], [0]], [[1, 2], [2, 3]], [[0, 2], [1, 3]]),
        ("CCCCCEE", [[1, 5], [2], [3], [4], [0], [6], [5]], [], [[4]]),
        ("CEEEEEC", [[6, 1], [2, 3], [1], [4], [3, 5], [5, 6], [6]], [[1, 6], [2, 4, 6]], [[6]]),
        ("EEEE", [[1], [2], [3], [3]], [], [[0]]),
        ("CECC", [[1], [2, 3], [0], [0]], [], [[0]]),
    ]
    owners, targets, assumptions, goals = copy.deepcopy(graphs[family])
    n = len(owners)
    prefix = f"f{family:02d}c{variant}-"
    ids = [prefix + str(v) for v in range(n)]
    unsafe = {4} if family == 3 else {2} if family in (4, 5, 8) else {7} if family == 15 else {3} if family in (25, 26, 30) else set()
    states = [{"id": ids[v], "owner": owners[v], "observation": ids[v], "safe": v not in unsafe,
               "remaining": max(0, 4 - v) if family == 22 else (v if family == 23 else 0),
               "unknown": ["s6-public-retained"] if family in (21, 31) else []} for v in range(n)]
    if family == 25:
        states[1]["observation"] = states[0]["observation"]
    initial = [0, 1] if family in (7, 25, 26) else [0]
    if variant == 1:
        # Boundary variant changes an original goal, not only a random label.
        goals = [[v for v in range(n) if v not in unsafe]]
        if family in (13, 14, 27):
            goals = list(reversed(graphs[family][3]))
    if variant == 3:
        goals = [[]]
    if family == 22:
        states[4]["remaining"] = states[3]["remaining"]
    if family == 23:
        states[0]["remaining"], states[1]["remaining"] = 1, 0
    edges = [{"from": ids[v], "to": ids[w], "action": f"edge-{v}-{k}",
              "renewalRef": "S5-public-recharge" if family == 23 and states[w]["remaining"] > states[v]["remaining"] else None,
              "settlementRef": None} for v in range(n) for k, w in enumerate(targets[v])]
    return {"schema": "finnor.z3.public-arena.v1", "id": prefix + "original",
            "observationMode": "PUBLIC_PERFECT_INFORMATION", "states": states, "edges": edges,
            "initial": [ids[v] for v in initial], "assumptions": [[ids[v] for v in a] for a in assumptions],
            "goals": [[ids[v] for v in b] for b in goals],
            "resources": {"capacity": 1 if family in (21, 31) else 0,
                          "maximum": 4 if family == 22 else 1 if family == 23 else 0,
                          "obligationIds": ["s6-public-retained"] if family in (21, 31) else [],
                          "renewalRefs": ["S5-public-recharge"] if family == 23 else [],
                          "settlementRefs": [], "unknownOccupiesCapacity": True}}


def freeze():
    specs = json.loads((REPO / "scope-z/prompts/qualification-families.json").read_text())
    cases = []
    for f, name in enumerate(specs["phases"]["Z3"]["families"]):
        for k, obligation in enumerate(OBLIGATIONS):
            a = arena_for(f, k)
            ref = exhaustive(a) if f != 25 else {"unsupported": "PARTIAL_OBSERVATION"}
            cases.append({"id": f"F{f + 1:02d}-{k + 1}", "family": f + 1, "structure": name,
                          "obligation": obligation, "arena": a, "binding": binding(f * 8 + k),
                          "reference": ref,
                          "positiveApplicable": k < 2 and f not in (18, 25, 30),
                          "inapplicability": "Defining condition precludes a viable positive" if f in (18, 25, 30) else None})
    body = {"schema": "finnor.z3.frozen-public-cases.v1", "protected": False,
            "families": 32, "casesPerFamily": 8, "caseCount": len(cases),
            "population": "reference.py:small_population plus all bounded frozen cases",
            "oracle": "independent exhaustive deterministic monitor policies plus original all-play SCC semantics",
            "stoppingRule": "One complete sweep, three guarded native interruption points, bounded defect reruns with original failures retained",
            "usefulThreshold": 0.95, "criticalFalsifierThreshold": 1,
            "nativeRecoveryNotSimulatedByReplay": True, "cases": cases}
    path = FROZEN
    data = canonical(body) + "\n"
    if path.exists() and path.read_text() != data:
        raise RuntimeError("Frozen public population cannot be silently revised")
    if not path.exists():
        path.write_text(data)
    print(canonical({"freeze": str(path.relative_to(REPO)), "sha256": hashlib.sha256(data.encode()).hexdigest(),
                     "cases": len(cases), "referencePopulation": sum(1 for _ in small_population())}))


def invoke_batch(command, requests):
    result = subprocess.run(command, input="".join(canonical(r) + "\n" for r in requests),
                            text=True, capture_output=True, timeout=240)
    if result.returncode:
        raise RuntimeError(f"Child exit {result.returncode}: {result.stderr[:2000]}")
    rows = [json.loads(line) for line in result.stdout.splitlines()]
    if len(rows) != len(requests):
        raise RuntimeError("Complete input/output denominator mismatch")
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--freeze", action="store_true")
    parser.add_argument("--cli", type=pathlib.Path)
    parser.add_argument("--checker", type=pathlib.Path, default=KERNEL / "checker.py")
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()
    if args.freeze:
        freeze()
        return
    if not args.cli or not args.output:
        parser.error("--cli and immutable --output are required")
    if args.output.exists():
        raise RuntimeError("Refusing to overwrite retained run")
    args.output.mkdir(parents=True)
    frozen = json.loads(FROZEN.read_text())
    cases = frozen["cases"]
    grid = list(small_population())
    requests = [{"arena": c["arena"], "binding": c["binding"]} for c in cases]
    requests += [{"arena": a, "binding": binding(1000 + i)} for i, a in enumerate(grid)]
    started = time.monotonic()
    candidates = invoke_batch(["node", str(args.cli), "produce-batch"], requests)
    checks = invoke_batch([sys.executable, str(args.checker), "--batch"],
                          [{**r, "candidate": c} for r, c in zip(requests, candidates)])
    failures, records, families = [], [], {}
    for i, (request, candidate, check) in enumerate(zip(requests, candidates, checks)):
        case = cases[i] if i < len(cases) else None
        oracle = case["reference"] if case else exhaustive(request["arena"])
        label = case["id"] if case else f"grid-{i - len(cases)}"
        if "region" in oracle and candidate.get("disposition") == "COMPLETE":
            if candidate["winningRegion"] != oracle["region"] or check.get("ordinaryComplete") is not True:
                failures.append([label, "COMPLETE_REGION_DISAGREES_WITH_EXHAUSTIVE_ORACLE"])
        elif not (case and case["family"] == 26):
            failures.append([label, "UNEXPECTED_UNSUPPORTED_OR_INCOMPLETE_REFERENCE"])
        if case:
            row = families.setdefault(case["family"], {"cases": 0, "positiveDenominator": 0,
                                                        "acceptedUseful": 0, "falsifiers": []})
            row["cases"] += 1
            if case["positiveApplicable"]:
                row["positiveDenominator"] += 1
                if check.get("status") == "VIABLE":
                    row["acceptedUseful"] += 1
                else:
                    failures.append([label, "USEFUL_POSITIVE_NOT_VIABLE", check.get("reason")])
            if case["obligation"] in ("false_candidate", "currentness") and candidate.get("disposition") == "COMPLETE":
                mutated = copy.deepcopy(candidate)
                if case["obligation"] == "currentness":
                    wrong = copy.deepcopy(request)
                    wrong["binding"]["rightsRevision"] = "revoked"
                else:
                    wrong = request
                    # Falsify the actual complete certificate. Additional SCC,
                    # action/update and source mutations are checked below.
                    mutated["certificate"]["safety"][0] = "0"
                rejected = invoke_batch([sys.executable, str(args.checker), "--batch"],
                                       [{**wrong, "candidate": mutated}])[0]
                row["falsifiers"].append({"case": label, "status": rejected["status"]})
                if rejected["status"] != "REJECTED":
                    failures.append([label, "CRITICAL_FALSIFIER_ACCEPTED"])
            if case["obligation"] == "information":
                private = copy.deepcopy(request)
                private["arena"]["observationMode"] = "PRIVATE_OR_PARTIAL"
                rejected = invoke_batch([sys.executable, str(args.checker), "--batch"],
                                       [{**private, "candidate": candidate}])[0]
                row["falsifiers"].append({"case": label, "status": rejected["status"]})
                if rejected["status"] not in ("UNSUPPORTED", "REJECTED"):
                    failures.append([label, "PRIVATE_STATE_ORACLE_ACCEPTED"])
            if case["obligation"] == "resources":
                limited = invoke_batch(["node", str(args.cli), "produce-batch"],
                                       [{**request, "limits": {"maxOperations": 1}}])[0]
                if limited.get("disposition") not in ("UNKNOWN", "UNSUPPORTED"):
                    failures.append([label, "RESOURCE_BOUND_DID_NOT_FAIL_CLOSED"])
            if case["obligation"] == "replay":
                again = invoke_batch(["node", str(args.cli), "produce-batch"], [request])[0]
                if any(again.get(key) != candidate.get(key) for key in
                       ("arenaDigest", "bindingDigest", "winningRegion", "strategy", "certificate")):
                    failures.append([label, "DETERMINISTIC_MEMORY_REPLAY_CHANGED"])
        records.append({"id": label, "request": request, "candidate": candidate,
                        "check": check, "oracle": oracle})
    # Registered semantic mutations, independent of a producer-selected path.
    critical = []
    for i, mode in enumerate(("wait_only", "nonbottom", "unfair_unsafe", "memory", "edge", "goal", "renewal", "unknown_release")):
        request = copy.deepcopy(requests[[0, 16, 32, 104, 8, 88, 184, 168][i]])
        candidate = copy.deepcopy(candidates[[0, 16, 32, 104, 8, 88, 184, 168][i]])
        if mode == "memory":
            candidate["strategy"]["updates"][0][0] = 999
        elif mode in ("wait_only", "nonbottom", "unfair_unsafe"):
            for m, actions in enumerate(candidate["strategy"]["actions"]):
                v = 0
                matching = [k for k, e in enumerate(request["arena"]["edges"]) if e["from"] == request["arena"]["states"][v]["id"]]
                actions[v] = matching[-1] if mode != "wait_only" else matching[0]
        elif mode == "edge":
            request["arena"]["edges"][0]["to"] = request["arena"]["states"][-1]["id"]
        elif mode == "goal":
            request["arena"]["goals"] = [[]]
        elif mode == "renewal":
            request["arena"]["resources"]["renewalRefs"] = []
        else:
            request["arena"]["states"][-1]["unknown"] = []
        result = invoke_batch([sys.executable, str(args.checker), "--batch"],
                              [{**request, "candidate": candidate}])[0]
        critical.append({"mutation": mode, "result": result})
        if result["status"] not in ("REJECTED", "UNSUPPORTED"):
            failures.append([mode, "SEMANTIC_MUTATION_NOT_REJECTED"])
    (args.output / "records.ndjson").write_text("".join(canonical(r) + "\n" for r in records))
    (args.output / "critical.json").write_text(canonical(critical) + "\n")
    report = {"schema": "finnor.z3.finite-e2e-report.v1", "status": "PASS" if not failures else "FAIL",
              "frozenDigest": digest(frozen), "requests": len(requests), "grid": len(grid),
              "families": families, "failures": failures, "wallSeconds": time.monotonic() - started,
              "nativeOwner": "NOT_RUN", "physicalRecovery": "NOT_RUN", "protected": "NOT_RUN",
              "financialCosts": None, "unknownCostsAreNotZero": True}
    (args.output / "report.json").write_text(canonical(report) + "\n")
    print(canonical(report))
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
