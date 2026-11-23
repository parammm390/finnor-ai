"""Independent exhaustive original histories and rational vertex oracle."""
from fractions import Fraction as F
import hashlib
import itertools
import json


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def local_game(problem, model, policy):
    parties = [p["id"] for p in problem["participants"]]
    tree = {n["id"]: n for n in model["nodes"]}
    infos, states = {}, {}

    def visit(nid, history, own, public):
        n = tree[nid]
        history = {p: list(h) for p, h in history.items()}
        public = list(public)
        for o in n["observations"]:
            token = {"date": n["date"], "key": o["key"], "value": o["value"],
                     "visibility": "PUBLIC" if "PUBLIC" in o["recipients"] else "PRIVATE"}
            if "PUBLIC" in o["recipients"]:
                public.append(token)
            for p in parties:
                if p in o["recipients"] or "PUBLIC" in o["recipients"]:
                    history[p].append(token)
        key = None
        edges = n.get("edges", [])
        if n["kind"] == "PROTOCOL":
            k = "K:"+digest({"controlId": n["controlId"], "date": n["date"], "publicObservations": public})
            edges = [e for e in edges if e["actionId"] == policy[k]]
            assert len(edges) == 1
        if n["kind"] == "DECISION":
            p = n["participant"]
            key = "I:"+digest({"participant": p, "date": n["date"], "observations": history[p], "recall": own[p]})
            actions = [e["actionId"] for e in edges]
            if key in infos:
                assert infos[key]["actions"] == actions
            else:
                infos[key] = {"party": p, "actions": actions}
        states[nid] = (n, key, [])
        for e in edges:
            weight = F(e["probability"]) if n["kind"] == "CHANCE" else F(1)
            if weight == 0:
                continue
            recall = {p: list(h) for p, h in own.items()}
            if key:
                recall[n["participant"]].append({"informationKey": key, "actionId": e["actionId"]})
            states[nid][2].append((e["actionId"], e["next"], weight))
            visit(e["next"], history, recall, public)
    visit(model["root"], {p: [] for p in parties}, {p: [] for p in parties}, [])
    return {"root": model["root"], "states": states, "infos": infos}


def value(game, strategy, plan):
    def walk(nid):
        n, key, edges = game["states"][nid]
        if n["kind"] == "TERMINAL":
            return tuple(F(v) for v in n["payoff"])
        if key in plan:
            return walk(next(child for action, child, _ in edges if action == plan[key]))
        values = [(F(strategy[key][a]) if key else chance, walk(child)) for a, child, chance in edges]
        return tuple(sum((w*v[i] for w, v in values), F(0)) for i in range(len(values[0][1])))
    return walk(game["root"])


def columns(game, strategy, coalition):
    domain = sorted((k, info["actions"]) for k, info in game["infos"].items() if info["party"] in coalition)
    count = 1
    for _, actions in domain:
        count *= len(actions)
    assert count <= 4096
    baseline = value(game, strategy, {})
    rows = []
    for actions in itertools.product(*(actions for _, actions in domain)):
        plan = dict(zip((k for k, _ in domain), actions))
        actual = value(game, strategy, plan)
        gain = tuple(actual[int(p[1:])]-baseline[int(p[1:])] for p in coalition)
        rows.append((plan, gain))
    return rows


def solve_square(matrix, rhs):
    a = [list(row)+[v] for row, v in zip(matrix, rhs)]
    for col in range(len(a)):
        pivot = next((i for i in range(col, len(a)) if a[i][col]), None)
        if pivot is None:
            return None
        a[col], a[pivot] = a[pivot], a[col]
        divisor = a[col][col]
        a[col] = [v/divisor for v in a[col]]
        for row in range(len(a)):
            if row != col:
                divisor = a[row][col]
                a[row] = [x-divisor*y for x, y in zip(a[row], a[col])]
    return [row[-1] for row in a]


def profitable_vertex(original):
    unique = {}
    for plan, gain in original:
        unique.setdefault(gain, plan)
    gains = list(unique)
    n = len(gains[0])
    for gain in gains:
        if min(gain) >= 0 and sum(gain) > 0:
            return {"gains": [str(v) for v in gain], "terms": [{"plan": unique[gain], "probability": "1"}]}
    if all(max(row[i] for row in gains) <= 0 for i in range(n)):
        return None
    # A vertex has <=n+1 positive weights. Its other active constraints are
    # zero gains. This enumerates vertices, not the producer's simplex pivots.
    for size in range(2, min(n+1, len(gains))+1):
        for support in itertools.combinations(gains, size):
            for tight in itertools.combinations(range(n), size-1):
                matrix = [[F(1)]*size]+[[row[i] for row in support] for i in tight]
                weights = solve_square(matrix, [F(1)]+[F(0)]*(size-1))
                if weights is None or min(weights) < 0:
                    continue
                vector = [sum((w*g[i] for w, g in zip(weights, support)), F(0)) for i in range(n)]
                if min(vector) >= 0 and sum(vector) > 0:
                    return {"gains": [str(v) for v in vector],
                            "terms": [{"plan": unique[g], "probability": str(w)} for g, w in zip(support, weights) if w]}
    return None


def inspect(problem, candidate, full=True):
    parties = [p["id"] for p in problem["participants"]]
    reports = []
    for model in problem["models"]:
        game = local_game(problem, model, candidate["policy"])
        family = [list(c) for size in range(1, len(parties)+1) for c in itertools.combinations(parties, size)] if full else [parties]
        for coalition in family:
            original = columns(game, candidate["strategy"], coalition)
            witness = profitable_vertex(original)
            reports.append({"modelId": model["id"], "coalition": coalition, "planCount": len(original),
                            "columnsDigest": digest([[str(v) for v in gain] for _, gain in original]),
                            "profitable": witness})
    return reports


def outside_grid_report(problem, candidate):
    game = local_game(problem, problem["models"][0], candidate["policy"])
    rows = columns(game, candidate["strategy"], ["P0", "P1"])
    gain_set = {gain for _, gain in rows}
    positive = lambda v: min(v) >= 0 and sum(v) > 0
    pure = any(positive(g) for g in gain_set)
    half = any(positive(tuple((x+y)/2 for x, y in zip(a, b))) for a in gain_set for b in gain_set)
    witness = profitable_vertex(rows)
    assert not pure and not half and witness is not None
    return {"allOriginalPurePlans": len(rows), "distinctGainColumns": [[str(v) for v in row] for row in sorted(gain_set)],
            "profitablePure": pure, "profitableOldGridOverEntireOriginalFamily": half,
            "exactVertexWitness": witness, "outsideGridNecessaryForWholeOriginalFamily": True}


if __name__ == "__main__":
    import sys
    original = json.load(sys.stdin)
    reports = inspect(original["problem"], original["candidate"])
    utilities = {}
    for model in original["problem"]["models"]:
        game = local_game(original["problem"], model, original["candidate"]["policy"])
        utilities[model["id"]] = [str(v) for v in value(game, original["candidate"]["strategy"], {})]
    print(json.dumps({"reports": reports, "utilities": utilities, "problemDigest": digest(original["problem"]),
                      "candidateDigest": digest(original["candidate"])}, sort_keys=True))
    raise SystemExit(int(any(row["profitable"] for row in reports)))
