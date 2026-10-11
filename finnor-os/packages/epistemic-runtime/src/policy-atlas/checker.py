"""Original-input R7 checker, specified in scope-r/.../acceptance.md before code.

Only Python stdlib/Fraction. No producer modules, normalized matrix or solver
status is accepted as proof. Exhaustively reconstruct bounded H/V bases in the
affine hull and strict common-slack geometry, original whole-world utility and
all original constraints. This is ordinary conditional scientific verification.
"""
import hashlib
import itertools
import json
import math
import pathlib
import re
import resource
import sys
import time
import os
import threading
from datetime import datetime
from fractions import Fraction
from functools import lru_cache


class Rejected(Exception):
    pass


class Limit(Exception):
    pass


def require(value, predicate):
    if not value:
        raise Rejected(predicate)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


@lru_cache(maxsize=8192)
def exact(value, bits=4096):
    require(isinstance(value, str) and len(value) <= 2500 and re.fullmatch(r"(?:0|-?[1-9]\d*)/[1-9]\d*", value), "RATIONAL_ENCODING")
    q = Fraction(value)
    require(str(q.numerator) + "/" + str(q.denominator) == value, "RATIONAL_CANONICAL")
    if abs(q.numerator).bit_length() > bits or q.denominator.bit_length() > bits:
        raise Limit("INTEGER_GROWTH_LIMIT")
    return q


def encoded(q):
    exact(str(q.numerator) + "/" + str(q.denominator))
    return str(q.numerator) + "/" + str(q.denominator)


def expr(value, n):
    require(isinstance(value, dict) and set(value) == {"a", "b"} and isinstance(value["a"], list) and len(value["a"]) == n, "AFFINE_DIMENSION")
    return tuple(exact(v) for v in value["a"]) + (exact(value["b"]),)


def output_expr(e):
    return {"a": [encoded(q) for q in e[:-1]], "b": encoded(e[-1])}


def plus(a, b, factor=Fraction(1)):
    result = tuple(x + factor * y for x, y in zip(a, b))
    for q in result:
        encoded(q)
    return result


def scaled(a, b):
    return plus(tuple(Fraction(0) for _ in a), a, b)


def at(a, point):
    return sum(x * y for x, y in zip(a[:-1], point)) + a[-1]


def valid(row, point, closed=False):
    e, relation = row
    value = at(e, point)
    return value == 0 if relation == "EQ" else value < 0 if relation == "LT" and not closed else value <= 0


def facet(value, n):
    require(isinstance(value, dict) and value.get("relation") in ("LE", "LT", "EQ"), "FACET_SEMANTICS")
    return expr(value["expression"], n), value["relation"]


class Meter:
    def __init__(self, budget):
        # Checker acceptance limits are fixed by its own implementation.
        caps = {"maxNodes": 1024, "maxDepth": 256, "maxFacets": 256, "maxBases": 200000,
                "maxTotalBases": 2000000, "maxBytes": 33554432, "deadlineMs": 30000}
        require(isinstance(budget, dict) and set(budget) == set(caps) and
                all(type(budget[k]) is int and 0 < budget[k] <= caps[k] for k in caps), "REGISTERED_BUDGET")
        self.budget = caps  # A small producer grant does not shrink the checker's proof predicate.
        self.bases = 0
        self.deadline = time.monotonic() + caps["deadlineMs"] / 1000

    def tick(self, basis=False):
        self.bases += int(basis)
        if self.bases > self.budget["maxTotalBases"]:
            raise Limit("CHECK_TOTAL_BASIS_LIMIT")
        if time.monotonic() >= self.deadline:
            raise Limit("CHECK_DEADLINE")


def eliminated(rows, n):
    matrix = [list(row) for row in rows]
    pivots = []
    for col in range(n):
        index = next((i for i in range(len(pivots), len(matrix)) if matrix[i][col]), None)
        if index is None:
            continue
        rank = len(pivots)
        matrix[rank], matrix[index] = matrix[index], matrix[rank]
        factor = matrix[rank][col]
        matrix[rank] = [q / factor for q in matrix[rank]]
        for i, row in enumerate(matrix):
            if i != rank and row[col]:
                factor = row[col]
                matrix[i] = [q - factor * v for q, v in zip(row, matrix[rank])]
        pivots.append(col)
    inconsistent = any(not any(row[:n]) and row[n] != 0 for row in matrix)
    return [row for row in matrix if any(row[:n])], pivots, inconsistent


def complete_vertices(rows, n, meter):
    meter.tick()
    # Positive normalization only. It does not change <=/< orientation.
    unique = {}
    for e, relation in rows:
        first = next((abs(v) for v in e if v), Fraction(1))
        unique[(tuple(v / first for v in e), relation)] = (e, relation)
    rows = list(unique.values())
    if len(rows) > meter.budget["maxFacets"] + 2:
        raise Limit("CHECK_CELL_FACET_LIMIT")
    equalities, pivots, inconsistent = eliminated([e[:-1] + (-e[-1],) for e, r in rows if r == "EQ"], n)
    if inconsistent:
        return []
    inequalities = [e for e, r in rows if r != "EQ"]
    vertices = set()
    for local, selected in enumerate(itertools.combinations(inequalities, n - len(pivots)), 1):
        meter.tick(True)
        if local > meter.budget["maxBases"]:
            raise Limit("CHECK_CELL_BASIS_LIMIT")
        matrix, indices, contradiction = eliminated(equalities + [e[:-1] + (-e[-1],) for e in selected], n)
        if contradiction or len(indices) != n:
            continue
        point = [Fraction(0)] * n
        for row, col in zip(matrix, indices):
            point[col] = row[n]
        if all(valid(row, point, True) for row in rows):
            for q in point:
                encoded(q)
            vertices.add(tuple(point))
    return sorted(vertices, key=lambda p: ",".join(encoded(v) for v in p))


def geometry(rows, n, meter):
    vertices = complete_vertices(rows, n, meter)
    if not vertices:
        return None
    if any(r == "LT" for _, r in rows):
        augmented = [(e[:-1] + (Fraction(int(r == "LT")), e[-1]), "EQ" if r == "EQ" else "LE") for e, r in rows]
        augmented += [(tuple([Fraction(0)] * n + [Fraction(-1), Fraction(0)]), "LE"),
                      (tuple([Fraction(0)] * n + [Fraction(1), Fraction(-1)]), "LE")]
        positive = [p for p in complete_vertices(augmented, n + 1, meter) if p[n] > 0]
        if not positive:
            return None
        witness = tuple(sum(p[i] for p in positive) / len(positive) for i in range(n))
        slack = sum(p[n] for p in positive) / len(positive)
    else:
        witness = tuple(sum(p[i] for p in vertices) / len(vertices) for i in range(n))
        slack = Fraction(1)
    require(all(valid(row, witness) for row in rows), "COMMON_SLACK_NONEMPTY")
    _, hull, _ = eliminated([tuple(q - v for q, v in zip(p, vertices[0])) + (Fraction(0),) for p in vertices[1:]], n)
    return {"vertices": vertices, "witness": witness, "slack": slack, "affineDimension": len(hull)}


def sign_over(e, rows, g, meter):
    meter.tick()
    cache = g.setdefault("checkedSigns", {})
    if e in cache:
        return cache[e]
    values = [at(e, point) for point in g["vertices"]]
    low, high = min(values), max(values)
    if low == high == 0:
        result = 0
    elif low > 0:
        result = 1
    elif high < 0:
        result = -1
    else:
        require(not (low < 0 < high), "CELL_UNRESOLVED_SIGN")
        require(geometry(rows + [(e, "EQ")], len(e) - 1, meter) is None, "CELL_EQUALITY_NOT_EXCLUDED")
        result = -1 if low < 0 else 1
    # Reuse only an independently proved sign in this same exact cell.
    # Original policy, world and constraint identities are still all checked.
    cache[e] = result
    return result


def original_shape(source):
    """Independent original wire shape. Unknown transforms cannot disappear."""
    def shape(v, keys):
        require(isinstance(v, dict) and set(v) == set(keys.split()), "ORIGINAL_INPUT_SHAPE")
    def count(v, low, high):
        require(isinstance(v, list) and low <= len(v) <= high, "ORIGINAL_CARDINALITY")
    def integer(v, low, high):
        require(type(v) is int and low <= v <= high, "ORIGINAL_INTEGER_DOMAIN")
    def clock(v):
        require(isinstance(v, str) and len(v) <= 64 and (v.endswith("Z") or re.search(r"[+-]\d\d:\d\d$", v)), "ORIGINAL_CLOCK")
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    def ref(v):
        shape(v, "owner id version contentDigest")
        require(all(isinstance(v[k], str) and 0 < len(v[k]) <= (4096 if k == "id" else 256) for k in v) and
                re.fullmatch(r"[a-f0-9]{64}", v["contentDigest"]), "ORIGINAL_REFERENCE")
    shape(source, "schema modelKey familyKey representation domain mandate stateUnits policies worlds hardPredicates tieOrder assumptions qualification parameterValues")
    count(source["assumptions"], 1, 64)
    shape(source["domain"], "parameters facets")
    count(source["domain"]["parameters"], 1, 4); count(source["domain"]["facets"], 0, 128)
    for p in source["domain"]["parameters"]:
        shape(p, "id unit currency owner valueSource resourceId resourcePeriod lower upper")
        exact(p["lower"], 256); exact(p["upper"], 256)
        if p["resourcePeriod"] is not None:
            integer(p["resourcePeriod"], 0, 12)
    m = source["mandate"]
    shape(m, "ref schema tenantId principalId episodeId rightsRef knowledgeAt validUntil businessOwnerRef utilityRef accountingConventionRef horizon quantityBasis utility minimumUtility maxHumanSeconds dimensions couplings funding ambiguity authorization")
    for k in ("ref", "businessOwnerRef", "utilityRef", "accountingConventionRef"):
        ref(m[k])
    require(clock(m["validUntil"]) > clock(m["knowledgeAt"]), "ORIGINAL_MANDATE_CLOCK")
    shape(m["horizon"], "startAt periodMs periods")
    clock(m["horizon"]["startAt"]); integer(m["horizon"]["periodMs"], 1, 31536000000); integer(m["horizon"]["periods"], 1, 12)
    shape(m["quantityBasis"], "unit currency ownershipRef valuationAt discountBasisRef")
    clock(m["quantityBasis"]["valuationAt"]); ref(m["quantityBasis"]["ownershipRef"]); ref(m["quantityBasis"]["discountBasisRef"])
    shape(m["utility"], "periodTerms terminalTerms discountFactors terminalLiability")
    for k in ("periodTerms", "terminalTerms"):
        count(m["utility"][k], 0, 32)
        for t in m["utility"][k]:
            shape(t, "variableId unit coefficient coefficientUnit")
            exact(t["coefficient"], 256)
            require(t["coefficientUnit"] == m["quantityBasis"]["unit"] + "/" + t["unit"], "ORIGINAL_UTILITY_UNIT")
    count(m["utility"]["discountFactors"], 2, 13)
    exact(m["minimumUtility"], 256)
    for q in m["utility"]["discountFactors"] + [m["maxHumanSeconds"], m["utility"]["terminalLiability"]]:
        require(exact(q, 256) >= 0, "NEGATIVE_ORIGINAL_LIMIT")
    count(m["dimensions"], 0, 16); count(m["couplings"], 0, 16)
    require(len({d["id"] for d in m["dimensions"]}) == len(m["dimensions"]) and
            len({d["id"] for d in m["couplings"]}) == len(m["couplings"]), "ORIGINAL_DIMENSION_IDENTITY")
    for d in m["dimensions"]:
        shape(d, "id unit resourceClass capacity totalLimit resourceId component")
        require(d["component"] in ("TOTAL", "OCCUPANCY") and d["resourceClass"] in
                ("CASH", "BORROWING_HEADROOM", "COMMITTED_CAPITAL", "OPERATIONAL_CAPACITY", "HUMAN_ATTENTION", "COMPUTE", "INQUIRY_EXPOSURE", "COUNTERPARTY_EXPOSURE", "OTHER_RESTRICTED"), "ORIGINAL_RESOURCE_CLASS")
        require(exact(d["capacity"], 256) >= 0 and exact(d["totalLimit"], 256) >= 0, "NEGATIVE_ORIGINAL_LIMIT")
    for c in m["couplings"]:
        shape(c, "id weights maxPerPeriod")
        require(isinstance(c["weights"], dict) and set(c["weights"]) <= {d["id"] for d in m["dimensions"]}, "ORIGINAL_COUPLING_COVERAGE")
        require(len({d["unit"] for d in m["dimensions"] if d["id"] in c["weights"]}) <= 1, "COUPLING_UNIT_BASIS_UNSUPPORTED")
        require(exact(c["maxPerPeriod"], 256) >= 0, "NEGATIVE_ORIGINAL_LIMIT")
        for q in c["weights"].values(): exact(q, 256)
    shape(m["funding"], "costResourceId liabilityResourceId humanResourceId")
    count(source["policies"], 1, 32); count(source["worlds"], 1, 64); count(source["hardPredicates"], 0, 65536)
    count(source["parameterValues"], 1, 4)
    for q in source["parameterValues"]: exact(q, 256)
    require(isinstance(source["stateUnits"], dict) and 1 <= len(source["stateUnits"]) <= 32, "ORIGINAL_STATE_DOMAIN")
    n = len(source["domain"]["parameters"])
    def affine(v):
        e = expr(v, n)
        for q in list(v["a"]) + [v["b"]]: exact(q, 256)
        return e
    for f in source["domain"]["facets"]:
        shape(f, "expression relation"); facet(f, n); affine(f["expression"])
    for p in source["policies"]:
        shape(p, "id ref rootNodeId actions nodes"); ref(p["ref"])
        count(p["actions"], 1, 32); count(p["nodes"], 1, 768)
        for a in p["actions"]:
            shape(a, "id kind cost costUnit tailLiability humanSeconds resources occupancy exposures occupationPeriods earliestPeriod lastPeriod atMostOnce protocolRef informationDelayPeriods precondition")
            require(a["kind"] in ("INQUIRE", "INTERVENE", "WAIT", "STOP") and type(a["atMostOnce"]) is bool, "ORIGINAL_ACTION_SEMANTICS")
            for k in ("cost", "tailLiability", "humanSeconds"): affine(a[k])
            for k in ("resources", "occupancy"):
                require(isinstance(a[k], dict), "ORIGINAL_DEMAND_COVERAGE")
                for v in a[k].values(): affine(v)
            require(isinstance(a["exposures"], dict) and (a["kind"] == "INTERVENE" or not a["exposures"]), "ORIGINAL_EXPOSURE_SEMANTICS")
            for v in a["exposures"].values():
                shape(v, "unit doses"); count(v["doses"], 1, 12)
                for e in v["doses"]: affine(e)
            integer(a["occupationPeriods"], 1, 13); integer(a["earliestPeriod"], 0, 11); integer(a["lastPeriod"], 0, 11)
            integer(a["informationDelayPeriods"], 1, 12)
            if a["protocolRef"] is not None: ref(a["protocolRef"])
            shape(a["precondition"], "afterActionIds observations")
            count(a["precondition"]["afterActionIds"], 0, 12); count(a["precondition"]["observations"], 0, 8)
            require(set(a["precondition"]["afterActionIds"]) <= {v["id"] for v in p["actions"]}, "ORIGINAL_PRECONDITION_IDENTITY")
            for v in a["precondition"]["observations"]:
                shape(v, "instrumentId tokens"); count(v["tokens"], 1, 64)
        for v in p["nodes"]:
            shape(v, "id period actionId actionHistory observations children")
            integer(v["period"], 0, 11); count(v["actionHistory"], 0, 12); count(v["children"], 0, 64); count(v["observations"], 0, 8)
            for o in v["observations"]:
                shape(o, "instrumentId token availablePeriod"); integer(o["availablePeriod"], 0, 12)
    for w in source["worlds"]:
        shape(w, "id mechanismRef supportRef paths"); ref(w["mechanismRef"]); ref(w["supportRef"]); count(w["paths"], 1, 32)
        for path in w["paths"]:
            shape(path, "policyId nodeIds states"); count(path["nodeIds"], 1, 12); count(path["states"], 2, 13)
            for state in path["states"]:
                require(isinstance(state, dict), "ORIGINAL_STATE_DOMAIN")
                for v in state.values(): affine(v)
    for c in source["hardPredicates"]:
        shape(c, "expression relation id policyId worldId period unit owner sourceRef")
        facet(c, n); affine(c["expression"]); ref(c["sourceRef"]); integer(c["period"], 0, 12)
        require(c["owner"] in ("S3", "S4", "S5", "BUSINESS_OWNER"), "ORIGINAL_CONSTRAINT_OWNER")


def reconstruct(source):
    original_shape(source)
    require(source.get("schema") == "finnor.s3.affine-family-source.v1" and
            source.get("representation") == "SUPPLIED_COMPLETE_AFFINE_PATH_HYPOTHESIS" and
            source.get("qualification") == "MODEL_RELATIVE_EXACT_UNADMITTED", "ORIGINAL_AFFINE_SEMANTICS")
    parameters, policies, worlds, m = source["domain"]["parameters"], source["policies"], source["worlds"], source["mandate"]
    n, h = len(parameters), m["horizon"]["periods"]
    require(1 <= n <= 4 and 1 <= len(policies) <= 32 and 1 <= len(worlds) <= 64 and 1 <= h <= 12, "ORIGINAL_PROFILE")
    require(len({p["id"] for p in policies}) == len(policies) and len({w["id"] for w in worlds}) == len(worlds) and
            len(source["tieOrder"]) == len(policies) and set(source["tieOrder"]) == {p["id"] for p in policies}, "ORIGINAL_FAMILY_TIE_COVERAGE")
    require(m["schema"] == "finnor.economic-mandate.exact-affine.v1" and
            m["ambiguity"] == "ROBUST_FIXED_COMPLETE_WORLDS_NO_PROBABILITIES" and
            m["authorization"] == "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED", "ORIGINAL_MANDATE_SEMANTICS")
    mb = {k: v for k, v in m.items() if k != "ref"}
    require(m["ref"]["contentDigest"] == digest(mb) and m["ref"]["id"] == "exact-affine-mandate:" + digest(mb) and
            m["ref"]["owner"] == "BUSINESS_OWNER" and m["ref"]["version"] == "economic-mandate-exact-affine-v1" and
            m["businessOwnerRef"]["id"] == m["principalId"], "ORIGINAL_MANDATE_BINDING")
    require(len(m["utility"]["discountFactors"]) == h + 1 and m["quantityBasis"]["currency"] in (None, m["quantityBasis"]["unit"]), "ORIGINAL_QUANTITY_DISCOUNT")
    require(len(source["parameterValues"]) == n and len({p["id"] for p in parameters}) == n, "ORIGINAL_PARAMETER_COVERAGE")
    for t in m["utility"]["periodTerms"] + m["utility"]["terminalTerms"]:
        require(source["stateUnits"].get(t["variableId"]) == t["unit"], "ORIGINAL_UTILITY_UNIT")
    rows = [facet(f, n) for f in source["domain"]["facets"]]
    for i, p in enumerate(parameters):
        lower, upper = exact(p["lower"], 256), exact(p["upper"], 256)
        require(lower <= upper, "DOMAIN_EMPTY")
        require(p["currency"] in (None, p["unit"]), "PARAMETER_UNIT")
        require((p["owner"] == "S5" and p["valueSource"] == "CURRENT_S5_AVAILABLE" and p["resourceId"] is not None and p["resourcePeriod"] is not None) or
                (p["owner"] == "BUSINESS_OWNER" and p["valueSource"] == "AUTHENTICATED_OWNER_REVISION" and p["resourceId"] is None and p["resourcePeriod"] is None), "PARAMETER_OWNER")
        a = [Fraction(0)] * n
        a[i] = Fraction(-1)
        rows.append((tuple(a) + (lower,), "LE"))
        a[i] = Fraction(1)
        rows.append((tuple(a) + (-upper,), "LE"))
    zero = tuple([Fraction(0)] * (n + 1))
    con = lambda q: zero[:-1] + (exact(q),)
    models = {}
    hard = source["hardPredicates"]
    require(len({c["id"] for c in hard}) == len(hard) and all(c["policyId"] in source["tieOrder"] and
            c["worldId"] in {w["id"] for w in worlds} and 0 <= c["period"] <= h and c["unit"] for c in hard), "ORIGINAL_CONSTRAINT_IDENTITY")
    for p in policies:
        pb = {k: v for k, v in p.items() if k != "ref"}
        require(p["ref"]["owner"] == "S4" and p["ref"]["version"] == "s4-exact-affine-v1" and
                p["ref"]["contentDigest"] == digest(pb) and p["ref"]["id"] == "exact-affine-policy:" + digest(pb), "ORIGINAL_POLICY_BINDING")
        actions = {a["id"]: a for a in p["actions"]}
        nodes = {v["id"]: v for v in p["nodes"]}
        require(len(actions) == len(p["actions"]) and len(nodes) == len(p["nodes"]) and
                p["rootNodeId"] in nodes and nodes[p["rootNodeId"]]["period"] == 0 and
                not nodes[p["rootNodeId"]]["observations"] and not nodes[p["rootNodeId"]]["actionHistory"], "ORIGINAL_POLICY_TOPOLOGY")
        parent_counts = {v: 0 for v in nodes}
        information_states = set()
        for node in nodes.values():
            require(node["actionId"] in actions, "ORIGINAL_ACTION_ID")
            a = actions[node["actionId"]]
            require(not any(actions[v]["kind"] == "STOP" for v in node["actionHistory"]) or a["kind"] == "STOP", "STOP_CONTINUATION")
            require(a["costUnit"] == m["quantityBasis"]["unit"] and a["earliestPeriod"] <= node["period"] <= a["lastPeriod"] < h and
                    len(node["actionHistory"]) == node["period"] and (node["period"] == h - 1) == (not node["children"]) and
                    (not a["atMostOnce"] or a["id"] not in node["actionHistory"]) and
                    all(v in node["actionHistory"] for v in a["precondition"]["afterActionIds"]), "LAWFUL_ACTION_HISTORY")
            require((a["kind"] == "INQUIRE") == (a["protocolRef"] is not None), "ORIGINAL_INQUIRY")
            for guard in a["precondition"]["observations"]:
                require(any(o["instrumentId"] == guard["instrumentId"] and o["token"] in guard["tokens"] for o in node["observations"]), "LAWFUL_OBSERVATION_GUARD")
            for o in node["observations"]:
                inquiry = next((v for v in actions.values() if v["protocolRef"] and v["protocolRef"]["id"] == o["instrumentId"]), None)
                require(inquiry is not None and 0 <= o["availablePeriod"] - inquiry["informationDelayPeriods"] < len(node["actionHistory"]) and
                        o["availablePeriod"] <= node["period"] and
                        node["actionHistory"][o["availablePeriod"] - inquiry["informationDelayPeriods"]] == inquiry["id"], "LAWFUL_OBSERVATION_TIMING")
            observed_events = [(o["instrumentId"], o["availablePeriod"]) for o in node["observations"]]
            require(len(set(observed_events)) == len(observed_events), "ORIGINAL_OBSERVATION_EVENT_IDENTITY")
            information = (node["period"], tuple(node["actionHistory"]),
                           tuple(sorted((o["instrumentId"], o["availablePeriod"], o["token"]) for o in node["observations"])))
            require(information not in information_states, "ORIGINAL_NONANTICIPATIVE_POLICY")
            information_states.add(information)
            require(len(set(node["children"])) == len(node["children"]), "BRANCH_IDENTITY")
            for child in node["children"]:
                require(child in nodes and nodes[child]["period"] == node["period"] + 1 and
                        nodes[child]["actionHistory"] == node["actionHistory"] + [node["actionId"]] and
                        all(o in nodes[child]["observations"] for o in node["observations"]), "ORIGINAL_POLICY_TOPOLOGY")
                parent_counts[child] += 1
        require(all(count == (0 if id == p["rootNodeId"] else 1) for id, count in parent_counts.items()), "ORIGINAL_POLICY_TOPOLOGY")
        model = {"payoffs": {}, "constraints": [], "demands": {}}
        def row(id, e, world, period, relation="LE"):
            model["constraints"].append({"id": id, "e": e, "world": world, "period": period, "relation": relation})
        covered = set()
        for world in worlds:
            require(len(world["paths"]) == len(policies) and {path["policyId"] for path in world["paths"]} == set(source["tieOrder"]) and
                    len({path["policyId"] for path in world["paths"]}) == len(policies), "ORIGINAL_WORLD_POLICY_COVERAGE")
            path = next(path for path in world["paths"] if path["policyId"] == p["id"])
            require(len(path["nodeIds"]) == h and len(path["states"]) == h + 1 and path["nodeIds"][0] == p["rootNodeId"] and
                    all(set(state) == set(source["stateUnits"]) for state in path["states"]), "COMPLETE_FIXED_WORLD")
            value, liability, human = zero, con(m["utility"]["terminalLiability"]), zero
            spend = {d["id"]: zero for d in m["dimensions"]}
            occupancy = {d["id"]: [zero] * (h + 1) for d in m["dimensions"]}
            demands = {}
            def fund(id, e, t, name):
                require(id is not None or not any(e), name + "_FUNDING_UNRESOLVED")
                if id is not None:
                    demands.setdefault(id, [zero] * (h + 1))[t] = plus(demands.setdefault(id, [zero] * (h + 1))[t], e)
            fund(m["funding"]["liabilityResourceId"], liability, h, "TAIL")
            for t, node_id in enumerate(path["nodeIds"]):
                require(node_id in nodes and nodes[node_id]["period"] == t and
                        (t == 0 or node_id in nodes[path["nodeIds"][t - 1]]["children"]), "FIXED_WORLD_LAWFUL_PATH")
                covered.add(node_id)
                a = actions[nodes[node_id]["actionId"]]
                require(set(a["resources"]) == set(spend) and set(a["occupancy"]) == set(spend), "ORIGINAL_DEMAND_COVERAGE")
                utility = zero
                for term in m["utility"]["periodTerms"]:
                    utility = plus(utility, expr(path["states"][t + 1][term["variableId"]], n), exact(term["coefficient"]))
                cost, tail, attention = expr(a["cost"], n), expr(a["tailLiability"], n), expr(a["humanSeconds"], n)
                value = plus(value, scaled(plus(utility, cost, Fraction(-1)), exact(m["utility"]["discountFactors"][t])))
                liability, human = plus(liability, tail), plus(human, attention)
                row("human:%s:%s" % (world["id"], t), plus(human, con(m["maxHumanSeconds"]), Fraction(-1)), world["id"], t)
                for name, amount in (("cost", cost), ("liability", tail), ("human", attention)):
                    row("nonnegative:%s:%s:%s" % (world["id"], t, name), scaled(amount, Fraction(-1)), world["id"], t)
                for d in m["dimensions"]:
                    demand, occupation = expr(a["resources"][d["id"]], n), expr(a["occupancy"][d["id"]], n)
                    row("nonnegative:%s:%s:total:%s" % (world["id"], t, d["id"]), scaled(demand, Fraction(-1)), world["id"], t)
                    row("nonnegative:%s:%s:occupancy:%s" % (world["id"], t, d["id"]), scaled(occupation, Fraction(-1)), world["id"], t)
                    spend[d["id"]] = plus(spend[d["id"]], demand)
                    row("total:%s:%s:%s" % (world["id"], t, d["id"]), plus(spend[d["id"]], con(d["totalLimit"]), Fraction(-1)), world["id"], t)
                    for k in range(t, min(h + 1, t + a["occupationPeriods"])):
                        occupancy[d["id"]][k] = plus(occupancy[d["id"]][k], occupation)
                    require(not any(occupation if d["component"] == "TOTAL" else demand), "DUAL_COMPONENT_RESOURCE_BINDING")
                    if d["component"] == "TOTAL":
                        fund(d["resourceId"], demand, t, "DIMENSION")
                    else:
                        for k in range(t, min(h + 1, t + a["occupationPeriods"])):
                            fund(d["resourceId"], occupation, k, "DIMENSION")
                fund(m["funding"]["costResourceId"], cost, t, "COST")
                fund(m["funding"]["liabilityResourceId"], tail, h, "LIABILITY")
                fund(m["funding"]["humanResourceId"], attention, t, "HUMAN")
            for d in m["dimensions"]:
                for t in range(h + 1):
                    row("capacity:%s:%s:%s" % (world["id"], t, d["id"]), plus(occupancy[d["id"]][t], con(d["capacity"]), Fraction(-1)), world["id"], t)
            for coupling in m["couplings"]:
                require(set(coupling["weights"]) <= set(occupancy), "ORIGINAL_COUPLING_COVERAGE")
                for t in range(h + 1):
                    used = zero
                    for key, weight in coupling["weights"].items():
                        used = plus(used, occupancy[key][t], exact(weight))
                    row("coupling:%s:%s:%s" % (world["id"], t, coupling["id"]), plus(used, con(coupling["maxPerPeriod"]), Fraction(-1)), world["id"], t)
            terminal = zero
            for term in m["utility"]["terminalTerms"]:
                terminal = plus(terminal, expr(path["states"][h][term["variableId"]], n), exact(term["coefficient"]))
            value = plus(value, scaled(plus(terminal, liability, Fraction(-1)), exact(m["utility"]["discountFactors"][h])))
            model["payoffs"][world["id"]] = value
            model["demands"][world["id"]] = demands
            row("risk:" + world["id"], plus(con(m["minimumUtility"]), value, Fraction(-1)), world["id"], h)
        require(covered == set(nodes), "OMITTED_REACHABLE_POLICY_NODE")
        for c in hard:
            if c["policyId"] == p["id"]:
                row("hard:" + c["id"], expr(c["expression"], n), c["worldId"], c["period"], c["relation"])
        models[p["id"]] = model
    return n, rows, models


def original_split(reason, models):
    kind = reason.get("kind")
    if kind == "CONSTRAINT":
        require(set(reason) == {"kind", "policyId", "constraintId"} and reason["policyId"] in models, "SPLIT_PROVENANCE")
        row = next((c for c in models[reason["policyId"]]["constraints"] if c["id"] == reason["constraintId"]), None)
        require(row is not None, "SPLIT_ORIGINAL_CONSTRAINT")
        return row["e"]
    if kind == "WORLD":
        require(set(reason) == {"kind", "policyId", "leftWorldId", "rightWorldId"} and reason["policyId"] in models, "SPLIT_PROVENANCE")
        payoffs = models[reason["policyId"]]["payoffs"]
        require(reason["leftWorldId"] in payoffs and reason["rightWorldId"] in payoffs, "SPLIT_ORIGINAL_WORLD")
        return plus(payoffs[reason["leftWorldId"]], payoffs[reason["rightWorldId"]], Fraction(-1))
    require(kind == "RANKING" and set(reason) == {"kind", "leftPolicyId", "leftWorldId", "rightPolicyId", "rightWorldId"} and
            reason["leftPolicyId"] in models and reason["rightPolicyId"] in models, "SPLIT_PROVENANCE")
    left, right = models[reason["leftPolicyId"]]["payoffs"], models[reason["rightPolicyId"]]["payoffs"]
    require(reason["leftWorldId"] in left and reason["rightWorldId"] in right, "SPLIT_ORIGINAL_WORLD")
    return plus(left[reason["leftWorldId"]], right[reason["rightWorldId"]], Fraction(-1))


def accepted_label(source, models, rows, g, meter, supplied):
    require(set(supplied) == {"policies", "winnerPolicyId", "tiedPolicyIds", "value", "disposition"}, "CELL_LABEL_SHAPE")
    statuses, values = [], {}
    require(len(supplied["policies"]) == len(source["policies"]), "CELL_FAMILY_COVERAGE")
    for p, issued in zip(source["policies"], supplied["policies"]):
        require(set(issued) == {"policyId", "feasible", "violatedConstraintId", "worstWorldIds", "bindingConstraintIds"} and issued["policyId"] == p["id"], "CELL_POLICY_IDENTITY")
        model, binding = models[p["id"]], []
        if not issued["feasible"]:
            violation = next((c for c in model["constraints"] if c["id"] == issued["violatedConstraintId"]), None)
            require(violation is not None, "ORIGINAL_INFEASIBILITY_WITNESS")
            s = sign_over(violation["e"], rows, g, meter)
            require((s != 0 if violation["relation"] == "EQ" else s >= 0 if violation["relation"] == "LT" else s > 0) and
                    issued["worstWorldIds"] == [] and issued["bindingConstraintIds"] == [], "WHOLE_CELL_INFEASIBILITY")
            statuses.append(issued)
            continue
        require(issued["violatedConstraintId"] is None, "FEASIBLE_CONTRADICTION")
        for c in model["constraints"]:
            s = sign_over(c["e"], rows, g, meter)
            require(s == 0 if c["relation"] == "EQ" else s < 0 if c["relation"] == "LT" else s <= 0, "ORIGINAL_WHOLE_CELL_FEASIBILITY")
            if s == 0:
                binding.append(c["id"])
        require(issued["bindingConstraintIds"] == binding, "BINDING_CONSTRAINT_COVERAGE")
        world = min(model["payoffs"], key=lambda w: at(model["payoffs"][w], g["witness"]))
        active = []
        for w, value in model["payoffs"].items():
            s = sign_over(plus(model["payoffs"][world], value, Fraction(-1)), rows, g, meter)
            require(s <= 0, "ORIGINAL_WORST_WORLD")
            if s == 0:
                active.append(w)
        require(issued["worstWorldIds"] == active, "WORST_WORLD_TIE_COVERAGE")
        values[p["id"]] = model["payoffs"][world]
        statuses.append(issued)
    if not values:
        require(supplied["winnerPolicyId"] is None and supplied["tiedPolicyIds"] == [] and supplied["value"] is None and
                supplied["disposition"] == "NAMED_FAMILY_INFEASIBLE", "NAMED_FAMILY_INFEASIBLE_ONLY")
        return
    winner = max(values, key=lambda p: at(values[p], g["witness"]))
    ties = set()
    for p in values:
        s = sign_over(plus(values[winner], values[p], Fraction(-1)), rows, g, meter)
        require(s >= 0, "ORIGINAL_ALL_POLICY_COMPARISONS")
        if s == 0:
            ties.add(p)
    ordered = [p for p in source["tieOrder"] if p in ties]
    require(supplied["winnerPolicyId"] == ordered[0] and supplied["tiedPolicyIds"] == ordered and
            supplied["disposition"] == "NAMED_FAMILY_OPTIMUM" and
            expr(supplied["value"], len(g["witness"])) == values[ordered[0]], "OWNER_TIE_AND_VALUE_RULE")


def check(source, proposal, checker_digest):
    start = time.monotonic()
    receipt = {"schema": "finnor.r7.original-input-check.v1", "status": "REJECTED",
               "inputDigest": digest(source), "proposalDigest": digest(proposal), "checkerDigest": checker_digest,
               "predicate": "UNSTARTED", "acceptedCellIds": [], "gapIds": [], "coverage": "UNKNOWN",
               "wallMs": 0, "bases": 0, "independentOriginalReconstruction": True}
    meter = None
    try:
        require(proposal.get("schema") == "finnor.decision-atlas.proposal.v1" and
                proposal.get("inputDigest") == receipt["inputDigest"] and proposal.get("checkerDigest") == checker_digest, "ORIGINAL_INPUT_CHECKER_BINDING")
        require(set(proposal) == {"schema", "inputDigest", "checkerDigest", "root", "nodes", "coverage", "boundaryRule", "budget", "costs"} and
                proposal["boundaryRule"] == "NEGATIVE_ZERO_POSITIVE_EXACT", "EXACT_COVERAGE_CONVENTION")
        meter = Meter(proposal["budget"])
        n, domain, models = reconstruct(source)
        require(geometry(domain, n, meter) is not None, "DOMAIN_EMPTY")
        nodes = {node["id"]: node for node in proposal["nodes"]}
        require(len(nodes) == len(proposal["nodes"]) and len(nodes) <= proposal["budget"]["maxNodes"], "TREE_NODE_IDENTITY_BOUND")
        seen, pending = set(), [(proposal["root"], domain, 0)]
        accepted, gaps = [], []
        while pending:
            meter.tick()
            id, rows, depth = pending.pop()
            require(id in nodes and id not in seen and depth <= proposal["budget"]["maxDepth"], "COVERAGE_CHILD_MISSING_OR_OVERLAP")
            seen.add(id)
            node = nodes[id]
            kind = node.get("kind")
            if kind == "SPLIT":
                require(set(node) == {"id", "kind", "reason", "expression", "negative", "zero", "positive"}, "SPLIT_SHAPE")
                e = original_split(node["reason"], models)
                require(expr(node["expression"], n) == e, "ORIGINAL_SPLIT_COEFFICIENTS")
                branches = [(node["negative"], (e, "LT")), (node["zero"], (e, "EQ")),
                            (node["positive"], (scaled(e, Fraction(-1)), "LT"))]
                require(len({id for id, _ in branches}) == 3, "COVERAGE_CHILD_OWNERSHIP")
                pending.extend((child, rows + [f], depth + 1) for child, f in branches)
            elif kind == "GAP":
                require(set(node) == {"id", "kind", "reason"} and isinstance(node["reason"], str) and node["reason"], "EXPLICIT_GAP")
                gaps.append(id)
            else:
                g = geometry(rows, n, meter)
                if kind == "EMPTY":
                    require(set(node) == {"id", "kind"} and g is None, "EMPTY_CELL_LIE")
                else:
                    require(kind == "CELL" and set(node) == {"id", "kind", "geometry", "label"} and g is not None, "CELL_NONEMPTY")
                    issued = node["geometry"]
                    require(set(issued) == {"basis", "vertices", "witness", "slack", "affineDimension"} and
                            issued["basis"] == "COMPLETE_BOUNDED_ACTIVE_BASIS_VERTICES_AND_COMMON_SLACK", "GEOMETRY_PROOF_BASIS")
                    require(sorted([tuple(exact(v) for v in p) for p in issued["vertices"]]) == sorted(g["vertices"]), "COMPLETE_HV_VERTEX_BASIS")
                    require(tuple(exact(v) for v in issued["witness"]) == g["witness"] and exact(issued["slack"]) == g["slack"] and
                            issued["affineDimension"] == g["affineDimension"], "COMMON_SLACK_AFFINE_HULL")
                    accepted_label(source, models, rows, g, meter, node["label"])
                    accepted.append(id)
        require(seen == set(nodes), "UNREACHABLE_OR_OVERLAPPING_CELL")
        coverage = "PARTIAL" if gaps else "COMPLETE"
        require(proposal["coverage"] == coverage, "COVERAGE_GAP_LIE")
        receipt.update(status="ACCEPTED", predicate="ORIGINAL_ENTIRE_CELL_AND_SPLIT_TREE_ACCEPTED",
                       acceptedCellIds=accepted, gapIds=gaps, coverage=coverage)
    except Limit as error:
        receipt.update(status="UNKNOWN", predicate=str(error), acceptedCellIds=[], gapIds=[], coverage="UNKNOWN")
    except (Rejected, KeyError, TypeError, ValueError, IndexError, ZeroDivisionError) as error:
        receipt.update(status="REJECTED", predicate=str(error) if isinstance(error, Rejected) else "MALFORMED_ORIGINAL_OR_CERTIFICATE",
                       acceptedCellIds=[], gapIds=[], coverage="UNKNOWN")
    receipt["wallMs"], receipt["bases"] = (time.monotonic() - start) * 1000, meter.bases if meter else 0
    return receipt


def main():
    raw = sys.stdin.buffer.read(33554433)
    require(len(raw) <= 33554432, "CHECK_INPUT_BYTE_LIMIT")
    frame = json.loads(raw)
    checker_digest = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
    started = time.monotonic()
    if "points" in frame:
        require(isinstance(frame["points"], list) and 1 <= len(frame["points"]) <= 128 and
                isinstance(frame["results"], list) and len(frame["points"]) == len(frame["results"]), "POINT_BATCH_BOUND")
        checks = [check_point(frame["source"], p["values"], r, p.get("feasiblePolicyIds"))
                  for p, r in zip(frame["points"], frame["results"])]
        result = {"status": "ACCEPTED" if all(c["status"] == "ACCEPTED" for c in checks) else "REJECTED",
                  "predicate": "ORIGINAL_FULL_FAMILY_POINT_BATCH", "checks": checks, "admitted": False}
    else:
        result = check_point(frame["source"], frame["point"], frame["result"], frame.get("feasiblePolicyIds")) if "point" in frame else check(frame["source"], frame["proposal"], checker_digest)
    usage = resource.getrusage(resource.RUSAGE_SELF)
    sys.stdout.write(json.dumps({"ok": True, "data": result, "usage": {"cpuMicros": int((usage.ru_utime + usage.ru_stime) * 1000000),
                     "peakRSSBytes": usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024),
                     "wallMs": (time.monotonic() - started) * 1000}}, separators=(",", ":")))


def check_point(source, point, result, eligible):
    # Ordinary development fallback. Exact whole-family point check, not cells.
    meter = Meter({"maxNodes":1024,"maxDepth":256,"maxFacets":256,"maxBases":200000,
                   "maxTotalBases":2000000,"maxBytes":33554432,"deadlineMs":30000})
    try:
        n, _, models = reconstruct(source)
        require(len(point) == n, "POINT_DIMENSION")
        point = tuple(exact(q, 256) for q in point)
        require(eligible is None or len(set(eligible)) == len(eligible) and set(eligible) <= set(models), "CURRENT_S5_ELIGIBLE_FAMILY")
        values = {}
        for id, model in models.items():
            meter.tick()
            if (eligible is None or id in eligible) and all(valid((c["e"], c["relation"]), point) for c in model["constraints"]):
                values[id] = min(at(e, point) for e in model["payoffs"].values())
        maximum = max(values.values()) if values else None
        ties = [id for id in source["tieOrder"] if id in values and values[id] == maximum]
        label = result["label"]
        require(label["winnerPolicyId"] == (ties[0] if ties else None) and label["tiedPolicyIds"] == ties and
                result["value"] == (encoded(maximum) if maximum is not None else None), "ORIGINAL_FULL_FAMILY_POINT_OPTIMUM")
        for id in values:
            issued = next(p for p in label["policies"] if p["policyId"] == id)
            require(issued["feasible"] is True and issued["worstWorldIds"] ==
                    [w for w, e in models[id]["payoffs"].items() if at(e, point) == values[id]], "POINT_WORST_WORLD_IDENTITY")
        return {"status":"ACCEPTED","predicate":"ORIGINAL_FULL_FAMILY_POINT_OPTIMUM","fullFamilyEvaluations":len(models),"admitted":False}
    except (Rejected, KeyError, TypeError, ValueError, IndexError, ZeroDivisionError) as error:
        return {"status":"REJECTED","predicate":str(error) if isinstance(error, Rejected) else "MALFORMED_POINT","admitted":False}


def parent_watchdog():
    parent = os.environ.get("FINNOR_R7_PARENT_PID")
    if parent is None:
        return
    deadline = os.environ.get("FINNOR_R7_CHILD_DEADLINE_AT")
    try:
        parent = int(parent)
        deadline = int(deadline)
    except (TypeError, ValueError):
        os._exit(73)
    while True:
        time.sleep(0.2)
        try:
            if os.getppid() != parent or time.time() * 1000 >= deadline:
                os._exit(73)
            os.kill(parent, 0)
        except (OSError, ValueError):
            os._exit(73)


if __name__ == "__main__":
    threading.Thread(target=parent_watchdog, daemon=True).start()
    main()
