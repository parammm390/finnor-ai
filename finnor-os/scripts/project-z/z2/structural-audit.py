"""Original-input qualification oracle. No producer, checker, LP or fixtures imports."""
import copy
from fractions import Fraction as F
import hashlib
import itertools
import json


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    ensure_ascii=False).encode()).hexdigest()


def policies(problem):
    controls = {c["id"]: c for c in problem["controls"]}
    domain = {}
    for model in problem["models"]:
        tree = {n["id"]: n for n in model["nodes"]}

        def walk(nid, public):
            node = tree[nid]
            public = public + [{"date": node["date"], "key": o["key"], "value": o["value"],
                                "visibility": "PUBLIC"} for o in node["observations"]
                               if "PUBLIC" in o["recipients"]]
            if node["kind"] == "PROTOCOL":
                key = "K:"+digest({"controlId": node["controlId"], "date": node["date"],
                                   "publicObservations": public})
                domain[key] = controls[node["controlId"]]["options"]
            for edge in node.get("edges", []):
                if node["kind"] != "CHANCE" or F(edge["probability"]) > 0:
                    walk(edge["next"], public)
        walk(model["root"], [])
    keys = sorted(domain)
    assert len(list(itertools.product(*(domain[k] for k in keys)))) <= 128
    return [dict(zip(keys, row)) for row in itertools.product(*(domain[k] for k in keys))]


def original_game(problem, model, policy):
    tree = {n["id"]: n for n in model["nodes"]}
    parties = [p["id"] for p in problem["participants"]]
    states, infos = {}, {}
    rules = {r["key"]: r for r in problem["observationRules"]}
    violations = set()

    def walk(nid, history, public, own, delivered):
        n = tree[nid]
        history = {p: list(v) for p, v in history.items()}
        public, delivered = list(public), {k: set(v) for k, v in delivered.items()}
        for obs in n["observations"]:
            token = {"date": n["date"], "key": obs["key"], "value": obs["value"],
                     "visibility": "PUBLIC" if "PUBLIC" in obs["recipients"] else "PRIVATE"}
            if "PUBLIC" in obs["recipients"]:
                public.append(token)
            for p in parties:
                if p in obs["recipients"] or "PUBLIC" in obs["recipients"]:
                    history[p].append(token)
            delivered.setdefault(obs["key"], set()).update(obs["recipients"])
        for name, value in n["resources"].items():
            if not 0 <= F(value) <= F(problem["resourceLimits"][name]["value"]):
                violations.add("RESOURCE")
        for i, (payment, liability) in enumerate(zip(n["payments"], n["liabilities"])):
            if abs(F(payment)) > F(problem["financialLimits"]["absolutePayments"][i]["value"]):
                violations.add("TRANSFER")
            if not 0 <= F(liability) <= F(problem["financialLimits"]["liabilities"][i]["value"]):
                violations.add("LIABILITY")
        edges = n.get("edges", [])
        if n["kind"] == "PROTOCOL":
            key = "K:"+digest({"controlId": n["controlId"], "date": n["date"],
                               "publicObservations": public})
            edges = [e for e in edges if e["actionId"] == policy[key]]
            assert len(edges) == 1
        local = None
        if n["kind"] == "DECISION":
            p = n["participant"]
            local = "I:"+digest({"participant": p, "date": n["date"],
                                 "observations": history[p], "recall": own[p]})
            info = infos.setdefault(local, {"party": p, "actions": [e["actionId"] for e in edges], "nodes": []})
            assert info["actions"] == [e["actionId"] for e in edges]
            info["nodes"].append(nid)
        states[nid] = {"original": n, "local": local, "edges": []}
        deadlines = [2] if n["kind"] == "TERMINAL" else [
            tree[e["next"]]["date"]-1 for e in edges if tree[e["next"]]["date"] > n["date"]
            and (n["kind"] != "CHANCE" or F(e["probability"]) > 0)]
        for date in deadlines:
            for key, rule in rules.items():
                if rule["mandatoryByDate"] is not None and rule["mandatoryByDate"] <= date:
                    got = delivered.get(key, set())
                    if not all(r in got or r != "PUBLIC" and "PUBLIC" in got for r in rule["allowedRecipients"]):
                        violations.add("MANDATORY_DISCLOSURE")
        for edge in edges:
            chance = F(edge["probability"]) if n["kind"] == "CHANCE" else F(1)
            if chance == 0:
                continue
            recall = {p: list(v) for p, v in own.items()}
            if local:
                recall[n["participant"]].append({"informationKey": local, "actionId": edge["actionId"]})
            states[nid]["edges"].append((edge["actionId"], edge["next"], chance))
            walk(edge["next"], history, public, recall, delivered)
    walk(model["root"], {p: [] for p in parties}, [], {p: [] for p in parties}, {})
    return {"root": model["root"], "states": states, "infos": infos, "violations": sorted(violations)}


def upper_values(game, n):
    cache = {}

    def walk(nid):
        if nid in cache:
            return cache[nid]
        state = game["states"][nid]
        node, edges = state["original"], state["edges"]
        if node["kind"] == "TERMINAL":
            result = list(map(F, node["payoff"]))
        else:
            children = [(weight, walk(child)) for _, child, weight in edges]
            result = [max(v[i] for _, v in children) if node["kind"] == "DECISION" else
                      sum((w*v[i] for w, v in children), F(0)) for i in range(n)]
        cache[nid] = result
        return result
    return [str(v) for v in walk(game["root"])]


def expectations(problem, family):
    n = len(problem["participants"])
    rows = []
    for policy in policies(problem):
        models = []
        for model in problem["models"]:
            game = original_game(problem, model, policy)
            counts = []
            for size in range(1, n+1):
                for coalition in itertools.combinations(("P"+str(i) for i in range(n)), size):
                    count = 1
                    for info in game["infos"].values():
                        if info["party"] in coalition:
                            count *= len(info["actions"])
                    assert count <= 4096, ("ORIGINAL_PLAN_BOUND", family, count)
                    counts.append({"coalition": list(coalition), "count": count})
            assert all(sum(v["party"] == "P"+str(i) for v in game["infos"].values()) <= 16 for i in range(n))
            models.append({"id": model["id"], "upperUtilities": upper_values(game, n),
                           "planCounts": counts, "violations": game["violations"]})
        rows.append({"policy": policy, "models": models})
    return {"expected": "CHECKED_INFEASIBLE" if family == 30 else "CHECKED_CANDIDATE",
            "allowedUnverified": family in (19, 20, 26),
            "completePolicyCount": len(rows), "originalPolicies": rows,
            "infeasibilityKind": "STRICT_DOMINANCE_EXHAUSTION" if family == 30 else None}


def invariant(problem, numeric=False):
    """Identifier-free graph invariant; unequal results prove nonisomorphism.

    Fixed-round colour refinement is deliberately not a complete isomorphism
    decider: equal results cannot certify distinctness. All identifiers serve
    only as graph vertex identities, never as colours.
    """
    colours, graph = {}, {}

    def node(key, colour):
        colour = digest(colour)
        assert key not in colours or colours[key] == colour
        colours[key] = colour
        graph.setdefault(key, [])
        return key

    def edge(a, b, role):
        graph[a].append((">"+role, b))
        graph[b].append(("<"+role, a))

    n = len(problem["participants"])
    ranges = []
    for i in range(n):
        values = [F(t["payoff"][i]) for m in problem["models"] for t in m["nodes"] if t["kind"] == "TERMINAL"]
        ranges.append((min(values), max(values)-min(values) or F(1)))
    public = node(("public",), ["PUBLIC"])
    for i, p in enumerate(problem["participants"]):
        outside = F(p["outsideOption"]["value"])
        low, span = ranges[i]
        node(("party", p["id"]), ["PARTY", str((outside-low)/span) if numeric else
             (outside > 0)-(outside < 0), F(problem["financialLimits"]["absolutePayments"][i]["value"]) != 0,
             F(problem["financialLimits"]["liabilities"][i]["value"]) != 0])
    for rule in problem["observationRules"]:
        key = node(("rule", rule["key"]), ["RULE", rule["mandatoryByDate"], rule["classification"]])
        for p in rule["allowedRecipients"]:
            edge(key, public if p == "PUBLIC" else ("party", p), "allowed")
    for control in problem["controls"]:
        node(("control", control["id"]), ["CONTROL", control["kind"], len(control["options"])])
    for model in problem["models"]:
        mid = node(("model", model["id"]), ["MODEL"])
        for t in model["nodes"]:
            key = node(("tree", model["id"], t["id"]), [t["kind"], t["date"], t.get("chanceRole")])
            edge(mid, key, "member")
            if t["id"] == model["root"]:
                edge(mid, key, "root")
            if "participant" in t:
                edge(key, ("party", t["participant"]), "actor")
            if "controlId" in t:
                edge(key, ("control", t["controlId"]), "controlled")
            for i, p in enumerate(problem["participants"]):
                transfer = F(t["payments"][i])
                limit = F(problem["financialLimits"]["absolutePayments"][i]["value"])
                attributes = ["ECONOMICS", (transfer > 0)-(transfer < 0), abs(transfer) == limit,
                              F(t["liabilities"][i]) != 0]
                if t["kind"] == "TERMINAL":
                    value, outside = F(t["payoff"][i]), F(p["outsideOption"]["value"])
                    low, span = ranges[i]
                    attributes.append(str((value-low)/span) if numeric else
                                      ((value > outside)-(value < outside)))
                econ = node(("economic", model["id"], t["id"], i), attributes)
                edge(key, econ, "snapshot")
                edge(econ, ("party", p["id"]), "owner")
            for name, value in t["resources"].items():
                limit = F(problem["resourceLimits"][name]["value"])
                r = node(("resource", name), ["RESOURCE", limit > 0])
                snap = node(("use", model["id"], t["id"], name),
                            ["USE", F(value) == 0, F(value) == limit, F(value) > limit])
                edge(key, snap, "use")
                edge(snap, r, "capacity")
            for j, obs in enumerate(t["observations"]):
                delivery = node(("delivery", model["id"], t["id"], j), ["DELIVERY"])
                value = node(("value", obs["key"], obs["value"]), ["OBSERVED_VALUE"])
                edge(key, delivery, "observes")
                edge(delivery, ("rule", obs["key"]), "rule")
                edge(delivery, value, "value")
                for p in obs["recipients"]:
                    edge(delivery, public if p == "PUBLIC" else ("party", p), "recipient")
        for t in model["nodes"]:
            for j, e in enumerate(t.get("edges", [])):
                chance = F(e["probability"]) if t["kind"] == "CHANCE" else None
                link = node(("edge", model["id"], t["id"], j),
                            ["EDGE", str(chance) if numeric and chance is not None else
                             ("ZERO" if chance == 0 else "POSITIVE") if chance is not None else "ACTION"])
                edge(("tree", model["id"], t["id"]), link, "from")
                edge(link, ("tree", model["id"], e["next"]), "to")
    for j, policy in enumerate(policies(problem)):
        choice = node(("policy", j), ["POLICY"])
        for model in problem["models"]:
            game = original_game(problem, model, policy)
            for key, info in game["infos"].items():
                local = node(("local", key), ["LOCAL", len(info["actions"])])
                edge(choice, local, "admitted")
                edge(local, ("party", info["party"]), "owner")
                for nid in info["nodes"]:
                    edge(("tree", model["id"], nid), local, "information")
            for nid in game["states"]:
                edge(choice, ("tree", model["id"], nid), "reachable")
    for _ in range(8):
        colours = {key: digest([colour, sorted((role, colours[other]) for role, other in graph[key])])
                   for key, colour in colours.items()}
    return digest(sorted(colours.values()))


def relabel(problem):
    """An isomorphic original input, including action/observation renaming."""
    result = copy.deepcopy(problem)
    actions = sorted({e["actionId"] for m in result["models"] for n in m["nodes"] for e in n.get("edges", [])})
    action = {old: "a"+str(i) for i, old in enumerate(reversed(actions))}
    rule = {r["key"]: "r"+str(i) for i, r in enumerate(reversed(result["observationRules"]))}
    control = {c["id"]: "c"+str(i) for i, c in enumerate(reversed(result["controls"]))}
    values = sorted({o["value"] for m in result["models"] for n in m["nodes"] for o in n["observations"]})
    value = {v: "v"+str(i) for i, v in enumerate(reversed(values))}
    for r in result["observationRules"]:
        r["key"] = rule[r["key"]]
    for c in result["controls"]:
        c["id"] = control[c["id"]]
        c["options"] = [action[a] for a in reversed(c["options"])]
    for i, m in enumerate(result["models"]):
        m["id"] = "model"+str(i)
        names = {n["id"]: "node"+str(j) for j, n in enumerate(reversed(m["nodes"]))}
        m["root"] = names[m["root"]]
        for n in m["nodes"]:
            n["id"] = names[n["id"]]
            for o in n["observations"]:
                o.update(key=rule[o["key"]], value=value[o["value"]])
            if "controlId" in n:
                n["controlId"] = control[n["controlId"]]
            for e in n.get("edges", []):
                e.update(actionId=action[e["actionId"]], next=names[e["next"]])
            if "edges" in n:
                n["edges"].reverse()
        m["nodes"].reverse()
    result["models"].reverse()
    result["observationRules"].reverse()
    return result
