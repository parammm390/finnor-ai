"""Independent original-record checks. No production planner/runtime imports."""
from datetime import datetime
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import sys
import traceback


def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def accepted(read):
    assert read["status"] == "TESTED"
    values = read["program"]["result"]["values"]
    assert Fraction(values["netEquity"]["value"]) == Fraction(120) - 70 - 7
    assert Fraction(values["leverage"]["value"]) == Fraction(70, 20)


def original_episode(before, after):
    for key in ("id", "deadline_at", "max_attempts", "max_steps", "max_candidates"):
        assert before[key] == after[key], key
    for used, maximum in (("attempts_used", "max_attempts"), ("steps_used", "max_steps"),
                          ("candidates_used", "max_candidates")):
        assert before[used] <= after[used] <= before[maximum], used


def sequential(data):
    original, measured, report = data["original"], data["measured"], data["report"]
    assert report["schema"] == "finnor.w1.strong-sequential-owning.v1"
    assert report["caseIds"] == ["W011"]
    assert original["search"]["limits"]["maxParallel"] == 1
    assert report["originalGrant"] == original["grant"]
    assert original["request"]["limits"] == report["originalLimits"]
    on, reference = measured["on"], measured["nativeReference"]
    accepted(on["on"])
    accepted(reference["reference"])
    assert len(on["attempts"]) == 2
    assert all(row["status"] == "COMPLETED" for row in on["attempts"])
    units = {row["id"]: row for row in on["units"]}
    paid = [units[row["unit_id"]] for row in on["attempts"]]
    assert sorted(row["kind"] for row in paid) == ["EXECUTE_P1", "VERIFY_P1"]
    execute = next(row for row in paid if row["kind"] == "EXECUTE_P1")
    verify = next(row for row in paid if row["kind"] == "VERIFY_P1")
    assert verify["body"]["prerequisites"] == [execute["id"]]
    assert not any(row["kind"] == "CONTROL_W1" for row in units.values())
    assert all(row["attempts"] == 0 for row in units.values() if row["status"] == "CANCELLED")
    assert reference["searches"] == []
    assert "computeSearch" not in reference["input"]["request"]
    assert on["input"]["input"]["workId"] == reference["input"]["input"]["workId"]
    assert on["input"]["input"]["workInputId"] != reference["input"]["input"]["workInputId"]
    for side in (on, reference):
        original_episode(original["episode"], side["before"])
        original_episode(side["before"], side["after"])
        assert side["after"]["attempts_used"] > side["before"]["attempts_used"]
    assert on["after"]["attempts_used"] == reference["before"]["attempts_used"]
    events = [row for row in on["events"] if row["kind"] == "W1_OBSERVED_SINGLE_PATH_FLOOR_RETAINED"]
    assert events == report["floorEvents"]
    assert {row["body"]["remainingNativeCalls"] for row in events} == {1, 2}
    for event in events:
        body = event["body"]
        assert body["nativeCallFloor"] == 2
        assert body["originalCompletedStages"] + body["remainingNativeCalls"] == 2
        assert body["originalMaxParallel"] == 1
        assert body["originalEpisode"] == original["episode"]["id"]
        assert body["originalGrant"] == original["grant"]
        assert body["probabilityOrFutureAcceptanceCertified"] is False
        assert body["supervisorCostIsZero"] is False
        assert body["observedStageRefs"]
    cost = report["completeCost"]
    assert cost["usd"] is None and cost["missingCostIsZero"] is False
    assert cost["completeDescendantUsage"] is None and cost["gaps"]
    assert report["comparisonOrder"] == ["WARM", "W1_SINGLE_PATH", "EQUIPPED_NATIVE_REFERENCE"]
    assert report["orderAndSingleTaskConfoundingRetained"] is True
    assert report["economicsQualified"] is False
    return ["W011"], "PASS_INDEPENDENT_NATIVE_SINGLE_PATH"


def standing(data):
    assert data["schema"] == "finnor.w1.standing-event-owning.v1"
    assert data["caseIds"] == ["W004"]
    information = data["informational"], data["doNotAct"]
    for read in information:
        assert read["before"] == read["after"]
        assert read["response"]["status"] == 200
        assert read["response"]["body"]["answers"][0]["value"] == "OPEN"
        assert read["response"]["body"]["productionActivated"] is False
        for key in ("loops", "waits", "wakes", "jobs", "effects"):
            assert read["after"][key] == []
    work_ids = {row["after"]["work"]["id"] for row in information}
    identity = data["standing"]
    assert identity["workId"] not in work_ids and len(work_ids) == 2
    waiting, woken, continued = (data[key] for key in ("waiting", "woken", "continued"))
    assert waiting["inputs"][0]["id"] == identity["workInputId"]
    assert waiting["inputs"][0]["instruction_text"] == data["originalMandate"]
    assert continued["inputs"] == waiting["inputs"]
    assert data["first"] == "waiting"
    assert len(waiting["waits"]) == 1 and waiting["waits"][0]["status"] == "waiting"
    assert waiting["wakes"] == []
    assert data["unrelated"]["matchedWaitIds"] == []
    assert data["matched"]["matchedWaitIds"] == [waiting["waits"][0]["id"]]
    assert len(data["matched"]["wakeClaimIds"]) == 1
    assert data["duplicate"]["duplicate"] is True
    assert len(woken["wakes"]) == len(continued["wakes"]) == 1
    assert woken["wakes"][0]["id"] == data["matched"]["wakeClaimIds"][0]
    assert woken["waits"][0]["matched_event_id"] == data["matched"]["eventId"]
    assert any(job["type"] == "run_objective_iteration"
               and job["payload"]["wakeEventId"] == data["matched"]["eventId"]
               and job["payload"]["wakeWaitId"] == waiting["waits"][0]["id"]
               for job in woken["jobs"] if "wakeEventId" in job["payload"])
    for cut in (waiting, woken, continued):
        loop = cut["loops"][0]
        assert loop["work_id"] == identity["workId"]
        assert instant(loop["deadline_at"]) == instant(data["originalDeadline"])
        assert (loop["max_steps"], loop["max_actions"], loop["max_queries"]) == (4, 0, 1)
        assert cut["effects"] == []
    assert continued["loops"][0]["action_count"] == 0
    assert continued["loops"][0]["query_count"] == 1
    assert any(row["intent"] == "pe_world_state" and row["status"] == "succeeded"
               for row in continued["queries"])
    assert data["wake"]["event"]["id"] == data["matched"]["eventId"]
    assert data["wake"]["event"]["workId"] == identity["workId"]
    assert data["wake"]["event"]["instructionEligible"] is False
    assert data["newBusinessEffectAuthority"] is False
    assert data["llmOrFieldBehaviorQualified"] is False
    return ["W004"], "PASS_INDEPENDENT_STANDING_EVENT_LINEAGE"


def drift(data):
    assert data["schema"] == "finnor.w1.actual-capability-drift.v1"
    assert [row["facet"] for row in data["cases"]] == ["PRICE", "MODEL", "LATENCY"]
    for case in data["cases"]:
        assert case["status"] == "PASS"
        assert case["cleanup"]["status"] == "PASS_OWNED_RESOURCES_CLOSED"
        search = case["searchId"]
        before, revised, terminal = (case[key] for key in ("before", "revised", "terminal"))
        capability = case["ownerRevision"]["capability"]
        source = case["ownerRevision"]["source"]
        assert source.startswith("finnor.w1.native-capability.v1:")
        assert json.loads(source.partition(":")[2]) == capability
        assert hashlib.sha256(source.encode()).hexdigest() == case["ownerRevision"]["sourceSha256"]
        assert case["revisedPolicy"]["source"] == source
        assert case["invalidation"]["status"] == 200
        assert case["oldCapsuleDigest"] in case["invalidation"]["body"]["affected"]
        old_capsule = next(row for row in before["w1_capsules"] if row["digest"] == case["oldCapsuleDigest"])
        assert old_capsule["search_id"] == search
        assert next(row for row in terminal["w1_capsules"] if row["digest"] == old_capsule["digest"]) == old_capsule
        assert any(row["capsule_digest"] == old_capsule["digest"]
                   and row["dependency_key"] == "native-facet:" + case["facet"] for row in revised["w1_invalidations"])
        original_attempts = [row for row in before["p2_attempts"] if row["search_id"] == search]
        assert len(original_attempts) == 1 and original_attempts[0]["status"] == "COMPLETED"
        assert next(row for row in before["p2_units"] if row["id"] == original_attempts[0]["unit_id"])["kind"] == "CONTROL_W1"
        assert len(before["p2_attempts"]) == len(revised["p2_attempts"])
        for attempt in before["p2_attempts"]:
            assert next(row for row in terminal["p2_attempts"] if row["id"] == attempt["id"]) == attempt
        for episode in before["p1_episodes"]:
            original_episode(episode, next(row for row in terminal["p1_episodes"] if row["id"] == episode["id"]))
        assert sum(int(row["spent"]) for row in terminal["p2_grant_usage"]) >= sum(
            int(row["spent"]) for row in before["p2_grant_usage"])
        assert case["current"]["status"] == 200 and case["current"]["body"]["capsule"] is None
        fresh_ids = {row["id"] for row in revised["p2_events"]}
        fresh = [row for row in terminal["p2_events"] if row["search_id"] == search and row["id"] not in fresh_ids]
        assert any(row["kind"] == "W1_PRE_ADMISSION_REPLANNED" for row in fresh)
        assert case["reselectionSteps"]
        if case["facet"] in ("PRICE", "MODEL"):
            assert len([row for row in terminal["p2_attempts"] if row["search_id"] == search]) == 1
            assert any(row["kind"] == "W1_NATIVE_COMPUTATION_STOPPED"
                       and row["body"]["stoppedDisposition"] == "INCOMPLETE" for row in fresh)
            assert case["result"]["body"]["status"] != "TESTED"
            if case["facet"] == "PRICE":
                assert Fraction(capability["nativeAttemptCostMultiplier"]) == 200
            else:
                assert capability["modelRef"] != "P1_REGISTERED_EXACT_NATIVE_NO_MODEL"
        else:
            receipt = case["ownerRevision"]["measuredLatencyReceipt"]
            assert receipt["status"] == "COMPLETED"
            assert next(row for row in before["p2_attempts"] if row["id"] == receipt["id"]) == receipt
            assert capability["latencyEvidence"] == [{"attemptId": receipt["id"], "digest": receipt["digest"]}]
            assert capability["stageLatencyPlanningMs"] == math.ceil(receipt["body"]["w1Meter"]["elapsedMs"])
            assert any(row["kind"] == "W1_NATIVE_FALLBACK_APPLIED" for row in fresh)
            accepted(case["result"]["body"])
    assert data["economicsQualified"] is False and data["protectedAdmission"] is False
    return ["W014"], "PASS_INDEPENDENT_PRICE_MODEL_LATENCY_RESELECTION"


def main():
    mode, source_name, output_name = sys.argv[1:]
    source, output = Path(source_name), Path(output_name)
    assert source.is_absolute() and output.is_absolute() and not output.exists()
    raw = source.read_bytes()
    receipt = {"schema": "finnor.w1.independent-internal-owner-oracle.v1", "mode": mode, "status": "FAIL",
               "inputSha256": hashlib.sha256(raw).hexdigest(),
               "oracleSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "productionRuntimeImported": False, "economicsQualified": False, "billingUSD": None}
    try:
        case_ids, status = {"standing": standing, "sequential": sequential, "drift": drift}[mode](json.loads(raw))
        receipt.update(status=status, caseIds=case_ids)
    except Exception as error:
        receipt.update(failure=repr(error), traceback=traceback.format_exc())
    with output.open("x") as stream:
        stream.write(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))
    return 0 if receipt["status"].startswith("PASS_") else 1


if __name__ == "__main__":
    raise SystemExit(main())
