"""Failure-first independent exhaustive temporal oracle, not product code.

It imports no producer/checker code and does not use GR(1) or a parity solver.
The frozen contract explains completeness of its <=4 monitor memories.
"""
from itertools import product


def components(vertices, successors):
    # Iterative Kosaraju, intentionally unlike the production checker.
    vertices = set(vertices)
    seen, order = set(), []
    for root in sorted(vertices):
        if root in seen:
            continue
        todo = [(root, False)]
        while todo:
            v, finish = todo.pop()
            if finish:
                order.append(v)
            elif v not in seen:
                seen.add(v)
                todo.append((v, True))
                todo.extend((w, False) for w in successors[v] if w in vertices and w not in seen)
    reverse = {v: [] for v in vertices}
    for v in vertices:
        for w in successors[v]:
            if w in vertices:
                reverse[w].append(v)
    seen, result = set(), []
    for root in reversed(order):
        if root in seen:
            continue
        group, todo = set(), [root]
        while todo:
            v = todo.pop()
            if v in seen:
                continue
            seen.add(v)
            group.add(v)
            todo.extend(reverse[v])
        result.append(group)
    return result


def reachable(starts, successors):
    result, todo = set(), list(starts)
    while todo:
        v = todo.pop()
        if v not in result:
            result.add(v)
            todo.extend(successors[v])
    return result


def exhaustive(arena, limit=4096):
    states = arena["states"]
    n = len(states)
    ids = {s["id"]: i for i, s in enumerate(states)}
    assumptions = [set(ids[x] for x in a) for a in arena["assumptions"]] or [set(range(n))]
    goals = [set(ids[x] for x in b) for b in arena["goals"]] or [set(range(n))]
    na, nb = len(assumptions), len(goals)
    memories = list(product(range(na), range(nb)))
    size = n * len(memories)
    edges = [[] for _ in states]
    for e in arena["edges"]:
        edges[ids[e["from"]]].append(ids[e["to"]])
    if any(not row for row in edges):
        return {"unsupported": "DEADLOCK"}
    choices, policy_count = [], 1
    for m in range(len(memories)):
        for v, s in enumerate(states):
            if s["owner"] == "C":
                choices.append((m, v, edges[v]))
                policy_count *= len(edges[v])
    if policy_count > limit:
        return {"unsupported": "REFERENCE_POLICY_BOUND", "policies": policy_count}
    region, nonconflicting = set(), set()
    for moves in product(*(row[2] for row in choices)):
        policy = {(m, v): w for (m, v, _), w in zip(choices, moves)}
        successors = []
        for m, (a, b) in enumerate(memories):
            for v, s in enumerate(states):
                next_a = (a + 1) % na if v in assumptions[a] else a
                next_b = (b + 1) % nb if v in goals[b] else b
                mm = memories.index((next_a, next_b))
                targets = [policy[m, v]] if s["owner"] == "C" else edges[v]
                successors.append([mm * n + w for w in targets])
        for v in range(n):
            seen = reachable([v], successors)
            if any(not states[x % n]["safe"] for x in seen):
                continue
            bad = False
            for goal in goals:
                vertices = {x for x in seen if x % n not in goal}
                for group in components(vertices, successors):
                    cyclic = len(group) > 1 or any(x in successors[x] for x in group)
                    if cyclic and all(any(x % n in a for x in group) for a in assumptions):
                        bad = True
                        break
                if bad:
                    break
            if bad:
                continue
            region.add(v)
            fair = set()
            for group in components(seen, successors):
                cyclic = len(group) > 1 or any(x in successors[x] for x in group)
                if cyclic and all(any(x % n in a for x in group) for a in assumptions):
                    fair.update(group)
            reverse = {x: [] for x in seen}
            for x in seen:
                for y in successors[x]:
                    reverse[y].append(x)
            if reachable(fair, reverse) == seen:
                nonconflicting.add(v)
    return {"region": sorted(region), "nonconflictingRegion": sorted(nonconflicting),
            "policies": policy_count, "memory": len(memories)}


def small_population():
    for n in (1, 2):
        subsets = [[v for v in range(n) if mask & (1 << v)] for mask in range(1 << n)]
        for targets in product(subsets[1:], repeat=n):
            for owners in product(("C", "E"), repeat=n):
                for safe in subsets:
                    for assumptions in [[], *[[a] for a in subsets]]:
                        for goals in [[], *[[b] for b in subsets]]:
                            yield {
                                "schema": "finnor.z3.public-arena.v1", "id": "exhaustive",
                                "observationMode": "PUBLIC_PERFECT_INFORMATION",
                                "states": [{"id": str(v), "owner": owners[v], "observation": str(v),
                                            "safe": v in safe, "remaining": 0, "unknown": []} for v in range(n)],
                                "edges": [{"from": str(v), "to": str(w), "action": str(w),
                                           "renewalRef": None, "settlementRef": None} for v in range(n) for w in targets[v]],
                                "initial": [str(v) for v in range(n)],
                                "assumptions": [[str(v) for v in a] for a in assumptions],
                                "goals": [[str(v) for v in b] for b in goals],
                                "resources": {"capacity": 0, "maximum": 0, "obligationIds": [],
                                              "renewalRefs": [], "settlementRefs": [], "unknownOccupiesCapacity": True},
                            }
