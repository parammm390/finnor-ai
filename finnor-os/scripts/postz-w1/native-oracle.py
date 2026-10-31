"""Independent original-input/SQL observer. No production selection/checker imports."""
import argparse
import hashlib
import json
from fractions import Fraction
from datetime import datetime
from pathlib import Path


def evaluate(expression, inputs):
    kind = expression["kind"]
    if kind == "input":
        return Fraction(inputs[expression["key"]])
    if kind == "literal":
        return Fraction(expression["value"])
    if kind == "if":
        condition = expression["condition"]
        left, right = evaluate(condition["left"], inputs), evaluate(condition["right"], inputs)
        holds = {"lt": left < right, "lte": left <= right, "eq": left == right,
                 "gte": left >= right, "gt": left > right}[condition["comparison"]]
        return evaluate(expression["whenTrue" if holds else "whenFalse"], inputs)
    left, right = evaluate(expression["left"], inputs), evaluate(expression["right"], inputs)
    if kind == "add":
        return left + right
    if kind == "subtract":
        return left - right
    if kind == "multiply":
        return left * right
    if kind == "ratio":
        return left / right
    if kind == "min":
        return min(left, right)
    if kind == "max":
        return max(left, right)
    raise AssertionError("Unsupported original expression " + str(kind))


def check(record):
    assert record["schema"] == "finnor.w1.native-observations.v1"
    assert record["auth"]["bypass"] is False
    assert record["auth"]["anonymousStatus"] == 401
    assert record["auth"]["foreignStatus"] == 404
    parent = record["parent"]
    assert parent["request"]["schema"] == "finnor.harness-request.v1"
    assert parent["status"] == "TESTED", "Original P1 result must be independently accepted"
    values = record["program"]["result"]["values"]
    expected = {}
    for target in parent["request"]["acceptance"]["targets"]:
        expected[target["key"]] = evaluate(target["expression"], record["sourceInputs"])
        assert Fraction(values[target["key"]]["value"]) == expected[target["key"]]
        assert values[target["key"]]["semantics"]["unit"] == target["unit"]
        assert values[target["key"]]["semantics"].get("currencyCode") == target["currencyCode"]
    if record["fixture"] == "P1_LIABILITY_ARITHMETIC":
        assert expected == {"netEquity": Fraction(43), "leverage": Fraction(7, 2)}
    attempts = record["attempts"]
    assert len({a["id"] for a in attempts}) == len(attempts)
    assert len({a["delivery_id"] for a in attempts}) == len(attempts)
    assert any(a["body"]["workKind"] == "CONTROL_W1" for a in attempts)
    assert all(a["body"]["originalEpisode"] == parent["episode_id"] for a in attempts)
    assert all(a["body"]["grantDigest"] == record["search"]["request"]["computeGrant"]["contentDigest"] for a in attempts)
    assert all(a["body"]["chargedNativeAttempts"] == 1 for a in attempts)
    jobs = {j["id"]: j for j in record["jobs"]}
    for attempt in attempts:
        job = jobs[attempt["body"]["jobId"]]
        assert job["tenant_id"] == parent["tenant_id"]
        assert int(job["claim_fence"]) >= int(attempt["claim_fence"]) >= 1
        assert job["protocol_version"] == 3
        assert attempt["body"]["costUSD"] is None
    episode = record["episode"]
    assert episode["id"] == parent["episode_id"]
    assert episode["attempts_used"] <= episode["max_attempts"]
    assert episode["steps_used"] <= episode["max_steps"]
    assert record["grantSpent"] >= len(attempts)
    assert record["grantSpent"] <= record["grantCapacity"]
    assert record["activeLeases"] == 0, "Actual scoped physical occupancy must be released"
    assert all(a["status"] not in ("INTENT", "SUBMITTED", "UNKNOWN") for a in attempts)
    applied = [e for e in record["events"] if e["kind"] == "W1_NEXT_COMPUTATION_APPLIED"]
    assert applied, "A saved capsule without actual consumption fails"
    units = {u["id"]: u for u in record["units"]}
    capsules = {row["digest"]: row for row in record["capsules"]}
    development = {row["candidate_digest"]: row["body"] for row in record["developmentChecks"]}
    attempt_by_id = {attempt["id"]: attempt for attempt in attempts}
    for event in applied:
        body = event["body"]
        assert body["authorityGranted"] is False
        assert len(body["capsuleDigest"]) == 64
        assert units[body["unitId"]]["kind"] in ("EXECUTE_P1", "VERIFY_P1")
        capsule = capsules[body["capsuleDigest"]]["body"]
        proposal = capsule["proposal"]
        assert proposal["status"] == "CHECKED_POLICY"
        assert proposal["check"]["status"] == "VALID"
        assert hashlib.sha256(proposal["modelBytes"].encode()).hexdigest() == proposal["check"]["modelSha256"]
        model = json.loads(proposal["modelBytes"])
        state_id = body.get("stateId", model["rootStateId"])
        selected = proposal["policy"]["states"][state_id]["selectedChoiceId"]
        choice = next(c for s in model["states"] if s["id"] == state_id for c in s["choices"] if c["id"] == selected)
        assert choice["kind"] == "COMPUTE"
        assert choice["computationRef"] == body.get("actionRef", body["computationRef"])
        physical = attempt_by_id[capsule["execution"]["attemptId"]]
        assert physical["body"]["workKind"] == "CONTROL_W1"
        assert physical["body"]["w1CapsuleDigest"] == body["capsuleDigest"]
        assert physical["status"] == "COMPLETED"
        receipt = development[body["capsuleDigest"]]
        assert receipt["domain"] == "ECONOMIC_ORCHESTRATION"
        assert receipt["protectionDomain"] == "DISPOSABLE_LOCAL_DEVELOPMENT"
        assert receipt["modelDigest"] == proposal["check"]["modelSha256"]
        assert receipt["protectedAdmission"] is False
        assert receipt["productionActivated"] is False
        assert receipt["executionAuthorityGranted"] is False
    checks = [u for u in units.values() if u["kind"] == "VERIFY_P1" and u["status"] == "COMPLETED"]
    assert checks
    for unit in checks:
        assert units[unit["body"]["prerequisites"][0]]["status"] == "COMPLETED"
        assert all(c["status"] == "PASS" and c["method"] == "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION"
                   and Fraction(c["actual"]) == Fraction(c["expected"]) for c in unit["result"]["checks"])
    revisions = record["responses"]
    assert revisions, "Actual native measured response revision required"
    observation_ids = set()
    for revision in revisions:
        assert revision["body"]["sourceClass"] == "CONTROLLED_NATIVE"
        for sample in revision["dataset"]["samples"]:
            assert sample["traceRef"].startswith("p2-native-treatment:")
            assert sample["monetaryCost"]["status"] == "UNKNOWN"
            observation_ids.add(sample["id"])
    assert observation_ids
    if any(row["body"]["version"] == "postz-w1-native-v2" for row in record["capsules"]):
        stages = record["nativeStageObservations"]
        assert stages and len({row["body"]["assignmentRef"] for row in stages}) == len(stages)
        assert any(len(row["body"]["before"]["history"]) > 0 for row in stages)
        for row in stages:
            stage = row["body"]
            assert stage["episodeRef"] == parent["episode_id"]
            assert stage["evidenceRefs"], "Transitions require actual original attempt/SQL evidence"
            if stage["action"] is not None:
                assert stage["after"]["history"] == stage["before"]["history"] + [
                    {"actionRef": stage["action"]["ref"], "observation": stage["observation"]}]
                physical = [a for a in record["continuationSourceAttempts"]
                            if a["body"].get("w1SelectionGroupRef") ==
                            stage["assignmentRef"].removeprefix("native-stage-assignment:")]
                assert physical, "A withdrawn/unexecuted assignment is not a fabricated observed transition"
                assert all(a["body"]["w1ActionRef"] == stage["action"]["ref"] for a in physical)
                assert all(a["body"]["originalEpisode"] == stage["episodeRef"] for a in physical)
                assert all("p2-attempt:" + a["id"] + ":" + a["digest"] in stage["evidenceRefs"] for a in physical)
                assert stage["consumption"]["attempts"] == len(physical)
                assert stage["consumption"]["steps"] == sum(a["body"]["steps"] for a in physical)
                selection = next(e for e in record["continuationSourceEvents"]
                                 if e["body"].get("selectionGroupRef") ==
                                 stage["assignmentRef"].removeprefix("native-stage-assignment:"))
                assert stage["beforeRemaining"] == selection["body"]["remaining"], "Original resource state cannot be erased"
                if stage["consumption"]["wallMs"] is not None:
                    start = datetime.fromisoformat(selection["created_at"].replace("Z", "+00:00"))
                    end = max(datetime.fromisoformat(a["body"]["w1Meter"]["endedAt"].replace("Z", "+00:00")) for a in physical)
                    assert Fraction(stage["consumption"]["wallMs"]) == Fraction(round((end-start).total_seconds()*1000))
        by_capsule = {}
        for event in applied:
            by_capsule.setdefault(event["body"]["capsuleDigest"], set()).add(event["body"].get("stateId"))
        assert any(len(ids - {None}) >= 2 for ids in by_capsule.values()), "Two flat root controls are not multistage consumption"
        assert record["continuationStates"]
        assert all(row["body"]["context"]["sourceClass"] == "CONTROLLED_NATIVE" for row in record["continuationStates"])
        gaps = record["measurementGaps"]
        assert 0 < len(gaps) <= 257
        assert any(row["body"]["kind"] == "UNKNOWN_MONETARY_COST" for row in gaps)
        assert all(row["body"]["value"] is None for row in gaps), "Unknown measurements cannot become zero"
        assert record["nativeDependencySnapshots"]
        for row in record["nativeDependencySnapshots"]:
            assert set(row["body"]["facets"]) >= {"METHOD", "MODEL", "PRICE", "DEADLINE", "RESOURCE", "SOURCE", "RIGHTS", "WORK"}
        for row in record["capsules"]:
            bound = datetime.fromisoformat(row["body"]["input"]["episodeDeadlineAt"].replace("Z", "+00:00"))
            actual = datetime.fromisoformat(episode["deadline_at"].replace("Z", "+00:00"))
            assert bound <= actual, "A capsule never invents an extended original episode"
    return {"status": "PASS", "scope": "CONTROLLED_NATIVE_DEVELOPMENT",
            "expected": {key: str(value) for key, value in expected.items()},
            "physicalAttempts": len(attempts), "nativeObservationIds": sorted(observation_ids),
            "protectedAdmission": False, "economicGainQualified": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("observations", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    raw = args.observations.read_bytes()
    try:
        result = check(json.loads(raw))
    except Exception as error:
        result = {"status": "FAIL", "predicate": type(error).__name__, "message": str(error)}
    result["originalObservationsSha256"] = hashlib.sha256(raw).hexdigest()
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    raise SystemExit(0 if result["status"] == "PASS" else 1)
