#!/usr/bin/env python3
"""Independent original-semantics checker. Standard library only.

No imports from the producer, parser, parity solver or test/reference oracle.
All original environment successors, complete iterants and every cyclic SCC
are checked. A rejected strategy never becomes an unrealizability claim.
"""
import hashlib
import json
import sys
import time

sys.setrecursionlimit(12000)
VERSION = "z3-public-gr1-v1"
MAX_BYTES, MAX_OPS, MAX_ITERANTS = 8388608, 40000000, 65536


class Refusal(Exception):
    pass


class BudgetExceeded(Exception):
    """Finite runtime budget exhausted: evidence is unjudged, not invalid.

    Budget exhaustion must surface as UNKNOWN. A resource limit is never a
    semantic rejection of the candidate and never an unrealizability proof.
    """
    pass


def demand(condition, code):
    if not condition:
        raise Refusal(code)


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def exact(value, keys):
    demand(type(value) is dict and set(value) == set(keys.split()), "Z3_CHECK_EXACT_SCHEMA")
    return value


def number(value, maximum):
    demand(type(value) is int and 0 <= value <= maximum, "Z3_CHECK_INTEGER_BOUND")
    return value


def identifier(value):
    demand(type(value) is str and 1 <= len(value) <= 128
           and value[0].isascii() and value[0].isalnum()
           and all(c.isascii() and (c.isalnum() or c in "_.:/-") for c in value),
           "Z3_CHECK_PUBLIC_IDENTIFIER")
    return value


def ids(value, maximum=256):
    demand(type(value) is list and len(value) <= maximum, "Z3_CHECK_SET_BOUND")
    for item in value:
        identifier(item)
    demand(len(set(value)) == len(value), "Z3_CHECK_DUPLICATE_MEMBER")
    return value


def original(arena, binding):
    exact(binding, "tenantId principalId workId workInputId originalParentId sourceRevision rightsRevision mandateDigest observationDigest resourceDigest deadlineAt codeDigest")
    demand(all(type(x) is str and 1 <= len(x) <= 256 for x in binding.values()), "Z3_CHECK_ORIGINAL_BINDING")
    exact(arena, "schema id observationMode states edges initial assumptions goals resources")
    demand(arena["schema"] == "finnor.z3.public-arena.v1", "Z3_CHECK_ARENA_VERSION")
    demand(arena["observationMode"] == "PUBLIC_PERFECT_INFORMATION", "Z3_PARTIAL_OBSERVATION_UNSUPPORTED")
    identifier(arena["id"])
    states = arena["states"]
    demand(type(states) is list and 1 <= len(states) <= 256, "Z3_CHECK_STATE_BOUND")
    for state in states:
        exact(state, "id owner observation safe remaining unknown")
        identifier(state["id"])
        identifier(state["observation"])
        demand(state["owner"] in ("C", "E") and type(state["safe"]) is bool, "Z3_CHECK_STATE_SEMANTICS")
        number(state["remaining"], 1000000000)
        ids(state["unknown"])
    index = {s["id"]: v for v, s in enumerate(states)}
    demand(len(index) == len(states) and len(set(s["observation"] for s in states)) == len(states),
           "Z3_PARTIAL_OBSERVATION_UNSUPPORTED")
    resource = exact(arena["resources"], "capacity maximum obligationIds renewalRefs settlementRefs unknownOccupiesCapacity")
    number(resource["capacity"], 256)
    number(resource["maximum"], 1000000000)
    for key in ("obligationIds", "renewalRefs", "settlementRefs"):
        ids(resource[key])
    demand(resource["unknownOccupiesCapacity"] is True, "Z3_CHECK_UNKNOWN_CAPACITY")
    for s in states:
        demand(s["remaining"] <= resource["maximum"] and set(s["unknown"]) <= set(resource["obligationIds"])
               and (not s["safe"] or len(s["unknown"]) <= resource["capacity"]), "Z3_CHECK_RESOURCE_STATE")
    successors, outgoing, names = [[] for _ in states], [[] for _ in states], set()
    demand(type(arena["edges"]) is list and len(arena["edges"]) <= 2048, "Z3_CHECK_EDGE_BOUND")
    for i, edge in enumerate(arena["edges"]):
        exact(edge, "from to action renewalRef settlementRef")
        identifier(edge["from"])
        identifier(edge["to"])
        identifier(edge["action"])
        demand(edge["from"] in index and edge["to"] in index, "Z3_CHECK_ORIGINAL_EDGE")
        key = (edge["from"], edge["action"])
        demand(key not in names, "Z3_CHECK_AMBIGUOUS_ACTION")
        names.add(key)
        v, w = index[edge["from"]], index[edge["to"]]
        a, b = states[v], states[w]
        successors[v].append(w)
        outgoing[v].append(i)
        for field, refs in (("renewalRef", "renewalRefs"), ("settlementRef", "settlementRefs")):
            demand(edge[field] is None or edge[field] in resource[refs], "Z3_CHECK_UNADMITTED_RESOURCE_PROOF")
        demand(b["remaining"] <= a["remaining"] or edge["renewalRef"] is not None, "Z3_CHECK_INVENTED_RENEWAL")
        demand(set(a["unknown"]) <= set(b["unknown"]) or edge["settlementRef"] is not None, "Z3_CHECK_UNKNOWN_ERASED")
    demand(all(1 <= len(row) <= 8 for row in successors), "Z3_CHECK_EXPLICIT_TOTALIZATION_REQUIRED")
    initial = ids(arena["initial"])
    demand(initial and set(initial) <= set(index), "Z3_CHECK_INITIAL_COVERAGE")
    sets = []
    for key in ("assumptions", "goals"):
        demand(type(arena[key]) is list and len(arena[key]) <= 2, "Z3_CHECK_JUSTICE_BOUND")
        values = []
        for row in arena[key]:
            ids(row)
            demand(set(row) <= set(index), "Z3_CHECK_JUSTICE_COVERAGE")
            values.append(set(index[x] for x in row))
        sets.append(values or [set(range(len(states)))])
    return states, index, successors, outgoing, sets[0], sets[1]


class Checker:
    def __init__(self):
        self.started = time.monotonic()
        self.operations = 0
        self.iterants = 0

    def tick(self, n=1):
        self.operations += n
        if self.operations > MAX_OPS or time.monotonic() - self.started > 15:
            raise BudgetExceeded("Z3_CHECK_FINITE_BUDGET")

    def region(self, states, successors, assumptions, goals, certificate):
        exact(certificate, "safety gr1")
        for stream in certificate.values():
            demand(type(stream) is list and len(stream) <= MAX_ITERANTS, "Z3_CHECK_TRANSCRIPT_BOUND")
        universe = set(range(len(states)))

        def pre(target):
            result = set()
            for v, state in enumerate(states):
                self.tick(len(successors[v]) + 1)
                inside = [w in target for w in successors[v]]
                if any(inside) if state["owner"] == "C" else all(inside):
                    result.add(v)
            return result

        offsets = {"safety": 0, "gr1": 0}

        def receipt(kind, values):
            self.iterants += 1
            self.tick()
            if self.iterants > MAX_ITERANTS:
                raise BudgetExceeded("Z3_CHECK_TOTAL_ITERANT_BOUND")
            stream, pos = certificate[kind], offsets[kind]
            encoded = format(sum(1 << v for v in values), "x")
            demand(pos < len(stream) and type(stream[pos]) is str and stream[pos] == encoded,
                   "Z3_CHECK_COMPLETE_ITERANT_MISMATCH")
            offsets[kind] += 1

        safe = {v for v, s in enumerate(states) if s["safe"]}
        kernel = universe.copy()
        receipt("safety", kernel)
        while True:
            updated = safe & pre(kernel)
            receipt("safety", updated)
            if updated == kernel:
                break
            kernel = updated
        z = kernel.copy()
        receipt("gr1", z)
        while True:
            outer = kernel.copy()
            for goal in goals:
                y = set()
                receipt("gr1", y)
                while True:
                    next_y = set()
                    base = (goal & pre(z)) | pre(y)
                    for assumption in assumptions:
                        x = kernel.copy()
                        receipt("gr1", x)
                        while True:
                            next_x = kernel & (base | ((universe - assumption) & pre(x)))
                            receipt("gr1", next_x)
                            if next_x == x:
                                break
                            x = next_x
                        next_y |= x
                    receipt("gr1", next_y)
                    if next_y == y:
                        break
                    y = next_y
                outer &= y
            receipt("gr1", outer)
            if outer == z:
                break
            z = outer
        demand(all(offsets[k] == len(certificate[k]) for k in offsets), "Z3_CHECK_EXTRA_OR_TRUNCATED_ITERANTS")
        return sorted(kernel), sorted(z)

    def reach(self, starts, graph):
        seen, todo = set(), list(starts)
        while todo:
            v = todo.pop()
            self.tick()
            if v not in seen:
                seen.add(v)
                todo.extend(graph[v])
        return seen

    def scc(self, vertices, graph):
        # Tarjan on every induced vertex, not only recurrent bottom classes.
        number_at, low, stack, active, result = {}, {}, [], set(), []

        def visit(v):
            number_at[v] = low[v] = len(number_at)
            stack.append(v)
            active.add(v)
            for w in graph[v]:
                self.tick()
                if w not in vertices:
                    continue
                if w not in number_at:
                    visit(w)
                    low[v] = min(low[v], low[w])
                elif w in active:
                    low[v] = min(low[v], number_at[w])
            if low[v] == number_at[v]:
                group = set()
                while True:
                    w = stack.pop()
                    active.remove(w)
                    group.add(w)
                    if w == v:
                        break
                if len(group) > 1 or any(x in graph[x] for x in group):
                    result.append(group)
        for v in sorted(vertices):
            if v not in number_at:
                visit(v)
        return result

    def fair_prefixes(self, vertices, graph, assumptions, modulus):
        fair = set()
        for group in self.scc(vertices, graph):
            if all(any(v % modulus in assumption for v in group) for assumption in assumptions):
                fair |= group
        reverse = [[] for _ in graph]
        for v in vertices:
            for w in graph[v]:
                if w in vertices:
                    reverse[w].append(v)
        return self.reach(fair, reverse)

    def strategy(self, arena, candidate, states, successors, outgoing, assumptions, goals, region):
        strategy = exact(candidate["strategy"], "memories initial actions updates")
        memories = [{"a": a, "b": b} for a in range(len(assumptions)) for b in range(len(goals))]
        n, count = len(states), len(memories)
        demand(strategy["memories"] == memories and strategy["initial"] == [0] * n, "Z3_CHECK_MEMORY_INITIALIZATION")
        for key in ("actions", "updates"):
            demand(type(strategy[key]) is list and len(strategy[key]) == count
                   and all(type(row) is list and len(row) == n for row in strategy[key]), "Z3_CHECK_MEMORY_TOTALITY")
        graph = [[] for _ in range(n * count)]
        for m, memory in enumerate(memories):
            a, b = memory["a"], memory["b"]
            for v, state in enumerate(states):
                aa = (a + 1) % len(assumptions) if v in assumptions[a] else a
                bb = (b + 1) % len(goals) if v in goals[b] else b
                mm = aa * len(goals) + bb
                demand(type(strategy["updates"][m][v]) is int and strategy["updates"][m][v] == mm,
                       "Z3_CHECK_MEMORY_UPDATE")
                action = strategy["actions"][m][v]
                if state["owner"] == "E":
                    demand(type(action) is int and action == -1, "Z3_CHECK_ENVIRONMENT_CANNOT_BE_PRUNED")
                    targets = successors[v]
                else:
                    demand(type(action) is int and action in outgoing[v], "Z3_CHECK_ILLEGAL_CONTROLLER_ACTION")
                    targets = [next(i for i, s in enumerate(states) if s["id"] == arena["edges"][action]["to"])]
                graph[m * n + v] = [mm * n + w for w in targets]
        # Cover the entire complete ordinary region, not only convenient initials.
        region_reach = self.reach(region, graph)
        safety = all(states[v % n]["safe"] for v in region_reach)
        bad = []
        for j, goal in enumerate(goals):
            avoiding = {v for v in region_reach if v % n not in goal}
            for group in self.scc(avoiding, graph):
                if all(any(v % n in a for v in group) for a in assumptions):
                    bad.append({"goal": j, "vertices": sorted(group), "originalStates": sorted({v % n for v in group})})
        initial = [next(v for v, s in enumerate(states) if s["id"] == x) for x in arena["initial"]]
        initial_reach = self.reach(initial, graph)
        fair = self.fair_prefixes(initial_reach, graph, assumptions, n)
        original_fair = self.fair_prefixes(set(range(n)), successors, assumptions, n)
        return {"safety": safety, "liveness": not bad, "badSccs": bad,
                "reachable": len(initial_reach), "originalAssumptionsSatisfiable": all(v in original_fair for v in initial),
                "nonconflicting": initial_reach <= fair}


def safe_sha(value):
    try:
        return sha(value)
    except (ValueError, TypeError):
        return None


def check(request):
    checker = Checker()
    if type(request) is not dict:
        request = {}
    arena, binding = request.get("arena"), request.get("binding")
    candidate = request.get("candidate")
    base = {"schema": "finnor.z3.independent-check.v1", "status": "REJECTED", "reason": "Z3_CHECK_REJECTED",
            "arenaDigest": safe_sha(arena), "bindingDigest": safe_sha(binding),
            # Meter floats are deliberately outside the semantic candidate digest.
            "candidateDigest": safe_sha({k: v for k, v in candidate.items() if k != "metrics"}
                                        if type(candidate) is dict else candidate),
            "ordinaryComplete": False}
    if base["arenaDigest"] is None or base["bindingDigest"] is None or base["candidateDigest"] is None:
        base.update(status="UNSUPPORTED", reason="Z3_CHECK_NONFINITE_OR_MALFORMED_INPUT")
        return base
    try:
        states, index, successors, outgoing, assumptions, goals = original(arena, binding)
    except (Refusal, TypeError, ValueError, KeyError):
        base.update(status="UNSUPPORTED", reason="Z3_ORIGINAL_PROFILE_UNSUPPORTED")
        return base
    try:
        demand(type(candidate) is dict and candidate.get("schema") == "finnor.z3.viability-candidate.v1"
               and candidate.get("version") == VERSION, "Z3_CHECK_CANDIDATE_VERSION")
        demand(candidate.get("arenaDigest") == base["arenaDigest"] and candidate.get("bindingDigest") == base["bindingDigest"],
               "Z3_CHECK_ORIGINAL_OR_CURRENTNESS_BINDING")
        if candidate.get("disposition") in ("UNKNOWN", "UNSUPPORTED"):
            demand(candidate.get("certificate") is None and candidate.get("strategy") is None, "Z3_CHECK_INCOMPLETE_CLAIM")
            base.update(status="UNKNOWN", reason="Z3_PRODUCER_DID_NOT_SUPPLY_COMPLETE_EVIDENCE")
            return base
        exact(candidate, "schema version disposition arenaDigest bindingDigest safetyKernel winningRegion certificate strategy ordinaryStatus completeness metrics")
        demand(candidate["disposition"] == "COMPLETE"
               and candidate["completeness"] == "COMPLETE_ORDINARY_REGION_NOT_COMPLETE_NONCONFLICTING_SYNTHESIS",
               "Z3_CHECK_COMPLETENESS_SCOPE")
        kernel, region = checker.region(states, successors, assumptions, goals, candidate["certificate"])
        demand(candidate["safetyKernel"] == kernel and candidate["winningRegion"] == region, "Z3_CHECK_COMPLETE_REGION")
        ordinary = "WINNING" if all(index[x] in region for x in arena["initial"]) else "UNREALIZABLE"
        demand(candidate["ordinaryStatus"] == ordinary, "Z3_CHECK_REJECTED_STRATEGY_NOT_UNREALIZABILITY")
        base.update(ordinaryComplete=True, ordinaryStatus=ordinary)
        observed = checker.strategy(arena, candidate, states, successors, outgoing, assumptions, goals, region)
        base.update(observed)
        demand(observed["safety"], "Z3_CHECK_UNFAIR_PLAY_SAFETY_VIOLATION")
        demand(observed["liveness"], "Z3_CHECK_FAIR_BAD_CYCLIC_SCC")
        if ordinary == "UNREALIZABLE":
            base.update(status="UNREALIZABLE", reason="Z3_COMPLETE_ORDINARY_INITIAL_REGION_EXCLUSION")
        elif not observed["originalAssumptionsSatisfiable"] or not observed["nonconflicting"]:
            base.update(status="UNKNOWN", reason="Z3_NONCONFLICTING_SYNTHESIS_NOT_ESTABLISHED")
        else:
            base.update(status="VIABLE", reason="Z3_COMPLETE_ORDINARY_REGION_AND_CHECKED_NONCONFLICTING_STRATEGY")
    except BudgetExceeded as error:
        base.update(status="UNKNOWN", reason=str(error))
    except Refusal as error:
        base.update(status="REJECTED", reason=str(error))
    except (TypeError, ValueError, KeyError, IndexError, RecursionError, StopIteration):
        base.update(status="REJECTED", reason="Z3_CHECK_MALFORMED_OR_INCOMPLETE_CANDIDATE")
    finally:
        base["metrics"] = {"wallMs": (time.monotonic() - checker.started) * 1000, "operations": checker.operations}
    return base


def reject_constant(value):
    raise ValueError(f"Z3_CHECK_NONFINITE_LITERAL:{value}")


def malformed(reason, status="UNSUPPORTED"):
    return {"schema": "finnor.z3.independent-check.v1", "status": status, "reason": reason,
            "arenaDigest": None, "bindingDigest": None, "candidateDigest": None,
            "ordinaryComplete": False, "metrics": {"wallMs": 0.0, "operations": 0}}


def main():
    demand(sys.argv[1:] == ["--batch"], "Z3_CHECK_BATCH_PROTOCOL_REQUIRED")
    for count, line in enumerate(sys.stdin.buffer):
        # One output row per input row, so batch callers keep index alignment.
        # A malformed or oversized record never aborts the remaining records.
        if count >= 8192:
            print(json.dumps(malformed("Z3_CHECK_INPUT_BOUND"), separators=(",", ":")), flush=True)
            if count >= 65535:
                break
            continue
        if len(line) > MAX_BYTES + 1048576:
            print(json.dumps(malformed("Z3_CHECK_INPUT_BOUND"), separators=(",", ":")), flush=True)
            continue
        try:
            result = check(json.loads(line, parse_constant=reject_constant))
        except BudgetExceeded:
            result = malformed("Z3_CHECK_FINITE_BUDGET", status="UNKNOWN")
        except (ValueError, TypeError, UnicodeDecodeError, RecursionError):
            result = malformed("Z3_CHECK_MALFORMED_NDJSON")
        print(json.dumps(result, separators=(",", ":"), allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
