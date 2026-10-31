"""Producer-side native compiled-game enumeration. Not imported by checker."""
import itertools
from common import Q, rat, PROFILE, Unsupported, need, digest, check_deadline
from linear import solve


def coalitions(parties):
    return [list(c) for size in range(1, len(parties)+1) for c in itertools.combinations(parties, size)]


def plans(game, coalition):
    infos = sorted((k, v["actionIds"]) for k, v in game["infos"].items() if v["participant"] in coalition)
    count = 1
    for _, actions in infos:
        count *= len(actions)
    if count > PROFILE["maxPureJointPlans"]:
        raise Unsupported("Z2_ORIGINAL_JOINT_PLAN_BOUND")
    return [dict(zip((k for k, _ in infos), row)) for row in itertools.product(*(a for _, a in infos))]


def value(game, strategy, party, plan, start=None):
    values = {}

    def evaluate(nid):
        if nid in values:
            return values[nid]
        s, n = game["nodes"][nid], game["nodes"][nid]["original"]
        if n["kind"] == "TERMINAL":
            v = rat(n["payoff"][int(party[1])])
        elif n["kind"] == "DECISION":
            key = s["informationKey"]
            if key in plan:
                v = evaluate(next(child for a, child, _ in s["edges"] if a == plan[key]))
            else:
                v = sum((rat(strategy[key][a])*evaluate(child) for a, child, _ in s["edges"]), Q(0))
        else:
            v = sum((Q(p)*evaluate(child) for _, child, p in s["edges"]), Q(0))
        values[nid] = v
        return v
    return evaluate(start or game["root"])


def certificate(game, strategy, coalition, deadline):
    original = plans(game, coalition)
    baseline = [value(game, strategy, p, {}) for p in coalition]
    columns = []
    for plan in original:
        check_deadline(deadline)
        columns.append([value(game, strategy, p, plan)-b for p, b in zip(coalition, baseline)])
    solved = solve(columns, deadline)
    result = {"modelId": game["modelId"], "coalition": coalition, "kind": solved["kind"],
              "planCount": len(original), "planDigest": digest(original),
              "gainsDigest": digest([[str(v) for v in row] for row in columns]), "pivots": solved["pivots"]}
    if solved["kind"] == "NO_PROFIT_DUAL":
        result.update({"lambda": [str(v) for v in solved["lambda"]], "nu": str(solved["nu"])})
    else:
        weights = solved["weights"]
        result["terms"] = [{"plan": p, "probability": str(w)} for p, w in zip(original, weights) if w > 0]
        result["gains"] = [str(sum((w*g[i] for w, g in zip(weights, columns)), Q(0))) for i in range(len(coalition))]
    return result


def force_strategy(game, parties, deadline):
    family = plans(game, parties)
    forced, steps = {}, []
    remaining = sorted(game["infos"], key=lambda k: max(game["nodes"][n]["depth"] for n in game["infos"][k]["nodeIds"]), reverse=True)
    while remaining:
        progress = False
        for key in remaining[:]:
            check_deadline(deadline)
            info = game["infos"][key]
            for action in info["actionIds"]:
                strict = True
                for other in info["actionIds"]:
                    if other == action:
                        continue
                    for node in info["nodeIds"]:
                        for plan in family:
                            check_deadline(deadline)
                            first, second = {**plan, **forced, key: action}, {**plan, **forced, key: other}
                            if value(game, {}, info["participant"], first, node) <= value(game, {}, info["participant"], second, node):
                                strict = False
                                break
                        if not strict:
                            break
                    if not strict:
                        break
                if strict:
                    forced[key] = action
                    steps.append({"informationKey": key, "actionId": action})
                    remaining.remove(key); progress = True
                    break
        if not progress:
            return None
    need(len(forced) == len(game["infos"]), "Z2_DOMINANCE_COVERAGE")
    return {"choices": forced, "steps": steps}
