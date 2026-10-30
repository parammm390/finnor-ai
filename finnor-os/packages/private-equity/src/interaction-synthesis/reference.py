"""Independent original-tree small-game exhaustive continuation oracle.

Frozen campaign rule: no imports from producer, checker, or precompiled games.
Every pure contingent continuation is enumerated. Mixed continuations cannot
improve the maximum because expected utility is multilinear in behavior.
This oracle is bounded to 4096 complete original pure continuations per participant.
"""
import hashlib
import itertools
import json
import sys
from fractions import Fraction as F

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

def key(value):
    return "I:" + hashlib.sha256(canonical(value).encode()).hexdigest()

def run(problem, candidate):
    reports = []
    for model in problem["models"]:
        original = {n["id"]: n for n in model["nodes"]}
        infos, states = {}, {}
        policy = candidate["policy"]
        def walk(nid, observations, public, recall):
            n = original[nid]
            observations = [list(x) for x in observations]
            public = list(public)
            for o in n["observations"]:
                token = {"date": n["date"], "key": o["key"], "value": o["value"], "visibility": "PUBLIC" if "PUBLIC" in o["recipients"] else "PRIVATE"}
                if "PUBLIC" in o["recipients"]:
                    public.append(token)
                for i, party in enumerate(p["id"] for p in problem["participants"]):
                    if party in o["recipients"] or "PUBLIC" in o["recipients"]:
                        observations[i].append(token)
            state = {"node": n, "children": [], "informationKey": None}
            states[nid] = state
            if n["kind"] == "TERMINAL":
                return
            edges = n["edges"]
            if n["kind"] == "PROTOCOL":
                k = "K:" + hashlib.sha256(canonical({"controlId": n["controlId"], "date": n["date"], "publicObservations": public}).encode()).hexdigest()
                edges = [e for e in edges if e["actionId"] == policy[k]]
            if n["kind"] == "DECISION":
                p = int(n["participant"][1])
                k = key({"participant": n["participant"], "date": n["date"], "observations": observations[p], "recall": recall[p]})
                state["informationKey"] = k
                infos.setdefault(k, {"participant": n["participant"], "nodes": [], "actions": [e["actionId"] for e in edges]})["nodes"].append(nid)
            for e in edges:
                if n["kind"] == "CHANCE" and F(e["probability"]) == 0:
                    continue
                next_recall = [list(x) for x in recall]
                if n["kind"] == "DECISION":
                    next_recall[p].append({"informationKey": k, "actionId": e["actionId"]})
                state["children"].append((e["actionId"], e["next"], F(e["probability"]) if n["kind"] == "CHANCE" else F(1)))
                walk(e["next"], observations, public, next_recall)
        walk(model["root"], [[] for _ in problem["participants"]], [], [[] for _ in problem["participants"]])
        assessment = next(x for x in candidate["models"] if x["modelId"] == model["id"])
        def payoff(nid, participant, plan):
            state = states[nid]
            n = state["node"]
            if n["kind"] == "TERMINAL":
                return F(n["payoff"][int(participant[1])])
            if n["kind"] == "CHANCE":
                return sum((p * payoff(child, participant, plan) for _, child, p in state["children"]), F(0))
            if n["kind"] == "PROTOCOL":
                return payoff(state["children"][0][1], participant, plan)
            k = state["informationKey"]
            if k in plan:
                return payoff(next(child for a, child, _ in state["children"] if a == plan[k]), participant, plan)
            return sum((F(candidate["strategy"][k][a]) * payoff(child, participant, plan) for a, child, _ in state["children"]), F(0))
        cases = []
        for start, info in infos.items():
            participant = info["participant"]
            party_infos = [(k, v["actions"]) for k, v in infos.items() if v["participant"] == participant]
            count = 1
            for _, actions in party_infos:
                count *= len(actions)
            if count > 4096:
                raise ValueError("REFERENCE_ORIGINAL_CONTINUATION_BOUND")
            mu = {n: F(v) for n, v in assessment["beliefs"][start].items()}
            prescribed = sum((mu[n] * payoff(n, participant, {}) for n in info["nodes"]), F(0))
            best, witness = prescribed, {}
            for actions in itertools.product(*(x[1] for x in party_infos)):
                plan = dict(zip((x[0] for x in party_infos), actions))
                value = sum((mu[n] * payoff(n, participant, plan) for n in info["nodes"]), F(0))
                if value > best:
                    best, witness = value, plan
            cases.append({"informationKey": start, "participant": participant, "prescribed": str(prescribed), "best": str(best), "gain": str(best - prescribed), "plan": witness})
        reports.append({"modelId": model["id"], "cases": cases, "maxRegret": str(max((F(c["gain"]) for c in cases), default=F(0)))})
    return {"schema": "finnor.y3.exhaustive-reference.v1", "models": reports}

if __name__ == "__main__":
    request = json.load(sys.stdin)
    print(canonical(run(request["problem"], request["candidate"])))
