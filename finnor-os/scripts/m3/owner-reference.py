"""Independent finite economic interpreter. No FINNOR/M3 imports or answers."""
from fractions import Fraction as F
import copy
import json
import sys

data = json.load(sys.stdin)


def q(value):
    return F(str(value))


def feature(term, history, exposure):
    if term["kind"] == "PRODUCT":
        return feature(term["left"], history, exposure) * feature(term["right"], history, exposure)
    if term["kind"] == "CONSTANT":
        return F(1)
    if term["kind"] == "EXPOSURE" and term["lag"] == 0:
        return exposure[term["id"]]
    return q(history[-term["lag"]]["states" if term["kind"] == "STATE" else "exposures"][term["id"]])


def advance(world, exposure, period):
    mechanism, scenario = world["mechanism"], world["scenario"]
    states = {}
    for i, equation in enumerate(mechanism["equations"]):
        states[equation["variableId"]] = sum(
            feature(term, world["history"], exposure) * q(scenario["coefficients"][i][j])
            for j, term in enumerate(equation["features"])
        ) + q(scenario["shocks"][period][i])
    result = dict(world)
    result["history"] = result["history"][-2:] + [{"states": states, "exposures": exposure}]
    return result


def value_terms(states, terms):
    return sum((q(term["coefficient"]) * states[term["variableId"]] for term in terms), F(0))


def finite_policy(problem, mandate, model, kernel, protocols):
    """Full action-tree enumeration over lawful controller information classes."""
    horizon = mandate["horizon"]["periods"]
    dimensions = mandate["resources"]["dimensions"]
    actions = problem["actions"]
    worlds = []
    for mechanism in kernel["mechanisms"]:
        for scenario in mechanism["scenarios"]:
            worlds.append({
                "mechanism": mechanism, "scenario": scenario,
                "history": copy.deepcopy(model["history"]["rows"][-3:]),
                "utility": F(0), "tail": q(mandate["utility"]["tail"]["terminalLiability"]),
                "schedule": {key: [q(v) for v in values] for key, values in problem["baselineExposures"].items()},
                "spent": {d["id"]: F(0) for d in dimensions},
                "occupancy": {d["id"]: [F(0)] * horizon for d in dimensions},
                "locked": {}, "pending": [], "observations": [],
            })
    if problem.get("continuation") or problem["obligations"]:
        raise ValueError("REFERENCE_CONTINUATION_OR_OBLIGATION_DOMAIN_NOT_REGISTERED")

    def search(paths, period, history, stopped=False):
        if period == horizon:
            values = [
                world["utility"] + q(mandate["utility"]["discountFactors"][horizon]) * (
                    value_terms(world["history"][-1]["states"], mandate["utility"]["terminalTerms"]) - world["tail"]
                ) for world in paths
            ]
            if min(values) < q(mandate["risk"]["minimumUtility"]):
                return None
            return min(values)
        best = None
        for action in actions:
            if stopped and action["kind"] != "STOP":
                continue
            if not action["earliestPeriod"] <= period <= action["lastPeriod"]:
                continue
            if action["atMostOnce"] and action["id"] in history:
                continue
            pre = action.get("precondition")
            if pre:
                if any(action_id not in history for action_id in pre["afterActionIds"]):
                    continue
                if any(not any(
                    observation["instrumentId"] == condition["instrumentId"]
                    and observation["token"] in condition["tokens"]
                    and observation["availablePeriod"] <= period
                    for observation in paths[0]["observations"]
                ) for condition in pre["observations"]):
                    continue
            children = []
            eligible = True
            for old in paths:
                # Mechanisms, scenarios and history rows are read-only. Copy
                # every controller-owned mutable collection, not the model graph.
                world = {**old,
                         "schedule": {key: values[:] for key, values in old["schedule"].items()},
                         "spent": dict(old["spent"]),
                         "occupancy": {key: values[:] for key, values in old["occupancy"].items()},
                         "locked": dict(old["locked"]), "pending": old["pending"][:],
                         "observations": old["observations"][:]}
                for dimension in dimensions:
                    key = dimension["id"]
                    world["spent"][key] += q(action["resources"][key])
                    for t in range(period, min(horizon, period + action["occupationPeriods"])):
                        world["occupancy"][key][t] += q(action["occupancy"][key])
                    if world["spent"][key] > q(dimension["totalLimit"]) or max(world["occupancy"][key]) > q(dimension["capacity"]):
                        eligible = False
                if action["kind"] == "INTERVENE":
                    for channel, doses in action["exposures"].items():
                        if period + len(doses) > horizon or world["locked"].get(channel, 0) > period:
                            eligible = False
                            break
                        world["schedule"][channel][period:period + len(doses)] = [q(dose) for dose in doses]
                        world["locked"][channel] = period + len(doses)
                if not eligible:
                    break
                exposure = {key: values[period] for key, values in world["schedule"].items()}
                world = advance(world, exposure, period)
                world["utility"] += q(mandate["utility"]["discountFactors"][period]) * (
                    value_terms(world["history"][-1]["states"], mandate["utility"]["periodTerms"]) - q(action["cost"])
                )
                world["tail"] += q(action["tailLiability"])
                for instrument in problem["observations"]:
                    if action["id"] not in instrument["afterActionIds"]:
                        continue
                    value = world["history"][-1]["states"][instrument["variableId"]]
                    bins = [b for b in instrument["bins"] if q(b["lowerInclusive"]) <= value < q(b["upperExclusive"])]
                    if len(bins) != 1:
                        eligible = False
                        break
                    world["pending"].append({
                        "instrumentId": instrument["id"], "token": bins[0]["category"],
                        "availablePeriod": period + instrument["delayPeriods"],
                    })
                if not eligible:
                    break
                tokens = [None]
                if action["kind"] == "INQUIRE":
                    protocol = next(p for p in protocols if p["id"] == action["protocolRef"]["id"]
                                    and p["contentDigest"] == action["protocolRef"]["contentDigest"])
                    if protocol["candidate"]["likelihood"]["status"] != "SUPPLIED_CONDITIONAL":
                        raise ValueError("REFERENCE_INQUIRY_CONDITIONAL_LAW_NOT_SUPPLIED")
                    mechanism_index = next(i for i, m in enumerate(model["request"]["mechanisms"])
                                           if m["id"] == world["mechanism"]["mechanismId"])
                    probabilities = protocol["candidate"]["likelihood"]["probabilities"][mechanism_index]
                    tokens = [json.dumps({"counts": o["counts"], "sampleSize": o["sampleSize"], "stop": o["stop"]},
                                         separators=(",", ":"))
                              for o in protocol["metrics"]["observations"]
                              if all(n == 0 or q(probabilities[i]) > 0 for i, n in enumerate(o["counts"]))]
                for token in tokens:
                    child = {**world, "pending": world["pending"][:],
                             "observations": world["observations"][:]}
                    if token is not None:
                        child["pending"].append({"instrumentId": action["protocolRef"]["id"], "token": token,
                                                 "availablePeriod": period + action["informationDelayPeriods"]})
                    child["observations"] += [o for o in child["pending"] if o["availablePeriod"] == period + 1]
                    child["pending"] = [o for o in child["pending"] if o["availablePeriod"] > period + 1]
                    children.append(child)
            if not eligible:
                continue
            groups = {}
            for world in children:
                key = json.dumps(world["observations"], sort_keys=True)
                groups.setdefault(key, []).append(world)
            results = [search(group, period + 1, history + [action["id"]], stopped or action["kind"] == "STOP")
                       for group in groups.values()]
            if not results or any(value is None for value in results):
                continue
            value = min(results)
            if best is None or value > best:
                best = value
        return best

    result = search(worlds, 0, [])
    return {"value": str(result) if result is not None else None, "worlds": len(worlds),
            "semantics": "EXACT_FRACTIONS_OF_RETAINED_DECIMAL_NUMERICS_NO_PROBABILITIES",
            "support": "OWNER_SUPPORT_CHECK_REQUIRED_REFERENCE_DOES_NOT_CERTIFY_SCIENTIFIC_SUPPORT"}


def examples():
    original = [{"id": "A", "ev": F(120), "ebitda": F(20), "debt": F(70), "payoff": F(20)},
                {"id": "B", "ev": F(100), "ebitda": F(25), "debt": F(50), "payoff": F(18)},
                {"id": "C", "ev": F(90), "ebitda": F(15), "debt": F(45), "payoff": F(14)}]
    results = []
    for leverage, reserve in [(F("3.5"), F(0)), (F(3), F(0)), (F("3.5"), F(25))]:
        rows = []
        for mask in range(8):
            chosen = [row for i, row in enumerate(original) if mask & (1 << i)]
            equity = sum((row["ev"] - min(row["debt"], row["ebitda"] * leverage) for row in chosen), F(0))
            payoff = sum((row["payoff"] for row in chosen), F(0))
            rows.append({"selected": [r["id"] for r in chosen], "equity": str(equity), "payoff": str(payoff),
                         "feasible": equity <= F(95) - reserve})
        best = max((row for row in rows if row["feasible"]), key=lambda row: q(row["payoff"]))
        results.append({"leverage": str(leverage), "reserve": str(reserve), "rows": rows, "best": best})
    return {"abc": results, "transaction40m": [
        {"p": str(p), "value": str(F(18) - F(50) * p), "incumbent": "3"}
        for p in (F("0.1"), F("0.6"), F("0.3"))]}


def allocations(problem):
    """Independent prefix, occupation, signed simultaneous and choice checker."""
    horizon = problem["mandate"]["horizon"]["periods"]
    resources = problem["resources"]
    results = []

    def usage(kind, values, period):
        return sum(values[:period + 1], F(0)) if kind in ("STOCK", "CUMULATIVE_EXPENDITURE") else values[period]

    for mask in range(1 << len(problem["policies"])):
        selected = sorted(p["ref"]["id"] for i, p in enumerate(problem["policies"]) if mask & (1 << i))
        reasons, values = [], []
        for constraint in problem["jointModel"]["choiceConstraints"]:
            count = len(set(selected) & set(constraint["policyIds"]))
            if not constraint["minimum"] <= count <= constraint["maximum"]:
                reasons.append("CHOICE")
        for scenario in problem["jointModel"]["scenarios"]:
            base = {r["resourceId"]: [q(v) for v in r["existingUse"]] for r in resources}
            lower = copy.deepcopy(base)
            increment = {r["resourceId"]: [F(0)] * (horizon + 1) for r in resources}
            spent = {d["id"]: F(0) for d in problem["mandate"]["resources"]["dimensions"]}
            occupancy = {key: [F(0)] * (horizon + 1) for key in spent}
            for outstanding in problem["outstanding"]:
                if any(ref["id"] in selected for ref in outstanding["policyRefs"]):
                    reasons.append("ALREADY_COMMITTED")
                for envelope in outstanding["envelopes"]:
                    for t in range(horizon + 1):
                        base[envelope["resourceId"]][t] += q(envelope["quantities"][t])
                        lower[envelope["resourceId"]][t] += q(envelope["minimumQuantities"][t])
            for policy in problem["policies"]:
                if policy["ref"]["id"] not in selected:
                    continue
                path = next(path for path in scenario["policyPaths"] if path["policyRef"]["id"] == policy["ref"]["id"])
                funding = next(f for f in problem["funding"] if f["policyRef"]["id"] == policy["ref"]["id"])
                for node_id in path["nodeIds"]:
                    node = next(n for n in policy["nodes"] if n["id"] == node_id)
                    action = next(a for a in policy["problem"]["actions"] if a["id"] == node["actionId"])
                    period = node["period"]
                    for key in spent:
                        spent[key] += q(action["resources"][key])
                        for t in range(period, min(horizon + 1, period + action["occupationPeriods"])):
                            occupancy[key][t] += q(action["occupancy"][key])
                    for binding in problem["demandBindings"]:
                        if binding["policyRef"]["id"] != policy["ref"]["id"]:
                            continue
                        if binding["component"] == "TOTAL":
                            increment[binding["resourceId"]][period] += q(action["resources"][binding["dimensionId"]])
                        else:
                            for t in range(period, min(horizon + 1, period + action["occupationPeriods"])):
                                increment[binding["resourceId"]][t] += q(action["occupancy"][binding["dimensionId"]])
                    for key, field, t in (("actionCostResourceId", "cost", period),
                                          ("humanSecondsResourceId", "humanSeconds", period),
                                          ("terminalLiabilityResourceId", "tailLiability", horizon)):
                        if funding[key]:
                            increment[funding[key]][t] += q(action[field])
            for dimension in problem["mandate"]["resources"]["dimensions"]:
                if spent[dimension["id"]] > q(dimension["totalLimit"]) or max(occupancy[dimension["id"]]) > q(dimension["capacity"]):
                    reasons.append("MANDATE")
            for resource in resources:
                key = resource["resourceId"]
                total = [a + b for a, b in zip(base[key], increment[key])]
                if resource["revoked"]:
                    reasons.append("REVOKED")
                for t, available in enumerate(resource["availability"]):
                    if available["amount"] is None or available["basis"] != "REPORTED_AVAILABLE":
                        reasons.append("UNKNOWN_AVAILABLE")
                    elif usage(resource["kind"], total, t) > q(available["amount"]) - q(resource["safetyMargin"]):
                        reasons.append("RESOURCE")
                for covenant in resource["covenants"]:
                    for t in covenant["periods"]:
                        used = F(0)
                        for term in covenant["terms"]:
                            other = next(r for r in resources if r["resourceId"] == term["resourceId"])
                            source = lower if q(term["coefficient"]) < 0 else base
                            simultaneous = [a + b for a, b in zip(source[other["resourceId"]], increment[other["resourceId"]])]
                            used += q(term["coefficient"]) * usage(other["kind"], simultaneous, t)
                        if used > q(covenant["maximum"]) - q(covenant["safetyMargin"]):
                            reasons.append("COVENANT")
            value = q(scenario["baseValue"]) + sum(
                (q(term["value"]) for term in scenario["terms"] if set(term["policyIds"]).issubset(selected)), F(0))
            values.append(value)
            if value < q(problem["mandate"]["risk"]["minimumUtility"]):
                reasons.append("RISK")
        results.append({"selectedPolicyIds": selected, "feasible": not reasons,
                        "objective": str(min(values)) if not reasons else None, "reasons": sorted(set(reasons))})
    return {"subsets": results, "semantics": "EXACT_FRACTIONS_COMPLETE_GIVEN_JOINT_PATHS_NOT_ECONOMIC_TRUTH"}


if data["operation"] == "policy":
    output = finite_policy(data["problem"], data["mandate"], data["model"], data["kernel"], data.get("protocols", []))
elif data["operation"] == "examples":
    output = examples()
elif data["operation"] == "allocation":
    output = allocations(data["problem"])
elif data["operation"] == "finance":
    values = data["values"]
    uses = q(values["ev"]) + q(values["fees"])
    def decimal(value):
        # Registered finite exact decimal outputs, not the producer's engine.
        denominator, places = value.denominator, 0
        while denominator > 1 and denominator % 2 == 0:
            denominator //= 2
        while denominator > 1 and denominator % 5 == 0:
            denominator //= 5
        if denominator != 1:
            raise ValueError("REFERENCE_NONTERMINATING_FINANCIAL_DECIMAL")
        while (value * 10 ** places).denominator != 1:
            places += 1
        integer = (value * 10 ** places).numerator
        text = str(abs(integer)).rjust(places + 1, "0")
        return ("-" if integer < 0 else "") + (text if places == 0 else text[:-places] + "." + text[-places:])
    output = {"total_uses": decimal(uses), "sponsor_equity": decimal(uses - q(values["principal"])),
              "interest": decimal(q(values["principal"]) * q(values["rate"]))}
else:
    raise ValueError("REFERENCE_OPERATION_UNSUPPORTED")
print(json.dumps(output, sort_keys=True))
