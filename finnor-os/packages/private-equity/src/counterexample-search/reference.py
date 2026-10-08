"""Separate original-input formulation. No proposer result, transformed row or claimed bound is read."""
import itertools
import json
import math
import sys
from fractions import Fraction as Q


class Unsupported(Exception):
    pass


def scalar_model(data):
    model, snapshot = data["model"], data["snapshot"]
    if model.get("runtime") or model.get("circularBlocks"):
        raise Unsupported("SPECIALIZED_RUNTIME_OR_CYCLE_REFERENCE_UNSUPPORTED")
    nodes = {n["id"]: n for n in model["nodes"]}
    if len(nodes) > 2048 or any(n["shape"] != "scalar" for n in nodes.values()):
        raise Unsupported("REFERENCE_SCALAR_ACYCLIC_DOMAIN")
    overrides = {c["nodeId"]: c["value"] for c in data["components"]
                 if c["candidateId"] == data["candidateId"]}
    values, active = {}, set()

    def expression(e):
        op = e["op"]
        if op == "ref":
            return node(e["nodeId"])
        if op == "literal":
            return Q(e["value"]) if e["valueType"] == "decimal" else e["value"]
        if op == "negate":
            return -expression(e["arg"])
        if op == "compare":
            a, b = expression(e["left"]), expression(e["right"])
            return {"eq": lambda: a == b, "ne": lambda: a != b,
                    "lt": lambda: a < b, "lte": lambda: a <= b,
                    "gt": lambda: a > b, "gte": lambda: a >= b}[e["comparison"]]()
        if op == "if":
            # Referenced nodes are all checked for validity independently below.
            return expression(e["then"] if expression(e["condition"]) else e["else"])
        if op not in ("add", "sum", "subtract", "multiply", "divide", "min", "max"):
            raise Unsupported("REFERENCE_OPERATOR_UNSUPPORTED:" + op)
        a = list(map(expression, e["args"]))
        if op in ("add", "sum"):
            return sum(a, Q(0))
        if op == "multiply":
            out = Q(1)
            for v in a:
                out *= v
            return out
        if op == "subtract":
            return a[0] - a[1]
        if op == "divide":
            return a[0] / a[1]
        if op == "min":
            return min(a)
        if op == "max":
            return max(a)
        raise Unsupported("REFERENCE_OPERATOR_UNSUPPORTED:" + op)

    def node(key):
        if key in values:
            return values[key]
        if key in active:
            raise Unsupported("REFERENCE_CYCLE")
        active.add(key)
        n = nodes[key]
        kind = n["kind"]
        if kind == "input":
            supplied = snapshot["values"][key]
            if supplied["status"] != "KNOWN" or supplied["value"] is None:
                raise Unsupported("ORIGINAL_INPUT_UNAVAILABLE:" + key)
            v = overrides.get(key, supplied["value"])
            v = Q(v) if n["valueType"] == "decimal" else v
        elif kind == "constant":
            v = Q(n["value"]) if n["valueType"] == "decimal" else n["value"]
        elif kind == "expression":
            v = expression(n["expression"])
        elif kind == "check":
            v = expression(n["assertion"])
        elif kind == "output":
            v = node(n["sourceNodeId"])
        else:
            raise Unsupported("REFERENCE_NODE_UNSUPPORTED:" + kind)
        values[key] = v
        active.remove(key)
        return v

    for key in nodes:
        node(key)
    v = values[data["nodeId"]]
    return {"checker": "M4_FRACTION_ORIGINAL_IR_V1", "observed": str(v) if isinstance(v, Q) else v,
            "trace": {k: str(v) if isinstance(v, Q) else v for k, v in values.items()}}


def allocation(data):
    p = data["problem"]
    ids = [v["ref"]["id"] for v in p["policies"]]
    if len(ids) > 8 or len(p["jointModel"]["scenarios"]) > 32:
        raise Unsupported("REFERENCE_S5_CARDINALITY")
    h = p["mandate"]["horizon"]["periods"]
    resources = {v["resourceId"]: v for v in p["resources"]}
    base = {k: list(map(Q, r["existingUse"])) for k, r in resources.items()}
    minimum = {k: list(v) for k, v in base.items()}
    for o in p["outstanding"]:
        for e in o["envelopes"]:
            for t in range(h + 1):
                base[e["resourceId"]][t] += Q(e["quantities"][t])
                minimum[e["resourceId"]][t] += Q(e["minimumQuantities"][t])

    def use(key, raw, t):
        return sum(raw[:t + 1], Q(0)) if resources[key]["kind"] in ("STOCK", "CUMULATIVE_EXPENDITURE") else raw[t]

    committed = {r["id"] for o in p["outstanding"] for r in o["policyRefs"]}
    covenants = {c["id"]: c for r in resources.values() for c in r["covenants"]}

    def evaluate(selected):
        chosen = set(selected)
        if len(chosen) != len(selected) or not chosen.issubset(ids):
            raise Unsupported("SELECTED_POLICY_IDENTITY")
        reasons, witnesses, values = [], [], []
        if chosen & committed:
            reasons.append("ALREADY_COMMITTED")
        for c in p["jointModel"]["choiceConstraints"]:
            if not c["minimum"] <= len(chosen & set(c["policyIds"])) <= c["maximum"]:
                reasons.append("CHOICE:" + c["id"])
        for s in p["jointModel"]["scenarios"]:
            sid = s["id"]
            inc = {k: [Q(0)] * (h + 1) for k in resources}
            dimensions = {d["id"]: {"spent": Q(0), "occupied": [Q(0)] * (h + 1)}
                          for d in p["mandate"]["resources"]["dimensions"]}
            human = Q(0)
            tail = Q(str(p["mandate"]["utility"]["tail"]["terminalLiability"]))
            if tail:
                tail_ids = {f["terminalLiabilityResourceId"] for f in p["funding"]}
                if len(tail_ids) != 1 or None in tail_ids:
                    raise Unsupported("TAIL_FUNDING_UNRESOLVED")
                inc[next(iter(tail_ids))][h] += tail
            for policy in p["policies"]:
                pid = policy["ref"]["id"]
                if pid not in chosen:
                    continue
                actions = {a["id"]: a for a in policy["problem"]["actions"]}
                nodes = {n["id"]: n for n in policy["nodes"]}
                path = next(q for q in s["policyPaths"] if q["policyRef"]["id"] == pid)
                funding = next(f for f in p["funding"] if f["policyRef"]["id"] == pid)
                for nid in path["nodeIds"]:
                    n = nodes[nid]
                    a, t = actions[n["actionId"]], n["period"]
                    human += Q(str(a["humanSeconds"]))
                    for b in p["demandBindings"]:
                        if b["policyRef"]["id"] != pid:
                            continue
                        if b["component"] == "TOTAL":
                            inc[b["resourceId"]][t] += Q(str(a["resources"][b["dimensionId"]]))
                        else:
                            for k in range(t, min(h + 1, t + a["occupationPeriods"])):
                                inc[b["resourceId"]][k] += Q(str(a["occupancy"][b["dimensionId"]]))
                    for field, period, value in (("actionCostResourceId", t, "cost"),
                                                 ("humanSecondsResourceId", t, "humanSeconds"),
                                                 ("terminalLiabilityResourceId", h, "tailLiability")):
                        if funding[field]:
                            inc[funding[field]][period] += Q(str(a[value]))
                    for key, d in dimensions.items():
                        d["spent"] += Q(str(a["resources"][key]))
                        for k in range(t, min(h + 1, t + a["occupationPeriods"])):
                            d["occupied"][k] += Q(str(a["occupancy"][key]))
            for key, r in resources.items():
                if r["revoked"] or any(a["amount"] is None or a["basis"] != "REPORTED_AVAILABLE" for a in r["availability"]):
                    raise Unsupported("RESOURCE_AVAILABILITY_UNRESOLVED:" + key)
                for t in range(h + 1):
                    used = use(key, [a + b for a, b in zip(base[key], inc[key])], t)
                    maximum = Q(r["availability"][t]["amount"]) - Q(r["safetyMargin"])
                    witnesses.append({"constraintId": "resource:" + key, "scenarioId": sid, "period": t,
                                      "used": str(used), "maximum": str(maximum), "margin": str(maximum - used)})
                    if used > maximum:
                        reasons.append(f"RESOURCE:{key}:{sid}:{t}")
            for c in covenants.values():
                for t in c["periods"]:
                    used = Q(0)
                    for term in c["terms"]:
                        key, coefficient = term["resourceId"], Q(term["coefficient"])
                        fixed = minimum[key] if coefficient < 0 else base[key]
                        used += coefficient * use(key, [a + b for a, b in zip(fixed, inc[key])], t)
                    maximum = Q(c["maximum"]) - Q(c["safetyMargin"])
                    witnesses.append({"constraintId": "covenant:" + c["id"], "scenarioId": sid, "period": t,
                                      "used": str(used), "maximum": str(maximum), "margin": str(maximum - used)})
                    if used > maximum:
                        reasons.append(f'COVENANT:{c["id"]}:{sid}:{t}')
            for d in p["mandate"]["resources"]["dimensions"]:
                v = dimensions[d["id"]]
                if v["spent"] > Q(str(d["totalLimit"])) or any(q > Q(str(d["capacity"])) for q in v["occupied"]):
                    reasons.append("MANDATE_RESOURCE:" + d["id"])
            for c in p["mandate"]["resources"]["couplings"]:
                for t in range(h + 1):
                    if sum((Q(str(w)) * dimensions[k]["occupied"][t] for k, w in c["weights"].items()), Q(0)) > Q(str(c["maxPerPeriod"])):
                        reasons.append("MANDATE_COUPLING:" + c["id"])
            if human > Q(str(p["mandate"]["search"]["maxHumanSeconds"])):
                reasons.append("MANDATE_HUMAN")
            value = Q(s["baseValue"]) + sum((Q(t["value"]) for t in s["terms"] if set(t["policyIds"]) <= chosen), Q(0))
            values.append(value)
            if value < Q(str(p["mandate"]["risk"]["minimumUtility"])):
                reasons.append("RISK:" + sid)
        return {"feasible": not reasons, "reasons": sorted(set(reasons)),
                "value": str(min(values)), "witnesses": witnesses}

    if data["mode"] == "SELECTION":
        return {"checker": "M4_FRACTION_ORIGINAL_S5_V1", **evaluate(data["selected"])}
    best, selected = None, None
    for bits in itertools.product((False, True), repeat=len(ids)):
        chosen = [pid for pid, bit in zip(ids, bits) if bit]
        result = evaluate(chosen)
        if result["feasible"] and (best is None or Q(result["value"]) > best):
            best, selected = Q(result["value"]), chosen
    return {"checker": "M4_FRACTION_ORIGINAL_S5_V1", "optimum": None if best is None else str(best),
            "selected": selected, "subsets": 2 ** len(ids)}


def policy(data):
    policy, model, kernel = data["policy"], data["model"], data["kernel"]
    if policy["problem"].get("continuation") or any(a["kind"] == "INQUIRE" for a in policy["problem"]["actions"]) or policy["problem"]["obligations"]:
        raise Unsupported("REFERENCE_CONTINUATION_INQUIRY_OR_LIABILITY_UNSUPPORTED")
    entry = next(((m, s) for m in kernel["mechanisms"] for s in m["scenarios"] if s["id"] == data["worldId"]), None)
    if not entry:
        raise Unsupported("ORIGINAL_JOINT_WORLD_UNAVAILABLE")
    m, s = entry
    history = [{"states": r["states"].copy(), "exposures": r["exposures"].copy()}
               for r in model["history"]["rows"][-3:]]
    h = policy["mandate"]["horizon"]["periods"]
    schedule = {k: list(v) for k, v in policy["problem"]["baselineExposures"].items()}
    actions = {a["id"]: a for a in policy["problem"]["actions"]}
    observations, pending, action_history, trace = [], [], [], []
    utility, liability = 0.0, policy["mandate"]["utility"]["tail"]["terminalLiability"]

    def atom(f, exposures):
        if f["kind"] == "CONSTANT":
            return 1.0
        if f["kind"] == "EXPOSURE" and f["lag"] == 0:
            return exposures[f["id"]]
        if not 0 < f["lag"] <= len(history):
            raise Unsupported("ORIGINAL_LAG_UNAVAILABLE")
        row = history[-f["lag"]]
        return row["states" if f["kind"] == "STATE" else "exposures"][f["id"]]

    def support(hull, x):
        if not hull["available"]:
            return False
        delta = [v - c for v, c in zip(x, hull["center"])]
        proj = [sum(delta[i] * hull["basis"][i][j] for i in range(len(delta))) for j in range(hull["rank"])]
        if any(abs(v - sum(proj[j] * hull["basis"][i][j] for j in range(hull["rank"]))) > 1e-8 for i, v in enumerate(delta)):
            return False
        if hull["rank"] == 0:
            return True
        if hull["rank"] == 1:
            return hull["range"][0] - 1e-8 <= proj[0] <= hull["range"][1] + 1e-8
        return all(row[-1] + sum(a * b for a, b in zip(proj, row)) <= 1e-8 for row in hull["halfspaces"])

    for t in range(h):
        observations += [o for o in pending if o["availablePeriod"] == t]
        pending = [o for o in pending if o["availablePeriod"] > t]
        matching = [n for n in policy["nodes"] if n["period"] == t and n["actionHistory"] == action_history and n["observations"] == observations]
        if len(matching) != 1:
            raise Unsupported("LAWFUL_OBSERVABLE_BRANCH_UNAVAILABLE")
        node = matching[0]
        action = actions[node["actionId"]]
        if not action["earliestPeriod"] <= t <= action["lastPeriod"] or (action["atMostOnce"] and action["id"] in action_history):
            raise Unsupported("ORIGINAL_ACTION_TIMING_INVALID")
        for key, doses in action["exposures"].items():
            for offset, dose in enumerate(doses):
                if t + offset >= h:
                    raise Unsupported("EXPOSURE_HORIZON")
                schedule[key][t + offset] = dose
        exposures = {key: values[t] for key, values in schedule.items()}
        states = {}
        for j, e in enumerate(m["equations"]):
            x = [atom(f, exposures) if f["kind"] != "PRODUCT" else atom(f["left"], exposures) * atom(f["right"], exposures) for f in e["features"]]
            value = sum(a * b for a, b in zip(x, s["coefficients"][j])) + s["shocks"][t][j]
            state_range = next(v["range"] for v in model["request"]["stateVariables"] if v["id"] == e["variableId"])
            if not math.isfinite(value) or not support(m["support"][j], x) or not state_range[0] <= value <= state_range[1]:
                raise Unsupported("OUTSIDE_ORIGINAL_S3_SUPPORT")
            states[e["variableId"]] = value
        history = history[-2:] + [{"states": states, "exposures": exposures}]
        mandate = policy["mandate"]
        utility += mandate["utility"]["discountFactors"][t] * (
            sum(term["coefficient"] * states[term["variableId"]] for term in mandate["utility"]["periodTerms"]) - action["cost"])
        liability += action["tailLiability"]
        for instrument in policy["problem"]["observations"]:
            if action["id"] not in instrument["afterActionIds"]:
                continue
            bins = [b for b in instrument["bins"] if b["lowerInclusive"] <= states[instrument["variableId"]] < b["upperExclusive"]]
            if len(bins) != 1:
                raise Unsupported("OBSERVATION_SUPPORT_UNAVAILABLE")
            pending.append({"instrumentId": instrument["id"], "token": bins[0]["category"], "availablePeriod": t + instrument["delayPeriods"]})
        trace.append({"period": t, "nodeId": node["id"], "actionId": action["id"], "observations": list(observations), "states": states, "exposures": exposures})
        action_history.append(action["id"])
    utility += mandate["utility"]["discountFactors"][h] * (
        sum(term["coefficient"] * states[term["variableId"]] for term in mandate["utility"]["terminalTerms"]) - liability)
    return {"checker": "M4_ORIGINAL_KERNEL_REFERENCE_V1", "observed": utility, "trace": trace,
            "qualification": "INHERITED_FLOAT64_TOLERANCE_MODEL_RELATIVE_NO_PROBABILITIES"}


try:
    data = json.load(sys.stdin)
    result = {"status": "CHECKED", **{"MODEL": scalar_model, "ALLOCATION": allocation, "POLICY": policy}[data["operation"]](data)}
except (Unsupported, KeyError, ValueError, ZeroDivisionError, TypeError) as error:
    result = {"status": "UNRESOLVED", "reason": str(error)}
json.dump(result, sys.stdout, allow_nan=False)
