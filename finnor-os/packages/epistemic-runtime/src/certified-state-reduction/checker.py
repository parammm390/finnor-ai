#!/usr/bin/env python3
"""Independent original-byte information bisimulation validator.

No producer/partition/search/signature imports. This is an ordinary scientific
checker, not Ring-0 admission. Fractions, complete membership and direct
pairwise premises are checked independently of the producer's refinement.
"""
import hashlib
import json
import os
import re
import resource
import sys
import time
from datetime import datetime
from fractions import Fraction

VERSION = "r1-python-fraction-v1"
REQUIRED = ("rights", "pendingObservations", "maturity", "optionConditions",
            "exposureSchedules", "exposureLocks", "resources", "liquidity",
            "covenants", "humanUsed", "humanLimit", "computeUsed", "computeLimit",
            "staffing", "compensation", "employeeBenefits", "obligations",
            "accruedUtility", "terminalLiabilities", "terminalUtility", "stopped")
steps = 0
ceiling = 4000000
parent_pid = os.getppid()
deadline_at = None


class Refusal(Exception):
    def __init__(self, predicate, status="INCOMPLETE"):
        self.predicate = predicate
        self.status = status


def require(condition, predicate, status="UNSUPPORTED"):
    global steps
    steps += 1
    if os.getppid() != parent_pid:
        os._exit(74)
    if deadline_at is not None and time.time()*1000 >= deadline_at:
        raise Refusal("ORIGINAL_R1_DEADLINE", "INCOMPLETE")
    if steps > ceiling:
        raise Refusal("ORIGINAL_R1_STEP_BOUND", "INCOMPLETE")
    if not condition:
        raise Refusal(predicate, status)


def pairs(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out, "DUPLICATE_JSON_MEMBER")
        out[key] = value
    return out


def q(value, digits=128):
    require(isinstance(value, dict) and set(value) == {"numerator", "denominator"}, "RATIONAL_SOURCE_ENCODING")
    for item in value.values():
        require(isinstance(item, str) and len(item) <= digits and re.fullmatch(r"-?(0|[1-9][0-9]*)", item) is not None, "RATIONAL_SOURCE_ENCODING")
    require(int(value["denominator"]) > 0, "RATIONAL_DENOMINATOR")
    return Fraction(int(value["numerator"]), int(value["denominator"]))


def checked(value):
    require(len(str(value.numerator)) <= 512 and len(str(value.denominator)) <= 512, "RATIONAL_INTEGER_GROWTH_BOUND", "INCOMPLETE")
    return value


def wire(value):
    value = checked(value)
    return {"numerator": str(value.numerator), "denominator": str(value.denominator)}


def norm(value):
    if isinstance(value, list):
        return [norm(v) for v in value]
    if isinstance(value, dict):
        if "numerator" in value or "denominator" in value:
            return wire(q(value, 512))
        return {k: norm(v) for k, v in value.items()}
    require(not isinstance(value, float), "FLOAT64_SOURCE_NOT_EXACT")
    return value


def original_source(value, depth=0):
    require(depth <= 128, "ORIGINAL_SOURCE_STRUCTURE_BOUND")
    require(not isinstance(value, float) and (type(value) is not int or abs(value) <= 9007199254740991), "FLOAT64_SOURCE_NOT_EXACT")
    if isinstance(value, dict):
        if "numerator" in value or "denominator" in value:
            q(value)
        else:
            for item in value.values():
                original_source(item, depth+1)
    elif isinstance(value, list):
        for item in value:
            original_source(item, depth+1)


def owner_ref(value):
    return isinstance(value, dict) and all(isinstance(value.get(k), str) and 0 < len(value[k]) <= 256 for k in ("owner", "id", "version")) and isinstance(value.get("contentDigest"), str) and re.fullmatch(r"[a-f0-9]{64}", value["contentDigest"]) is not None


def key(value):
    # The ordering is explicitly UTF-16 code-unit order, matching the declared
    # wire canonicalization. Equality itself compares normalized structures.
    if isinstance(value, dict):
        return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + key(value[k]) for k in sorted(value, key=lambda x: x.encode("utf-16-be"))) + "}"
    if isinstance(value, list):
        return "[" + ",".join(key(v) for v in value) + "]"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def enabled(model, state):
    if state["period"] == model["horizon"]["periods"]:
        return []
    return [a["id"] for a in model["actions"]
            if (not state["semantics"]["stopped"] or a["kind"] == "STOP")
            and a["earliestPeriod"] <= state["period"] <= a["lastPeriod"]
            and (not a["atMostOnce"] or a["id"] not in state["history"])
            and all(i in state["history"] for i in a["precondition"]["afterActionIds"])
            and all(any(o["instrumentId"] == g["instrumentId"] and o["token"] in g["tokens"] for o in state["observations"])
                    for g in a["precondition"]["observations"])]


def label(model, state):
    relevant = {i for a in model["actions"] for i in ([a["id"]] if a["atMostOnce"] else []) + a["precondition"]["afterActionIds"]}
    return norm({"period": state["period"], "observations": state["observations"],
                 "worlds": state["worlds"], "semantics": state["semantics"],
                 "sufficientHistory": [{"actionId": a["id"], "occurred": a["id"] in state["history"]}
                                       for a in model["actions"] if a["id"] in relevant],
                 "enabled": enabled(model, state)})


def transitions(state, relation):
    result = []
    for action in state["transitions"]:
        grouped = {}
        for edge in action["outcomes"]:
            rest = {k: v for k, v in edge.items() if k not in ("successor", "mass")}
            rest["successorBlock"] = relation[edge["successor"]]
            rest = norm(rest)
            signature = key(rest)
            if signature not in grouped:
                grouped[signature] = [rest, Fraction(0)]
            grouped[signature][1] = checked(grouped[signature][1] + q(edge["mass"]))
        result.append({"actionId": action["actionId"], "outcomes":
                       [{"label": grouped[k][0], "mass": wire(grouped[k][1])}
                        for k in sorted(grouped, key=lambda x: x.encode("utf-16-be"))]})
    return result


def validate_original(model):
    original_source(model)
    require(model["schema"] == "finnor.s3.exact-information-model.v1"
            and model["profile"] == "finite-information-rational-v1"
            and model["encoding"] == {"kind": "EXACT_RATIONAL_SOURCE", "originalNumericModelRef": None}, "EXACT_SOURCE_PROFILE_REQUIRED")
    horizon = model["horizon"]["periods"]
    require(type(horizon) is int and 1 <= horizon <= 12 and type(model["horizon"]["periodMs"]) is int and model["horizon"]["periodMs"] > 0, "EXACT_ORIGINAL_HORIZON")
    require(1 <= len(model["states"]) <= 128 and 1 <= len(model["actions"]) <= 8, "FINITE_MODEL_CARDINALITY")
    worlds = model["uncertainty"]["worlds"]
    require(1 <= len(worlds) <= 512 and len(set(worlds)) == len(worlds), "COMPLETE_WORLD_SUPPORT_REQUIRED")
    require(model["uncertainty"]["kind"] in ("FIXED_COMPLETE_WORLDS", "EXACT_PROBABILITY_LAW"), "UNCERTAINTY_DOMAIN")
    dimensions = set(model["units"]["resources"])
    require(1 <= len(dimensions) <= 8 and len(model["economics"]["discountFactors"]) == horizon + 1 and q(model["economics"]["normalization"]) > 0, "EXACT_UNITS_OR_ACCOUNTING")
    require(1 <= len(model["sourceRefs"]) <= 128 and all(owner_ref(r) for r in model["sourceRefs"])
            and owner_ref(model["mandateRef"]) and 1 <= len(model["assumptions"]) <= 64
            and all(isinstance(a, str) and 0 < len(a) <= 2048 for a in model["assumptions"]), "EXACT_OWNER_BINDINGS")
    money = model["units"]["money"]
    require(owner_ref(money["discountConventionRef"]), "EXACT_OWNER_BINDINGS")
    require(re.fullmatch(r"[A-Z]{3}", money["currency"]) and money["unit"] == model["units"]["utility"]
            and money["timeBasis"] == "DECLARED_FINITE_PERIODS" and money["discountConventionRef"]
            and money["qualification"] == "SUPPLIED_OWNER_ASSERTION_UNADMITTED" and 0 <= q(money["ownerShare"]) <= 1,
            "COMPLETE_EXACT_MONEY_CONTEXT_REQUIRED")
    datetime.fromisoformat(money["valuationAt"].replace("Z", "+00:00"))
    actions = {a["id"]: a for a in model["actions"]}
    states = {s["id"]: s for s in model["states"]}
    require(len(actions) == len(model["actions"]) and len(states) == len(model["states"]), "DUPLICATE_STATE_OR_ACTION")
    require(model["roots"] and len(set(model["roots"])) == len(model["roots"]) and all(r in states for r in model["roots"]), "ROOT_MAPPING")
    instruments = {i["id"]: i for i in model["observationInstruments"]}
    require(len(instruments) == len(model["observationInstruments"]) <= 8, "OBSERVATION_DOMAIN")
    for instrument in instruments.values():
        require(instrument["rightsRef"] == model["rightsRef"] and type(instrument["delayPeriods"]) is int and 1 <= instrument["delayPeriods"] <= horizon
                and 1 <= len(instrument["tokens"]) <= 128 and len(set(instrument["tokens"])) == len(instrument["tokens"])
                and all(isinstance(t,str) and 0 < len(t) <= 256 for t in instrument["tokens"])
                and owner_ref(instrument["sourceRef"]) and len(instrument["afterActionIds"]) <= 8
                and all(a in actions for a in instrument["afterActionIds"]), "INSTRUMENT_RIGHTS_OR_DELAY")
        measurement = instrument.get("measurement")
        if measurement is not None:
            require(measurement["schema"] == "finnor.s2.exact-recorded-coarsening.v1" and isinstance(measurement["root"],dict)
                    and isinstance(measurement["seriesId"],str) and isinstance(measurement["unit"],str)
                    and 1 <= len(measurement["bins"]) <= 128
                    and len({b["token"] for b in measurement["bins"]}) == len(measurement["bins"])
                    and all(b["token"] in instrument["tokens"] and q(b["lowerInclusive"]) < q(b["upperExclusive"]) for b in measurement["bins"]), "EXACT_MEASUREMENT_COARSENING")
            require(all(q(a["upperExclusive"]) <= q(b["lowerInclusive"]) for a,b in zip(measurement["bins"],measurement["bins"][1:])), "OVERLAPPING_MEASUREMENT_BIN")
    for a in actions.values():
        require(a["kind"] in ("INQUIRE", "INTERVENE", "WAIT", "STOP")
                and type(a["atMostOnce"]) is bool and 0 <= a["earliestPeriod"] <= a["lastPeriod"] < horizon
                and a["costUnit"] == model["units"]["utility"] and 0 <= a["occupationPeriods"] <= horizon + 1, "EXACT_ACTION_CONTRACT")
        require(set(a["resources"]) == set(a["occupancy"]) == dimensions, "ACTION_RESOURCE_UNITS")
        for value in list(a["resources"].values()) + list(a["occupancy"].values()) + [a["cost"], a["tailLiability"], a["humanSeconds"]]:
            require(q(value) >= 0, "NEGATIVE_ACTION_DEMAND")
        require(all(i in actions for i in a["precondition"]["afterActionIds"]), "ACTION_GUARD_SOURCE")
        require(a["protocolRef"] is None or owner_ref(a["protocolRef"]), "ACTION_PROTOCOL_BINDING")
        for guard in a["precondition"]["observations"]:
            require(guard["instrumentId"] in instruments and all(t in instruments[guard["instrumentId"]]["tokens"] for t in guard["tokens"]), "ACTION_GUARD_SOURCE")
        if a["kind"] == "INQUIRE":
            require(a["protocolRef"] and a["protocolRef"]["id"] in instruments and instruments[a["protocolRef"]["id"]]["delayPeriods"] == a["informationDelayPeriods"], "INQUIRY_INSTRUMENT_REQUIRED")
    if model["uncertainty"]["kind"] == "FIXED_COMPLETE_WORLDS":
        require(model["uncertainty"]["lawRef"] is None and model["uncertainty"]["qualificationRef"] is None
                and model["uncertainty"]["worldWeights"] == {}, "FIXED_WORLD_PROBABILITY_RELABEL")
    else:
        weights = model["uncertainty"]["worldWeights"]
        require(owner_ref(model["uncertainty"]["lawRef"]) and (model["uncertainty"]["qualificationRef"] is None or owner_ref(model["uncertainty"]["qualificationRef"])) and set(weights) == set(worlds)
                and all(q(v) >= 0 for v in weights.values()) and sum((q(v) for v in weights.values()), Fraction(0)) == 1, "PROBABILITY_ROOT_MASS")
    information_keys = set()
    for state in states.values():
        require(type(state["period"]) is int and 0 <= state["period"] <= horizon
                and len(state["history"]) == state["period"] and all(i in actions for i in state["history"]), "COMPLETE_INFORMATION_STATE_REQUIRED")
        information = key([state["period"], state["history"], state["observations"]])
        require(information not in information_keys, "NON_MARKOV_CONTROLLER_INFORMATION")
        information_keys.add(information)
        semantics = state["semantics"]
        require(all(field in semantics for field in REQUIRED), "COMPLETE_INFORMATION_STATE_REQUIRED")
        require(state["worlds"] and len(set(state["worlds"])) == len(state["worlds"])
                and all(w in worlds for w in state["worlds"]), "COMPLETE_PER_WORLD_LABEL")
        require(semantics["rights"]["rightsRef"] == model["rightsRef"] and type(semantics["rights"]["revision"]) is int
                and semantics["rights"]["revision"] >= 0 and type(semantics["stopped"]) is bool, "STATE_RIGHTS_AND_PENDING_INFORMATION")
        for field in ("accruedUtility", "terminalUtility", "terminalLiabilities"):
            require(set(semantics[field]) == set(state["worlds"]), "COMPLETE_PER_WORLD_LABEL")
            for value in semantics[field].values():
                if value is not None:
                    q(value)
        resources = semantics["resources"]
        require(isinstance(resources["couplings"],list) and len(resources["couplings"]) <= 32, "COMPLETE_RESOURCE_OBLIGATION_STATE")
        for coupling in resources["couplings"]:
            require(isinstance(coupling["id"],str) and coupling["weights"] and set(coupling["weights"]) <= dimensions
                    and q(coupling["maximum"]) >= 0 and all(q(v) >= 0 for v in coupling["weights"].values()), "COUPLED_RESOURCE_DIMENSIONS")
        require(all(isinstance(v,list) and len(v) == horizon+1 for v in semantics["exposureSchedules"].values()), "EXACT_EXPOSURE_SCHEDULE")
        for world in state["worlds"]:
            use=resources["worldUse"][world]
            require(set(use["used"]) == set(use["occupancy"]) == dimensions and all(q(v) >= 0 for v in use["used"].values())
                    and q(use["humanUsed"]) >= 0 and q(use["computeUsed"]) >= 0, "WORLD_RESOURCE_DIMENSIONS")
            for dimension in dimensions:
                require(len(use["occupancy"][dimension]) == len(resources["occupancy"][dimension]) == horizon+1
                        and all(q(v) >= 0 for v in use["occupancy"][dimension] + resources["occupancy"][dimension]), "FULL_RESOURCE_OCCUPANCY_HORIZON")
        require(set(resources["worldUse"]) == set(state["worlds"]), "COMPLETE_PER_WORLD_LABEL")
        for field in ("capacity", "totalLimit", "used", "reserved"):
            require(set(resources[field]) == dimensions and all(q(v) >= 0 for v in resources[field].values()), "STATE_RESOURCE_DIMENSIONS")
        for field in ("humanUsed", "humanLimit", "computeUsed", "computeLimit"):
            require(q(semantics[field]) >= 0, "NEGATIVE_ATTENTION_OR_COMPUTE")
        for obligation in semantics["obligations"]:
            require(owner_ref(obligation["ref"]) and owner_ref(obligation["effectRef"]) and obligation["status"] in ("KNOWN_PENDING", "UNKNOWN", "PARTIAL", "SETTLED"), "S6_OBLIGATION_IDENTITY")
        for observed in state["observations"]:
            instrument = instruments.get(observed["instrumentId"])
            require(instrument and observed["token"] in instrument["tokens"] and instrument["id"] in semantics["rights"]["availableInstruments"]
                    and instrument["delayPeriods"] <= observed["availablePeriod"] <= state["period"]
                    and state["history"][observed["availablePeriod"]-instrument["delayPeriods"]] in instrument["afterActionIds"], "OBSERVATION_AVAILABILITY_OR_RIGHTS")
        for pending in semantics["pendingObservations"]:
            instrument = instruments.get(pending["instrumentId"])
            trigger = pending["availablePeriod"] - instrument["delayPeriods"] if instrument else -1
            require(instrument and state["period"] < pending["availablePeriod"] <= horizon
                    and pending["tokens"] and all(t in instrument["tokens"] for t in pending["tokens"])
                    and pending["sourceRef"] == instrument["sourceRef"] and 0 <= trigger < state["period"]
                    and state["history"][trigger] in instrument["afterActionIds"], "PENDING_OBSERVATION_SOURCE_OR_DELAY")
        require([a["actionId"] for a in state["transitions"]] == enabled(model, state), "COMPLETE_ADMISSIBLE_ACTION_CATALOGUE")
        for field in ("maturity", "optionConditions", "exposureLocks", "liquidity", "covenants", "staffing", "compensation", "employeeBenefits", "obligations"):
            require(isinstance(semantics[field], list), "COMPLETE_SEMANTIC_COLLECTION")
        norm(semantics)
    for state in states.values():
        for transition in state["transitions"]:
            action = actions[transition["actionId"]]
            masses = {w: Fraction(0) for w in state["worlds"]}
            child_worlds = {}
            require(transition["outcomes"], "COMPLETE_TRANSITION_SUPPORT")
            for edge in transition["outcomes"]:
                require(edge["successor"] in states and edge["worldId"] in masses, "WORLD_IDENTITY_TEMPORAL_OR_HISTORY_CLOSURE")
                child = states[edge["successor"]]
                require(child["period"] == state["period"] + 1 and child["history"] == state["history"] + [action["id"]]
                        and edge["worldId"] in child["worlds"], "WORLD_IDENTITY_TEMPORAL_OR_HISTORY_CLOSURE")
                mass = q(edge["mass"])
                require(mass >= 0, "NEGATIVE_TRANSITION_MASS")
                if model["uncertainty"]["kind"] == "FIXED_COMPLETE_WORLDS":
                    require(mass == 1, "FIXED_WORLD_TRANSITION_MASS")
                masses[edge["worldId"]] = checked(masses[edge["worldId"]] + mass)
                child_worlds.setdefault(child["id"], set()).add(edge["worldId"])
                require(norm(edge["resourceDelta"]) == norm(action["resources"]) and q(edge["humanDelta"]) == q(action["humanSeconds"])
                        and edge["obligations"] == child["semantics"]["obligations"] == state["semantics"]["obligations"], "ORIGINAL_ACTION_RESOURCE_OR_S6_OBLIGATION")
                require(q(edge["immediateUtility"]) == checked((q(edge["grossUtility"])-q(action["cost"]))*q(model["economics"]["discountFactors"][state["period"]])), "IMMEDIATE_ACCOUNTING_CONVENTION")
                world = edge["worldId"]
                debt, next_debt = state["semantics"]["terminalLiabilities"][world], child["semantics"]["terminalLiabilities"][world]
                require((debt is None) == (next_debt is None), "RETAINED_TERMINAL_LIABILITY")
                if debt is not None:
                    require(q(debt)+q(action["tailLiability"]) == q(next_debt), "RETAINED_TERMINAL_LIABILITY")
                    accrued = q(state["semantics"]["accruedUtility"][world]) + q(edge["immediateUtility"])
                    if child["period"] == horizon:
                        accrued += (q(child["semantics"]["terminalUtility"][world])-q(next_debt))*q(model["economics"]["discountFactors"][horizon])
                    require(checked(accrued) == q(child["semantics"]["accruedUtility"][world]), "COMPLETE_WORLD_ACCRUED_VALUE")
                before, after = state["semantics"]["resources"]["worldUse"][world], child["semantics"]["resources"]["worldUse"][world]
                require(set(before["used"]) == set(after["used"]) == dimensions, "WORLD_RESOURCE_DIMENSIONS")
                for dimension in dimensions:
                    require(q(before["used"][dimension])+q(edge["resourceDelta"][dimension]) == q(after["used"][dimension]), "WORLD_RESOURCE_PROPAGATION")
                    require(len(before["occupancy"][dimension]) == len(after["occupancy"][dimension]) == len(edge["occupancyDelta"][dimension]) == horizon+1, "TRANSITION_OCCUPANCY_HORIZON")
                    for period in range(horizon+1):
                        increment = q(action["occupancy"][dimension]) if state["period"] <= period < state["period"]+action["occupationPeriods"] else Fraction(0)
                        require(q(edge["occupancyDelta"][dimension][period]) == increment
                                and q(before["occupancy"][dimension][period])+increment == q(after["occupancy"][dimension][period]), "EXACT_OCCUPANCY_PROPAGATION")
                require(q(before["humanUsed"])+q(action["humanSeconds"]) == q(after["humanUsed"])
                        and q(before["computeUsed"]) == q(after["computeUsed"]), "HUMAN_OR_COMPUTE_PROPAGATION")
                require(child["semantics"]["stopped"] == (state["semantics"]["stopped"] or action["kind"] == "STOP"), "STOP_LIFECYCLE")
                for observed in state["observations"]:
                    require(observed in child["observations"], "OBSERVATION_HISTORY_DROPPED")
                for observed in child["observations"]:
                    if observed in state["observations"]:
                        continue
                    instrument = instruments[observed["instrumentId"]]
                    pending = any(p["instrumentId"] == observed["instrumentId"] and p["availablePeriod"] == child["period"] and observed["token"] in p["tokens"] for p in state["semantics"]["pendingObservations"])
                    require(pending or action["id"] in instrument["afterActionIds"] and instrument["delayPeriods"] == 1 and observed["availablePeriod"] == child["period"], "UNAUTHORIZED_NEW_OBSERVATION")
                for pending in state["semantics"]["pendingObservations"]:
                    if pending["availablePeriod"] > child["period"]:
                        require(pending in child["semantics"]["pendingObservations"], "PENDING_OBSERVATION_DROPPED")
                    elif pending["availablePeriod"] == child["period"]:
                        require(any(o["instrumentId"] == pending["instrumentId"] and o["availablePeriod"] == child["period"] and o["token"] in pending["tokens"] for o in child["observations"]), "PENDING_OBSERVATION_DELIVERY")
            require(all(v == 1 for v in masses.values()), "COMPLETE_TRANSITION_MASS")
            for child, support in child_worlds.items():
                require(support == set(states[child]["worlds"]), "SUCCESSOR_INFORMATION_WORLD_SUPPORT")
    return states


def check(model_bytes, candidate):
    require(len(model_bytes.encode("utf-8")) <= 2*1024*1024, "ORIGINAL_MODEL_BYTE_BOUND")
    model = json.loads(model_bytes, object_pairs_hook=pairs)
    states = validate_original(model)
    require(candidate["schema"] == "finnor.control-quotient.v1" and candidate["producerVersion"] == "r1-native-refinement-v1"
            and candidate["profile"] == model["profile"] and candidate["modelDigest"] == hashlib.sha256(model_bytes.encode()).hexdigest(), "ORIGINAL_BYTES_VERSION_BINDING", "INCOMPLETE")
    blocks = candidate["blocks"]
    members = [member for block in blocks for member in block["members"]]
    require(blocks and all(block["members"] for block in blocks) and len(members) == len(states)
            and len(set(members)) == len(members) and set(members) == set(states), "RELATION_MEMBER_COVERAGE", "INCOMPLETE")
    require(len(set(b["id"] for b in blocks)) == len(blocks), "RELATION_BLOCK_IDENTITY", "INCOMPLETE")
    relation = {member: b["id"] for b in blocks for member in b["members"]}
    require(candidate["stateToBlock"] == relation and candidate["roots"] == [relation[r] for r in model["roots"]], "ROOT_OR_RELATION_MAP", "INCOMPLETE")
    for block in blocks:
        original_label = label(model, states[block["members"][0]])
        original_edges = transitions(states[block["members"][0]], relation)
        require(norm(block["label"]) == original_label and norm(block["transitions"]) == original_edges, "QUOTIENT_ORIGINAL_LABEL_OR_EDGE", "INCOMPLETE")
        for member in block["members"]:
            require(label(model, states[member]) == original_label, "EQUIVALENCE_FULL_INFORMATION_LABEL", "INCOMPLETE")
            require(transitions(states[member], relation) == original_edges, "EQUIVALENCE_WORLD_SUCCESSOR_OR_MASS", "INCOMPLETE")
    lifts = candidate["lift"]
    require(len(lifts) == len(states) and len(set(x["stateId"] for x in lifts)) == len(states), "COMPLETE_LIFT_COVERAGE", "INCOMPLETE")
    for lift in lifts:
        original = states.get(lift["stateId"])
        require(original and lift == {"stateId": original["id"], "blockId": relation[original["id"]],
                                     "period": original["period"], "history": original["history"], "observations": original["observations"]}, "ORIGINAL_INFORMATION_LIFT", "INCOMPLETE")
    require(candidate["witness"]["kind"] == "COMPLETE_LABELLED_INFORMATION_BISIMULATION"
            and candidate["witness"]["checkedStates"] == len(states)
            and candidate["witness"]["qualification"] == "SUPPLIED_MODEL_RELATIVE_NO_AUTHORITY", "EQUIVALENCE_CLAIM_SCOPE", "INCOMPLETE")


if __name__ == "__main__":
    started = time.monotonic()
    request = None
    status, predicate = "UNKNOWN", "CHECKER_PROTOCOL"
    try:
        raw = sys.stdin.buffer.read(8*1024*1024+1)
        require(len(raw) <= 8*1024*1024, "CHECKER_TRANSPORT_BYTE_BOUND")
        request = json.loads(raw, object_pairs_hook=pairs)
        ceiling = request["maxSteps"]
        deadline_at = request["deadlineAt"]
        require(type(deadline_at) is int and deadline_at > 0, "ORIGINAL_R1_BUDGET_REQUIRED")
        require(type(ceiling) is int and 1 <= ceiling <= 4000000, "ORIGINAL_R1_BUDGET_REQUIRED")
        check(request["modelBytes"], request["candidate"])
        status, predicate = "COMPLETE", "COMPLETE_ORIGINAL_INFORMATION_BISIMULATION"
    except Refusal as error:
        status, predicate = error.status, error.predicate
    except (KeyError, TypeError, ValueError, IndexError, AttributeError, OverflowError):
        status, predicate = "UNSUPPORTED", "INCOMPLETE_OR_UNSUPPORTED_ORIGINAL_CONTRACT"
    executable = os.path.realpath(sys.executable)
    with open(executable, "rb") as binary:
        executable_digest = hashlib.file_digest(binary, "sha256").hexdigest() if hasattr(hashlib, "file_digest") else hashlib.sha256(binary.read()).hexdigest()
    usage = resource.getrusage(resource.RUSAGE_SELF)
    result = {"schema": "finnor.r1.independent-check.v1", "checkerVersion": VERSION, "status": status, "predicate": predicate,
              "modelDigest": hashlib.sha256((request or {}).get("modelBytes", "").encode()).hexdigest(),
              "candidateDigest": hashlib.sha256((request or {}).get("candidateBytes", "").encode()).hexdigest(),
              "checkerDigest": hashlib.sha256(open(__file__, "rb").read()).hexdigest(),
              "profile": "finite-information-rational-v1", "relationComplete": status == "COMPLETE",
              "probabilityLawQualified": False, "causalQualification": "UNQUALIFIED", "executionAuthorityGranted": False,
              "steps": steps, "pythonVersion": sys.version, "elapsedMs": (time.monotonic()-started)*1000,
              "physical": {"pid": os.getpid(), "parentPid": parent_pid, "executable": executable, "executableDigest": executable_digest,
                           "cpuUserMicros": round(usage.ru_utime*1000000), "cpuSystemMicros": round(usage.ru_stime*1000000),
                           "maxRssNative": usage.ru_maxrss, "maxRssUnit": "PLATFORM_NATIVE", "platform": sys.platform,
                           "aggregateSimultaneousPeakKnown": False, "usd": None}}
    print(json.dumps(result, separators=(",", ":")))
