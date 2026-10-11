"""Distinct Fraction arrangement/reference, no imports from producer or checker.

Direct original paths evaluate at exact points. For one/two parameter fixtures,
prederive the complete utility/hard arrangement, then enumerate every stratum.
Cramer's determinant method is separate from the checker's Gaussian active bases.
Maximal tractable cases use exact whole-cell acceptance plus original direct
queries, not a claim that arbitrary maximal arrangements fit the grant.
"""
import itertools
import json
import sys
from fractions import Fraction as F


def ev(e, point):
    return F(e["b"]) + sum(F(a) * x for a, x in zip(e["a"], point))


def value(s, p, w, point):
    m = s["mandate"]
    path = next(v for v in w["paths"] if v["policyId"] == p["id"])
    nodes = {v["id"]: v for v in p["nodes"]}
    actions = {a["id"]: a for a in p["actions"]}
    total, liability = F(0), F(m["utility"]["terminalLiability"])
    for t, id in enumerate(path["nodeIds"]):
        a = actions[nodes[id]["actionId"]]
        u = sum(F(term["coefficient"]) * ev(path["states"][t + 1][term["variableId"]], point) for term in m["utility"]["periodTerms"])
        total += F(m["utility"]["discountFactors"][t]) * (u - ev(a["cost"], point))
        liability += ev(a["tailLiability"], point)
    terminal = sum(F(term["coefficient"]) * ev(path["states"][-1][term["variableId"]], point) for term in m["utility"]["terminalTerms"])
    return total + F(m["utility"]["discountFactors"][-1]) * (terminal - liability)


def direct(s, point):
    feasible, payoffs = [], {}
    m = s["mandate"]
    for p in s["policies"]:
        valid = True
        for c in s["hardPredicates"]:
            if c["policyId"] != p["id"]:
                continue
            v = ev(c["expression"], point)
            valid &= (v == 0 if c["relation"] == "EQ" else v < 0 if c["relation"] == "LT" else v <= 0)
        worlds = {w["id"]: value(s, p, w, point) for w in s["worlds"]}
        nodes, actions = {v["id"]: v for v in p["nodes"]}, {a["id"]: a for a in p["actions"]}
        for w in s["worlds"]:
            path = next(path for path in w["paths"] if path["policyId"] == p["id"])
            spent = {d["id"]: F(0) for d in m["dimensions"]}
            occupancy = {d["id"]: [F(0)] * (m["horizon"]["periods"] + 1) for d in m["dimensions"]}
            human = F(0)
            for t, id in enumerate(path["nodeIds"]):
                a = actions[nodes[id]["actionId"]]
                human += ev(a["humanSeconds"], point)
                valid &= human <= F(m["maxHumanSeconds"])
                valid &= all(ev(a[k], point) >= 0 for k in ("cost", "humanSeconds", "tailLiability"))
                for d in m["dimensions"]:
                    spend, occupied = ev(a["resources"][d["id"]], point), ev(a["occupancy"][d["id"]], point)
                    valid &= spend >= 0 and occupied >= 0
                    spent[d["id"]] += spend
                    valid &= spent[d["id"]] <= F(d["totalLimit"])
                    for k in range(t, min(len(occupancy[d["id"]]), t + a["occupationPeriods"])):
                        occupancy[d["id"]][k] += occupied
            for d in m["dimensions"]:
                valid &= all(v <= F(d["capacity"]) for v in occupancy[d["id"]])
            for coupling in m["couplings"]:
                for t in range(m["horizon"]["periods"] + 1):
                    valid &= sum(F(q) * occupancy[d][t] for d, q in coupling["weights"].items()) <= F(coupling["maxPerPeriod"])
        valid &= min(worlds.values()) >= F(m["minimumUtility"])
        if valid:
            feasible.append(p["id"])
            payoffs[p["id"]] = worlds
    if not feasible:
        return {"winner": None, "ties": [], "worst": [], "value": None}
    robust = {p: min(payoffs[p].values()) for p in feasible}
    best = max(robust.values())
    ties = [p for p in s["tieOrder"] if p in robust and robust[p] == best]
    return {"winner": ties[0], "ties": ties, "worst": [w for w, v in payoffs[ties[0]].items() if v == best], "value": encode(best)}


def encode(q):
    return str(q.numerator) + "/" + str(q.denominator)


def determinant(a):
    if len(a) == 1:
        return a[0][0]
    return sum((-1 if i % 2 else 1) * q * determinant([row[:i] + row[i + 1:] for row in a[1:]]) for i, q in enumerate(a[0]))


def vertices(rows, n):
    result = set()
    for equations in itertools.combinations(rows, n):
        matrix = [list(e[:-1]) for e, _ in equations]
        denominator = determinant(matrix)
        if not denominator:
            continue
        rhs = [-e[-1] for e, _ in equations]
        point = []
        for i in range(n):
            numerator = determinant([row[:i] + [v] + row[i + 1:] for row, v in zip(matrix, rhs)])
            point.append(numerator / denominator)
        if all((sum(a * x for a, x in zip(e[:-1], point)) + e[-1] == 0 if r == "EQ" else
                sum(a * x for a, x in zip(e[:-1], point)) + e[-1] <= 0) for e, r in rows):
            result.add(tuple(point))
    return list(result)


def arrangement(s):
    n = len(s["domain"]["parameters"])
    if n > 2:
        return {"status": "INAPPLICABLE_MAXIMAL_TRACTABLE_DIRECT_AND_WHOLE_CELL", "points": []}
    z = [F(0)] * n
    rows = [(tuple(F(v) for v in f["expression"]["a"]) + (F(f["expression"]["b"]),), f["relation"]) for f in s["domain"]["facets"]]
    for i, p in enumerate(s["domain"]["parameters"]):
        a = list(z); a[i] = F(-1); rows.append((tuple(a) + (F(p["lower"]),), "LE"))
        a[i] = F(1); rows.append((tuple(a) + (-F(p["upper"]),), "LE"))
    planes = set()
    def plane(e):
        if not any(e[:-1]):
            return
        first = next(v for v in e if v)
        planes.add(tuple(v / first for v in e))
    for c in s["hardPredicates"]:
        plane(tuple(F(v) for v in c["expression"]["a"]) + (F(c["expression"]["b"]),))
    payoffs = []
    for p in s["policies"]:
        for w in s["worlds"]:
            b = value(s, p, w, z)
            a = []
            for i in range(n):
                unit = list(z); unit[i] = F(1)
                a.append(value(s, p, w, unit) - b)
            payoffs.append(tuple(a) + (b,))
    for a, b in itertools.combinations(payoffs, 2):
        plane(tuple(x - y for x, y in zip(a, b)))
    cells = [rows]
    for e in sorted(planes):
        next_cells = []
        for cell in cells:
            for f in ((e, "LT"), (e, "EQ"), (tuple(-q for q in e), "LT")):
                refined = cell + [f]
                v = vertices(refined, n)
                if not v:
                    continue
                witness = tuple(sum(point[i] for point in v) / len(v) for i in range(n))
                if all((sum(a * x for a, x in zip(e[:-1], witness)) + e[-1] == 0 if r == "EQ" else
                        sum(a * x for a, x in zip(e[:-1], witness)) + e[-1] < 0 if r == "LT" else
                        sum(a * x for a, x in zip(e[:-1], witness)) + e[-1] <= 0) for e, r in refined):
                    next_cells.append(refined)
        cells = next_cells
        if len(cells) > 4096:
            raise ValueError("REFERENCE_ARRANGEMENT_LIMIT")
    points = []
    for cell in cells:
        v = vertices(cell, n)
        witness = tuple(sum(point[i] for point in v) / len(v) for i in range(n))
        points.append({"point": [encode(x) for x in witness], "expected": direct(s, witness)})
    return {"status": "COMPLETE_REGISTERED_ARRANGEMENT", "planes": len(planes), "strata": len(cells), "points": points}


frame = json.load(sys.stdin)
s = frame["source"]
print(json.dumps({"arrangement": arrangement(s), "queries": [direct(s, [F(v) for v in p]) for p in frame.get("points", [])]}, separators=(",", ":")))
