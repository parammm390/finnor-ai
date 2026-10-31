#!/usr/bin/env python3
"""Versioned finite-memory adapter over the UNCHANGED original checker.

Original parsing, ordinary certificate replay and all-cyclic-SCC semantics
remain original code. The new certificate is replayed with Python sets, not
producer ranks/bitsets. Native execution injects captured, approved original
bytes as _original_checker; standalone process E2E verifies the adjacent core.
"""
import hashlib
import json
import pathlib
import sys
import time
import types

if "_original_checker" not in globals():
    original_path = pathlib.Path(__file__).resolve().with_name("checker.py")
    with original_path.open("rb") as original_file:
        original_bytes = original_file.read(8388609)
    if hashlib.sha256(original_bytes).hexdigest() != "b71c0bec3be5eb1e6218e4b04a26bf07918a3f781e5712800a8ff061497e837e":
        raise RuntimeError("Z3_ORIGINAL_CHECKER_NOT_APPROVED")
    _original_checker = types.ModuleType("finnor_z3_original_checker")
    exec(compile(original_bytes, "<approved-original-checker>", "exec"), _original_checker.__dict__)

original = _original_checker
VERSION = "z3-public-nonconflicting-v2"


def complete_nonconflicting(checker, states, successors, assumptions, goals, kernel, transcript):
    original.demand(type(transcript) is list and len(transcript) <= original.MAX_ITERANTS,
                    "Z3_CHECK_NONCONFLICTING_TRANSCRIPT_BOUND")
    position = 0

    def receipt(values):
        nonlocal position
        checker.iterants += 1
        checker.tick()
        if checker.iterants > original.MAX_ITERANTS:
            raise original.BudgetExceeded("Z3_CHECK_TOTAL_ITERANT_BOUND")
        encoded = format(sum(1 << v for v in values), "x")
        original.demand(position < len(transcript) and type(transcript[position]) is str
                        and transcript[position] == encoded, "Z3_CHECK_NONCONFLICTING_ITERANT_MISMATCH")
        position += 1

    def predecessor(target):
        result = set()
        for v, state in enumerate(states):
            checker.tick(len(successors[v]) + 1)
            if any(w in target for w in successors[v]) if state["owner"] == "C" else all(w in target for w in successors[v]):
                result.add(v)
        return result

    def conditional(target, escape):
        result, permitted = set(), target | escape
        for v, state in enumerate(states):
            checker.tick(len(successors[v]) + 1)
            if any(w in target for w in successors[v]) and (
                    state["owner"] == "C" or all(w in permitted for w in successors[v])):
                result.add(v)
        return result

    # Including assumptions among chased goals establishes the theorem's
    # goal-implies-assumption premise without changing A => B on originals.
    joint_goals = []
    for goal in goals + assumptions:
        if goal not in joint_goals:
            joint_goals.append(goal)
    z = [set(kernel) for _ in joint_goals]
    for values in z:
        receipt(values)
    while True:
        outer = []
        for g, goal in enumerate(joint_goals):
            goal_return = goal & predecessor(z[(g + 1) % len(z)])
            y = set()
            receipt(y)
            while True:
                base, next_y = goal_return | predecessor(y), set()
                for assumption in assumptions:
                    x = set(kernel)
                    receipt(x)
                    while True:
                        w = set()
                        receipt(w)
                        while True:
                            next_w = set(kernel) & (base | ((set(kernel) - assumption) & conditional(w, x - assumption)))
                            receipt(next_w)
                            if next_w == w:
                                break
                            w = next_w
                        receipt(w)
                        if w == x:
                            break
                        x = w
                    next_y |= x
                receipt(next_y)
                if next_y == y:
                    break
                y = next_y
            outer.append(y)
        for values in outer:
            receipt(values)
        if outer == z:
            break
        z = outer
    original.demand(position == len(transcript), "Z3_CHECK_EXTRA_NONCONFLICTING_ITERANTS")
    original.demand(all(values == z[0] for values in z), "Z3_CHECK_NONCONFLICTING_PHASE_REGIONS")
    return sorted(z[0]), joint_goals


def strategy_graph(checker, arena, strategy, states, successors, outgoing, assumptions, joint_goals):
    original.exact(strategy, "memories initial actions updates")
    n = len(states)
    # Only the chased-goal phase is memory. The producer's least assumption
    # rank is state-derived; the graph checker does not trust that extraction.
    memories = [{"a": 0, "b": b} for b in range(len(joint_goals))]
    count = len(memories)
    original.demand(1 <= count <= 4 and n * count <= 1024, "Z3_CHECK_NONCONFLICTING_PRODUCT_BOUND")
    original.demand(type(strategy["memories"]) is list and len(strategy["memories"]) == count
                    and all(type(memory) is dict and set(memory) == {"a", "b"}
                            and type(memory["a"]) is int and type(memory["b"]) is int
                            for memory in strategy["memories"])
                    and strategy["memories"] == memories
                    and type(strategy["initial"]) is list and len(strategy["initial"]) == n
                    and all(type(memory) is int and memory == 0 for memory in strategy["initial"]),
                    "Z3_CHECK_NONCONFLICTING_MEMORY_INITIALIZATION")
    for key in ("actions", "updates"):
        original.demand(type(strategy[key]) is list and len(strategy[key]) == count
                        and all(type(row) is list and len(row) == n for row in strategy[key]),
                        "Z3_CHECK_NONCONFLICTING_MEMORY_TOTALITY")
    index = {state["id"]: v for v, state in enumerate(states)}
    graph = []
    for m in range(count):
        for v, state in enumerate(states):
            checker.tick(len(successors[v]) + 1)
            mm, action = strategy["updates"][m][v], strategy["actions"][m][v]
            original.demand(type(mm) is int and 0 <= mm < count, "Z3_CHECK_NONCONFLICTING_MEMORY_UPDATE")
            if state["owner"] == "E":
                original.demand(type(action) is int and action == -1, "Z3_CHECK_ENVIRONMENT_CANNOT_BE_PRUNED")
                targets = successors[v]
            else:
                original.demand(type(action) is int and action in outgoing[v], "Z3_CHECK_ILLEGAL_CONTROLLER_ACTION")
                targets = [index[arena["edges"][action]["to"]]]
            graph.append([mm * n + w for w in targets])
    return graph


def check(request):
    if type(request) is not dict:
        request = {}
    candidate = request.get("candidate")
    if type(candidate) is dict and candidate.get("schema") == "finnor.z3.viability-candidate.v1":
        return original.check(request)
    checker = original.Checker()
    arena, binding = request.get("arena"), request.get("binding")
    base = {"schema": "finnor.z3.independent-check.v1", "status": "REJECTED",
            "reason": "Z3_CHECK_REJECTED", "arenaDigest": original.safe_sha(arena),
            "bindingDigest": original.safe_sha(binding),
            "candidateDigest": original.safe_sha({k: v for k, v in candidate.items() if k != "metrics"}
                                                  if type(candidate) is dict else candidate),
            "ordinaryComplete": False, "nonconflictingComplete": False}
    if any(base[key] is None for key in ("arenaDigest", "bindingDigest", "candidateDigest")):
        base.update(status="UNSUPPORTED", reason="Z3_CHECK_NONFINITE_OR_MALFORMED_INPUT")
        return base
    try:
        states, index, successors, outgoing, assumptions, goals = original.original(arena, binding)
    except (original.Refusal, TypeError, ValueError, KeyError):
        base.update(status="UNSUPPORTED", reason="Z3_ORIGINAL_PROFILE_UNSUPPORTED")
        return base
    try:
        original.exact(candidate, "schema version disposition arenaDigest bindingDigest safetyKernel winningRegion certificate strategy ordinaryStatus completeness nonconflicting metrics")
        original.demand(candidate["schema"] == "finnor.z3.viability-candidate.v2"
                        and candidate["version"] == VERSION and candidate["disposition"] == "COMPLETE"
                        and candidate["completeness"] == "COMPLETE_NONCONFLICTING_REGION",
                        "Z3_CHECK_NONCONFLICTING_VERSION_OR_SCOPE")
        original.demand(len(json.dumps(candidate, separators=(",", ":"), ensure_ascii=False).encode()) <= original.MAX_BYTES,
                        "Z3_CHECK_CANDIDATE_BYTE_BOUND")
        original.demand(candidate["arenaDigest"] == base["arenaDigest"]
                        and candidate["bindingDigest"] == base["bindingDigest"],
                        "Z3_CHECK_ORIGINAL_OR_CURRENTNESS_BINDING")
        proof = original.exact(candidate["nonconflicting"], "region certificate ordinaryStrategy")
        for values in (candidate["safetyKernel"], candidate["winningRegion"], proof["region"]):
            original.demand(type(values) is list and len(values) <= len(states)
                            and all(type(v) is int and 0 <= v < len(states) for v in values),
                            "Z3_CHECK_NONCONFLICTING_REGION_INDEX_FORMAT")
        kernel, region = checker.region(states, successors, assumptions, goals, candidate["certificate"])
        original.demand(candidate["safetyKernel"] == kernel and candidate["winningRegion"] == region,
                        "Z3_CHECK_COMPLETE_REGION")
        ordinary_status = "WINNING" if all(index[x] in region for x in arena["initial"]) else "UNREALIZABLE"
        original.demand(candidate["ordinaryStatus"] == ordinary_status, "Z3_CHECK_REJECTED_STRATEGY_NOT_UNREALIZABILITY")
        # Reuse original verification, sharing ONE total operation/time/iterant
        # budget. A conflicting ordinary policy is not a nonconflicting witness.
        observed_ordinary = checker.strategy(arena, {"strategy": proof["ordinaryStrategy"]}, states,
                                             successors, outgoing, assumptions, goals, region)
        original.demand(observed_ordinary["safety"], "Z3_CHECK_UNFAIR_PLAY_SAFETY_VIOLATION")
        original.demand(observed_ordinary["liveness"], "Z3_CHECK_FAIR_BAD_CYCLIC_SCC")
        base.update(ordinaryComplete=True, ordinaryStatus=ordinary_status)
        nc_region, joint_goals = complete_nonconflicting(checker, states, successors, assumptions, goals,
                                                        kernel, proof["certificate"])
        original.demand(proof["region"] == nc_region and set(nc_region) <= set(region),
                        "Z3_CHECK_COMPLETE_NONCONFLICTING_REGION")
        graph = strategy_graph(checker, arena, candidate["strategy"], states, successors,
                               outgoing, assumptions, joint_goals)
        n = len(states)
        reachable = checker.reach(nc_region, graph)
        safety = all(states[v % n]["safe"] for v in reachable)
        bad = []
        for j, goal in enumerate(goals):
            avoiding = {v for v in reachable if v % n not in goal}
            for group in checker.scc(avoiding, graph):
                if all(any(v % n in assumption for v in group) for assumption in assumptions):
                    bad.append({"goal": j, "vertices": sorted(group),
                                "originalStates": sorted({v % n for v in group})})
        fair = checker.fair_prefixes(reachable, graph, assumptions, n)
        initial = [index[value] for value in arena["initial"]]
        original_fair = checker.fair_prefixes(set(range(n)), successors, assumptions, n)
        original.demand(safety, "Z3_CHECK_UNFAIR_PLAY_SAFETY_VIOLATION")
        original.demand(not bad, "Z3_CHECK_FAIR_BAD_CYCLIC_SCC")
        original.demand(reachable <= fair, "Z3_CHECK_NONCONFLICTING_STRATEGY_FAIR_PREFIX")
        winning = all(v in nc_region for v in initial)
        satisfiable = all(v in original_fair for v in initial)
        original.demand(not winning or satisfiable, "Z3_CHECK_NONCONFLICTING_ORIGINAL_NONVACUITY")
        base.update(nonconflictingComplete=True, nonconflictingRegion=nc_region,
                    nonconflictingStatus="WINNING" if winning else "UNREALIZABLE",
                    originalAssumptionsSatisfiable=satisfiable, nonconflicting=winning,
                    safety=safety, liveness=not bad, reachable=len(reachable), badSccs=bad,
                    checkedStrategyScope="COMPLETE_NONCONFLICTING_REGION")
        base.update(status="VIABLE" if winning else "UNREALIZABLE",
                    reason="Z3_COMPLETE_CHECKED_NONCONFLICTING_REGION_AND_STRATEGY" if winning
                    else "Z3_COMPLETE_NONCONFLICTING_INITIAL_REGION_EXCLUSION")
    except original.BudgetExceeded as error:
        base.update(status="UNKNOWN", reason=str(error))
    except original.Refusal as error:
        base.update(status="REJECTED", reason=str(error))
    except (TypeError, ValueError, KeyError, IndexError, RecursionError, StopIteration):
        base.update(status="REJECTED", reason="Z3_CHECK_MALFORMED_OR_INCOMPLETE_CANDIDATE")
    finally:
        base["metrics"] = {"wallMs": (time.monotonic() - checker.started) * 1000,
                           "operations": checker.operations}
    return base


def main():
    original.demand(sys.argv[1:] == ["--batch"], "Z3_CHECK_BATCH_PROTOCOL_REQUIRED")
    for count, line in enumerate(sys.stdin.buffer):
        if count >= 8192 or len(line) > original.MAX_BYTES + 1048576:
            result = original.malformed("Z3_CHECK_INPUT_BOUND")
        else:
            try:
                result = check(json.loads(line, parse_constant=original.reject_constant))
            except (ValueError, TypeError, UnicodeDecodeError, RecursionError):
                result = original.malformed("Z3_CHECK_MALFORMED_NDJSON")
        print(json.dumps(result, separators=(",", ":"), allow_nan=False), flush=True)
        if count >= 65535:
            break


if __name__ == "__main__":
    main()
