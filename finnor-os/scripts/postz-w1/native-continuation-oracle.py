"""Failure-first exact conditional-policy oracle. No FINNOR imports or estimated answers."""
import argparse
import json
from fractions import Fraction as F
from pathlib import Path


def verify(record):
    model, policy = record["model"], record["policy"]
    states = {s["id"]: s for s in model["states"]}
    assert len(states) == len(model["states"]) <= 64
    assert model["maxDecisions"] == 8
    values, ties = {}, {}
    order = {key: i for i, key in enumerate(model["tieOrder"])}
    for state in sorted(states.values(), key=lambda s: -s["decisionIndex"]):
        assert len(state["history"]) == state["decisionIndex"] <= 8
        assert 1 <= len(state["choices"]) <= 16
        alternatives = {}
        for choice in state["choices"]:
            if choice["kind"] == "STOP":
                alternatives[choice["id"]] = F(choice["utility"])
                assert choice["disposition"] != "ACCEPTED", "A forecast must not publish actual business acceptance"
                continue
            assert sum(F(t["probability"]) for t in choice["outcomes"]) == 1
            assert sum(t["kind"] == "INVALID" for t in choice["outcomes"]) == 1
            total = -F(choice["utilityCost"])
            for transition in choice["outcomes"]:
                after = states[transition["nextStateId"]]
                assert after["history"] == state["history"] + [{"choiceId": choice["id"], "observation": transition["observation"]}]
                for dimension, before in state["remaining"].items():
                    consumption = F(transition["consumption"][dimension])
                    assert 0 <= consumption <= F(choice["reservation"][dimension]) <= F(before)
                    assert F(after["remaining"][dimension]) == F(before) - consumption
                assert {o["id"] for o in state["obligations"]} <= {o["id"] for o in after["obligations"]}
                total += F(transition["probability"]) * (F(transition["utilityDelta"]) + values[after["id"]])
            alternatives[choice["id"]] = total
        best = max(alternatives.values())
        optimal = sorted((key for key, value in alternatives.items() if value == best), key=order.__getitem__)
        actual = policy["states"][state["id"]]
        assert F(actual["value"]) == best
        assert actual["optimalChoiceIds"] == optimal and actual["selectedChoiceId"] == optimal[0]
        assert {key: F(value) for key, value in actual["choiceValues"].items()} == alternatives
        values[state["id"]], ties[state["id"]] = best, optimal
    root = model["rootStateId"]
    assert values[root] == 93, values[root]
    selected = policy["states"][root]["selectedChoiceId"]
    assert record["actions"][selected]["unitKeys"] == ["A:execute"]
    root_values = policy["states"][root]["choiceValues"]
    by_units = {tuple(record["actions"][key]["unitKeys"]): F(value) for key, value in root_values.items() if key in record["actions"]}
    assert by_units[("B:execute",)] == 92
    assert by_units[("A:execute", "B:execute")] == -4
    assert max(s["decisionIndex"] for s in states.values()) >= 3
    contingent = [s for s in states.values() if record["frames"][s["id"]]["units"][0]["status"] == "FAILED"]
    assert any(record["actions"].get(policy["states"][s["id"]]["selectedChoiceId"], {}).get("unitKeys") == ["B:execute"] for s in contingent)
    return {"status": "PASS", "classification": "DETERMINISTICALLY_VERIFIED",
            "rootValue": "93", "states": len(states), "maxDepth": max(s["decisionIndex"] for s in states.values()),
            "scope": "INDEPENDENT_LITERAL_FRACTION_CONTINUATION_NOT_NATIVE_E2E"}


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("record", type=Path)
    p.add_argument("--output", required=True, type=Path)
    args = p.parse_args()
    try:
        result = verify(json.loads(args.record.read_text()))
    except Exception as error:
        result = {"status": "FAIL", "message": repr(error)}
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    raise SystemExit(result["status"] != "PASS")
