"""Independent finite oracle. No producer imports, network, credentials or plugins."""
import hashlib
import itertools
import json
import math
import os
import platform
import resource
import sys
import time

resource.setrlimit(resource.RLIMIT_AS, (268435456, 268435456))
resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
START = time.process_time()
HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "profile.json"), encoding="utf8") as source:
    PROFILE = json.load(source)


class WireFloat(float):
    """Retain the JSON number emitted by the caller, not Python's spelling.
    Transport custody only; decision arithmetic mirrors the S4 binary64 owner."""
    def __new__(cls, token):
        value = super().__new__(cls, token)
        value.token = token
        return value

    def __str__(self):
        return self.token


def canonical(value):
    if isinstance(value, WireFloat):
        return value.token
    if isinstance(value, list):
        return "[" + ",".join(canonical(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(canonical(k) + ":" + canonical(value[k]) for k in sorted(value)) + "}"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def byte_digest(path):
    with open(path, "rb") as source:
        return hashlib.sha256(source.read()).hexdigest()


def demand(predicate, reason):
    if not predicate:
        raise ValueError(reason)


def integer(value, lo=-32, hi=32):
    return type(value) is int and lo <= value <= hi


def validate_problem(p):
    demand(p["schema"] == "finnor.strategic-response-problem.v1", "PROBLEM_SCHEMA")
    actors = [a["id"] for a in p["actors"]]
    demand(2 <= len(actors) <= 3 and len(set(actors)) == len(actors), "ACTOR_DOMAIN")
    demand(all(a["privateInformation"] == "OWN_OUTSIDE_OPTION_AND_OWN_PREVIOUS_CHOICE" and
               a["outcomeVisibility"] == "PUBLIC" for a in p["actors"]), "INFORMATION_BOUNDARY")
    rules = {r["id"]: r for r in p["rules"]}
    demand(1 <= len(rules) == len(p["rules"]) <= PROFILE["maximumRules"], "RULE_DOMAIN")
    for rule in rules.values():
        demand(set(rule) == {"id", "incentive", "interaction", "peerDisclosure", "settlement", "allocation", "transfer"}, "RULE_MEANING_KEYS")
        demand(integer(rule["incentive"]) and integer(rule["interaction"], 0, 2) and
               rule["peerDisclosure"] in ("LAGGED_PEER_COUNT", "NONE") and
               rule["settlement"] == "ALL_ACTORS_PARTICIPATE" and rule["allocation"] == "JOINT_ALL_OR_NONE" and
               rule["transfer"] == "DECLARED_FIXED_INCENTIVE", "PUBLIC_RULE_MEANING")
    episodes = p["training"] + p["holdout"]
    demand(len(p["training"]) >= 64 and len(p["holdout"]) >= 20 and len(episodes) <= 256, "EVIDENCE_BOUND")
    demand(len({e["id"] for e in episodes}) == len(episodes), "EPISODE_LEAKAGE_OR_DUPLICATE")
    for e in episodes:
        demand(set(e["initial"]) == set(actors) and all(integer(v, 0, 1) for v in e["initial"].values()), "JOINT_INITIAL")
        demand(1 <= len(e["rounds"]) <= 4, "PERIOD_BOUND")
        demand(e["origin"] != "REQUESTED_EXPERIMENT" or e["execution"] == "REQUESTED", "REQUEST_NOT_OBSERVATION")
        for row in e["rounds"]:
            demand(row["ruleId"] in rules and set(row["choices"]) == set(actors) and
                   set(row["outsideOptions"]) == set(actors), "JOINT_ROUND_MEANING")
            demand(all(integer(v, 0, 1) for v in row["choices"].values()) and
                   all(integer(v) for v in row["outsideOptions"].values()) and integer(row["commonSignal"]), "EXACT_SCORE_INPUT")
            demand(e["assignment"] != "INCUMBENT_OBSERVATIONAL" or rules[row["ruleId"]]["interaction"] == 0, "FALSE_INCUMBENT")
    demand(p["payoff"]["scale"] == "1" and p["payoff"]["unit"] == p["payoff"]["currency"] and
           p["payoff"]["accountingBasis"] == "GROSS_JOINT_PAYOFF_BEFORE_ACTION_COSTS", "MONEY_MEANING")
    money = p["payoff"]["jointPayoff"]
    demand(str(int(money)) == money and 0 <= int(money) <= 1000000, "CANONICAL_RESOURCE_QUANTITY")
    return actors, rules


def parameters(p):
    actors = [a["id"] for a in p["actors"]]
    out = []
    for values, weight, peer, tie in itertools.product(
            itertools.product((0, 1, 2), repeat=len(actors)), (1, 2), (-2, 0, 2), ("PARTICIPATE", "DECLINE", "INERTIA")):
        body = {"bias": dict(zip(actors, values)), "incentiveWeight": weight, "peerWeight": peer, "tie": tie}
        out.append(dict(body, id="response-hypothesis:" + digest(body)))
    return sorted(out, key=lambda m: m["id"])


def choose(m, actor, own_type, own_previous, public_peer_count, public_signal, rule):
    # This signature cannot access another actor's type or simultaneous action.
    value = (m["bias"][actor] + m["incentiveWeight"] * rule["incentive"] - own_type + public_signal)
    if rule["peerDisclosure"] == "LAGGED_PEER_COUNT":
        value += m["peerWeight"] * rule["interaction"] * public_peer_count
    if value != 0:
        return int(value > 0)
    return 1 if m["tie"] == "PARTICIPATE" else 0 if m["tie"] == "DECLINE" else own_previous


def transition(p, m, old, rule, private, signal):
    public_count = sum(old.values())
    return {a["id"]: choose(m, a["id"], private[a["id"]], old[a["id"]],
                            public_count - old[a["id"]], signal, rule) for a in p["actors"]}


def fit(p):
    actors, rules = validate_problem(p)
    all_models = parameters(p)
    established = all(p["assumptions"].values())
    usable = lambda e: (established and e["execution"] == "OBSERVED" and e["origin"] != "REQUESTED_EXPERIMENT" and
                        e["assignment"] in ("INCUMBENT_OBSERVATIONAL", "PERMITTED_RANDOMIZED"))
    training = [e for e in p["training"] if usable(e)]
    applications = 0

    def agrees(m, e):
        nonlocal applications
        previous = e["initial"]
        for row in e["rounds"]:
            applications += len(actors)
            demand(applications <= 2000000, "CHECKER_APPLICATION_BOUND")
            previous = transition(p, m, previous, rules[row["ruleId"]], row["outsideOptions"], row["commonSignal"])
            if previous != row["choices"]:
                return False
        return True

    retained = [m for m in all_models if all(agrees(m, e) for e in training)]
    holdout = [e for e in p["holdout"] if e["execution"] == "OBSERVED" and e["origin"] != "REQUESTED_EXPERIMENT"]
    covered = sum(any(agrees(m, e) for m in retained) for e in holdout)
    return {"schema": "finnor.strategic-fitted-set.v1", "profileDigest": digest(PROFILE), "problemDigest": digest(p),
            "status": "UNIDENTIFIED" if not established or len(training) < 64 else "FITTED" if retained else "NO_SUPPORTED_MODEL",
            "hypotheses": retained, "universeSize": len(all_models), "semanticApplications": applications,
            "training": {"eligibleEpisodeIds": [e["id"] for e in training], "ignoredEpisodeIds": [e["id"] for e in p["training"] if not usable(e)]},
            "holdout": {"episodes": len(holdout), "coveredCompleteJointTrajectories": covered, "empiricalCalibrationEstablished": False},
            "identification": {"structuralFamilies": sorted({m["peerWeight"] for m in retained}),
                               "behaviorSelections": sorted({m["tie"] for m in retained}),
                               "basis": "FINITE_STRUCTURAL_CLASS_CONDITIONAL_ON_DECLARED_ASSUMPTIONS",
                               "pointIdentifiedInClass": len(retained) == 1, "fieldIdentificationEstablished": False},
            "omittedModelGap": "UNKNOWN", "probabilityWeights": None}


def paths(p, m, q):
    demand(m["status"] == "FITTED" and len(m["hypotheses"]) > 0, "SUPPORTED_MODEL_REQUIRED")
    actors = {a["id"] for a in p["actors"]}
    h = len(q["ruleIds"])
    demand(p["transport"]["status"] == "CONDITIONAL" and q["context"] in p["transport"]["contexts"], "TRANSPORT")
    demand(1 <= h <= 4 and set(q["initial"]) == actors, "QUERY_HISTORY")
    demand(1 <= len(q["jointPrivatePaths"]) <= 4 and 1 <= len(q["sharedSignalPaths"]) <= 4, "PATH_BOUND")
    demand(len({s["id"] for s in q["jointPrivatePaths"]}) == len(q["jointPrivatePaths"]) and
           len({s["id"] for s in q["sharedSignalPaths"]}) == len(q["sharedSignalPaths"]), "PATH_IDENTITY")
    outside_range, common_range = p["transport"]["outsideOptionRange"], p["transport"]["commonSignalRange"]
    for s in q["jointPrivatePaths"]:
        demand(set(s["outsideOptions"]) == actors and all(len(v) == h and all(integer(x) and outside_range[0] <= x <= outside_range[1] for x in v)
               for v in s["outsideOptions"].values()), "PRIVATE_TRANSPORT")
    for s in q["sharedSignalPaths"]:
        demand(len(s["values"]) == h and all(integer(x) and common_range[0] <= x <= common_range[1] for x in s["values"]), "COMMON_TRANSPORT")
    result = list(itertools.product(m["hypotheses"], q["jointPrivatePaths"], q["sharedSignalPaths"]))
    demand(len(result) <= 512, "COMPLETE_JOINT_WORLD_BOUND")
    return result


def forecast(p, m, q):
    all_paths = paths(p, m, q)
    rules = {r["id"]: r for r in p["rules"]}
    result = []
    for hypothesis, private, signal in all_paths:
        previous = q["initial"]
        rows = []
        for t, rule_id in enumerate(q["ruleIds"]):
            previous = transition(p, hypothesis, previous, rules[rule_id],
                                  {a: values[t] for a, values in private["outsideOptions"].items()}, signal["values"][t])
            rows.append({"ruleId": rule_id, "choices": previous,
                         "jointPayoff": p["payoff"]["jointPayoff"] if all(previous.values()) else "0"})
        identity = {"hypothesisId": hypothesis["id"], "privatePathId": private["id"], "signalPathId": signal["id"]}
        result.append(dict(identity, worldId=digest(identity), rounds=rows))
    return {"schema": "finnor.strategic-prediction.v1", "modelDigest": digest(m), "queryDigest": digest(q),
            "trajectories": result, "probabilityWeights": None,
            "qualification": "CONDITIONAL_JOINT_MODEL_SET_NOT_CALIBRATED_FIELD_PREDICTION"}


def check_decision(p, model, query, mandate, control, bindings, candidate):
    """Rebuild all admissible open-loop programmes from original owner contracts.
    This first information profile has no new observations; hidden worlds cannot
    select actions. Resources, STOP, locked durations and tail debt are retained."""
    all_paths = paths(p, model, query)
    demand(control["schema"] == "finnor.control-problem.v1" and not control.get("continuation") and
           not control["observations"], "S4_INFORMATION_PROFILE")
    demand(all(o["status"] == "SETTLED" and o["terminalLiability"] is not None for o in control["obligations"]), "S6_PENDING_RESPONSIBILITY")
    demand(mandate["ambiguity"]["kind"] == "ROBUST_FIXED_JOINT_SCENARIOS", "AMBIGUITY")
    demand(mandate["horizon"]["periods"] == len(query["ruleIds"]), "FULL_HORIZON")
    demand(control["modelRef"] == candidate["bindings"]["modelRef"] and control == candidate["problem"] and
           mandate == candidate["mandate"], "ORIGINAL_MANDATE_AND_PROBLEM")
    h = mandate["horizon"]["periods"]
    actions = {a["id"]: a for a in control["actions"]}
    rules = {r["id"]: r for r in p["rules"]}
    bound = {b["actionId"]: b["ruleIds"] for b in bindings}
    demand(len(bound) == len(bindings) and set(bound) == {a["id"] for a in actions.values() if a["kind"] == "INTERVENE"}, "ACTION_RULE_IDENTITIES")
    demand(not mandate["utility"].get("operatingProfit") and not any(a["kind"] == "INQUIRE" for a in actions.values()), "ACCOUNTING_PROFILE")
    demand(all(not a.get("precondition", {}).get("observations") for a in actions.values()), "PRIVATE_BRANCH_DENIED")
    for label, rule_ids, exposures in [(None, query["ruleIds"], control["baselineExposures"])] + [
            (a, bound[a], actions[a]["exposures"]) for a in bound]:
        demand(set(exposures) == {"incentive", "interaction"} and len(exposures["incentive"]) == len(rule_ids) == len(exposures["interaction"]), "PUBLIC_SCHEDULE")
        demand(all(rules[r]["incentive"] == exposures["incentive"][t] and rules[r]["interaction"] == exposures["interaction"][t]
                   for t, r in enumerate(rule_ids)), "RULE_MEANING_NOT_NUMERICAL_ALIAS")
    demand(candidate["certificate"]["completeSearch"] is True, "INCOMPLETE_S4_SEARCH")
    # S4 uses left-to-right IEEE-754 binary64 operations, not exact rationals
    # or Python's compensated sum. Check that same declared numeric contract.
    f = float

    def add_all(values):
        total = 0.0
        for value in values:
            total += value
        return total

    dims = {r["id"]: r for r in mandate["resources"]["dimensions"]}
    tail = f(mandate["utility"]["tail"]["terminalLiability"]) + add_all(f(o["terminalLiability"]) for o in control["obligations"])
    best = None
    feasible = {}
    evaluated = 0

    def consider(history):
        nonlocal best, evaluated
        spent = {d: 0.0 for d in dims}
        occupancy = {d: [0.0] * h for d in dims}
        liability, humans, stopped = tail, 0.0, False
        rule_schedule = list(query["ruleIds"])
        locked_until = 0
        for t, action_id in enumerate(history):
            a = actions[action_id]
            if (stopped and a["kind"] != "STOP" or t < a["earliestPeriod"] or t > a["lastPeriod"] or
                    a["atMostOnce"] and (action_id in history[:t] or any(o["actionId"] == action_id for o in control["obligations"])) or
                    any(i not in history[:t] for i in a.get("precondition", {}).get("afterActionIds", []))):
                return
            if a["kind"] == "INTERVENE":
                if t < locked_until or t + len(bound[action_id]) > h:
                    return
                rule_schedule[t:t + len(bound[action_id])] = bound[action_id]
                locked_until = t + len(bound[action_id])
            stopped |= a["kind"] == "STOP"
            liability += f(a["tailLiability"])
            humans += f(a["humanSeconds"])
            for d in dims:
                spent[d] += f(a["resources"][d])
                for k in range(t, min(h, t + a["occupationPeriods"])):
                    occupancy[d][k] += f(a["occupancy"][d])
        if humans > f(mandate["search"]["maxHumanSeconds"]) or any(
                spent[d] > f(r["totalLimit"]) or any(v > f(r["capacity"]) for v in occupancy[d]) for d, r in dims.items()):
            return
        if any(add_all(f(w) * occupancy[d][t] for d, w in coupling["weights"].items()) > f(coupling["maxPerPeriod"])
               for coupling in mandate["resources"]["couplings"] for t in range(h)):
            return
        values = []
        for hypothesis, private, signal in all_paths:
            previous = query["initial"]
            value = 0.0
            state = None
            for t, rule_id in enumerate(rule_schedule):
                evaluated += len(p["actors"])
                demand(evaluated <= PROFILE["maximumSemanticApplicationsPerAttempt"], "DECISION_ORACLE_WORK_BOUND")
                previous = transition(p, hypothesis, previous, rules[rule_id],
                                      {a: v[t] for a, v in private["outsideOptions"].items()}, signal["values"][t])
                state = dict(("actor_" + a, v) for a, v in previous.items())
                state["joint_payoff"] = int(p["payoff"]["jointPayoff"]) if all(previous.values()) else 0
                period_value = add_all(f(term["coefficient"]) * state[term["variableId"]] for term in mandate["utility"]["periodTerms"])
                value += f(mandate["utility"]["discountFactors"][t]) * (period_value - f(actions[history[t]]["cost"]))
                demand(math.isfinite(value), "NONFINITE_UTILITY")
            value += f(mandate["utility"]["discountFactors"][h]) * (
                add_all(f(term["coefficient"]) * state[term["variableId"]] for term in mandate["utility"]["terminalTerms"]) - liability)
            demand(math.isfinite(value), "NONFINITE_TERMINAL_VALUE")
            if value < f(mandate["risk"]["minimumUtility"]):
                return
            values.append(value)
        worst = min(values)
        feasible[history] = worst
        best = worst if best is None else max(best, worst)

    for history in itertools.product(actions.keys(), repeat=h):
        consider(history)
    nodes = {n["id"]: n for n in candidate["nodes"]}
    demand(len(nodes) == len(candidate["nodes"]), "POLICY_NODE_IDENTITY")
    node, chosen, seen = nodes[candidate["rootNodeId"]], [], set()
    for t in range(h):
        demand(node["period"] == t and node["actionHistory"] == chosen and not node["observations"] and
               node["actionId"] in actions, "NONANTICIPATIVE_PUBLIC_PROGRAMME")
        chosen.append(node["actionId"])
        seen.add(node["id"])
        if t < h - 1:
            demand(len(node["branches"]) == 1 and node["branches"][0]["observationKey"] == "[]", "PRIVATE_WORLD_BRANCH")
            node = nodes[node["branches"][0]["childId"]]
        else:
            demand(not node["branches"], "TERMINAL_POLICY")
    history = tuple(chosen)
    demand(len(seen) == len(nodes) and history in feasible and feasible[history] == best, "WRONG_ROBUST_PROGRAMME")
    demand(all(f(v) == best for v in candidate["certificate"]["valueBounds"]) and
           all(f(v) == best for v in candidate["certificate"]["optimalBounds"]) and
           candidate["certificate"]["worlds"] == len(all_paths), "FALSE_DECISION_CERTIFICATE")
    demand(all(all(f(v) == best for v in node["valueBounds"]) for node in candidate["nodes"]), "FALSE_NODE_VALUE")
    return len(all_paths)


def main():
    raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    demand(len(raw) <= 8 * 1024 * 1024, "INPUT_BOUND")
    request = json.loads(raw, parse_float=WireFloat)
    operation, inputs, candidate = request["operation"], request["input"], request["candidate"]
    result = {"schema": "finnor.strategic-independent-check.v1", "operation": operation,
              "inputDigest": digest(inputs), "candidateDigest": digest(candidate), "profileDigest": digest(PROFILE),
              "checkerDigest": byte_digest(__file__), "interpreterDigest": byte_digest(sys.executable),
              "interpreterVersion": platform.python_version(), "executionAuthorityGranted": False, "protectedQualification": False}
    try:
        p = inputs["problem"]
        expected = fit(p)
        if operation == "FIT":
            demand(expected == candidate, "FITTED_SET_OR_ALTERNATIVES_DIFFER")
            worlds = len(expected["hypotheses"])
        else:
            demand(expected == inputs["model"], "UNBOUND_OR_CORRUPTED_FITTED_STATE")
            if operation == "PREDICT":
                demand(forecast(p, expected, inputs["query"]) == candidate, "JOINT_PREDICTION_DIFFERS")
                worlds = len(candidate["trajectories"])
            else:
                demand(operation == "DECISION", "OPERATION")
                worlds = check_decision(p, expected, inputs["query"], inputs["mandate"], inputs["control"], inputs["actionRules"], candidate)
        result.update(status="CHECKED", nonVacuous=worlds > 0, checkedWorlds=worlds)
    except (ValueError, KeyError, IndexError, TypeError, ZeroDivisionError):
        result.update(status="REJECTED", reason="INDEPENDENT_FINITE_CONTRACT_OR_DENOTATION_MISMATCH")
    result.update(cpuMs=round((time.process_time() - START) * 1000, 3), peakRssBytes=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024)
    print(canonical(result))


if __name__ == "__main__":
    main()
