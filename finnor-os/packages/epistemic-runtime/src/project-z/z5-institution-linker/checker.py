"""Independent original-semantics verifier. Standard library, no producer imports."""
from collections import defaultdict, deque
from itertools import product
import hashlib
import json
import math
import re
import resource
import sys
import time

VERSION = "z5-original-semantics-checker-v1"
PREORDER = "SHARED_STATE_EXACT_STRONG_MAY_SIMULATION_MUST_AVAILABILITY_LEGAL_QUIESCENCE_NONBLOCKING_V1"


class Refusal(Exception):
    def __init__(self, status, reason):
        super().__init__(reason)
        self.status = status


def insist(ok, reason):
    if not ok:
        raise ValueError(reason)


def unsupported(ok, reason):
    if not ok:
        raise Refusal("UNSUPPORTED", reason)


def canonical(x):
    return json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def sha(x):
    return hashlib.sha256(canonical(x).encode()).hexdigest()


def keys(x, names):
    unsupported(type(x) is dict and set(x) == set(names), "EXACT_FIELDS")


def identifier(x):
    return type(x) is str and re.fullmatch(r"[A-Za-z0-9_:./-]{1,192}", x) and x not in ["__proto__", "constructor", "prototype"]


class Bounds:
    def __init__(self, m):
        self.limit = m["limits"]
        self.count = 0
        self.start = time.monotonic()

    def debit(self, n=1):
        self.count += n
        if self.count > self.limit["maxOperations"] or (time.monotonic() - self.start) * 1000 > self.limit["wallMs"]:
            raise Refusal("INCOMPLETE", "ORIGINAL_OPERATION_OR_WALL_BOUND_EXHAUSTED")


def expression(e, m, depth=0):
    unsupported(type(e) is dict and depth <= 16, "EXPRESSION")
    if "const" in e:
        keys(e, ["const"])
        unsupported(type(e["const"]) is bool or type(e["const"]) is str and re.fullmatch(r"[\x20-\x7e]{0,192}", e["const"]) is not None, "CONSTANT")
    elif "cell" in e:
        keys(e, ["cell"])
        unsupported(e["cell"] in [x["id"] for x in m["cells"]], "UNKNOWN_CELL")
    elif "local" in e:
        keys(e, ["local"])
        unsupported(e["local"] in [x["id"] for x in m["components"]], "UNKNOWN_COMPONENT")
    else:
        keys(e, ["op", "args"])
        unsupported(e["op"] in ["eq", "ne", "lte", "and", "or", "not", "implies"] and type(e["args"]) is list
                    and len(e["args"]) <= 32, "OPERATOR")
        unsupported(len(e["args"]) > 0 if e["op"] in ["and", "or"] else len(e["args"]) == (1 if e["op"] == "not" else 2), "ARITY")
        for a in e["args"]:
            expression(a, m, depth + 1)


def interpret(e, s):
    if "const" in e:
        return e["const"]
    if "cell" in e:
        return s["cells"][e["cell"]]
    if "local" in e:
        return s["locals"][e["local"]]
    a = [interpret(x, s) for x in e["args"]]
    if e["op"] in ["eq", "ne"]:
        equal = type(a[0]) is type(a[1]) and a[0] == a[1]
        return equal if e["op"] == "eq" else not equal
    if e["op"] == "lte":
        unsupported(all(type(v) is str and re.fullmatch(r"(0|-?[1-9][0-9]{0,63})", v) for v in a), "EXACT_INTEGER")
        return int(a[0]) <= int(a[1])
    unsupported(all(type(v) is bool for v in a), "BOOLEAN_REQUIRED")
    return {"and": lambda: all(a), "or": lambda: any(a), "not": lambda: not a[0],
            "implies": lambda: not a[0] or a[1]}[e["op"]]()


def original_state(m, s):
    keys(s, ["locals", "cells"])
    keys(s["locals"], [c["id"] for c in m["components"]])
    keys(s["cells"], [c["id"] for c in m["cells"]])
    unsupported(all(s["locals"][c["id"]] in [x["id"] for x in c["states"]] for c in m["components"])
                and all(s["cells"][c["id"]] in c["values"] for c in m["cells"]), "STATE_DOMAIN")


def validate(m):
    unsupported(len(canonical(m).encode()) <= 8 * 1024 * 1024, "INPUT_BOUND")
    keys(m, ["schema", "claim", "domain", "components", "cells", "ports", "initial", "safety", "observe",
             "excludedEnvironmentActions", "replacementCandidates", "live", "limits"])
    unsupported(m["schema"] == "finnor.z5.composition-input.v1" and m["claim"] == "SOUND_SUBSET"
                and m["domain"] in ["PUBLIC_OFFLINE_FIXED_KERNELS", "ORDINARY_DEVELOPMENT"], "CLAIM")
    unsupported(type(m["components"]) is list and 2 <= len(m["components"]) <= 16 and type(m["cells"]) is list
                and len(m["cells"]) <= 8 and type(m["ports"]) is list and len(m["ports"]) <= 16, "PROFILE")
    for field, key in [("components", "id"), ("cells", "id"), ("cells", "identity"), ("ports", "label")]:
        unsupported(len({x[key] for x in m[field]}) == len(m[field]), "DUPLICATE_OR_ALIASED_IDENTITY")
    for c in m["cells"]:
        keys(c, ["id", "identity", "values", "kind", "public", "immutable"])
        unsupported(all(identifier(c[k]) for k in ["id", "identity", "kind"])
                    and type(c["public"]) is bool and type(c["immutable"]) is bool
                    and type(c["values"]) is list and 1 <= len(c["values"]) <= 32
                    and all(type(v) is str and re.fullmatch(r"[\x20-\x7e]{1,192}", v) for v in c["values"])
                    and len(set(c["values"])) == len(c["values"]), "CELL")
    for p in m["ports"]:
        keys(p, ["label", "environment", "public"])
        unsupported(identifier(p["label"]) and type(p["environment"]) is bool and type(p["public"]) is bool
                    and (not p["environment"] or p["public"]), "PRIVATE_ENVIRONMENT")
    maxima = {"maxProductStates": 65536, "maxContextStates": 4096, "maxTransitions": 524288,
              "maxOperations": 8000000, "wallMs": 30000, "maxRelationPairs": 262144, "maxTranslationRows": 262144}
    keys(m["limits"], maxima)
    unsupported(all(type(m["limits"][k]) is int and 1 <= m["limits"][k] <= top for k, top in maxima.items()), "LIMITS")
    unsupported(type(m["replacementCandidates"]) is list and len(m["replacementCandidates"]) <= 16, "REVISIONS")
    for c in m["components"] + m["replacementCandidates"]:
        keys(c, ["id", "revision", "states", "transitions", "assumption", "correspondence", "bridges"])
        unsupported(identifier(c["id"]) and identifier(c["revision"]) and c["id"] in [x["id"] for x in m["components"]]
                    and type(c["states"]) is list and 1 <= len(c["states"]) <= 32
                    and len({s["id"] for s in c["states"]}) == len(c["states"]), "COMPONENT")
        for s in c["states"]:
            keys(s, ["id", "terminal", "quiescent"])
            unsupported(identifier(s["id"]) and type(s["terminal"]) is bool and type(s["quiescent"]) is bool, "LOCAL_SEMANTICS")
        unsupported(type(c["transitions"]) is list and len(c["transitions"]) <= 256
                    and len({t["id"] for t in c["transitions"]}) == len(c["transitions"]), "TRANSITIONS")
        q = c["correspondence"]
        keys(q, ["kind", "scope", "admission", "implementationDigest"])
        unsupported(q["kind"] == "BOUNDED_TYPED_KERNEL_V1" and q["scope"] == "EXACT_LISTED_KERNEL_ONLY"
                    and q["admission"] in ["PUBLIC_OFFLINE_FIXED_FIXTURE", "NATIVE_S8_CURRENT_DECLARED_CONTRACT"]
                    and q["implementationDigest"] == sha(c["transitions"]), "CORRESPONDENCE")
        expression(c["assumption"], m)
        for t in c["transitions"]:
            keys(t, ["id", "from", "to", "guard", "writes", "port", "direction", "modality"])
            unsupported(identifier(t["id"]) and all(t[k] in [s["id"] for s in c["states"]] for k in ["from", "to"])
                        and t["port"] in [p["label"] for p in m["ports"]]
                        and t["direction"] in ["input", "output", "internal"] and t["modality"] in ["may", "must"]
                        and type(t["writes"]) is dict, "ORIGINAL_TRANSITION")
            expression(t["guard"], m)
            for key, e in t["writes"].items():
                unsupported(any(x["id"] == key and not x["immutable"] for x in m["cells"]), "FOREIGN_OR_IMMUTABLE_WRITE")
                expression(e, m)
        unsupported(type(c["bridges"]) is list and len(c["bridges"]) <= 1024, "BRIDGES")
        for b in c["bridges"]:
            keys(b, ["fromRevision", "fromState", "toState"])
            unsupported(identifier(b["fromRevision"]) and identifier(b["fromState"])
                        and b["toState"] in [s["id"] for s in c["states"]], "BRIDGE_ENTRY")
    unsupported(type(m["initial"]) is list and 1 <= len(m["initial"]) <= 4096 and type(m["safety"]) is list
                and 1 <= len(m["safety"]) <= 64, "INITIAL_PROPERTY")
    for e in m["safety"]:
        expression(e, m)
    for s in m["initial"] + [m["live"]]:
        original_state(m, s)
    unsupported(type(m["observe"]) is list and len(set(m["observe"])) == len(m["observe"])
                and all(any(c["id"] == x and c["public"] for c in m["cells"]) for x in m["observe"]), "LAWFUL_OBSERVATION")
    unsupported(all(c["id"] in m["observe"] for c in m["cells"] if c["public"]
                    and c["kind"] in ["resource", "reservation", "obligation", "authorization", "world"]), "OBSERVATION_ERASED")
    unsupported(type(m["excludedEnvironmentActions"]) is list
                and all(any(p["label"] == label and p["environment"] for p in m["ports"])
                        for label in m["excludedEnvironmentActions"]), "EXCLUSIONS")


def enabled(c, s, port=None, direction=None):
    return [t for t in c["transitions"] if t["from"] == s["locals"][c["id"]]
            and (port is None or t["port"] == port) and (direction is None or t["direction"] == direction)
            and interpret(t["guard"], s) is True]


def apply(m, s, selected):
    r = {"locals": dict(s["locals"]), "cells": dict(s["cells"])}
    writes = {}
    for c, t in selected:
        r["locals"][c["id"]] = t["to"]
        for key, e in t["writes"].items():
            value = interpret(e, s)
            if type(value) is not str or not any(x["id"] == key and value in x["values"] for x in m["cells"]):
                return {**r, "fault": "WRITE_OUTSIDE_ORIGINAL_DOMAIN"}
            if key in writes and writes[key] != value:
                return {**r, "fault": "CONFLICTING_ATOMIC_WRITES"}
            writes[key] = value
    r["cells"].update(writes)
    return r


def steps(m, s, bound):
    if "fault" in s:
        return []
    result = []

    def emit(selected, label, owner, environment=False, fault=None):
        bound.debit()
        result.append(({"label": label, "owner": owner,
                        "transitions": [c["id"] + ":" + t["id"] for c, t in selected],
                        "control": "ENVIRONMENT" if environment else "COMPONENT",
                        "must": any(t["modality"] == "must" for _, t in selected)},
                       {**s, "fault": fault} if fault else apply(m, s, selected)))

    for c in m["components"]:
        for t in enabled(c, s):
            bound.debit()
            if t["direction"] == "internal":
                emit([(c, t)], t["port"], c["id"])
            elif t["direction"] == "output":
                receivers = [d for d in m["components"] if d["id"] != c["id"]
                             and any(x["port"] == t["port"] and x["direction"] == "input" for x in d["transitions"])]
                groups = [[(d, x) for x in enabled(d, s, t["port"], "input")] for d in receivers]
                if any(not g for g in groups):
                    emit([(c, t)], t["port"], c["id"], fault="UNMATCHED_OUTPUT")
                else:
                    for combo in product(*groups):
                        emit([(c, t), *combo], t["port"], c["id"])
    for p in m["ports"]:
        if not p["environment"]:
            continue
        unsupported(not any(t["port"] == p["label"] and t["direction"] == "output"
                            for c in m["components"] for t in c["transitions"]), "AMBIGUOUS_ENVIRONMENT")
        receivers = [d for d in m["components"] if any(t["port"] == p["label"] and t["direction"] == "input"
                                                      for t in d["transitions"])]
        if receivers:
            groups = [[(d, t) for t in enabled(d, s, p["label"], "input")] for d in receivers]
            for combo in product(*groups):
                emit(list(combo), p["label"], "ENVIRONMENT", True)
    return result


def reconstruct(m, bound):
    states = {}
    for s in m["initial"]:
        key = sha(s)
        if key not in states:
            if len(states) >= m["limits"]["maxProductStates"]:
                raise Refusal("INCOMPLETE", "ORIGINAL_PRODUCT_STATE_BOUND_EXHAUSTED")
            states[key] = s
    edges = []
    queue = deque(states)
    while queue:
        source = queue.popleft()
        bound.debit()
        for e, state in steps(m, states[source], bound):
            target = sha(state)
            if target not in states:
                if len(states) >= m["limits"]["maxProductStates"]:
                    raise Refusal("INCOMPLETE", "ORIGINAL_PRODUCT_STATE_BOUND_EXHAUSTED")
                states[target] = state
                queue.append(target)
            if len(edges) >= m["limits"]["maxTransitions"]:
                raise Refusal("INCOMPLETE", "ORIGINAL_TRANSITION_BOUND_EXHAUSTED")
            edges.append({"from": source, "to": target, **e})
    return states, edges, [sha(s) for s in m["initial"]]


def safe(m, s):
    return "fault" not in s and all(interpret(e, s) is True for e in m["safety"] + [c["assumption"] for c in m["components"]])


def complete(m, s):
    return "fault" not in s and all(any(x["id"] == s["locals"][c["id"]] and (x["terminal"] or x["quiescent"])
                                      for x in c["states"]) for c in m["components"])


def rank_paths(nodes, edges, targets, bound):
    distance = {s: 0 for s in targets if s in nodes}
    reverse = defaultdict(list)
    for e in edges:
        if e["from"] in nodes and e["to"] in nodes:
            reverse[e["to"]].append(e["from"])
    queue = deque(distance)
    while queue:
        target = queue.popleft()
        for source in reverse[target]:
            bound.debit()
            if source not in distance:
                distance[source] = distance[target] + 1
                queue.append(source)
    return distance


def finite_feasibility(m, states, edges, bound):
    # Independently solve a descending finite bad-attractor/nonblocking closure.
    bad = {s for s in states if not safe(m, states[s])}
    while True:
        prior = len(bad)
        bad |= {e["from"] for e in edges if e["control"] == "COMPONENT" and e["to"] in bad}
        good = set(states) - bad
        public_groups = defaultdict(list)
        by = defaultdict(list)
        for e in edges:
            by[e["from"]].append(e)
        for s in good:
            public_groups[canonical({c: states[s]["cells"][c] for c in m["observe"]})].append(s)
        enabled_offers = {}
        for group in public_groups.values():
            allowed = set()
            for p in m["ports"]:
                if not p["environment"] or p["label"] in m["excludedEnvironmentActions"]:
                    continue
                if all((a := [e for e in by[s] if e["control"] == "ENVIRONMENT" and e["label"] == p["label"]])
                       and all(e["to"] in good for e in a) for s in group):
                    allowed.add(p["label"])
            for s in group:
                enabled_offers[s] = allowed
        retained = [e for e in edges if e["from"] in good and e["to"] in good and
                    (e["control"] == "COMPONENT" or e["label"] in enabled_offers[e["from"]])]
        reachable_completion = rank_paths(good, retained, {s for s in good if complete(m, states[s])}, bound)
        bad |= good - set(reachable_completion)
        bound.debit(len(states))
        if len(bad) == prior:
            return set(states) - bad


def full_translation(m, bound):
    h = hashlib.sha256()
    rows = 0
    shared_domains = [c["values"] for c in m["cells"]]
    # No dropped factor: compare every original local tuple and shared valuation.
    for component in m["components"]:
        for location in component["states"]:
            for valuation in product(*shared_domains):
                for locations in product(*([location["id"]] if c["id"] == component["id"]
                                           else [s["id"] for s in c["states"]] for c in m["components"])):
                    bound.debit()
                    rows += 1
                    if rows > m["limits"]["maxTranslationRows"]:
                        raise Refusal("INCOMPLETE", "FULL_TRANSLATION_ROW_BOUND_EXHAUSTED")
                    s = {"locals": dict(zip([c["id"] for c in m["components"]], locations)),
                         "cells": dict(zip([c["id"] for c in m["cells"]], valuation))}
                    meaning = [{"id": t["id"], "port": t["port"], "direction": t["direction"], "modality": t["modality"],
                                "result": apply(m, s, [(component, t)])} for t in enabled(component, s)]
                    h.update((canonical([component["id"], location["id"], s, meaning]) + "\n").encode())
    return {"rows": rows, "digest": h.hexdigest()}


def check_ranks(nodes, edges, ranks, terminal):
    insist(set(ranks) == set(nodes), "RANK_COVERAGE")
    for node in nodes:
        rank = ranks[node]
        insist(type(rank) is int and 0 <= rank <= len(nodes), "RANK_BOUND")
        insist(terminal(node) if rank == 0 else any(e["from"] == node and ranks.get(e["to"], rank) < rank for e in edges),
               "NONBLOCKING_RANK_HAS_NO_ORIGINAL_COMPLETION_PATH")


def check_context(m, proof, graph):
    states, edges, initial = graph
    keys(proof, ["states", "initial", "edges", "ranks", "semantics", "conditionality", "maximality"])
    nodes = set(proof["states"])
    insist(len(nodes) == len(proof["states"]) and 0 < len(nodes) <= m["limits"]["maxContextStates"], "NONEMPTY_CONTEXT_BOUND")
    insist(proof["initial"] == initial and all(s in nodes for s in initial), "EVERY_ORIGINAL_INITIAL_REQUIRED")
    insist(all(s in states and safe(m, states[s]) for s in nodes), "CONTEXT_OUTSIDE_ORIGINAL_OR_UNSAFE")
    original = {canonical(e) for e in edges}
    offered = {canonical(e) for e in proof["edges"]}
    insist(len(offered) == len(proof["edges"]), "DUPLICATE_CONTEXT_EDGE")
    insist(all(canonical(e) in original and e["from"] in nodes and e["to"] in nodes for e in proof["edges"]), "FORGED_CONTEXT_TRANSITION")
    insist(all(canonical(e) in offered for e in edges if e["from"] in nodes and e["control"] == "COMPONENT"), "OMITTED_ORIGINAL_COMPONENT_TRANSITION")
    for e in proof["edges"]:
        if e["control"] == "ENVIRONMENT":
            insist(e["label"] not in m["excludedEnvironmentActions"], "EXCLUDED_ENVIRONMENT")
            insist(all(canonical(a) in offered for a in edges if a["from"] == e["from"]
                       and a["control"] == "ENVIRONMENT" and a["label"] == e["label"]), "ENVIRONMENT_NDETERMINISM_PRUNED")
    by_observation = {}
    for s in nodes:
        observation = canonical({c: states[s]["cells"][c] for c in m["observe"]})
        offers = {e["label"] for e in proof["edges"] if e["from"] == s and e["control"] == "ENVIRONMENT"}
        insist(observation not in by_observation or by_observation[observation] == offers, "PRIVATE_STATE_DEPENDENT_CONTEXT")
        by_observation[observation] = offers
    seen = set(initial)
    while True:
        more = {e["to"] for e in proof["edges"] if e["from"] in seen} - seen
        if not more:
            break
        seen |= more
    insist(seen == nodes, "UNREACHABLE_ASSUMPTION_STATE")
    check_ranks(nodes, proof["edges"], proof["ranks"], lambda n: complete(m, states[n]))
    insist(proof["semantics"] == "ALL_COMPONENT_STEPS_AND_REQUIRED_ENVIRONMENT_OFFERS_NO_INEVITABILITY"
           and proof["maximality"] == "NOT_CLAIMED_SOUND_SUBSET" and type(proof["conditionality"]) is str
           and len(proof["conditionality"]) > 0, "FALSE_MAXIMALITY_OR_INEVITABILITY")


def check_counterexample(m, counterexample, graph, bound):
    states, edges, initial = graph
    can_finish = rank_paths(set(states), edges, {s for s in states if complete(m, states[s])}, bound)
    bad = {s for s in states if not safe(m, states[s]) or s not in can_finish}
    if not bad:
        insist(counterexample is None, "FALSE_ORIGINAL_COUNTEREXAMPLE")
        return
    insist(type(counterexample) is dict and counterexample["initial"] in initial, "ORIGINAL_COUNTEREXAMPLE_REQUIRED")
    current = counterexample["initial"]
    for step in counterexample["steps"]:
        insist(step["from"] == current and step in edges, "COUNTEREXAMPLE_NOT_ORIGINAL_TRANSITION")
        current = step["to"]
    insist(current == counterexample["final"] and current in bad, "COUNTEREXAMPLE_NOT_BAD")
    expected_kind = states[current].get("fault") or ("SAFETY_OR_ASSUMPTION" if not safe(m, states[current]) else "NONBLOCKING")
    insist(counterexample["kind"] == expected_kind, "FALSE_ORIGINAL_COUNTEREXAMPLE_CLASS")


def checked_replacement(m, cert, graph, bound):
    proof = cert["replacement"]
    insist(type(proof) is dict and proof["preorder"] == PREORDER, "EXACT_PREORDER_REQUIRED")
    if proof["status"] == "RETAIN_OLD":
        insist(proof["bridge"] is None and proof["relation"] == [] and proof["component"] is None
               and proof["revision"] is None, "FALLBACK_MINTS_REPLACEMENT")
        return
    insist(proof["status"] == "BRIDGED", "REPLACEMENT_STATUS")
    supplied = [c for c in m["replacementCandidates"] if c["id"] == proof["component"] and c["revision"] == proof["revision"]]
    insist(len(supplied) == 1, "NOT_A_SUPPLIED_FIXED_ADMITTED_REVISION")
    new = supplied[0]
    old = next(c for c in m["components"] if c["id"] == new["id"])

    def bridge_state(s):
        entries = [b for b in new["bridges"] if b["fromRevision"] == old["revision"] and b["fromState"] == s["locals"][old["id"]]]
        insist(len(entries) == 1, "ORIGINAL_BRIDGE_ENTRY_NOT_AUTHORIZED")
        return {"locals": {**s["locals"], old["id"]: entries[0]["toState"]}, "cells": dict(s["cells"])}

    newer = {**m, "components": [new if c["id"] == new["id"] else c for c in m["components"]],
             "initial": [bridge_state(s) for s in m["initial"]], "live": bridge_state(m["live"]), "replacementCandidates": []}
    full_translation(newer, bound)
    states, edges, initial = graph
    new_states, new_edges, new_initial = reconstruct(newer, bound)
    relation = {tuple(p) for p in proof["relation"]}
    insist(len(relation) == len(proof["relation"]) and 0 < len(relation) <= m["limits"]["maxRelationPairs"], "RELATION_BOUND")
    insist(all((a, b) in relation for a, b in zip(initial, new_initial)), "INITIAL_REPLACEMENT_COVERAGE")
    context = cert["context"]
    joint = []
    for a, b in relation:
        bound.debit()
        insist(a in context["states"] and b in new_states and safe(newer, new_states[b])
               and states[a]["cells"] == new_states[b]["cells"]
               and (not complete(newer, new_states[b]) or complete(m, states[a])), "PREORDER_LOSES_OBSERVATION_AUTHORITY_RESOURCE_LIABILITY_OR_QUIESCENCE")
        previous = [e for e in context["edges"] if e["from"] == a]
        offers = {e["label"] for e in previous if e["control"] == "ENVIRONMENT"}
        actual = [e for e in new_edges if e["from"] == b and (e["control"] == "COMPONENT" or e["label"] in offers)]

        def matches(e, f):
            return e["label"] == f["label"] and e["control"] == f["control"] and (f["to"], e["to"]) in relation

        insist(all(any(matches(e, f) for f in previous) for e in actual), "NEW_BEHAVIOR_OUTSIDE_CONTEXTUAL_SIMULATION")
        insist(all(any(matches(e, f) for e in actual) for f in previous if f["must"] or f["control"] == "ENVIRONMENT"),
               "REPLACEMENT_LOSES_MUST_OR_ENVIRONMENT_AVAILABILITY")
        for e in actual:
            for f in previous:
                if matches(e, f):
                    joint.append({"from": a + ":" + b, "to": f["to"] + ":" + e["to"]})
    relation_keys = {a + ":" + b for a, b in relation}
    check_ranks(relation_keys, joint, proof["ranks"], lambda p: complete(newer, new_states[p[65:]]))
    before, after = sha(m["live"]), sha(newer["live"])
    insist(before in states and after in new_states and (before, after) in relation, "UNREACHABLE_CLEAN_RESET_OR_UNSIMULATED_LIVE_STATE")
    insist(proof["bridge"] == {"old": before, "replacement": after, "carriedCellsDigest": sha(m["live"]["cells"])},
           "LIVE_BRIDGE_LOSES_ORIGINAL_RESERVATION_OR_UNRESOLVED_OBLIGATION")


def check(m, cert):
    insist(type(cert) is dict and set(cert) == {
        "schema", "version", "inputDigest", "disposition", "reasons", "context", "replacement",
        "originalCounterexample", "translation", "original", "discharge", "correspondence",
        "executionAuthorityGranted", "protectedAdmission", "costs"}, "CERTIFICATE_FIELDS")
    insist(cert["schema"] == "finnor.z5.institution-composition-certificate.v1" and cert["version"] == "z5-coupled-kernel-v1"
           and cert["inputDigest"] == sha(m) and cert["executionAuthorityGranted"] is False
           and cert["protectedAdmission"] is False
           and cert["correspondence"] == "EXACT_BOUNDED_LISTED_TYPED_KERNELS_NOT_ARBITRARY_TS_SQL_OR_PROVIDER",
           "CERTIFICATE_ENVELOPE_BINDING")
    bound = None
    try:
        validate(m)
        bound = Bounds(m)
        translation = full_translation(m, bound)
        graph = reconstruct(m, bound)
        states, edges, initial = graph
        insist(cert["translation"] == translation, "INDEPENDENT_FULL_TRANSLATION_MISMATCH")
        insist(cert["original"] == {"states": len(states), "transitions": len(edges), "initial": len(initial)}, "ORIGINAL_PRODUCT_COVERAGE_MISMATCH")
        check_counterexample(m, cert["originalCounterexample"], graph, bound)
        if cert["disposition"] == "CHECKED_INFEASIBLE":
            region = finite_feasibility(m, states, edges, bound)
            insist(not all(s in region for s in initial) and cert["context"] is None and cert["replacement"] is None,
                   "FALSE_FINITE_INFEASIBILITY")
        elif cert["disposition"] == "CHECKED_CANDIDATE":
            check_context(m, cert["context"], graph)
            insist(cert["discharge"] == {"initial": len(initial), "componentTransitions": sum(e["control"] == "COMPONENT" for e in cert["context"]["edges"]),
                                         "environmentTransitions": sum(e["control"] == "ENVIRONMENT" for e in cert["context"]["edges"]), "noncircular": True},
                   "FALSE_INITIAL_OR_EVERY_TRANSITION_DISCHARGE")
            checked_replacement(m, cert, graph, bound)
        else:
            raise ValueError("FALSE_UNSUPPORTED_OR_UNEXHAUSTED_INCOMPLETE")
    except Refusal as error:
        insist(cert["disposition"] == error.status and cert["context"] is None and cert["replacement"] is None
               and cert["discharge"]["noncircular"] is False, "REFUSAL_CANNOT_CARRY_POSITIVE_PROOF")
    claim = {k: v for k, v in cert.items() if k != "costs"}
    return {"schema": "finnor.z5.independent-check.v1", "checker": VERSION, "checked": True,
            "inputDigest": sha(m), "claimDigest": sha(claim), "disposition": cert["disposition"],
            "protectedAdmission": False, "executionAuthorityGranted": False,
            "scope": "ORIGINAL_FINITE_TYPED_KERNEL_SEMANTICS_NOT_NATIVE_TS_SQL_OR_PROTECTED_CUSTODY",
            "operations": bound.count if bound else 0}


def main():
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (35, 35))
    raw = sys.stdin.buffer.read(32 * 1024 * 1024 + 1)
    insist(len(raw) <= 32 * 1024 * 1024, "CHECKER_INPUT_BYTE_BOUND")
    request = json.loads(raw)
    try:
        result = check(request["input"], request["certificate"])
        print(canonical(result))
    except (ValueError, KeyError, TypeError, Refusal, StopIteration) as error:
        print(canonical({"schema": "finnor.z5.independent-check.v1", "checker": VERSION,
                         "checked": False, "reason": str(error)[:256], "executionAuthorityGranted": False}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
