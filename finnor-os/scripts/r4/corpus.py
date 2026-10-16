"""Frozen independent E2E inputs and analytic oracles, before producer code.

These are positive, finite hypothetical distributions, never company data.
"""
from copy import deepcopy
from fractions import Fraction
from itertools import product


def rational(n=0, d=1):
    f = Fraction(n, d)
    return {"numerator": str(f.numerator), "denominator": str(f.denominator)}


def probability(variables, given=()):
    return {"op": "probability", "law": "OBS", "variables": sorted(variables), "given": sorted(given)}


def multiply(*terms):
    return {"op": "product", "terms": list(terms)}


def marginal(variables, expression):
    return {"op": "sum", "variables": sorted(variables), "expression": expression}


def base(nodes=("X", "Y"), edges=(("X", "Y"),), bidirected=(), conditions=()):
    scope = {"population": "synthetic-cohort-v1", "intervention": "set-X-v1",
             "time": {"start": "2026-10-01T00:00:00.000Z", "end": "2026-10-02T00:00:00.000Z"},
             "units": {n: "binary" for n in nodes}}
    basis = {"currency": "USD", "unit": "USD", "valuationAt": "2026-10-01",
             "ownerShare": rational(1), "horizon": scope["time"], "discount": "NO_DISCOUNT_ONE_DAY"}
    premises = {p: {"status": "SATISFIED", "basis": "SUPPLIED_MODEL_PREMISE_UNADMITTED",
                    "reason": "Positive complete finite synthetic observational joint, not field qualification"}
                for p in ["positivity", "denominator", "selection", "missingness", "measurement", "linkage"]}
    law = {"id": "joint", "kind": "OBSERVATIONAL_JOINT", "variables": list(nodes),
           "scope": deepcopy(scope), "premises": premises, "sourceRefs": ["synthetic-source-v1"],
           "rowLinkage": "SINGLE_COHORT_JOINT", "availability": "OBSERVED"}
    graph = {"id": "g1", "nodes": list(nodes), "directed": [list(e) for e in edges],
             "bidirected": [list(e) for e in bidirected], "observedNodes": list(nodes),
             "projection": "NONE", "assumptionBasis": "OWNER_DECLARED_UNADMITTED"}
    return {"schema": "finnor.identification-problem.v1", "profile": "R4_OBSERVATIONAL_ADMG_ID_IDC_V1",
            "query": {"id": "q1", "outcomes": ["Y"], "treatments": ["X"], "conditions": list(conditions),
                      "scope": scope, "estimandRef": "s7-synthetic-preregistration"},
            "variables": [{"id": n, "unit": "binary"} for n in nodes],
            "graphs": [graph], "baseline": [law], "bundles": [], "costItems": [],
            "constraints": {"costBasis": basis, "scheduleUnit": "second", "resourceOrder": ["staff"],
                            "resources": [{"id": "staff", "unit": "person", "capacity": rational(2)}],
                            "exposureLimit": rational(10), "collectBy": rational(100)},
            "identities": {"domain": "synthetic-declared-v1", "owners": "synthetic-owner-cut-v1",
                           "method": "y0-0.2.11-current-kernel-trace-v1", "checker": "r4-independent-v1"}}


def bundle(problem, id, variables=None, cost=1, delay=1, resource=1, items=None):
    source = deepcopy(problem["baseline"][0]) if problem["baseline"] else deepcopy(base()["baseline"][0])
    source["id"] = id + "-law"
    source["variables"] = variables or [v["id"] for v in problem["variables"]]
    source["scope"] = deepcopy(problem["query"]["scope"])
    source["availability"] = "PROSPECTIVE"
    source["sourceRefs"] = [id + "-source"]
    cost_ids = items or [id + "-cost"]
    if items is None:
        problem["costItems"].append({"id": cost_ids[0], "amount": None if cost is None else rational(cost),
                                     "basis": deepcopy(problem["constraints"]["costBasis"])})
    b = {"id": id, "laws": [source], "costItemIds": cost_ids,
         "admissibility": {"rights": "PERMITTED", "s2": "PERMITTED", "privacy": "PERMITTED", "staffing": "PERMITTED"},
         "schedule": {"after": [], "earliestStart": rational(), "duration": rational(delay)},
         "resources": [{"id": "staff", "quantity": rational(resource)}], "exposure": rational(1)}
    problem["bundles"].append(b)
    return b


def scenarios():
    result = []
    add = lambda id, p, expected: result.append((id, p, expected))
    p = base()
    add("unconfounded", p, {"selected": 0, "functional": probability(["Y"], ["X"])})
    p = base(("Z", "X", "Y"), (("Z", "X"), ("Z", "Y"), ("X", "Y")))
    add("backdoor", p, {"selected": 0,
                       "functional": marginal(["Z"], multiply(probability(["Y"], ["X", "Z"]), probability(["Z"])))})
    p = base(("X", "M", "Y"), (("X", "M"), ("M", "Y")), (("X", "Y"),))
    add("frontdoor", p, {"selected": 0,
                        "functional": marginal(["M"], multiply(probability(["M"], ["X"]),
                           marginal(["X"], multiply(probability(["Y"], ["X", "M"]), probability(["X"])))))})
    p = base(("W", "X", "Y"), (("X", "Y"),), (("W", "X"),))
    add("recursive-kernel", p, {"selected": 0, "functional": probability(["Y"], ["X"])})
    p = base(("Z", "X", "Y"), (("Z", "Y"), ("X", "Y")), (), ("Z",))
    add("idc-exchange", p, {"selected": 0, "functional": probability(["Y"], ["X", "Z"]), "rule": "IDC_EXCHANGE"})
    p = base(("X", "Y", "Z"), (("X", "Y"), ("Y", "Z")), (), ("Z",))
    add("idc-normalization", p, {"selected": 0, "rule": "IDC_NORMALIZE",
                                "functional": {"op": "ratio",
                                    "numerator": multiply(probability(["Y"], ["X"]), probability(["Z"], ["X", "Y"])),
                                    "denominator": marginal(["Y"], multiply(probability(["Y"], ["X"]),
                                                                                 probability(["Z"], ["X", "Y"])))}})
    p = base(bidirected=(("X", "Y"),))
    add("hedge", p, {"selected": None, "structural": "NONIDENTIFIABLE"})
    p = base()
    p["graphs"].append({**deepcopy(p["graphs"][0]), "id": "g2", "directed": [["Y", "X"]]})
    add("opposed-graphs", p, {"selected": 0, "equivalence": "NOT_PROVED", "identification": "CONDITIONAL"})
    p = base()
    p["graphs"].append({**deepcopy(p["graphs"][0]), "id": "g2"})
    add("equivalent-functionals", p, {"selected": 0, "equivalence": "PROVED", "identification": "INVARIANT"})

    for id in ["empty-baseline", "necessary-affordable", "cheaper-insufficient", "delay-tie", "resource-tie",
               "irrelevant-expensive", "joint-exposure", "joint-resource", "shared-cost", "unknown-cost",
               "incomparable-cost", "unsupported-cheaper", "unknown-cheaper-support", "eight-by-eight"]:
        p = base()
        # The cheap marginal cannot synthesize the joint required by P(Y|X).
        cheap = bundle(p, "a-marginal", ["X"], cost=1)
        joint = bundle(p, "b-joint", ["X", "Y"], cost=3, delay=3)
        p["baseline"] = []
        expected = {"selected": 2, "identification": "CONDITIONAL"}
        if id == "empty-baseline":
            p["baseline"] = base()["baseline"]
            expected = {"selected": 0}
        elif id in ["delay-tie", "resource-tie"]:
            cheap["laws"][0]["variables"] = ["X", "Y"]
            p["costItems"][0]["amount"] = rational(3)
            if id == "delay-tie":
                cheap["schedule"]["duration"] = rational(5)
            else:
                cheap["schedule"]["duration"] = rational(3)
                cheap["resources"][0]["quantity"] = rational(2)
        elif id == "irrelevant-expensive":
            bundle(p, "z-irrelevant", ["X"], cost=100)
        elif id in ["joint-exposure", "joint-resource"]:
            p["constraints"]["exposureLimit"] = rational(1) if id == "joint-exposure" else rational(10)
            if id == "joint-resource":
                p["constraints"]["resources"][0]["capacity"] = rational(1)
            expected["rejectedMask"] = 3
        elif id == "shared-cost":
            cheap["laws"][0]["variables"] = ["X", "Y"]
            joint["costItemIds"] = cheap["costItemIds"]
            expected = {"selected": 1, "unionMask": 3, "unionCost": rational(1)}
        elif id == "unknown-cost":
            cheap["laws"][0]["variables"] = ["X", "Y"]
            p["costItems"][0]["amount"] = None
            expected["minimality"] = "UNKNOWN"
        elif id == "incomparable-cost":
            cheap["laws"][0]["variables"] = ["X", "Y"]
            p["costItems"][0]["basis"]["currency"] = "EUR"
            expected["minimality"] = "UNKNOWN"
        elif id in ["unsupported-cheaper", "unknown-cheaper-support"]:
            cheap["laws"][0]["variables"] = ["X", "Y"]
            if id == "unsupported-cheaper":
                cheap["laws"][0]["kind"] = "EXPERIMENTAL"
                expected["data"] = "UNSUPPORTED"
            else:
                cheap["laws"][0]["premises"]["positivity"]["status"] = "UNKNOWN"
                expected["data"] = "UNKNOWN"
            expected["minimality"] = "UNKNOWN"
        elif id == "eight-by-eight":
            for n in range(6):
                bundle(p, "c" + str(n), ["X"], cost=4+n)
            p["graphs"] = [{**deepcopy(p["graphs"][0]), "id": "g" + str(i)} for i in range(8)]
            expected.update({"masks": 256, "pairs": 2048})
        add(id, p, expected)

    for id in ["unavailable-law", "population", "time", "intervention", "missing-joint-linkage",
               "overlapping-marginals", "positivity-unknown", "positivity-contradicted", "idc-zero-denominator",
               "selection", "missingness", "measurement", "experimental", "transport",
               "unobserved-confounder", "unqualified-projection", "prospective"]:
        p = base()
        law = p["baseline"][0]
        expected = {"selected": None}
        if id == "unavailable-law":
            p["baseline"] = []
        elif id in ["population", "intervention"]:
            law["scope"][id] = "incompatible-v2"
        elif id == "time":
            law["scope"]["time"]["end"] = "2026-10-03T00:00:00.000Z"
        elif id == "missing-joint-linkage":
            law["rowLinkage"] = "UNKNOWN"
        elif id == "overlapping-marginals":
            p = base(("X", "Y", "Z"), (("Z", "X"), ("Z", "Y"), ("X", "Y")))
            p["baseline"][0]["variables"] = ["X", "Y"]
            p["baseline"].append({**deepcopy(p["baseline"][0]), "id": "other", "variables": ["X", "Z"]})
        elif id in ["positivity-unknown", "positivity-contradicted"]:
            law["premises"]["positivity"]["status"] = "UNKNOWN" if id.endswith("unknown") else "CONTRADICTED"
            expected["data"] = law["premises"]["positivity"]["status"]
        elif id == "idc-zero-denominator":
            p = base(("X", "Y", "Z"), (("X", "Y"), ("Y", "Z")), (), ("Z",))
            p["baseline"][0]["premises"]["denominator"]["status"] = "CONTRADICTED"
            expected["data"] = "CONTRADICTED"
        elif id in ["selection", "missingness", "measurement"]:
            law["premises"][id]["status"] = "UNSUPPORTED"
            expected.update({"data": "UNSUPPORTED", "minimality": "UNKNOWN", "identification": "UNKNOWN"})
        elif id in ["experimental", "transport"]:
            law["kind"] = "EXPERIMENTAL" if id == "experimental" else "TRANSPORT"
            expected.update({"data": "UNSUPPORTED", "minimality": "UNKNOWN", "identification": "UNKNOWN"})
        elif id == "unobserved-confounder":
            p = base(("Z", "X", "Y"), (("Z", "X"), ("Z", "Y"), ("X", "Y")))
            p["graphs"][0]["observedNodes"] = ["X", "Y"]
            p["baseline"][0]["variables"] = ["X", "Y"]
            expected.update({"data": "UNSUPPORTED", "minimality": "UNKNOWN", "identification": "UNKNOWN"})
        elif id == "unqualified-projection":
            p["graphs"][0]["projection"] = "UNQUALIFIED_INDUCED_SUBGRAPH"
            expected.update({"data": "UNSUPPORTED", "minimality": "UNKNOWN", "identification": "UNKNOWN"})
        else:
            bundle(p, "future-joint", cost=2)
            p["baseline"] = []
            expected = {"selected": 1, "identification": "CONDITIONAL", "future": True}
        add(id, p, expected)
    for id in ["cycle", "unknown-node", "unit", "bidirected-misuse", "duplicate-cost", "oversized-menu"]:
        p = base()
        if id == "cycle": p["graphs"][0]["directed"].append(["Y", "X"])
        if id == "unknown-node": p["query"]["outcomes"] = ["not-registered"]
        if id == "unit": p["query"]["scope"]["units"]["Y"] = "USD"
        if id == "bidirected-misuse": p["graphs"][0]["bidirected"].append(["X", "X"])
        if id == "duplicate-cost":
            bundle(p, "a")
            p["costItems"].append(deepcopy(p["costItems"][0]))
        if id == "oversized-menu":
            for n in range(9): bundle(p, "b" + str(n))
        add(id, p, {"invalid": True})
    return result


MUTATIONS = ["graph", "query", "conditioning", "intervention", "district", "ancestor", "decomposition",
             "idc-mutilation", "separation", "kernel", "source", "bound-variable", "marginalization",
             "denominator", "support", "cost", "tie", "mask", "omitted-cheaper", "backend", "checker", "domain",
             "unsupported-as-missing", "unresolved-as-proved"]


def evaluate_ast(term, joint, assignment, names=("X", "Y")):
    """Independent rational evaluation, not an equivalence acceptance oracle."""
    op = term["op"]
    if op == "one": return Fraction(1)
    if op == "probability":
        children, given = term["variables"], term["given"]
        def mass(coords):
            return sum((v for k,v in joint.items()
                        if all(k[names.index(n)] == assignment[n] for n in coords)), Fraction())
        return mass(children + given) / mass(given)
    if op == "product":
        total = Fraction(1)
        for t in term["terms"]: total *= evaluate_ast(t, joint, assignment, names)
        return total
    if op == "ratio":
        return evaluate_ast(term["numerator"], joint, assignment, names) / evaluate_ast(term["denominator"], joint, assignment, names)
    if op == "sum":
        return sum((evaluate_ast(term["expression"], joint, {**assignment, **dict(zip(term["variables"], bits))}, names)
                    for bits in product([0,1], repeat=len(term["variables"]))), Fraction())
    raise ValueError("Unsupported independent evaluation term")
