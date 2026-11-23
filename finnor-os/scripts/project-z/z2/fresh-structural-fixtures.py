"""Pre-candidate original public fixtures; independent audit/oracle is separate."""
import argparse
import copy
from fractions import Fraction as F
import hashlib
import importlib.util
import json
from pathlib import Path


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(base, family, case):
    problem = base.build(family, case)
    problem["id"] = "fresh-20261026-"+problem["id"]
    for model in problem["models"]:
        tree = {n["id"]: n for n in model["nodes"]}
        if family == 28:
            extra = []
            for n in model["nodes"]:
                if n["kind"] == "DECISION" and n["date"] == 2 and n["participant"] == "P0":
                    assert [e["actionId"] for e in n["edges"]] == ["confirm"]
                    terminal = copy.deepcopy(tree[n["edges"][0]["next"]])
                    assert terminal["kind"] == "TERMINAL"
                    terminal["id"] += "-withdraw"
                    terminal["payoff"][0] = str(F(terminal["payoff"][0])-1)
                    n["edges"].append({"actionId": "withdraw", "next": terminal["id"]})
                    extra.append(terminal)
            model["nodes"].extend(extra)
            tree.update({n["id"]: n for n in extra})
        if family == 32:
            for n in model["nodes"]:
                n["observations"] = [o for o in n["observations"] if o["key"] != "s6-outcome-status"]
                if n["kind"] == "DECISION" and n["date"] == 2:
                    n["observations"].append({"key": "s6-outcome-status", "value": "UNKNOWN", "recipients": ["PUBLIC"]})

        def walk(nid, route=None):
            n = tree[nid]
            if n["kind"] == "TERMINAL" and (route == "authorized" or family == 30):
                n["payoff"] = [str(F(v)*(1+F((case+1)*(i+1)+n["state"][i]*(case+2), 17+case)))
                               for i, v in enumerate(n["payoff"])]
            for e in n.get("edges", []):
                walk(e["next"], e["actionId"] if n.get("controlId") == "evidence-route" else route)
        walk(model["root"])
    return problem


def freeze(repo, out, spec):
    scripts = repo/"finnor-os/scripts/project-z/z2"
    base = load("original_public_blueprint", scripts/"structural-fixtures.py")
    audit = load("independent_original_structure", scripts/"structural-audit.py")
    out.mkdir(parents=True, exist_ok=False)
    rows, structures = [], {}
    for family in range(1, 33):
        fresh = set()
        for case in range(8):
            problem = build(base, family, case)
            expected = audit.expectations(problem, family)
            structure = audit.invariant(problem)
            numeric = audit.invariant(problem, numeric=True)
            if case == 0:
                renamed = audit.relabel(problem)
                assert structure == audit.invariant(renamed), ("LABEL_DEPENDENT_STRUCTURE", family)
                assert numeric == audit.invariant(renamed, numeric=True), ("LABEL_DEPENDENT_FRESHNESS", family)
            fresh.add(numeric)
            name = str(family).zfill(2)+"-"+str(case)
            target = out/name
            target.mkdir()
            for filename, value in [("problem.json", problem), ("expected.json", expected)]:
                (target/filename).write_text(json.dumps(value, sort_keys=True, indent=2)+"\n")
            rows.append({"family": family, "case": case, "name": base.NAMES[family-1],
                         "problem": name+"/problem.json", "expectation": name+"/expected.json",
                         "problemSha256": hashlib.sha256((target/"problem.json").read_bytes()).hexdigest(),
                         "expectationSha256": hashlib.sha256((target/"expected.json").read_bytes()).hexdigest(),
                         "structuralInvariant": structure, "affineInvariant": numeric,
                         "expected": expected["expected"]})
            if case == 0:
                structures.setdefault(structure, []).append(family)
        assert len(fresh) == 8, ("RENAMED_OR_AFFINE_REPETITION", family, len(fresh))
    collision = [v for v in structures.values() if len(v) > 1]
    result = {"schema": "finnor.project-z.z2.fresh-original-registration.v1",
              "status": "FROZEN" if not collision else "STRUCTURAL_COLLISION",
              "familyCount": len(structures), "casesPerFamily": 8, "cases": rows,
              "structuralCollisions": collision, "protectedCases": False,
              "independentOracle": "ORIGINAL_INPUT_COMPONENTWISE_UPPER_AND_EXHAUSTIVE_LOCAL_PLANS",
              "candidateInvocationsBeforeFreeze": 0,
              "failureMapSha256": hashlib.sha256(spec.read_bytes()).hexdigest(),
              "equipment": {str(p.relative_to(repo)): hashlib.sha256(p.read_bytes()).hexdigest()
                            for p in [scripts/"structural-fixtures.py", scripts/"fresh-structural-fixtures.py",
                                      scripts/"structural-audit.py", scripts/"original-oracle.py"]}}
    (out/"registration.json").write_text(json.dumps(result, sort_keys=True, indent=2)+"\n")
    print(json.dumps({"status": result["status"], "structuralFamilyCount": len(structures),
                      "cases": len(rows), "collisions": collision}))
    return int(bool(collision))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--failure-map", required=True, type=Path)
    args = parser.parse_args()
    raise SystemExit(freeze(args.repo.resolve(), args.out.resolve(), args.failure_map.resolve()))
