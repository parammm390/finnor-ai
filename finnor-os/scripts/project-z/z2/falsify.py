"""Original-input process E2E for the failure models frozen in pre-code-contract.md.

Native Y3 proposal equipment creates known unilateral fixture assessments.
No Z2 engine module is imported. Every scientific verdict comes from a fresh
complete checker process. These are public development cases, not owner proof.
"""
import argparse
import copy
import hashlib
import importlib.util
import itertools
import json
from fractions import Fraction
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fixtures import problem, reference


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def inventory(engine, native):
    return {str(p): hashlib.sha256(p.read_bytes()).hexdigest()
            for directory in (engine, native) for p in sorted(directory.iterdir()) if p.is_file()}


def baseline(native, original):
    spec = importlib.util.spec_from_file_location("native_fixture_equipment", native/"producer.py")
    equipment = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(equipment)
    keys = equipment.checker.control_keys(original)
    policy = {k: "unverified" if "unverified" in v["options"] else v["options"][0] for k, v in keys.items()}
    games = [equipment.checker.compile_original(original, m, policy) for m in original["models"]]
    strategy, left, right = {}, {}, {}
    for game in games:
        for key, info in game["infos"].items():
            actions = info["actionIds"]
            preferred = next(a for a in ("stay", "withhold", "decline", "confirm", "left") if a in actions)
            strategy[key] = {a: str(int(a == preferred)) for a in actions}
            left[key] = next(a for a in ("coordinate", "ready", "join", "commit", "confirm", "left") if a in actions)
            right[key] = "right" if "right" in actions else left[key]
    candidate = equipment.propose(original, games, policy, strategy, equipment.checker.objective_bound(original))
    return candidate, left, right


def original_mixture_oracle():
    # Two early private-state choices, four recalled final choices, one
    # state-blind P1 choice. Off-path local choices are included, not sampled.
    columns = []
    for choices in itertools.product((0, 1), repeat=7):
        total = [Fraction(0), Fraction(0)]
        for state in (0, 1):
            early, later = choices[state], choices[6]
            last = choices[2+2*state+early]
            payoff = ((4, -2) if last == 0 else (-1, 1)) if early == later == 0 else \
                (-1, 0) if early == 0 else (0, -1) if later == 0 else (0, 0)
            total = [v+Fraction(p, 2) for v, p in zip(total, payoff)]
        columns.append(total)
    profitable = lambda row: all(v >= 0 for v in row) and sum(row) > 0
    grid = [Fraction(0), Fraction(1, 2), Fraction(1)]
    quarter = [5*Fraction(1, 4)-1, 1-3*Fraction(1, 4)]
    assert len(columns) == 128 and not any(map(profitable, columns))
    assert not any(profitable([5*p-1, 1-3*p]) for p in grid)
    assert quarter == [Fraction(1, 4), Fraction(1, 4)]
    # The displayed two columns are not the whole original plan family:
    # a private-state-contingent pure plan can supply another convex column.
    unique = sorted({tuple(row) for row in columns})
    half_pair = next((a, b) for a in unique for b in unique
                     if profitable([(x+y)/2 for x, y in zip(a, b)]))
    return {"completeOriginalPurePlans": 128, "profitablePurePlans": 0,
        "pureGainColumnsDigest": digest([[str(v) for v in row] for row in columns]),
        "coarseGrid": [str(v) for v in grid], "coarseGridOverDisplayedPairFindsProfitableMixture": False,
        "completeOriginalFamilyHasProfitableHalfMixture": True,
        "halfMixtureWitness": {"originalPureGainColumns": [[str(v) for v in row] for row in half_pair],
            "weights": ["1/2", "1/2"], "gains": [str((x+y)/2) for x, y in zip(*half_pair)]},
        "outsideGridNecessaryForWholeOriginalFamily": False,
        "lawfulExAnteMixtureWeights": ["1/4", "3/4"], "exactOriginalGains": [str(v) for v in quarter],
        "provenance": "Direct fixture outcome table and seven original local binary choices, no Z2 engine imports"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--evidence-dir", required=True)
    args = parser.parse_args()
    repo, out = Path(args.repo).resolve(), Path(args.evidence_dir).resolve()
    out.mkdir(parents=True, exist_ok=False)
    engine = repo/"finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions"
    native = repo/"finnor-os/packages/private-equity/src/interaction-synthesis"
    pins, rows, mixture_oracle = inventory(engine, native), [], original_mixture_oracle()

    def run(name, path, request, expected=None):
        target = out/name
        target.mkdir()
        (target/"input.json").write_text(json.dumps(request, sort_keys=True)+"\n")
        started = time.monotonic()
        try:
            child = subprocess.run([sys.executable, "-I", "-B", str(path)], input=json.dumps(request),
                text=True, capture_output=True, timeout=40, env={"LANG": "C.UTF-8", "PATH": "/usr/bin:/bin"})
            (target/"stdout.json").write_text(child.stdout)
            (target/"stderr.log").write_text(child.stderr)
            result = json.loads(child.stdout)
            ok = child.returncode == 0 and (expected is None or
                 (result.get("status"), result.get("reason")) == expected)
            row = {"id": name, "exitCode": child.returncode, "status": result.get("status"),
                   "reason": result.get("reason"), "expected": expected, "passed": ok}
        except (subprocess.TimeoutExpired, ValueError) as error:
            result = {}
            row = {"id": name, "passed": False, "failure": type(error).__name__, "expected": expected}
        row["wallMs"] = round(1000*(time.monotonic()-started))
        rows.append(row)
        return result

    original = problem()
    stable = run("construct-authorized", engine/"producer.py", {"problem": original, "budgetMs": 20000},
                 ("CANDIDATE", "Z2_FRESH_INDEPENDENT_CHECK_REQUIRED"))
    run("stable-all-coalitions", engine/"checker.py", {"problem": original, "construction": stable},
        ("CHECKED_CANDIDATE", "Z2_EXACT_ALL_ORIGINAL_CORRELATED_COALITIONS"))

    def mutated(name, reason, change, status="COUNTEREXAMPLE"):
        request = {"problem": copy.deepcopy(original), "construction": copy.deepcopy(stable)}
        change(request)
        run(name, engine/"checker.py", request, (status, reason))

    mutated("omitted-certificate", "Z2_CERTIFICATE_COVERAGE", lambda r: r["construction"]["certificates"].pop())
    mutated("negative-lambda", "Z2_DUAL_SIGNS",
            lambda r: r["construction"]["certificates"][0]["lambda"].__setitem__(0, "-1"))
    mutated("positive-nu", "Z2_DUAL_SIGNS", lambda r: r["construction"]["certificates"][0].update(nu="1"))
    mutated("violated-original-inequality", "Z2_ORIGINAL_DUAL_INEQUALITY",
            lambda r: r["construction"]["certificates"][0].update(nu="-1"))
    mutated("missing-original-plan", "Z2_ORIGINAL_PLAN_COVERAGE",
            lambda r: r["construction"]["certificates"][0].update(planCount=0))
    mutated("changed-original-utility", "Z2_CONSTRUCTION_BINDING",
            lambda r: next(n for n in r["problem"]["models"][0]["nodes"] if n["kind"] == "TERMINAL")["payoff"].__setitem__(0, "99"))
    mutated("weakened-native-sequential-floor", "Z2_NATIVE_FULL_Y3_FLOOR",
            lambda r: next(row for row in r["construction"]["candidate"]["strategy"].values() if "withhold" in row).update(ready="0", withhold="1"))
    mutated("convenient-off-path-beliefs", "Z2_NATIVE_FULL_Y3_FLOOR",
            lambda r: next(iter(r["construction"]["candidate"]["models"][0]["beliefs"].values())).update(
                {k: "0" for k in next(iter(r["construction"]["candidate"]["models"][0]["beliefs"].values()))}))
    mutated("grid-is-not-infeasibility", "Z2_ORIGINAL_INFEASIBILITY_PROOF_REQUIRED",
            lambda r: r["construction"].update(status="CHECKED_INFEASIBLE", infeasibility={"kind": "GRID_EXHAUSTION"}))
    mutated("rational-component-bound", "Z2_ARITHMETIC_BOUND",
            lambda r: r["construction"]["certificates"][0].update(nu=str(-(2**512))), status="INCOMPLETE")

    impossible = problem("impossible")
    exclusion = run("construct-full-family-exclusion", engine/"producer.py", {"problem": impossible, "budgetMs": 20000},
                    ("CHECKED_INFEASIBLE", "Z2_COMPLETE_STRICT_DOMINANCE_EXCLUSION"))
    run("full-family-exclusion", engine/"checker.py", {"problem": impossible, "construction": exclusion},
        ("CHECKED_INFEASIBLE", "Z2_ORIGINAL_FAMILY_INFEASIBILITY_CHECKED"))
    missing = copy.deepcopy(exclusion)
    missing["infeasibility"]["policies"] = []
    run("omitted-original-policy", engine/"checker.py", {"problem": impossible, "construction": missing},
        ("COUNTEREXAMPLE", "Z2_ORIGINAL_CANDIDATE_FAMILY_COVERAGE"))
    missing = copy.deepcopy(exclusion)
    missing["infeasibility"]["policies"][0]["dominance"][0]["steps"].pop()
    run("omitted-forced-information-set", engine/"checker.py", {"problem": impossible, "construction": missing},
        ("COUNTEREXAMPLE", "Z2_DOMINANCE_NOT_COMPLETE"))

    mixture = problem("mixture")
    candidate, left, right = baseline(native, mixture)
    run("mixture-native-unilateral-floor", native/"checker.py", {"problem": mixture, "candidate": candidate},
        ("CHECKED", "Y3_EXACT_SEQUENTIAL_ASSESSMENT"))
    witness = {"modelId": "m0", "coalition": ["P0", "P1"], "kind": "PROFITABLE_MIXTURE",
        "terms": [{"plan": left, "probability": "1/4"}, {"plan": right, "probability": "3/4"}],
        "gains": ["1/4", "1/4"]}
    counter = {"schema": "finnor.project-z.z2.construction.v1", "status": "CANDIDATE", "candidate": candidate,
        "problemDigest": digest(mixture), "profileDigest": pins[str(engine/"profile.json")],
        "certificates": [], "search": {"complete": False}, "counterstrategy": witness}
    checked = run("exact-original-mixture-quarter", engine/"checker.py", {"problem": mixture, "construction": counter},
                  ("COUNTEREXAMPLE", "Z2_CHECKED_PROFITABLE_CORRELATED_MIXTURE"))
    rows[-1]["passed"] &= checked.get("counterstrategy", {}).get("gains") == ["1/4", "1/4"] and \
        checked.get("counterstrategy", {}).get("independentlyVerifiedOriginalLocalPlans") is True
    counter_mutations = [
        ("private-pooling", "Z2_LOCAL_PLAN_DOMAIN", lambda w: w["terms"][0]["plan"].update({"I:unobserved-other-private-state": "left"})),
        ("future-anticipation", "Z2_LOCAL_PLAN_DOMAIN", lambda w: w["terms"][0]["plan"].update({"I:future-chance-before-draw": "left"})),
        ("illegal-local-action", "Z2_LOCAL_PLAN_ALPHABET", lambda w: w["terms"][0]["plan"].__setitem__(next(iter(w["terms"][0]["plan"])), "unauthorized")),
        ("invalid-simplex", "Z2_PRIMAL_SIMPLEX", lambda w: w["terms"][1].update(probability="1/2")),
        ("false-original-gains", "Z2_ORIGINAL_PRIMAL_GAINS", lambda w: w.update(gains=["1", "1"])),
        ("negative-mixture-weight", "Z2_PRIMAL_PROBABILITY", lambda w: w["terms"][0].update(probability="-1/4")),
    ]
    for name, reason, change in counter_mutations:
        forged = copy.deepcopy(counter)
        change(forged["counterstrategy"])
        run(name, engine/"checker.py", {"problem": mixture, "construction": forged}, ("COUNTEREXAMPLE", reason))

    adverse = copy.deepcopy(mixture)
    harmless = adverse["models"][0]
    for n in harmless["nodes"]:
        if n["kind"] == "TERMINAL" and n["id"].endswith(("join-left", "join-right")) and "-coordinate-" in n["id"]:
            n["payoff"] = [str(-int(v)) for v in n["payoff"]]
    bad = copy.deepcopy(mixture["models"][0])
    bad["id"], bad["qualificationRef"] = "adverse", reference("adverse-original-model")
    for n in bad["nodes"]:
        if n["kind"] == "CHANCE":
            n["probabilityBasis"]["identificationRef"] = bad["qualificationRef"]
    adverse["models"].append(bad)
    adverse["actorModelRefs"].append(bad["qualificationRef"])
    candidate, left, right = baseline(native, adverse)
    run("adverse-native-unilateral-floor", native/"checker.py", {"problem": adverse, "candidate": candidate},
        ("CHECKED", "Y3_EXACT_SEQUENTIAL_ASSESSMENT"))
    counter = copy.deepcopy(counter)
    counter.update(problemDigest=digest(adverse), candidate=candidate)
    counter["counterstrategy"].update(modelId="adverse", terms=[
        {"plan": left, "probability": "1/4"}, {"plan": right, "probability": "3/4"}])
    checked = run("one-adverse-model-not-averaged", engine/"checker.py", {"problem": adverse, "construction": counter},
                  ("COUNTEREXAMPLE", "Z2_CHECKED_PROFITABLE_CORRELATED_MIXTURE"))
    rows[-1]["passed"] &= checked.get("counterstrategy", {}).get("gains") == ["1/4", "1/4"] and \
        checked.get("counterstrategy", {}).get("modelId") == "adverse"
    unchanged = pins == inventory(engine, native)
    report = {"schema": "finnor.project-z.z2.original-process-falsifiers.v1", "cases": rows,
        "passed": sum(r["passed"] for r in rows), "failed": sum(not r["passed"] for r in rows),
        "sourcesUnchanged": unchanged, "sourceHashes": pins,
        "independentOriginalMixtureOracle": mixture_oracle,
        "oracle": "Original fixture outcomes (4,-2),(-1,1); ex-ante weights 1/4,3/4; exact gains 1/4,1/4. Adverse-model averaging cancels both gains.",
        "scope": "PUBLIC_TWO_PARTY_PROCESS_DEVELOPMENT_NOT_OWNER_OR_32x8_QUALIFICATION",
        "authenticatedOwner": "NOT_RUN", "nativePhysicalRecovery": "NOT_RUN", "protectedAdmission": False}
    (out/"report.json").write_text(json.dumps(report, indent=2)+"\n")
    hashes = {str(p.relative_to(out)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in sorted(out.rglob("*")) if p.is_file()}
    (out/"sha256.json").write_text(json.dumps(hashes, indent=2)+"\n")
    print(json.dumps({"passed": report["passed"], "failed": report["failed"], "sourcesUnchanged": unchanged}))
    return 1 if report["failed"] or not unchanged else 0


if __name__ == "__main__":
    raise SystemExit(main())
