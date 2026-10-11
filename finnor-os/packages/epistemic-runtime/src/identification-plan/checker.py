"""Independent R4 proof/menu checker, Python standard library only.

It imports no y0, producer, graph predicates, search, or trace constructors.
Checking supplied business premises does not establish their field truth.
"""
import collections
import hashlib
import itertools
import json
import pathlib
import re
import resource
import sys
import time
from fractions import Fraction

if sys.platform == "linux":
    resource.setrlimit(resource.RLIMIT_AS, (1024**3, 1024**3))
resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
START = time.monotonic()


class Rejected(Exception):
    def __init__(self, boundary, reason):
        super().__init__(reason)
        self.boundary = boundary


def require(predicate, boundary, reason):
    if not predicate:
        raise Rejected(boundary, reason)
    if time.monotonic() - START > 19:
        raise Rejected("budget", "CHECKING_UNFINISHED_ORIGINAL_DEADLINE")


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(value):
    return hashlib.sha256(canonical_json(value).encode()).hexdigest()


def q(value):
    require(isinstance(value, dict) and set(value) == {"numerator", "denominator"}, "input", "RATIONAL_SHAPE")
    n, d = value["numerator"], value["denominator"]
    require(isinstance(n, str) and isinstance(d, str) and
            re.fullmatch(r"0|[1-9][0-9]{0,255}", n) and re.fullmatch(r"[1-9][0-9]{0,255}", d),
            "input", "RATIONAL_DOMAIN")
    r = Fraction(int(n), int(d))
    require((str(r.numerator), str(r.denominator)) == (n, d), "input", "RATIONAL_NOT_NORMALIZED")
    return r


def out(r):
    return {"numerator": str(r.numerator), "denominator": str(r.denominator)}


def no_duplicates(values, message):
    require(len(values) == len(set(values)), "input", message)


def induced(g, nodes):
    ns = set(nodes)
    return {"nodes": sorted(ns), "directed": sorted(e for e in g["directed"] if set(e) <= ns),
            "bidirected": sorted(e for e in g["bidirected"] if set(e) <= ns)}


def clean_graph(g):
    return {"nodes": sorted(g["nodes"]), "directed": sorted(g["directed"]),
            "bidirected": sorted(sorted(e) for e in g["bidirected"])}


def ancestors(g, targets):
    reached, frontier = set(targets), list(targets)
    parents = collections.defaultdict(set)
    for a, b in g["directed"]:
        parents[b].add(a)
    while frontier:
        for p in parents[frontier.pop()]:
            if p not in reached:
                reached.add(p); frontier.append(p)
    return reached


def components(g):
    remaining = set(g["nodes"])
    adjacent = collections.defaultdict(set)
    for a, b in g["bidirected"]:
        adjacent[a].add(b); adjacent[b].add(a)
    result = []
    while remaining:
        current = {min(remaining)}
        work = list(current)
        while work:
            for n in adjacent[work.pop()]:
                if n not in current:
                    current.add(n); work.append(n)
        remaining -= current
        result.append(sorted(current))
    return sorted(result)


def mutilated(g, actions, exchanged):
    return {"nodes": sorted(g["nodes"]),
            "directed": sorted(e for e in g["directed"] if e[1] not in actions and e[0] != exchanged),
            "bidirected": sorted(e for e in g["bidirected"] if not set(e) & set(actions))}


def separated(g, left, right, conditioned):
    # Expand each bidirected edge into its own latent common parent. On that
    # DAG, ancestral moralization and undirected reachability decide d-separation.
    expanded = {"nodes": list(g["nodes"]), "directed": [list(e) for e in g["directed"]]}
    for i, (a, b) in enumerate(g["bidirected"]):
        latent = "@latent" + str(i)
        expanded["nodes"].append(latent)
        expanded["directed"].extend([[latent, a], [latent, b]])
    relevant = ancestors(expanded, set(left) | {right} | set(conditioned))
    neighbors, parents = collections.defaultdict(set), collections.defaultdict(set)
    for a, b in expanded["directed"]:
        if a in relevant and b in relevant:
            neighbors[a].add(b); neighbors[b].add(a); parents[b].add(a)
    for ps in parents.values():
        for a, b in itertools.combinations(ps, 2):
            neighbors[a].add(b); neighbors[b].add(a)
    reached, work = set(left), list(left)
    while work:
        for n in neighbors[work.pop()] - set(conditioned):
            if n not in reached:
                reached.add(n); work.append(n)
    return right not in reached


def validate_input(p):
    require(isinstance(p, dict) and p.get("schema") == "finnor.identification-problem.v1", "input", "SCHEMA")
    require(p.get("profile") == "R4_OBSERVATIONAL_ADMG_ID_IDC_V1", "input", "PROFILE")
    require(1 <= len(p["graphs"]) <= 8 and len(p["bundles"]) <= 8 and len(p["costItems"]) <= 64, "input", "FINITE_BOUNDS")
    no_duplicates([v["id"] for v in p["variables"]], "VARIABLE_DUPLICATE")
    declared = {v["id"]: v["unit"] for v in p["variables"]}
    require(0 < len(declared) <= 64 and declared == p["query"]["scope"]["units"], "input", "VARIABLE_UNIT_MAPPING")
    require(p["query"]["scope"]["time"]["start"] < p["query"]["scope"]["time"]["end"], "input", "TIME_ORDER")
    sets = [set(p["query"][key]) for key in ["outcomes", "treatments", "conditions"]]
    require(bool(sets[0]) and not any(sets[a] & sets[b] for a in range(3) for b in range(a)), "input", "QUERY_APPLICABILITY")
    for k in ["outcomes", "treatments", "conditions"]:
        no_duplicates(p["query"][k], "QUERY_DUPLICATE")
    no_duplicates([g["id"] for g in p["graphs"]], "GRAPH_DUPLICATE")
    for g in p["graphs"]:
        ns = set(g["nodes"])
        no_duplicates(g["nodes"], "NODE_DUPLICATE")
        require(0 < len(ns) <= 12 and ns <= declared.keys() and set.union(*sets) <= ns, "input", "NODE_OR_QUERY_IDENTITY")
        require(len(g["directed"]) + len(g["bidirected"]) <= 132, "input", "EDGE_BOUND")
        for kind in ["directed", "bidirected"]:
            pairs = [tuple(e) if kind == "directed" else tuple(sorted(e)) for e in g[kind]]
            no_duplicates(pairs, "EDGE_DUPLICATE")
            require(all(len(e) == 2 and e[0] != e[1] and set(e) <= ns for e in pairs), "input", "ILLEGITIMATE_MIXED_EDGE")
        require(all(b not in ancestors(g, {a}) for a,b in g["directed"]), "input", "DIRECTED_CYCLE")
        require(set(g["observedNodes"]) <= ns, "input", "OBSERVED_NODE_DOMAIN")
    no_duplicates([c["id"] for c in p["costItems"]], "COST_ITEM_DUPLICATE")
    no_duplicates([b["id"] for b in p["bundles"]], "BUNDLE_DUPLICATE")
    no_duplicates([r["id"] for r in p["constraints"]["resources"]], "RESOURCE_DUPLICATE")
    resources = {r["id"] for r in p["constraints"]["resources"]}
    require(len(resources) <= 64 and len(p["constraints"]["resourceOrder"]) == len(resources) and
            set(p["constraints"]["resourceOrder"]) == resources, "input", "RESOURCE_TIE_ORDER")
    costs = {c["id"] for c in p["costItems"]}
    bundles = {b["id"]: b for b in p["bundles"]}
    for c in p["costItems"]:
        if c["amount"] is not None: q(c["amount"])
        q(c["basis"]["ownerShare"])
    q(p["constraints"]["costBasis"]["ownerShare"])
    require(p["constraints"].get("scheduleUnit") == "second", "input", "REGISTERED_SCHEDULE_UNIT_REQUIRED")
    q(p["constraints"]["collectBy"])
    if p["constraints"]["exposureLimit"] is not None: q(p["constraints"]["exposureLimit"])
    for r in p["constraints"]["resources"]:
        if r["capacity"] is not None: q(r["capacity"])
    laws = p["baseline"] + [l for b in p["bundles"] for l in b["laws"]]
    require(len(laws) <= 32, "input", "LAW_BOUND")
    no_duplicates([l["id"] for l in laws], "LAW_DUPLICATE")
    for law in laws:
        no_duplicates(law["variables"], "LAW_COORDINATE_DUPLICATE")
        require(set(law["variables"]) <= declared.keys() and bool(law["sourceRefs"]), "input", "LAW_COORDINATES_SOURCE")
        require(set(law["premises"]) == {"positivity", "denominator", "selection", "missingness", "measurement", "linkage"}, "input", "PREMISE_COMPLETENESS")
        for premise in law["premises"].values():
            require(premise["status"] in {"SATISFIED", "UNKNOWN", "CONTRADICTED", "UNSUPPORTED"} and
                    bool(premise["reason"]) and bool(premise["basis"]), "input", "EXPLICIT_PREMISE")
    require(all(l["availability"] == "OBSERVED" for l in p["baseline"]), "input", "BASELINE_NOT_OBSERVED")
    for b in p["bundles"]:
        no_duplicates(b["costItemIds"], "BUNDLE_COST_DUPLICATE")
        no_duplicates([r["id"] for r in b["resources"]], "BUNDLE_RESOURCE_DUPLICATE")
        require(set(b["costItemIds"]) <= costs and {r["id"] for r in b["resources"]} <= resources, "input", "UNREGISTERED_RESOURCE_COST")
        require(set(b["schedule"]["after"]) <= bundles.keys(), "input", "UNREGISTERED_SCHEDULE_DEPENDENCY")
        q(b["schedule"]["duration"]); q(b["schedule"]["earliestStart"]); q(b["exposure"])
        for r in b["resources"]: q(r["quantity"])
        require(all(l["availability"] == "PROSPECTIVE" for l in b["laws"]), "input", "FUTURE_ACQUISITION_ALREADY_OBSERVED")
    def visit(id, seen):
        require(id not in seen, "input", "SCHEDULE_CYCLE")
        for other in bundles[id]["schedule"]["after"]: visit(other, seen | {id})
    for id in bundles: visit(id, set())


def one():
    return {"op": "one"}


def prod(terms):
    terms = sorted([t for t in terms if t != one()], key=canonical_json)
    return one() if not terms else terms[0] if len(terms) == 1 else {"op": "product", "terms": terms}


def summation(variables, expression):
    return expression if not variables else {"op": "sum", "variables": sorted(variables), "expression": expression}


def ratio(numerator, denominator):
    return {"op": "ratio", "numerator": numerator, "denominator": denominator}


def used_variables(t):
    if t["op"] == "one": return set()
    if t["op"] == "probability": return set(t["variables"] + t["given"])
    if t["op"] == "product": return set().union(*(used_variables(v) for v in t["terms"]))
    if t["op"] == "ratio": return used_variables(t["numerator"]) | used_variables(t["denominator"])
    return used_variables(t["expression"]) - set(t["variables"])


def law_coordinates(t):
    if t["op"] == "probability": return set(t["variables"] + t["given"])
    if t["op"] == "one": return set()
    if t["op"] == "product": return set().union(*(law_coordinates(v) for v in t["terms"]))
    if t["op"] == "ratio": return law_coordinates(t["numerator"]) | law_coordinates(t["denominator"])
    return law_coordinates(t["expression"])


def validate_term(t, allowed, count=None, depth=0):
    count = count if count is not None else [0]
    count[0] += 1
    require(depth <= 96 and count[0] <= 65536 and isinstance(t, dict), "expression", "AST_BOUND")
    op = t.get("op")
    if op == "one":
        require(set(t) == {"op"}, "expression", "ONE_SHAPE")
    elif op == "probability":
        require(set(t) == {"op", "law", "variables", "given"} and bool(t["variables"]) and
                len(t["variables"]) == len(set(t["variables"])) and len(t["given"]) == len(set(t["given"])) and
                not set(t["variables"]) & set(t["given"]) and set(t["variables"] + t["given"]) <= allowed and
                isinstance(t["law"], str), "expression", "PROBABILITY_BINDING")
    elif op == "sum":
        require(set(t) == {"op", "variables", "expression"} and bool(t["variables"]) and
                len(t["variables"]) == len(set(t["variables"])) and set(t["variables"]) <= allowed,
                "expression", "BOUND_VARIABLE_IDENTITY")
        validate_term(t["expression"], allowed, count, depth + 1)
    elif op == "product":
        require(set(t) == {"op", "terms"} and 1 <= len(t["terms"]) <= 132, "expression", "PRODUCT_SHAPE")
        for term in t["terms"]: validate_term(term, allowed, count, depth + 1)
    elif op == "ratio":
        require(set(t) == {"op", "numerator", "denominator"}, "expression", "DENOMINATOR_SHAPE")
        validate_term(t["numerator"], allowed, count, depth + 1)
        validate_term(t["denominator"], allowed, count, depth + 1)
    else:
        require(False, "expression", "UNSUPPORTED_EXPRESSION_RULE")


def normalize(t):
    """Sound kernel rewrites via signed factor multisets, not syntax hashes.

    Cancellation is conditional on the explicitly checked positivity premises.
    Summation only uses linear factoring and normalized-law marginalization.
    No numerical agreement is used to accept equivalence.
    """
    op = t["op"]
    if op == "one": return one()
    if op == "probability":
        joint = {"op": "probability", "law": t["law"], "variables": sorted(t["variables"] + t["given"]), "given": []}
        return joint if not t["given"] else ratio(joint, {"op": "probability", "law": t["law"], "variables": sorted(t["given"]), "given": []})
    if op in {"product", "ratio"}:
        factors, examples = collections.Counter(), {}
        def collect(term, sign):
            term = normalize(term)
            if term["op"] == "one": return
            if term["op"] == "product":
                for child in term["terms"]: collect(child, sign)
            elif term["op"] == "ratio":
                collect(term["numerator"], sign); collect(term["denominator"], -sign)
            else:
                key = canonical_json(term); examples[key] = term; factors[key] += sign
        if op == "product":
            for child in t["terms"]: collect(child, 1)
        else:
            collect(t["numerator"], 1); collect(t["denominator"], -1)
        n = prod([examples[k] for k in sorted(factors) for i in range(max(0, factors[k]))])
        d = prod([examples[k] for k in sorted(factors) for i in range(max(0, -factors[k]))])
        return n if d == one() else ratio(n, d)
    ranges, body = set(t["variables"]), normalize(t["expression"])
    if body["op"] == "sum" and not ranges & set(body["variables"]):
        return normalize(summation(ranges | set(body["variables"]), body["expression"]))
    if body["op"] == "probability" and ranges <= set(body["variables"]):
        keep = set(body["variables"]) - ranges
        return one() if not keep else {**body, "variables": sorted(keep)}
    numerator = body["numerator"] if body["op"] == "ratio" else body
    denominator = body["denominator"] if body["op"] == "ratio" else one()
    terms = numerator["terms"] if numerator["op"] == "product" else [numerator]
    dependent = [v for v in terms if used_variables(v) & ranges]
    fixed = [v for v in terms if not used_variables(v) & ranges]
    if not used_variables(denominator) & ranges and dependent:
        inner = prod(dependent)
        if inner["op"] == "probability" and ranges <= set(inner["variables"]):
            reduced = normalize(summation(ranges, inner))
            return normalize(ratio(prod(fixed + [reduced]), denominator))
        if fixed or denominator != one():
            return normalize(ratio(prod(fixed + [summation(ranges, inner)]), denominator))
    return summation(ranges, body)


def lexical(t, bindings=(), depth=0):
    """Lexical alpha binding preserves free treatment versus summed dummy X."""
    def name(v):
        for i, mapping in enumerate(reversed(bindings)):
            if v in mapping: return ["bound", i, mapping[v]]
        return ["free", v]
    op = t["op"]
    if op == "one": return ["one"]
    if op == "probability":
        # A dummy value binding is not permission to rename measured source
        # coordinates. Keep column identity even when its value is locally bound.
        return ["probability", t["law"], sorted([[v, name(v)] for v in t["variables"]]),
                sorted([[v, name(v)] for v in t["given"]])]
    if op == "product": return ["product", sorted([lexical(v, bindings, depth) for v in t["terms"]], key=canonical_json)]
    if op == "ratio": return ["ratio", lexical(t["numerator"], bindings, depth), lexical(t["denominator"], bindings, depth)]
    variables = sorted(t["variables"])
    # The supported grammar has named measured coordinates, not arbitrary
    # relabeling of source columns. Permutations inside a simultaneous sum are AC.
    return ["sum", len(variables), lexical(t["expression"], bindings + ({v:i for i,v in enumerate(variables)},), depth + 1)]


def equal(left, right, boundary, reason):
    require(lexical(normalize(left)) == lexical(normalize(right)), boundary, reason)


def verify_hedge(w, g, x, y):
    big, small, roots = w["larger"], w["smaller"], set(w["roots"])
    require(set(small["nodes"]) < set(big["nodes"]) <= set(g["nodes"]) and
            bool(set(big["nodes"]) & x) and not set(small["nodes"]) & x, "hedge", "NESTED_TREATMENT_FORESTS")
    for forest in [big, small]:
        nodes = set(forest["nodes"])
        require(bool(nodes) and len(components(forest)) == 1, "hedge", "BIDIRECTED_CONNECTED_FOREST")
        require(all(e in g["directed"] for e in forest["directed"]) and
                all(sorted(e) in g["bidirected"] for e in forest["bidirected"]), "hedge", "FOREST_EDGE_NOT_IN_GRAPH")
        degree = collections.Counter(a for a,b in forest["directed"])
        require(all(d <= 1 for d in degree.values()) and all(set(e) <= nodes for e in forest["directed"] + forest["bidirected"]),
                "hedge", "C_FOREST_OUTDEGREE_OR_NODE")
        actual_roots = {n for n in nodes if degree[n] == 0}
        require(actual_roots == roots and bool(roots), "hedge", "ROOT_IDENTITY")
    require(all(e in big["directed"] for e in small["directed"]) and all(e in big["bidirected"] for e in small["bidirected"]),
            "hedge", "SMALL_FOREST_NOT_CONTAINED")
    require(roots <= ancestors(induced(g, set(g["nodes"]) - x), y), "hedge", "ROOTS_NOT_ANCESTRAL_TO_OUTCOME")


def verify_trace(node, g, x, y, z, kernel, algorithm, allowed, visits):
    visits[0] += 1
    require(visits[0] <= 4096, "trace", "TRACE_BOUND")
    require(node["graph"] == g and node["query"] == {"x": sorted(x), "y": sorted(y), "z": sorted(z)} and
            node["algorithm"] == algorithm, "trace", "GRAPH_QUERY_TRANSFORM_BINDING")
    validate_term(node["kernel"], allowed)
    equal(node["kernel"], kernel, "kernel", "RECURSIVE_KERNEL_MISMATCH")
    v, children, w = set(g["nodes"]), node["children"], node["witness"]
    rule = node["rule"]
    def child(index, cg, cx, cy, cz, ck, ca):
        require(len(children) > index, "trace", "MISSING_CHILD")
        return verify_trace(children[index], cg, cx, cy, cz, ck, ca, allowed, visits)
    if algorithm == "IDC":
        tests, applicable = [], None
        for c in sorted(z):
            modified = mutilated(g, x, c)
            sep = separated(modified, y, c, x | (z - {c}))
            tests.append({"condition": c, "graph": modified, "separated": sep})
            if sep:
                applicable = c; break
        require(w.get("tests") == tests, "separation", "IDC_MUTILATION_OR_SEPARATION")
        require(len(children) == 1, "trace", "IDC_CHILD_COUNT")
        if applicable is not None:
            require(rule == "IDC_EXCHANGE" and w.get("condition") == applicable, "separation", "INVALID_OBSERVATION_ACTION_EXCHANGE")
            result = child(0, g, x | {applicable}, y, z - {applicable}, kernel, "IDC")
        else:
            require(rule == "IDC_NORMALIZE" and w.get("marginalized") == sorted(y), "denominator", "IDC_NORMALIZATION_DOMAIN")
            joint = child(0, g, x, y | z, set(), kernel, "ID")
            result = None if joint is None else ratio(joint, summation(y, joint))
    else:
        a = ancestors(g, y)
        reduced = induced(g, v - x)
        districts, original_districts = components(reduced), components(g)
        extra = (v - x) - ancestors(reduced, y)
        if not x:
            require(rule == "ID1" and not children and w == {"marginalized": sorted(v - y)}, "marginalization", "ID1_SUM_DOMAIN")
            result = summation(v - y, kernel)
        elif a != v:
            require(rule == "ID2" and w == {"ancestors": sorted(a)} and len(children) == 1, "ancestor", "ID2_ANCESTRAL_SUBGRAPH")
            result = child(0, induced(g, a), x & a, y, set(), summation(v - a, kernel), "ID")
        elif extra:
            require(rule == "ID3" and w == {"addedActions": sorted(extra)} and len(children) == 1, "ancestor", "ID3_NO_EFFECT_ACTIONS")
            result = child(0, g, x | extra, y, set(), kernel, "ID")
        elif len(districts) > 1:
            require(rule == "ID4" and w == {"districts": districts, "marginalized": sorted(v - x - y)} and
                    len(children) == len(districts), "decomposition", "ID4_COMPLETE_DISTRICTS")
            terms = [child(i, g, v - set(s), set(s), set(), kernel, "ID") for i,s in enumerate(districts)]
            result = None if any(t is None for t in terms) else summation(v - x - y, prod(terms))
        elif len(original_districts) == 1:
            require(rule == "ID5" and not children, "hedge", "ID5_SINGLE_DISTRICT_PRECONDITION")
            verify_hedge(w, g, x, y)
            result = None
        else:
            s = set(districts[0])
            selected = s if sorted(s) in original_districts else set(next(d for d in original_districts if s < set(d)))
            order = w.get("order", [])
            require(len(order) == len(v) and set(order) == v and all(order.index(a) < order.index(b) for a,b in g["directed"]),
                    "kernel", "CHAIN_ORDER_NOT_TOPOLOGICAL")
            fs = prod([ratio(summation(set(order[i+1:]), kernel), summation(set(order[i:]), kernel))
                       for i,n in enumerate(order) if n in selected])
            equal(w["factors"], fs, "kernel", "FACTORS_NOT_FROM_CURRENT_KERNEL")
            require(w.get("district") == sorted(s), "district", "SINGLE_DISTRICT_IDENTITY")
            if selected == s:
                require(rule == "ID6" and not children and w.get("marginalized") == sorted(s - y), "district", "ID6_DISTRICT_OR_SUM")
                result = summation(s - y, fs)
            else:
                require(rule == "ID7" and w.get("larger") == sorted(selected) and len(children) == 1, "district", "ID7_LARGER_DISTRICT")
                result = child(0, induced(g, selected), x & selected, y, set(), fs, "ID")
    if result is None:
        require(node["expression"] is None, "expression", "FAILURE_WITH_EXPRESSION")
    else:
        require(node["expression"] is not None, "expression", "DERIVATION_WITHOUT_EXPRESSION")
        validate_term(node["expression"], allowed)
        equal(node["expression"], result, "expression", "RULE_RESULT_MISMATCH")
    return result


def check_mask(p, mask):
    bs = {b["id"]: b for i,b in enumerate(p["bundles"]) if mask & (1 << i)}
    reasons, unknown = [], []
    for b in bs.values():
        for key, state in b["admissibility"].items():
            if state != "PERMITTED":
                (reasons if state == "REJECTED" else unknown).append("BUNDLE_" + key.upper() + ("_UNKNOWN" if state != "REJECTED" else "") + ":" + b["id"])
    cost_ids = sorted(set(itertools.chain.from_iterable(b["costItemIds"] for b in bs.values())))
    by_cost = {c["id"]: c for c in p["costItems"]}
    amount = Fraction()
    for id in cost_ids:
        c = by_cost[id]
        if c["amount"] is None: unknown.append("COST_UNKNOWN:" + id)
        elif c["basis"] != p["constraints"]["costBasis"]: unknown.append("COST_BASIS_INCOMPARABLE:" + id)
        else: amount += q(c["amount"])
    intervals = {}
    def schedule(id):
        if id in intervals: return intervals[id]
        b = bs[id]
        if not set(b["schedule"]["after"]) <= bs.keys(): return None
        parents = [schedule(other) for other in b["schedule"]["after"]]
        if any(v is None for v in parents): return None
        start = max([q(b["schedule"]["earliestStart"])] + [v[1] for v in parents])
        intervals[id] = (start, start + q(b["schedule"]["duration"]))
        return intervals[id]
    if any(schedule(id) is None for id in bs): reasons.append("REQUIRED_SCHEDULE_BUNDLE_MISSING")
    completion = max((end for start,end in intervals.values()), default=Fraction())
    if completion > q(p["constraints"]["collectBy"]): reasons.append("COLLECTION_TIMING_EXCEEDED")
    use = {}
    for r in p["constraints"]["resources"]:
        events = collections.defaultdict(Fraction)
        for id,b in bs.items():
            if id not in intervals: continue
            for demand in b["resources"]:
                if demand["id"] != r["id"]: continue
                begin,end = intervals[id]
                events[begin] += q(demand["quantity"]); events[end] -= q(demand["quantity"])
        running, peak = Fraction(), Fraction()
        for at, delta in sorted(events.items()):
            running += delta; peak = max(peak, running)
        use[r["id"]] = out(peak)
        if r["capacity"] is None: unknown.append("RESOURCE_CAPACITY_UNKNOWN:" + r["id"])
        elif peak > q(r["capacity"]): reasons.append("JOINT_RESOURCE_EXCEEDED:" + r["id"])
    exposure = sum((q(b["exposure"]) for b in bs.values()), Fraction())
    if p["constraints"]["exposureLimit"] is None: unknown.append("EXPOSURE_LIMIT_UNKNOWN")
    elif exposure > q(p["constraints"]["exposureLimit"]): reasons.append("JOINT_EXPOSURE_EXCEEDED")
    return {"mask": mask, "bundleIds": sorted(bs), "status": "REJECTED" if reasons else "UNKNOWN" if unknown else "PERMITTED",
            "reasons": sorted(reasons + unknown), "costItemIds": cost_ids,
            "totalCost": None if any(r.startswith("COST_") for r in unknown) else out(amount),
            "completion": out(completion), "schedule": [{"bundleId": id, "start": out(s), "end": out(e)} for id,(s,e) in sorted(intervals.items())],
            "resourceUse": use}


def check_law(p, law, required):
    reasons, conditions = [], []
    if not required <= set(law["variables"]): reasons.append("MISSING_DISTRIBUTION_COORDINATES")
    if law["scope"] != p["query"]["scope"]: reasons.append("POPULATION_TIME_INTERVENTION_OR_UNIT_MISMATCH")
    if law["kind"] != "OBSERVATIONAL_JOINT": reasons.append("AVAILABLE_LAW_ALGORITHM_UNSUPPORTED")
    if law["rowLinkage"] not in {"SINGLE_COHORT_JOINT", "WITNESSED_MARGINAL"}: reasons.append("JOINT_LAW_ROW_LINKAGE_UNKNOWN")
    for key, premise in law["premises"].items():
        if key == "denominator" and not p["query"]["conditions"]: continue
        conditions.append({"lawId": law["id"], "premise": key, **premise, "prospective": law["availability"] == "PROSPECTIVE"})
        if premise["status"] != "SATISFIED": reasons.append(key.upper() + "_" + premise["status"])
    state = "CONDITIONAL" if law["availability"] == "PROSPECTIVE" else "AVAILABLE"
    if reasons:
        state = "CONTRADICTED" if any("CONTRADICTED" in r for r in reasons) else "UNKNOWN" if any("UNKNOWN" in r for r in reasons) else "UNSUPPORTED" if any("UNSUPPORTED" in r for r in reasons) else "MISSING_DATA"
    return state, sorted(reasons), conditions


def replace_law(value, name):
    if isinstance(value, list): return [replace_law(v, name) for v in value]
    if not isinstance(value, dict): return value
    return {k: name if k == "law" else replace_law(v, name) for k,v in value.items()}


def rank(p, m):
    return (q(m["totalCost"]), q(m["completion"]),
            tuple(q(m["resourceUse"][r]) for r in p["constraints"]["resourceOrder"]), tuple(m["bundleIds"]))


def verify(p, candidate):
    validate_input(p)
    require(candidate.get("schema") == "finnor.r4.candidate.v1" and candidate.get("inputDigest") == sha(p), "input-binding", "ORIGINAL_INPUT_DIGEST")
    require(candidate["identities"] == p["identities"] and p["identities"]["method"] == "y0-0.2.11-current-kernel-trace-v1" and
            p["identities"]["checker"] == "r4-independent-v1", "identity", "DOMAIN_METHOD_CHECKER_BINDING")
    method = candidate["method"]
    require(method["id"] == p["identities"]["method"] and method["y0"] == "0.2.11" and
            method["sourceCommit"] == "15cfeeacf2870107560d209863fc177a5fd25b0c" and method["python"].startswith("3.11.") and
            method["producerDigest"] == hashlib.sha256(pathlib.Path(__file__).with_name("producer.py").read_bytes()).hexdigest(),
            "identity", "PRODUCER_RUNTIME_IDENTITY")
    expected_hashes = {
        "algorithm/identify/api.py": "ad107d01a61c9ba1df2c71ca8e128851c6f3b1fee3f9377d5159c34d6b0e50c4",
        "algorithm/identify/id_std.py": "734e359cfa1e6ccb7113844a3efb97c5eb8d6baf6c316f65b9fc6c1711d3c681",
        "algorithm/identify/id_c.py": "e3de2d8723765d54a45255538744460f27fb260ab27370357242982f13338fc6",
        "dsl.py": "51d4026d9a855953d92ea85b10ca611b4fa2922698a145df9678eb59003b6e85",
        "graph.py": "99d3d6f339765ca545b942fa62e144a184df32328428a3a80f2fa57166bcbf31"}
    require(method["y0SourceHashes"] == expected_hashes, "identity", "Y0_SOURCE_PIN")
    graphs = {g["id"]: g for g in p["graphs"]}
    proofs, checked_expressions = {}, {}
    for proof in candidate["proofs"]:
        require(proof["graphId"] in graphs and proof["graphId"] not in proofs, "trace", "UNKNOWN_OR_DUPLICATE_GRAPH_PROOF")
        graph = graphs[proof["graphId"]]
        require(proof["graphDigest"] == sha(graph) and proof["queryDigest"] == sha(p["query"]) and
                proof["inputDigest"] == sha(p) and proof["method"] == method, "trace", "PROOF_INPUT_METHOD_BINDING")
        body = {k:v for k,v in proof.items() if k != "id"}
        require(proof["id"] == sha(body), "trace", "PROOF_DIGEST")
        query = p["query"]
        kernel = {"op": "probability", "law": "OBS", "variables": sorted(graph["nodes"]), "given": []}
        visits = [0]
        expression = verify_trace(proof["trace"], clean_graph(graph), set(query["treatments"]), set(query["outcomes"]),
                                  set(query["conditions"]), kernel, "IDC" if query["conditions"] else "ID",
                                  set(v["id"] for v in p["variables"]), visits)
        require(visits[0] == proof["traceNodes"], "trace", "TRACE_NODE_ACCOUNTING")
        require(proof["structural"] == ("NONIDENTIFIABLE" if expression is None else "IDENTIFIED"), "hedge", "STRUCTURAL_STATUS_WITHOUT_BASIS")
        if expression is None:
            require(proof["expression"] is None and proof["requiredCoordinates"] == [], "expression", "FAILURE_COORDINATES")
        else:
            validate_term(proof["expression"], set(v["id"] for v in p["variables"]))
            equal(proof["expression"], expression, "expression", "FINAL_EXPRESSION_MISMATCH")
            require(proof["requiredCoordinates"] == sorted(law_coordinates(proof["expression"])), "data", "REQUIRED_KERNEL_COORDINATES")
        proofs[graph["id"]] = proof
        checked_expressions[graph["id"]] = proof["expression"]
    require(set(proofs) == {g["id"] for g in p["graphs"] if g["projection"] == "NONE" and set(g["observedNodes"]) == set(g["nodes"])},
            "trace", "MISSING_SUPPORTED_GRAPH")
    plan = candidate["plan"]
    require(plan["targetQuery"] == p["query"], "query", "PLAN_QUERY_IDENTITY")
    expected_masks = [check_mask(p, i) for i in range(1 << len(p["bundles"]))]
    require(plan["masks"] == expected_masks, "minimality", "MASK_COST_SCHEDULE_RESOURCE_OR_TIE")
    pairs, seen = [], set()
    for pair in plan["pairs"]:
        key = (pair["mask"], pair["graphId"])
        require(key not in seen and pair["mask"] in range(len(expected_masks)) and pair["graphId"] in graphs, "minimality", "PAIR_MENU_COVERAGE")
        seen.add(key)
        mask, graph = expected_masks[pair["mask"]], graphs[pair["graphId"]]
        laws = p["baseline"] + [l for i,b in enumerate(p["bundles"]) if pair["mask"] & (1 << i) for l in b["laws"]]
        expected_key = sha({"query": p["query"], "graph": graph, "laws": laws, "admissibility": mask,
                            "identities": p["identities"], "inputDigest": sha(p)})
        require(pair["problemKey"] == expected_key, "data", "COMPLETE_PROBLEM_CACHE_KEY")
        proof = proofs.get(graph["id"])
        structural = proof["structural"] if proof else "UNSUPPORTED"
        state, reasons, conditions, law_id = "NOT_CHECKED", [], [], None
        if mask["status"] == "REJECTED":
            state, reasons = "ADMISSIBILITY_REJECTED", mask["reasons"]
        elif not proof:
            state, reasons = "UNSUPPORTED", ["UNOBSERVED_NODE_OR_PROJECTION_UNQUALIFIED"]
        elif structural == "NONIDENTIFIABLE":
            state, reasons = "NOT_APPLICABLE", ["INDEPENDENT_HEDGE_CHECK_REQUIRED"]
        else:
            # One compatible law, or its witnessed marginal. No overlapping-law
            # union is an admitted scientific operation.
            checks = [(law, *check_law(p, law, set(proof["requiredCoordinates"]))) for law in laws]
            good = [c for c in checks if c[1] in {"AVAILABLE", "CONDITIONAL"}]
            if good:
                law, state, reasons, conditions = min(good, key=lambda c: (c[1] != "AVAILABLE", c[0]["id"]))
                law_id = law["id"]
            else:
                if any(check[1] == "UNKNOWN" for check in checks):
                    state = "UNKNOWN"
                elif any(check[1] == "UNSUPPORTED" for check in checks):
                    state = "UNSUPPORTED"
                elif checks and all(check[1] == "CONTRADICTED" for check in checks):
                    state = "CONTRADICTED"
                else:
                    state = "MISSING_DATA"
                reasons = sorted(set(itertools.chain.from_iterable(c[2] for c in checks))) or ["OBSERVATIONAL_JOINT_LAW_UNAVAILABLE"]
                conditions = [c for check in checks for c in check[3]]
        require((pair["structural"], pair["data"], pair["lawId"], pair["reasons"], pair["conditions"], pair["proofId"]) ==
                (structural, state, law_id, reasons, conditions, proof["id"] if proof else None), "data-support", "DATA_SUPPORT_OR_LAW_BINDING")
        sufficient = mask["status"] == "PERMITTED" and structural == "IDENTIFIED" and state in {"AVAILABLE", "CONDITIONAL"}
        require(pair["sufficient"] is sufficient, "sufficiency", "FAMILY_SUFFICIENCY_PREMISES")
        expr = None if not proof or proof["expression"] is None else replace_law(proof["expression"], law_id or "MISSING_OBSERVATIONAL_JOINT")
        require(pair["expression"] == expr, "data-support", "SOURCE_KERNEL_IDENTITY")
        pairs.append(pair)
    require(len(seen) == len(expected_masks) * len(graphs), "minimality", "OMITTED_MASK_OR_GRAPH_COMPETITOR")
    sufficient_masks = [m for m in expected_masks if m["status"] == "PERMITTED" and all(
        pair["sufficient"] for pair in pairs if pair["mask"] == m["mask"])]
    selected = min(sufficient_masks, key=lambda m: rank(p, m)) if sufficient_masks else None
    expected_selected = None if selected is None else {k:selected[k] for k in ["mask", "bundleIds", "totalCost", "completion", "schedule", "resourceUse"]}
    require(plan["selected"] == expected_selected, "minimality", "CHEAPER_OR_TIE_PREFERRED_PLAN")
    unresolved = {m["mask"] for m in expected_masks if m["status"] == "UNKNOWN"}
    for pair in pairs:
        if pair["data"] in ("UNKNOWN", "UNSUPPORTED"):
            unresolved.add(pair["mask"])
    gaps = sorted(i for i in unresolved if not selected or expected_masks[i]["totalCost"] is None or rank(p, expected_masks[i]) < rank(p, selected))
    expected_minimality = {"status": "UNKNOWN" if gaps else "PROVED", "masks": len(expected_masks), "pairs": len(pairs),
                           "unresolvedMasks": gaps, "basis": "COMPLETE_DECLARED_FINITE_MENU_ONLY"}
    require(plan["minimality"] == expected_minimality, "minimality", "UNRESOLVED_CHEAPER_PLAN_OR_COVERAGE")
    alternatives = []
    for graph in p["graphs"]:
        options = [m for m in expected_masks if any(pair["mask"] == m["mask"] and pair["graphId"] == graph["id"] and pair["sufficient"] for pair in pairs)]
        best = min(options, key=lambda m: rank(p, m)) if options else None
        alternatives.append({"graphId": graph["id"], "selectedMask": None if best is None else best["mask"],
                             "minimality": "UNKNOWN" if unresolved else "PROVED"})
    require(plan["alternatives"] == alternatives, "minimality", "GRAPH_CONDITIONAL_ALTERNATIVES")
    selected_pairs = [pair for pair in pairs if selected and pair["mask"] == selected["mask"]]
    common = bool(selected_pairs) and all(lexical(normalize(pair["expression"])) ==
                                         lexical(normalize(selected_pairs[0]["expression"])) for pair in selected_pairs)
    # A producer may conservatively decline a supported proof of equivalence.
    # It may never claim a common effect merely from separate identification.
    if plan["commonFunctional"]["status"] == "PROVED":
        require(common, "equivalence", "COMMON_EFFECT_NOT_PROVED")
    else:
        common = False
    prospective = any(pair["data"] == "CONDITIONAL" for pair in selected_pairs)
    expected_state = "UNKNOWN" if gaps and not selected else "UNIDENTIFIED" if not selected else "CONDITIONAL" if prospective or not common else "INVARIANT"
    require(plan["identification"] == expected_state, "equivalence", "IDENTIFICATION_STATE_OR_PROSPECTIVE_PROMOTION")
    require(plan["basis"] == "MODEL_RELATIVE_EXACT" and plan["graphTruthEstablished"] is False and
            plan["effectEstimate"] is None and plan["attributionGranted"] is False and
            plan["executionAuthorityGranted"] is False and plan["admission"] is None, "authority", "FORMULA_CANNOT_GRANT_EFFECT_OR_CREDIT")
    return {"schema": "finnor.r4.check.v1", "status": "ACCEPTED", "checker": "r4-independent-v1",
            "checkerDigest": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
            "inputDigest": sha(p), "candidateDigest": sha(candidate), "planDigest": sha(plan),
            "acceptedProofIds": sorted(proof["id"] for proof in proofs.values()),
            "checks": {"derivation": "PASS", "hedge": "PASS", "dataSupport": "PASS", "finiteMenu": "PASS",
                       "equivalence": "PROVED" if common else "NOT_PROVED", "masks": len(expected_masks), "pairs": len(pairs)},
            "equivalenceRules": ["LEXICAL_ALPHA_BINDING", "AC_PRODUCT", "NONZERO_CANCELLATION",
                                 "PROBABILITY_CHAIN_RULE", "NORMALIZED_LAW_MARGINALIZATION", "SUM_LINEAR_FACTORING"],
            "qualification": "MODEL_RELATIVE_ONLY_SUPPLIED_BUSINESS_PREMISES_NOT_FIELD_TRUTH",
            "elapsedMs": (time.monotonic() - START) * 1000, "costUSD": None}


def main():
    raw = sys.stdin.buffer.read(64 * 1024**2 + 524289)
    require(len(raw) <= 64 * 1024**2 + 524288, "input", "CHECKER_INPUT_BYTE_BOUND")
    request = json.loads(raw)
    result = verify(request["problem"], request["candidate"])
    print(canonical_json(result))


if __name__ == "__main__":
    try:
        main()
    except Rejected as error:
        print(canonical_json({"schema": "finnor.r4.check.v1", "status": "REJECTED", "boundary": error.boundary,
                              "reason": str(error), "elapsedMs": (time.monotonic() - START) * 1000}))
    except Exception as error:
        print(canonical_json({"schema": "finnor.r4.check.v1", "status": "REJECTED", "boundary": "malformed",
                              "reason": type(error).__name__, "elapsedMs": (time.monotonic() - START) * 1000}))
