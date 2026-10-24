"""Untrusted finite-grid proposal search.

Only original immutable protocol alternatives are selected. A proposal is
screened by the original-bytes checker, then independently checked again by
the caller in a new process. The exhaustive reference is not imported.
"""
import importlib.util
import itertools
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.realpath(__file__))
spec = importlib.util.spec_from_file_location("y3_original_checker", os.path.join(ROOT, "checker.py"))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)
Q, rat = checker.Q, checker.rat
PROFILE = checker.PROFILE

def distribution_rows(actions):
    grid = [rat(v) for v in PROFILE["prescribedBehaviorGrid"]]
    if len(actions) == 1:
        return [{actions[0]: "1"}]
    if len(actions) != 2:
        raise checker.Gap("Y3_ACTION_BOUND")
    first = [Q(1)] + [v for v in grid if v != 1]
    return [{actions[0]: str(p), actions[1]: str(Q(1) - p)} for p in first if Q(1) - p in grid]

def propose(problem, games, policy, strategy, bound):
    certificates, objectives = [], []
    for game in games:
        leading = {game["root"]: (0, Q(1))}
        for nid in game["sequence"]:
            order, coefficient = leading[nid]
            state = game["nodes"][nid]
            for action, child, probability in state["edges"]:
                child_order, child_coefficient = order, coefficient * probability
                if state["informationKey"] is not None:
                    behavior = rat(strategy[state["informationKey"]][action])
                    if behavior == 0:
                        child_order += 1
                    else:
                        child_coefficient *= behavior
                leading[child] = (child_order, child_coefficient)
        beliefs, trembles = {}, {}
        for key, info in game["infos"].items():
            minimum = min(leading[n][0] for n in info["nodeIds"])
            total = sum((leading[n][1] for n in info["nodeIds"] if leading[n][0] == minimum), Q(0))
            beliefs[key] = {n: str(leading[n][1] / total if leading[n][0] == minimum else Q(0)) for n in info["nodeIds"]}
            trembles[key] = {a: {"order": 1, "coefficient": "1"} for a in info["actionIds"]}
        certificates.append({"modelId": game["modelId"], "beliefs": beliefs, "trembles": trembles})
        values = {}
        for nid in reversed(game["sequence"]):
            state = game["nodes"][nid]
            n = state["original"]
            if n["kind"] == "TERMINAL":
                values[nid] = rat(n["ownerValue"])
            elif n["kind"] == "DECISION":
                values[nid] = sum((rat(strategy[state["informationKey"]][a]) * values[child] for a, child, _ in state["edges"]), Q(0))
            else:
                values[nid] = sum((p * values[child] for _, child, p in state["edges"]), Q(0))
        objectives.append(values[game["root"]])
    return {
        "schema": "finnor.interaction-candidate.v1", "problemDigest": checker.digest(problem),
        "profileDigest": checker.PROFILE_DIGEST, "policy": policy, "strategy": strategy,
        "models": certificates, "objective": str(min(objectives)), "upperBound": str(bound),
        "nontrivial": checker.nontrivial(problem, games)
    }

def construct(problem, budget_ms):
    deadline = time.monotonic() + budget_ms / 1000
    search = {
        "steps": 0, "policies": 0, "profiles": 0, "complete": False,
        "witnessFamily": "ONE_COMMON_UNIT_MONOMIAL_TABLE_PER_MODEL",
        "behaviorGrid": PROFILE["prescribedBehaviorGrid"],
        "uncovered": ["NON_GRID_BEHAVIOR", "NONUNIT_TREMBLE_COEFFICIENTS", "NONUNIT_TREMBLE_ORDERS", "ALGEBRAIC_ASSESSMENTS"]
    }
    def result(status, reasons, candidate=None):
        return {"status": status, "candidate": candidate, "reasons": reasons, "search": search}
    try:
        checker.schema(problem)
        bound = checker.objective_bound(problem)
        if bound < checker.known_quantity(problem["goal"]["minimumOwnerValue"]):
            proof = checker.inspect(problem, None)
            if proof["status"] == "INFEASIBLE":
                search["wholeFamilyGoalBound"] = str(bound)
                return result("INFEASIBLE", [proof["reason"]])
        controls = checker.control_keys(problem)
        ordered_keys = sorted(controls)
        all_options = [controls[k]["options"] for k in ordered_keys]
        for choices in itertools.product(*all_options):
            if time.monotonic() >= deadline or search["steps"] >= PROFILE["maxSearchSteps"]:
                return result("INCOMPLETE", ["Y3_SEARCH_RESOURCE_BOUND", "Y3_BELIEF_SEARCH_INCOMPLETE"])
            search["policies"] += 1; search["steps"] += 1
            policy = dict(zip(ordered_keys, choices))
            try:
                games = [checker.compile_original(problem, m, policy) for m in problem["models"]]
            except checker.Rejected:
                continue
            union = {}
            for game in games:
                for key, info in game["infos"].items():
                    if key in union and set(union[key]["actionIds"]) != set(info["actionIds"]):
                        raise checker.Rejected("Y3_CROSS_MODEL_INFORMATION_ALPHABET")
                    union[key] = info
            keys = list(union)
            rows = [distribution_rows(union[k]["actionIds"]) for k in keys]
            for profile in itertools.product(*rows):
                if time.monotonic() >= deadline or search["steps"] >= PROFILE["maxSearchSteps"]:
                    return result("INCOMPLETE", ["Y3_SEARCH_RESOURCE_BOUND", "Y3_BELIEF_SEARCH_INCOMPLETE"])
                search["profiles"] += 1; search["steps"] += 1
                strategy = dict(zip(keys, profile))
                candidate = propose(problem, games, policy, strategy, bound)
                if rat(candidate["objective"]) < checker.known_quantity(problem["goal"]["minimumOwnerValue"]):
                    continue
                checked = checker.inspect(problem, candidate)
                if checked["status"] == "CHECKED":
                    return result("CANDIDATE", ["Y3_INDEPENDENT_CHECK_REQUIRED", "Y3_SEARCH_NOT_COMPLETE"], candidate)
                if checked["status"] in ("UNKNOWN", "INCOMPLETE"):
                    return result("INCOMPLETE", [checked.get("reason", "Y3_CHECKER_GAP")])
        search["behaviorGridAndUnitWitnessesExhausted"] = True
        return result("INCOMPLETE", ["Y3_FINITE_GRID_EXHAUSTED_NOT_AN_INFEASIBILITY_PROOF", "Y3_BELIEF_SEARCH_INCOMPLETE"])
    except checker.Gap as error:
        return result("UNIDENTIFIED" if str(error) == "Y3_UNIDENTIFIED_CHANCE" else "UNKNOWN", [str(error)])
    except checker.Rejected as error:
        return result("UNSUPPORTED", [str(error)])
    except (MemoryError, RecursionError):
        return result("INCOMPLETE", ["Y3_PROCESS_RESOURCE_BOUND"])

def main():
    checker.configure_limits()
    maximum = PROFILE["maxRequestBytes"] + 65536
    raw = sys.stdin.buffer.read(maximum + 1)
    checker.need(len(raw) <= maximum, "Y3_PROCESS_INPUT_BOUND")
    request = json.loads(raw, object_pairs_hook=checker.unique_object, parse_constant=checker.reject_constants)
    checker.obj(request, ("problem", "budgetMs"))
    checker.need(type(request["budgetMs"]) is int and 0 <= request["budgetMs"] <= PROFILE["maxProcessWallMs"], "Y3_PROCESS_BUDGET")
    out = construct(request["problem"], request["budgetMs"])
    result = checker.canonical(out).encode()
    checker.need(len(result) <= PROFILE["maxProcessOutputBytes"], "Y3_PROCESS_OUTPUT_BOUND")
    sys.stdout.buffer.write(result)

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stdout.write(checker.canonical({
            "status": "UNKNOWN", "candidate": None, "reasons": [str(error)[:256] or "Y3_PROCESS_FAILURE"],
            "search": {"steps": 0, "policies": 0, "profiles": 0, "complete": False}
        }))
