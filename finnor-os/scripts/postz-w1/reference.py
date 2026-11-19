#!/usr/bin/env python3
"""Independent original-byte oracle. No producer/checker imports or output inputs."""
import argparse
import hashlib
import json
import re
from fractions import Fraction
from decimal import Decimal, InvalidOperation
from pathlib import Path


def fail(reason):
    raise ValueError(reason)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("DUPLICATE_JSON_KEY:" + key)
        result[key] = value
    return result


def keys(value, expected):
    if not isinstance(value, dict) or set(value) != set(expected.split()):
        fail("INVALID_FIELDS:" + str(expected))


def strings(values):
    if not isinstance(values, list) or any(not isinstance(x, str) or not x for x in values):
        fail("INVALID_STRING_LIST")
    if len(values) != len(set(values)):
        fail("DUPLICATE_IDENTITY")


def quantity(token):
    if not isinstance(token, str) or len(token) > 1025:
        fail("INVALID_RATIONAL")
    if not re.fullmatch(r"[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:/[1-9]\d*)?", token):
        fail("INVALID_RATIONAL")
    if "/" in token and "." in token:
        fail("INVALID_RATIONAL")
    result = Fraction(token)
    if len(str(abs(result.numerator))) > 512 or len(str(result.denominator)) > 512:
        fail("UNSUPPORTED_RATIONAL_PRECISION")
    return result


def vector(value, dimensions):
    if not isinstance(value, dict) or set(value) != dimensions:
        fail("RESOURCE_DIMENSIONS")
    result = {k: quantity(v) for k, v in value.items()}
    if any(v < 0 for v in result.values()):
        fail("NEGATIVE_RESOURCE")
    return result


def integer_token(token):
    try:
        value = Decimal(token)
        if not value.is_finite() or value.copy_abs() > 9007199254740991 or value != value.to_integral_value():
            fail("FLOAT64_SOURCE_NOT_EXACT")
        return int(value)
    except InvalidOperation:
        fail("FLOAT64_SOURCE_NOT_EXACT")


def solve(original):
    if len(original) > 2 * 1024 * 1024:
        fail("UNSUPPORTED_INPUT_BYTE_BOUND")
    model = json.loads(original, object_pairs_hook=unique_object,
                       parse_int=integer_token, parse_float=integer_token,
                       parse_constant=lambda x: fail("NONFINITE_JSON:" + x))
    keys(model, "schema id binding utilityUnit rootStateId maxDecisions tieOrder states")
    if model["schema"] != "finnor.metalevel-model.v1":
        fail("SCHEMA")
    keys(model["binding"], "tenantId principalId workId outcomeRef mandateRef sourceRef rightsRef catalogueRef responseRef modelRef priceRef checkerRef runtimeRef parentGrantRef deadline")
    if any(not isinstance(v, str) or not v for v in model["binding"].values()):
        fail("BINDING")
    if not isinstance(model["utilityUnit"], str) or not model["utilityUnit"]:
        fail("UTILITY_UNIT")
    if type(model["maxDecisions"]) is not int or not 0 <= model["maxDecisions"] <= 8:
        fail("UNSUPPORTED_DECISION_BOUND")
    rows = model["states"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= 64:
        fail("UNSUPPORTED_STATE_BOUND")
    states = {}
    choices = set()
    for state in rows:
        keys(state, "id decisionIndex history remaining obligations requiredChecks completedChecks acceptanceRef choices")
        if not isinstance(state["id"], str) or not state["id"] or state["id"] in states:
            fail("STATE_IDENTITY")
        states[state["id"]] = state
    if model["rootStateId"] not in states or states[model["rootStateId"]]["decisionIndex"] != 0:
        fail("ROOT")
    dimensions = set(rows[0]["remaining"])
    if not dimensions:
        fail("EMPTY_RESOURCES")
    for state in rows:
        depth = state["decisionIndex"]
        if type(depth) is not int or not 0 <= depth <= model["maxDecisions"]:
            fail("STATE_HORIZON")
        if not isinstance(state["history"], list) or len(state["history"]) != depth:
            fail("INCOMPLETE_HISTORY")
        for event in state["history"]:
            keys(event, "choiceId observation")
            if any(not isinstance(v, str) or not v for v in event.values()):
                fail("HISTORY_TOKEN")
        remaining = vector(state["remaining"], dimensions)
        strings(state["requiredChecks"])
        strings(state["completedChecks"])
        if state["acceptanceRef"] is not None and (not isinstance(state["acceptanceRef"], str) or not state["acceptanceRef"]):
            fail("ACCEPTANCE_REF")
        obligations = {}
        if not isinstance(state["obligations"], list):
            fail("OBLIGATIONS")
        for obligation in state["obligations"]:
            keys(obligation, "id status resolutionRef")
            if not isinstance(obligation["id"], str) or not obligation["id"] or obligation["id"] in obligations:
                fail("OBLIGATION_IDENTITY")
            if obligation["status"] not in ("PENDING", "UNKNOWN", "RESOLVED"):
                fail("OBLIGATION_STATUS")
            if obligation["status"] == "RESOLVED" and not obligation["resolutionRef"]:
                fail("RESOLUTION_REQUIRED")
            if obligation["status"] != "RESOLVED" and obligation["resolutionRef"] is not None:
                fail("UNRESOLVED_RECEIPT")
            obligations[obligation["id"]] = obligation
        available = state["choices"]
        if not isinstance(available, list) or not 1 <= len(available) <= 17:
            fail("UNSUPPORTED_CHOICE_BOUND")
        local_ids = set()
        stop_count = 0
        for choice in available:
            if not isinstance(choice, dict) or not isinstance(choice.get("id"), str) or not choice["id"]:
                fail("CHOICE_IDENTITY")
            if choice["id"] in local_ids:
                fail("DUPLICATE_CHOICE")
            local_ids.add(choice["id"])
            choices.add(choice["id"])
            if choice.get("kind") == "STOP":
                keys(choice, "id kind utility disposition resultRef")
                quantity(choice["utility"])
                stop_count += 1
                if choice["disposition"] not in ("ACCEPTED", "INCOMPLETE", "UNKNOWN", "ESCALATE"):
                    fail("STOP_DISPOSITION")
                if choice["resultRef"] is not None and (not isinstance(choice["resultRef"], str) or not choice["resultRef"]):
                    fail("STOP_RESULT")
                if choice["disposition"] == "ACCEPTED":
                    if not choice["resultRef"] or not state["acceptanceRef"] or set(state["requiredChecks"]) - set(state["completedChecks"]):
                        fail("UNSAFE_ACCEPTED_STOP")
                    if any(o["status"] != "RESOLVED" for o in obligations.values()):
                        fail("UNRESOLVED_ACCEPTED_STOP")
                continue
            if choice.get("kind") != "COMPUTE" or depth >= model["maxDecisions"]:
                fail("COMPUTATION_HORIZON")
            keys(choice, "id kind computationRef contextRefs dependsOn verifierRefs utilityCost reservation outcomes")
            if not isinstance(choice["computationRef"], str) or not choice["computationRef"]:
                fail("COMPUTATION_REF")
            for name in ("contextRefs", "dependsOn", "verifierRefs"):
                strings(choice[name])
            if any(dependency not in {event["choiceId"] for event in state["history"]} for dependency in choice["dependsOn"]):
                fail("UNMET_DEPENDENCY")
            if quantity(choice["utilityCost"]) < 0:
                fail("NEGATIVE_COST")
            reserve = vector(choice["reservation"], dimensions)
            if any(reserve[d] > remaining[d] for d in dimensions):
                fail("UNAFFORDABLE_RESERVATION")
            outcomes = choice["outcomes"]
            if not isinstance(outcomes, list) or not outcomes:
                fail("OUTCOMES")
            tokens = set()
            probability = Fraction(0)
            invalid = 0
            for outcome in outcomes:
                keys(outcome, "observation kind probability utilityDelta consumption nextStateId")
                token = outcome["observation"]
                if not isinstance(token, str) or not token or token in tokens:
                    fail("OBSERVATION_IDENTITY")
                tokens.add(token)
                p = quantity(outcome["probability"])
                if p < 0:
                    fail("NEGATIVE_PROBABILITY")
                probability += p
                quantity(outcome["utilityDelta"])
                if outcome["kind"] not in ("VALID", "INVALID"):
                    fail("OBSERVATION_KIND")
                invalid += outcome["kind"] == "INVALID"
                consumed = vector(outcome["consumption"], dimensions)
                if any(consumed[d] > reserve[d] for d in dimensions):
                    fail("RESERVATION_EXCEEDED")
                successor = states.get(outcome["nextStateId"])
                if successor is None or successor["decisionIndex"] != depth + 1:
                    fail("SUCCESSOR_HORIZON")
                if successor["history"] != state["history"] + [{"choiceId": choice["id"], "observation": token}]:
                    fail("SUCCESSOR_HISTORY")
                after = vector(successor["remaining"], dimensions)
                if any(after[d] != remaining[d] - consumed[d] for d in dimensions):
                    fail("RESOURCE_CONSERVATION")
                subsequent = {o["id"]: o for o in successor["obligations"]}
                if set(obligations) - set(subsequent):
                    fail("ERASED_OBLIGATION")
                for identity, before in obligations.items():
                    after_obligation = subsequent[identity]
                    if before["status"] == "RESOLVED" and after_obligation != before:
                        fail("ALTERED_RESOLVED_OBLIGATION")
            if invalid != 1 or probability != 1:
                fail("INVALID_OBSERVATION_OR_PROBABILITY_MASS")
        if not stop_count:
            fail("EXPLICIT_STOP_REQUIRED")
    strings(model["tieOrder"])
    if set(model["tieOrder"]) != choices:
        fail("TOTAL_TIE_ORDER_REQUIRED")
    order = {identity: index for index, identity in enumerate(model["tieOrder"])}
    values = {}
    result = {}
    for state in sorted(rows, key=lambda x: -x["decisionIndex"]):
        alternatives = {}
        for choice in state["choices"]:
            if choice["kind"] == "STOP":
                value = quantity(choice["utility"])
            else:
                value = -quantity(choice["utilityCost"])
                for outcome in choice["outcomes"]:
                    value += quantity(outcome["probability"]) * (
                        quantity(outcome["utilityDelta"]) + values[outcome["nextStateId"]])
            alternatives[choice["id"]] = value
        best = max(alternatives.values())
        ties = sorted((k for k, v in alternatives.items() if v == best), key=order.get)
        values[state["id"]] = best
        result[state["id"]] = {
            "value": str(best), "selectedChoiceId": ties[0], "optimalChoiceIds": ties,
            "choiceValues": {k: str(v) for k, v in alternatives.items()}}
    return {"modelSha256": hashlib.sha256(original).hexdigest(),
            "rootStateId": model["rootStateId"], "states": result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("model", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(solve(args.model.read_bytes()), sort_keys=True, indent=2))
    except (ValueError, KeyError, TypeError, ZeroDivisionError, OverflowError) as error:
        print(json.dumps({"status": "INVALID_OR_UNSUPPORTED", "reason": str(error)}))
        raise SystemExit(1)
