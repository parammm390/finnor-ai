#!/usr/bin/env python3
"""Development original models, independently specified before producer code."""
import argparse
import copy
import json
from pathlib import Path


def base(identity, decisions):
    return {
        "schema": "finnor.metalevel-model.v1", "id": identity,
        "binding": {k: "development:" + k for k in (
            "tenantId", "principalId", "workId", "outcomeRef", "mandateRef",
            "sourceRef", "rightsRef", "catalogueRef", "responseRef", "modelRef",
            "priceRef", "checkerRef", "runtimeRef", "parentGrantRef")}
        | {"deadline": "2099-01-01T00:00:00.000Z"},
        "utilityUnit": "synthetic-utility", "rootStateId": "root",
        "maxDecisions": decisions, "tieOrder": [], "states": []}


def state(identity, history, remaining, utility, accepted=False):
    return {"id": identity, "decisionIndex": len(history), "history": history,
            "remaining": {"computeUnits": str(remaining)}, "obligations": [],
            "requiredChecks": ["original-check"] if accepted else [],
            "completedChecks": ["original-check"] if accepted else [],
            "acceptanceRef": "original-model-acceptance:" + identity if accepted else None,
            "choices": [{"id": "stop", "kind": "STOP", "utility": str(utility),
                         "disposition": "ACCEPTED" if accepted else "INCOMPLETE",
                         "resultRef": "original-result:" + identity if accepted else None}]}


def outcome(token, successor, probability="1", valid=True):
    return {"observation": token, "kind": "VALID" if valid else "INVALID",
            "probability": probability, "utilityDelta": "0",
            "consumption": {"computeUnits": "1"}, "nextStateId": successor}


def computation(identity, outcomes, cost="1"):
    return {"id": identity, "kind": "COMPUTE",
            "computationRef": "admitted-development-method:" + identity,
            "contextRefs": ["lawful-original-context"], "dependsOn": [],
            "verifierRefs": ["original-check"], "utilityCost": cost,
            "reservation": {"computeUnits": "1"}, "outcomes": outcomes}


def complementarity():
    model = base("complementarity-50-98", 2)
    root = state("root", [], 2, 50)
    first_history = [{"choiceId": "first", "observation": "READY"}]
    first = state("first-result", first_history, 1, 50)
    invalid_first = state("invalid-first", [{"choiceId": "first", "observation": "INVALID"}], 1, 50)
    left = state("left", first_history + [{"choiceId": "second", "observation": "LEFT"}], 0, 100, True)
    right = state("right", first_history + [{"choiceId": "second", "observation": "RIGHT"}], 0, 100, True)
    invalid_second = state("invalid-second", first_history + [{"choiceId": "second", "observation": "INVALID"}], 0, 50)
    root["choices"].append(computation("first", [
        outcome("READY", first["id"]), outcome("INVALID", invalid_first["id"], "0", False)]))
    first["choices"].append(computation("second", [
        outcome("LEFT", left["id"], "1/2"), outcome("RIGHT", right["id"], "1/2"),
        outcome("INVALID", invalid_second["id"], "0", False)]))
    model["states"] = [root, first, invalid_first, left, right, invalid_second]
    model["tieOrder"] = ["stop", "first", "second"]
    return model


def exact_tie():
    model = base("exact-rational-original-ties", 1)
    root = state("root", [], 1, "1/3")
    ok = state("ok", [{"choiceId": "equal", "observation": "OK"}], 0, "2/3", True)
    invalid = state("invalid", [{"choiceId": "equal", "observation": "INVALID"}], 0, 0)
    root["choices"].append(computation("equal", [
        outcome("OK", "ok"), outcome("INVALID", "invalid", "0", False)], "1/3"))
    model["states"] = [root, ok, invalid]
    model["tieOrder"] = ["equal", "stop"]
    return model


def boundary():
    model = base("complete-64-state-16-choice-8-decision", 8)
    root = state("root", [], 8, 0)
    model["states"].append(root)
    model["tieOrder"] = ["stop"]
    primary = None
    for number in range(15):
        identity = "root-choice-" + str(number)
        history = [{"choiceId": identity, "observation": "OK"}]
        ok = state("branch-" + str(number), history, 7, 50)
        invalid = state("invalid-root-" + str(number), [{"choiceId": identity, "observation": "INVALID"}], 7, 0)
        root["choices"].append(computation(identity, [
            outcome("OK", ok["id"]), outcome("INVALID", invalid["id"], "0", False)]))
        model["states"].extend([ok, invalid])
        model["tieOrder"].append(identity)
        if number == 0:
            primary = ok
    for depth in range(1, 8):
        identity = "continuation-" + str(depth)
        history = primary["history"] + [{"choiceId": identity, "observation": "OK"}]
        ok = state("depth-" + str(depth + 1), history, 7 - depth, 100 if depth == 7 else 0, depth == 7)
        invalid = state("invalid-depth-" + str(depth + 1), primary["history"] + [{"choiceId": identity, "observation": "INVALID"}], 7 - depth, 0)
        primary["choices"].append(computation(identity, [
            outcome("OK", ok["id"]), outcome("INVALID", invalid["id"], "0", False)]))
        model["states"].extend([ok, invalid])
        model["tieOrder"].append(identity)
        primary = ok
    for number in range(19):
        token = "ZERO_SUPPORT_" + str(number)
        extra = state("explicit-zero-" + str(number), [{"choiceId": "root-choice-0", "observation": token}], 7, 0)
        root["choices"][1]["outcomes"].append(outcome(token, extra["id"], "0"))
        model["states"].append(extra)
    assert len(model["states"]) == 64
    assert len(root["choices"]) == 16
    return model


def computation_boundary(count):
    model = base("complete-" + str(count) + "-computation-boundary", 1)
    root = state("root", [], 1, 0)
    model["states"] = [root]
    model["tieOrder"] = ["stop"]
    for number in range(count):
        identity = "alternative-" + str(number)
        ok = state("result-" + str(number), [{"choiceId": identity, "observation": "OK"}], 0, 50, True)
        invalid = state("invalid-" + str(number), [{"choiceId": identity, "observation": "INVALID"}], 0, 0)
        root["choices"].append(computation(identity, [
            outcome("OK", ok["id"]), outcome("INVALID", invalid["id"], "0", False)]))
        model["states"].extend([ok, invalid])
        model["tieOrder"].append(identity)
    return model


def full_boundary():
    model = copy.deepcopy(boundary())
    model["id"] = "complete-64-state-16-computation-8-decision"
    root = model["states"][0]
    # Replace two explicitly zero-support leaves, not an observed branch.
    model["states"] = model["states"][:-2]
    root["choices"][1]["outcomes"] = root["choices"][1]["outcomes"][:-2]
    identity = "root-choice-15"
    ok = state("branch-15", [{"choiceId": identity, "observation": "OK"}], 7, 50)
    invalid = state("invalid-root-15", [{"choiceId": identity, "observation": "INVALID"}], 7, 0)
    root["choices"].append(computation(identity, [
        outcome("OK", ok["id"]), outcome("INVALID", invalid["id"], "0", False)]))
    model["states"].extend([ok, invalid])
    model["tieOrder"].append(identity)
    assert len(model["states"]) == 64
    assert len(root["choices"]) == 17
    return model


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    for name, model in (("complementarity", complementarity()), ("rational-tie", exact_tie()), ("boundary", boundary()),
                        ("computation-boundary", computation_boundary(16)), ("full-boundary", full_boundary()),
                        ("unsupported-17-computations", computation_boundary(17))):
        target = args.output / (name + ".json")
        target.write_text(json.dumps(model, sort_keys=True, indent=2) + "\n")
        print(target)
