"""Bounded y0 0.2.11 ID/IDC trace adapter and complete finite-menu producer.

Untrusted ordinary machinery. Only the separate checker can accept a claim.
The release's recursive global-P shortcut is not used: factors retain the
current estimand. Raw supported ID/IDC output is retained for diagnosis.
"""
import hashlib
import importlib.metadata
import itertools
import json
import os
import pathlib
import resource
import sys
import time
from fractions import Fraction as Rational

os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"
if sys.platform == "linux":
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
resource.setrlimit(resource.RLIMIT_CPU, (20, 20))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

from y0.algorithm.identify import identify_outcomes
from y0.algorithm.identify.id_std import line_1, line_2, line_3, line_4
from y0.algorithm.identify.utils import Identification
from y0.algorithm.conditional_independencies import are_d_separated
from y0.dsl import Variable, P, Probability, Product, Sum, Fraction, One
from y0.graph import NxMixedGraph
import y0

METHOD = "y0-0.2.11-current-kernel-trace-v1"
CHECKER = "r4-independent-v1"
SOURCE_HASHES = {
    "algorithm/identify/api.py": "ad107d01a61c9ba1df2c71ca8e128851c6f3b1fee3f9377d5159c34d6b0e50c4",
    "algorithm/identify/id_std.py": "734e359cfa1e6ccb7113844a3efb97c5eb8d6baf6c316f65b9fc6c1711d3c681",
    "algorithm/identify/id_c.py": "e3de2d8723765d54a45255538744460f27fb260ab27370357242982f13338fc6",
    "dsl.py": "51d4026d9a855953d92ea85b10ca611b4fa2922698a145df9678eb59003b6e85",
    "graph.py": "99d3d6f339765ca545b942fa62e144a184df32328428a3a80f2fa57166bcbf31",
}
STARTED = time.monotonic()
DEADLINE = STARTED + 19
TRACE_NODES = 0


class Limit(Exception):
    pass


def stable(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(stable(value).encode()).hexdigest()


def bound():
    if time.monotonic() > DEADLINE:
        raise Limit("ORIGINAL_NATIVE_DEADLINE_EXHAUSTED")


def quantity(value):
    if not isinstance(value, dict) or set(value) != {"numerator", "denominator"}:
        raise ValueError("EXACT_QUANTITY_REQUIRED")
    n, d = value["numerator"], value["denominator"]
    if not isinstance(n, str) or not isinstance(d, str) or len(n) > 256 or len(d) > 256:
        raise ValueError("QUANTITY_DIGIT_BOUND")
    if not n.isascii() or not d.isascii() or not n.isdigit() or not d.isdigit() or int(d) <= 0:
        raise ValueError("NONNEGATIVE_RATIONAL_REQUIRED")
    f = Rational(int(n), int(d))
    if str(f.numerator) != n or str(f.denominator) != d:
        raise ValueError("NORMALIZED_RATIONAL_REQUIRED")
    return f


def encoded(value):
    return {"numerator": str(value.numerator), "denominator": str(value.denominator)}


def unique(values, reason):
    if len(set(values)) != len(values):
        raise ValueError(reason)


def validate(problem):
    if problem.get("schema") != "finnor.identification-problem.v1":
        raise ValueError("SCHEMA_REQUIRED")
    if problem.get("profile") != "R4_OBSERVATIONAL_ADMG_ID_IDC_V1":
        raise ValueError("UNSUPPORTED_PROFILE")
    graphs, bundles = problem["graphs"], problem["bundles"]
    if not 1 <= len(graphs) <= 8 or len(bundles) > 8:
        raise ValueError("FINITE_FAMILY_OR_MENU_BOUND")
    variables = {v["id"]: v["unit"] for v in problem["variables"]}
    unique([v["id"] for v in problem["variables"]], "DUPLICATE_VARIABLE")
    if len(variables) > 64:
        raise ValueError("VARIABLE_BOUND")
    q = problem["query"]
    if q["scope"]["units"] != variables:
        raise ValueError("VARIABLE_UNIT_MAPPING")
    if q["scope"]["time"]["start"] >= q["scope"]["time"]["end"]:
        raise ValueError("QUERY_TIME_ORDER")
    sets = [set(q[k]) for k in ["outcomes", "treatments", "conditions"]]
    if not sets[0] or any(sets[i] & sets[j] for i in range(3) for j in range(i)):
        raise ValueError("DISJOINT_QUERY_SETS_REQUIRED")
    for key in ["outcomes", "treatments", "conditions"]:
        unique(q[key], "DUPLICATE_QUERY_VARIABLE")
    unique([g["id"] for g in graphs], "DUPLICATE_GRAPH")
    for g in graphs:
        nodes = set(g["nodes"])
        unique(g["nodes"], "DUPLICATE_GRAPH_NODE")
        if not 1 <= len(nodes) <= 12 or not nodes <= variables.keys() or not set.union(*sets) <= nodes:
            raise ValueError("GRAPH_NODE_OR_QUERY_MAPPING")
        if len(g["directed"]) + len(g["bidirected"]) > 132:
            raise ValueError("EDGE_BOUND")
        for kind in ["directed", "bidirected"]:
            edges = [tuple(e) if kind == "directed" else tuple(sorted(e)) for e in g[kind]]
            unique(edges, "DUPLICATE_EDGE")
            if any(len(e) != 2 or e[0] == e[1] or not set(e) <= nodes for e in edges):
                raise ValueError("INVALID_" + kind.upper() + "_EDGE")
        pending = set(nodes)
        while pending:
            ready = {n for n in pending if not any(b == n and a in pending for a, b in g["directed"])}
            if not ready:
                raise ValueError("DIRECTED_CYCLE")
            pending -= ready
        if not set(g["observedNodes"]) <= nodes:
            raise ValueError("UNKNOWN_OBSERVED_NODE")
    unique([b["id"] for b in bundles], "DUPLICATE_BUNDLE")
    if len(problem["costItems"]) > 64 or len(problem["constraints"]["resources"]) > 64:
        raise ValueError("COST_OR_RESOURCE_BOUND")
    unique([c["id"] for c in problem["costItems"]], "DUPLICATE_COST_ITEM")
    unique([r["id"] for r in problem["constraints"]["resources"]], "DUPLICATE_RESOURCE")
    cost_ids = {c["id"] for c in problem["costItems"]}
    resource_ids = {r["id"] for r in problem["constraints"]["resources"]}
    unique(problem["constraints"]["resourceOrder"], "DUPLICATE_RESOURCE_ORDER")
    if set(problem["constraints"]["resourceOrder"]) != resource_ids:
        raise ValueError("COMPLETE_RESOURCE_TIE_ORDER_REQUIRED")
    for c in problem["costItems"]:
        if c["amount"] is not None:
            quantity(c["amount"])
        quantity(c["basis"]["ownerShare"])
    quantity(problem["constraints"]["costBasis"]["ownerShare"])
    for r in problem["constraints"]["resources"]:
        if r["capacity"] is not None:
            quantity(r["capacity"])
    if problem["constraints"]["exposureLimit"] is not None:
        quantity(problem["constraints"]["exposureLimit"])
    if problem["constraints"].get("scheduleUnit") != "second":
        raise ValueError("REGISTERED_SCHEDULE_UNIT_REQUIRED")
    quantity(problem["constraints"]["collectBy"])
    laws = problem["baseline"] + [law for b in bundles for law in b["laws"]]
    if len(laws) > 32:
        raise ValueError("LAW_BOUND")
    unique([law["id"] for law in laws], "DUPLICATE_LAW")
    for law in laws:
        unique(law["variables"], "DUPLICATE_LAW_VARIABLE")
        if not set(law["variables"]) <= variables.keys() or not law["sourceRefs"]:
            raise ValueError("LAW_COORDINATE_OR_SOURCE_REQUIRED")
        if any(p["status"] not in {"SATISFIED", "UNKNOWN", "CONTRADICTED", "UNSUPPORTED"}
               or not p["basis"] or not p["reason"] for p in law["premises"].values()):
            raise ValueError("EXPLICIT_PREMISE_REQUIRED")
    if any(l["availability"] != "OBSERVED" for l in problem["baseline"]):
        raise ValueError("BASELINE_IS_NOT_OBSERVED")
    ids = {b["id"] for b in bundles}
    for b in bundles:
        unique(b["costItemIds"], "DUPLICATE_BUNDLE_COST")
        unique([r["id"] for r in b["resources"]], "DUPLICATE_BUNDLE_RESOURCE")
        if not set(b["costItemIds"]) <= cost_ids or not {r["id"] for r in b["resources"]} <= resource_ids:
            raise ValueError("UNREGISTERED_COST_OR_RESOURCE")
        if not set(b["schedule"]["after"]) <= ids or b["id"] in b["schedule"]["after"]:
            raise ValueError("UNKNOWN_OR_SELF_SCHEDULE_DEPENDENCY")
        quantity(b["schedule"]["earliestStart"])
        quantity(b["schedule"]["duration"])
        quantity(b["exposure"])
        for r in b["resources"]:
            quantity(r["quantity"])
        if any(l["availability"] != "PROSPECTIVE" for l in b["laws"]):
            raise ValueError("ACQUISITION_IS_PROSPECTIVE_UNTIL_OWNER_READBACK")
    pending = set(ids)
    while pending:
        ready = {b["id"] for b in bundles if b["id"] in pending and not set(b["schedule"]["after"]) & pending}
        if not ready:
            raise ValueError("SCHEDULE_CYCLE")
        pending -= ready


def ast(expression):
    if isinstance(expression, One):
        return {"op": "one"}
    if isinstance(expression, Probability):
        return {"op": "probability", "law": "OBS",
                "variables": sorted(v.name for v in expression.children),
                "given": sorted(v.name for v in expression.parents)}
    if isinstance(expression, Sum):
        return {"op": "sum", "variables": sorted(v.name for v in expression.ranges), "expression": ast(expression.expression)}
    if isinstance(expression, Product):
        return {"op": "product", "terms": [ast(t) for t in expression.expressions]}
    if isinstance(expression, Fraction):
        return {"op": "ratio", "numerator": ast(expression.numerator), "denominator": ast(expression.denominator)}
    raise ValueError("UNSUPPORTED_Y0_EXPRESSION")


def graph_ast(graph):
    return {"nodes": sorted(v.name for v in graph.nodes()),
            "directed": sorted([a.name, b.name] for a, b in graph.directed.edges()),
            "bidirected": sorted(sorted([a.name, b.name]) for a, b in graph.undirected.edges())}


def names(values):
    return sorted(v.name for v in values)


def factors(identification, selected):
    # Marginal-ratio chain rule for the CURRENT kernel, including its fixed
    # arguments. This is the registered adapter difference from id_std 6/7.
    order = list(identification.graph.topological_sort())
    factors = []
    for i, v in enumerate(order):
        if v not in selected:
            continue
        numerator = Sum.safe(identification.estimand, order[i + 1:], simplify=True)
        denominator = Sum.safe(identification.estimand, order[i:], simplify=True)
        factors.append(Fraction(numerator, denominator))
    return Product.safe(factors), [v.name for v in order]


def hedge(graph, treatments, outcomes):
    """Explicit nested equally rooted C-forests, not an exception receipt."""
    smaller = set(graph.nodes()) - treatments
    roots = {v for v in smaller if not any(b in smaller for b in graph.directed.successors(v))}
    chosen = {}
    reachable = set(roots)
    pending = set(graph.nodes()) - reachable
    while pending:
        ready = []
        for v in sorted(pending, key=lambda v: v.name):
            targets = set(graph.directed.successors(v)) & reachable
            if v in smaller:
                targets &= smaller
            if targets:
                chosen[v] = min(targets, key=lambda v: v.name)
                ready.append(v)
        if not ready:
            raise ValueError("HEDGE_FOREST_CONSTRUCTION_UNSUPPORTED")
        pending -= set(ready)
        reachable |= set(ready)
    edges = [[v.name, target.name] for v, target in chosen.items()]
    big = graph_ast(graph)
    big["directed"] = sorted(edges)
    small = {"nodes": names(smaller),
             "directed": sorted(e for e in edges if set(e) <= set(names(smaller))),
             "bidirected": sorted(e for e in big["bidirected"] if set(e) <= set(names(smaller)))}
    return {"larger": big, "smaller": small, "roots": names(roots)}


def trace(identification, conditional=False, depth=0):
    global TRACE_NODES
    bound()
    TRACE_NODES += 1
    if depth > 96 or TRACE_NODES > 4096:
        raise Limit("TRACE_OR_RECURSION_BOUND")
    g, x, y, z = identification.graph, identification.treatments, identification.outcomes, identification.conditions
    v = set(g.nodes())
    node = {"algorithm": "IDC" if conditional else "ID", "query": {"y": names(y), "x": names(x), "z": names(z)},
            "graph": graph_ast(g), "kernel": ast(identification.estimand), "children": [], "witness": {}}
    if conditional:
        exchanges = []
        for c in sorted(z, key=lambda n: n.name):
            # Keep all isolated original vertices in a mutilated graph.
            modified = NxMixedGraph.from_edges(
                nodes=sorted(v, key=lambda n: n.name),
                directed=[(a, b) for a, b in g.directed.edges() if b not in x and a != c],
                undirected=[(a, b) for a, b in g.undirected.edges() if a not in x and b not in x])
            separated = all(are_d_separated(modified, outcome, c, conditions=x | (z - {c})) for outcome in y)
            exchanges.append({"condition": c.name, "graph": graph_ast(modified), "separated": separated})
            if separated:
                node["rule"] = "IDC_EXCHANGE"
                node["witness"] = {"tests": exchanges, "condition": c.name}
                child, expression = trace(identification.exchange_observation_with_action(c), True, depth + 1)
                node["children"] = [child]
                break
        else:
            node["rule"] = "IDC_NORMALIZE"
            node["witness"] = {"tests": exchanges, "marginalized": names(y)}
            child, joint = trace(identification.uncondition(), False, depth + 1)
            node["children"] = [child]
            expression = None if joint is None else Fraction(joint, Sum.safe(joint, y, simplify=True))
    elif not x:
        node["rule"] = "ID1"
        node["witness"] = {"marginalized": names(v - y)}
        expression = line_1(identification)
    else:
        a = g.ancestors_inclusive(y)
        without_x = g.remove_nodes_from(x)
        w = (v - x) - without_x.ancestors_inclusive(y)
        districts = sorted(without_x.districts(), key=lambda d: names(d))
        all_districts = g.districts()
        if a != v:
            node["rule"] = "ID2"
            node["witness"] = {"ancestors": names(a)}
            child, expression = trace(line_2(identification), False, depth + 1)
            node["children"] = [child]
        elif w:
            node["rule"] = "ID3"
            node["witness"] = {"addedActions": names(w)}
            child, expression = trace(line_3(identification), False, depth + 1)
            node["children"] = [child]
        elif len(districts) > 1:
            node["rule"] = "ID4"
            node["witness"] = {"districts": [names(d) for d in districts], "marginalized": names(v - x - y)}
            children = sorted(line_4(identification), key=lambda i: names(i.outcomes))
            results = [trace(child, False, depth + 1) for child in children]
            node["children"] = [n for n, e in results]
            expression = None if any(e is None for n, e in results) else Sum.safe(Product.safe(e for n, e in results), v - x - y)
        elif len(all_districts) == 1:
            node["rule"] = "ID5"
            node["witness"] = hedge(g, x, y)
            expression = None
        elif districts[0] in all_districts:
            s = districts[0]
            kernel, order = factors(identification, s)
            node["rule"] = "ID6"
            node["witness"] = {"district": names(s), "order": order, "marginalized": names(s - y), "factors": ast(kernel)}
            expression = Sum.safe(kernel, s - y)
        else:
            s = districts[0]
            larger = next(d for d in all_districts if s < d)
            kernel, order = factors(identification, larger)
            node["rule"] = "ID7"
            node["witness"] = {"district": names(s), "larger": names(larger), "order": order, "factors": ast(kernel)}
            child_input = Identification.from_parts(
                outcomes=y, treatments=x & larger, graph=g.subgraph(larger), estimand=kernel)
            child, expression = trace(child_input, False, depth + 1)
            node["children"] = [child]
    node["expression"] = None if expression is None else ast(expression)
    return node, expression


def normal(term):
    """Producer algebra proposal, independently redone by the checker."""
    op = term["op"]
    if op in {"one", "probability"}:
        return term
    if op == "product":
        terms = [normal(t) for t in term["terms"]]
        n, d = [], []
        for t in terms:
            if t["op"] == "one": continue
            if t["op"] == "product": n.extend(t["terms"])
            elif t["op"] == "ratio":
                n.extend(t["numerator"]["terms"] if t["numerator"]["op"] == "product" else [t["numerator"]])
                d.extend(t["denominator"]["terms"] if t["denominator"]["op"] == "product" else [t["denominator"]])
            else: n.append(t)
        for t in n[:]:
            if t in d:
                n.remove(t); d.remove(t)
        def product_of(xs):
            xs = sorted(xs, key=stable)
            return {"op": "one"} if not xs else xs[0] if len(xs) == 1 else {"op": "product", "terms": xs}
        return product_of(n) if not d else {"op": "ratio", "numerator": product_of(n), "denominator": product_of(d)}
    if op == "ratio":
        n, d = normal(term["numerator"]), normal(term["denominator"])
        if n == d: return {"op": "one"}
        if d["op"] == "one": return n
        if n["op"] == "probability" and d["op"] == "probability" and not n["given"] and not d["given"] and n["law"] == d["law"] and set(d["variables"]) < set(n["variables"]):
            return {"op": "probability", "law": n["law"], "variables": sorted(set(n["variables"]) - set(d["variables"])), "given": d["variables"]}
        return normal({"op": "product", "terms": [n, {"op": "ratio", "numerator": {"op": "one"}, "denominator": d}]}) if n["op"] == "product" or d["op"] == "product" else {"op": "ratio", "numerator": n, "denominator": d}
    s, t = set(term["variables"]), normal(term["expression"])
    if t["op"] == "sum":
        return normal({"op": "sum", "variables": sorted(s | set(t["variables"])), "expression": t["expression"]})
    if t["op"] == "probability" and not s & set(t["given"]) and s <= set(t["variables"]):
        keep = sorted(set(t["variables"]) - s)
        return {"op": "one"} if not keep else {**t, "variables": keep}
    return {"op": "sum", "variables": sorted(s), "expression": t}


def coordinates(term):
    if term["op"] == "probability":
        return set(term["variables"]) | set(term["given"])
    if term["op"] == "one":
        return set()
    if term["op"] == "product":
        return set().union(*(coordinates(t) for t in term["terms"]))
    if term["op"] == "ratio":
        return coordinates(term["numerator"]) | coordinates(term["denominator"])
    return coordinates(term["expression"])


def bind_law(term, law):
    if isinstance(term, list): return [bind_law(t, law) for t in term]
    if not isinstance(term, dict): return term
    return {k: law if k == "law" else bind_law(v, law) for k, v in term.items()}


def disposition(problem, mask):
    bs = [b for i, b in enumerate(problem["bundles"]) if mask & (1 << i)]
    reasons, unresolved = [], []
    for b in bs:
        for k, v in b["admissibility"].items():
            if v == "REJECTED": reasons.append("BUNDLE_" + k.upper() + ":" + b["id"])
            if v == "UNKNOWN": unresolved.append("BUNDLE_" + k.upper() + "_UNKNOWN:" + b["id"])
    selected = {b["id"] for b in bs}
    cost_ids = sorted({c for b in bs for c in b["costItemIds"]})
    items = {c["id"]: c for c in problem["costItems"]}
    total = Rational()
    for id in cost_ids:
        c = items[id]
        if c["amount"] is None: unresolved.append("COST_UNKNOWN:" + id)
        elif c["basis"] != problem["constraints"]["costBasis"]: unresolved.append("COST_BASIS_INCOMPARABLE:" + id)
        else: total += quantity(c["amount"])
    times, pending = {}, list(bs)
    while pending:
        bound()
        ready = [b for b in pending if not set(b["schedule"]["after"]) - times.keys()]
        if not ready:
            reasons.append("REQUIRED_SCHEDULE_BUNDLE_MISSING")
            break
        for b in ready:
            begin = max([quantity(b["schedule"]["earliestStart"])] + [times[id][1] for id in b["schedule"]["after"]])
            times[b["id"]] = (begin, begin + quantity(b["schedule"]["duration"]))
            pending.remove(b)
    completion = max((end for begin, end in times.values()), default=Rational())
    if completion > quantity(problem["constraints"]["collectBy"]):
        reasons.append("COLLECTION_TIMING_EXCEEDED")
    resource_use = {}
    for r in problem["constraints"]["resources"]:
        maximum = Rational()
        for point in sorted({t for pair in times.values() for t in pair}):
            current = sum((quantity(d["quantity"]) for b in bs if b["id"] in times and
                           times[b["id"]][0] <= point < times[b["id"]][1]
                           for d in b["resources"] if d["id"] == r["id"]), Rational())
            maximum = max(maximum, current)
        resource_use[r["id"]] = maximum
        if r["capacity"] is None: unresolved.append("RESOURCE_CAPACITY_UNKNOWN:" + r["id"])
        elif maximum > quantity(r["capacity"]): reasons.append("JOINT_RESOURCE_EXCEEDED:" + r["id"])
    exposure = sum((quantity(b["exposure"]) for b in bs), Rational())
    if problem["constraints"]["exposureLimit"] is None: unresolved.append("EXPOSURE_LIMIT_UNKNOWN")
    elif exposure > quantity(problem["constraints"]["exposureLimit"]): reasons.append("JOINT_EXPOSURE_EXCEEDED")
    return {"mask": mask, "bundleIds": sorted(selected),
            "status": "REJECTED" if reasons else "UNKNOWN" if unresolved else "PERMITTED",
            "reasons": sorted(reasons + unresolved), "costItemIds": cost_ids,
            "totalCost": None if any(s.startswith("COST_") for s in unresolved) else encoded(total),
            "completion": encoded(completion),
            "schedule": [{"bundleId": id, "start": encoded(begin), "end": encoded(end)} for id, (begin, end) in sorted(times.items())],
            "resourceUse": {id: encoded(q) for id, q in sorted(resource_use.items())}}


def data(problem, law, required):
    reasons, status = [], "MISSING_DATA"
    if not required <= set(law["variables"]):
        reasons.append("MISSING_DISTRIBUTION_COORDINATES")
    if law["scope"] != problem["query"]["scope"]:
        reasons.append("POPULATION_TIME_INTERVENTION_OR_UNIT_MISMATCH")
    if law["kind"] != "OBSERVATIONAL_JOINT":
        reasons.append("AVAILABLE_LAW_ALGORITHM_UNSUPPORTED")
    if law["rowLinkage"] not in {"SINGLE_COHORT_JOINT", "WITNESSED_MARGINAL"}:
        reasons.append("JOINT_LAW_ROW_LINKAGE_UNKNOWN")
    conditions = []
    for key, premise in law["premises"].items():
        if key == "denominator" and not problem["query"]["conditions"]:
            continue
        conditions.append({"lawId": law["id"], "premise": key, **premise, "prospective": law["availability"] == "PROSPECTIVE"})
        if premise["status"] != "SATISFIED":
            reasons.append(key.upper() + "_" + premise["status"])
    if not reasons:
        status = "CONDITIONAL" if law["availability"] == "PROSPECTIVE" else "AVAILABLE"
    elif any("CONTRADICTED" in r for r in reasons):
        status = "CONTRADICTED"
    elif any("UNKNOWN" in r for r in reasons):
        status = "UNKNOWN"
    elif any("UNSUPPORTED" in r for r in reasons):
        status = "UNSUPPORTED"
    return status, sorted(reasons), conditions


def rank(problem, item):
    return (quantity(item["totalCost"]), quantity(item["completion"]),
            tuple(quantity(item["resourceUse"][r]) for r in problem["constraints"]["resourceOrder"]), tuple(item["bundleIds"]))


def runtime():
    root = pathlib.Path(y0.__file__).parent
    actual = {p: hashlib.sha256((root / p).read_bytes()).hexdigest() for p in SOURCE_HASHES}
    if importlib.metadata.version("y0") != "0.2.11" or actual != SOURCE_HASHES:
        raise ValueError("PINNED_Y0_RUNTIME_MISMATCH")
    return {"id": METHOD, "python": sys.version.split()[0], "y0": "0.2.11", "sourceCommit": "15cfeeacf2870107560d209863fc177a5fd25b0c",
            "y0SourceHashes": actual, "producerDigest": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
            "adapter": "CURRENT_KERNEL_CHAIN_FACTORS_AND_ISOLATE_PRESERVING_IDC_V1"}


def compile_plan(problem):
    global TRACE_NODES
    validate(problem)
    method = runtime()
    proofs, templates, calls = [], {}, 0
    q = problem["query"]
    for graph in problem["graphs"]:
        bound()
        if graph["projection"] != "NONE" or set(graph["observedNodes"]) != set(graph["nodes"]):
            templates[graph["id"]] = {"structural": "UNSUPPORTED", "reason": "UNOBSERVED_NODE_OR_PROJECTION_UNQUALIFIED"}
            continue
        variables = {n: Variable(n) for n in graph["nodes"]}
        g = NxMixedGraph.from_edges(nodes=[variables[n] for n in sorted(variables)],
             directed=[(variables[a], variables[b]) for a,b in graph["directed"]],
             undirected=[(variables[a], variables[b]) for a,b in graph["bidirected"]])
        x, y, z = (set(variables[n] for n in q[k]) for k in ["treatments", "outcomes", "conditions"])
        raw = identify_outcomes(g, treatments=x, outcomes=y, conditions=z if z else None)
        calls += 1
        inp = Identification.from_parts(graph=g, treatments=x, outcomes=y, conditions=z, estimand=P(list(variables.values())))
        TRACE_NODES = 0
        derivation, expression = trace(inp, bool(z))
        simplified = None if expression is None else normal(ast(expression))
        body = {"graphId": graph["id"], "queryDigest": digest(q), "graphDigest": digest(graph),
                "inputDigest": digest(problem), "trace": derivation,
                "expression": simplified, "rawY0": None if raw is None else ast(raw),
                "requiredCoordinates": [] if simplified is None else sorted(coordinates(simplified)),
                "structural": "NONIDENTIFIABLE" if expression is None else "IDENTIFIED",
                "method": method, "traceNodes": TRACE_NODES}
        proof = {**body, "id": digest(body)}
        proofs.append(proof)
        templates[graph["id"]] = proof
    masks, pairs = [], []
    for mask in range(1 << len(problem["bundles"])):
        bound()
        item = disposition(problem, mask)
        masks.append(item)
        laws = problem["baseline"] + [law for i, b in enumerate(problem["bundles"]) if mask & (1 << i) for law in b["laws"]]
        for graph in problem["graphs"]:
            t = templates[graph["id"]]
            conditions, reasons, law_id = [], [], None
            structural, data_status = t["structural"], "NOT_CHECKED"
            expression = t.get("expression")
            if item["status"] == "REJECTED":
                reasons = item["reasons"]
                data_status = "ADMISSIBILITY_REJECTED"
            elif structural == "UNSUPPORTED":
                reasons = [t["reason"]]
                data_status = "UNSUPPORTED"
            elif structural == "NONIDENTIFIABLE":
                reasons = ["INDEPENDENT_HEDGE_CHECK_REQUIRED"]
                data_status = "NOT_APPLICABLE"
            else:
                required = set(t["requiredCoordinates"])
                attempted = [(law, *data(problem, law, required)) for law in laws]
                usable = [a for a in attempted if a[1] in {"AVAILABLE", "CONDITIONAL"}]
                if usable:
                    law, data_status, reasons, conditions = min(usable, key=lambda a: (a[1] != "AVAILABLE", a[0]["id"]))
                    law_id = law["id"]
                else:
                    states = {a[1] for a in attempted}
                    data_status = ("UNKNOWN" if "UNKNOWN" in states else
                                   "UNSUPPORTED" if "UNSUPPORTED" in states else
                                   "CONTRADICTED" if states == {"CONTRADICTED"} else "MISSING_DATA")
                    reasons = sorted({r for a in attempted for r in a[2]}) or ["OBSERVATIONAL_JOINT_LAW_UNAVAILABLE"]
                    conditions = [c for a in attempted for c in a[3]]
            sufficient = item["status"] == "PERMITTED" and structural == "IDENTIFIED" and data_status in {"AVAILABLE", "CONDITIONAL"}
            pairs.append({"mask": mask, "graphId": graph["id"], "structural": structural, "data": data_status,
                          "sufficient": sufficient, "proofId": t.get("id"), "lawId": law_id,
                          "reasons": reasons, "conditions": conditions,
                          "expression": None if expression is None else bind_law(expression, law_id or "MISSING_OBSERVATIONAL_JOINT"),
                          "problemKey": digest({"query": q, "graph": graph, "laws": laws, "admissibility": item,
                                                "identities": problem["identities"], "inputDigest": digest(problem)})})
    candidates = [m for m in masks if m["status"] == "PERMITTED" and
                  all(p["sufficient"] for p in pairs if p["mask"] == m["mask"])]
    selected = min(candidates, key=lambda m: rank(problem, m)) if candidates else None
    unresolved = sorted({p["mask"] for p in pairs if p["data"] in {"UNKNOWN", "UNSUPPORTED"}} |
                        {m["mask"] for m in masks if m["status"] == "UNKNOWN"})
    cheaper_unresolved = [i for i in unresolved if not selected or masks[i]["totalCost"] is None or rank(problem, masks[i]) < rank(problem, selected)]
    alternatives = []
    for g in problem["graphs"]:
        available = [m for m in masks if any(p["mask"] == m["mask"] and p["graphId"] == g["id"] and p["sufficient"] for p in pairs)]
        best = min(available, key=lambda m: rank(problem, m)) if available else None
        alternatives.append({"graphId": g["id"], "selectedMask": None if best is None else best["mask"],
                             "minimality": "UNKNOWN" if unresolved else "PROVED"})
    common = False
    selected_pairs = [p for p in pairs if selected and p["mask"] == selected["mask"]]
    if selected_pairs:
        common = all(p["expression"] == selected_pairs[0]["expression"] for p in selected_pairs)
    prospective = any(p["data"] == "CONDITIONAL" for p in selected_pairs)
    identification = ("UNKNOWN" if cheaper_unresolved and not selected else "UNIDENTIFIED" if not selected else
                      "CONDITIONAL" if prospective or not common else "INVARIANT")
    return {"schema": "finnor.r4.candidate.v1", "inputDigest": digest(problem), "identities": problem["identities"],
            "method": method, "proofs": proofs,
            "plan": {"schema": "finnor.identification-plan.v1", "targetQuery": q,
                     "selected": None if selected is None else {k: selected[k] for k in ["mask", "bundleIds", "totalCost", "completion", "schedule", "resourceUse"]},
                     "alternatives": alternatives, "identification": identification,
                     "commonFunctional": {"status": "PROVED" if common else "NOT_PROVED",
                         "basis": "PROPOSED_TYPED_KERNEL_ALGEBRA_REQUIRES_INDEPENDENT_CHECK",
                         "premises": ["ALIGNED_LAW_POPULATION_INTERVENTION_TIME_UNITS", "NONZERO_REQUIRED_DENOMINATORS"]},
                     "pairs": pairs, "masks": masks,
                     "minimality": {"status": "UNKNOWN" if cheaper_unresolved else "PROVED", "masks": len(masks),
                         "pairs": len(pairs), "unresolvedMasks": cheaper_unresolved, "basis": "COMPLETE_DECLARED_FINITE_MENU_ONLY"},
                     "assumptions": ["OWNER_DECLARED_ADMG_NOT_GRAPH_TRUTH", "SUPPLIED_LAW_SUPPORT_MEASUREMENT_LINKAGE_PREMISES",
                                     "PROSPECTIVE_COLLECTION_MUST_SUCCEED_AND_BE_RECHECKED"],
                     "basis": "MODEL_RELATIVE_EXACT", "graphTruthEstablished": False, "effectEstimate": None,
                     "attributionGranted": False, "executionAuthorityGranted": False, "admission": None},
            "usage": {"rawY0Calls": calls, "traceCount": len(proofs), "pairChecksProposed": len(pairs),
                      "structuralCache": "FULL_ORIGINAL_INPUT_GRAPH_QUERY_METHOD_BINDING; DATA_AND_ADMISSIBILITY_CHECKED_PER_PAIR",
                      "elapsedMs": (time.monotonic() - STARTED) * 1000, "costUSD": None}}


def main():
    raw = sys.stdin.buffer.read(524289)
    if len(raw) > 524288:
        raise ValueError("INPUT_BYTE_BOUND")
    request = json.loads(raw)
    problem = request.get("problem", request)
    result = compile_plan(problem)
    payload = stable(result)
    if len(payload.encode()) > 64 * 1024**2:
        raise Limit("OUTPUT_BYTE_BOUND")
    print(payload)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError) as e:
        print(stable({"schema": "finnor.r4.candidate.v1", "status": "INVALID_INPUT", "reason": str(e)}))
    except Limit as e:
        print(stable({"schema": "finnor.r4.candidate.v1", "status": "INCOMPLETE", "reason": str(e)}))
    except Exception as e:
        print(stable({"schema": "finnor.r4.candidate.v1", "status": "UNKNOWN", "reason": type(e).__name__}))
