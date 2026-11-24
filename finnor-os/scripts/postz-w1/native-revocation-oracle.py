"""Independent six-boundary lineage/currentness/counter oracle."""
from fractions import Fraction
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sys


def main():
    source, destination = map(Path, sys.argv[1:])
    raw = source.read_bytes()
    record = json.loads(raw)
    cases = record["cases"]
    assert [row["boundary"] for row in cases] == ["SUBMIT", "CLAIM", "USE", "CHECK", "PUBLISH", "DISPATCH"]
    for case in cases:
        assert case["status"] == "PASS", (case["boundary"], case.get("failure"))
        assert case["cleanup"]["status"] == "PASS_OWNED_RESOURCES_CLOSED"
        target = case["target"]
        assert case["revoked"]["workId"] == target["work"]["workId"]
        assert case["revoked"]["workInputId"] != target["work"]["workInputId"]
        if case["boundary"] == "SUBMIT":
            assert case["blocked"] and all(row["wait_event"] == "advisory" for row in case["blocked"])
            assert all("s5_reservations" in row["query"] for row in case["blocked"])
            assert case["refusedSubmit"]["status"] in (400, 404, 409, 422)
            assert case["refusedSubmit"]["body"]["predicate"] == "EXACT_WORK_REVISION_CHANGED"
            assert not any(row["program_id"] == target["program"]["programId"]
                           for row in case["terminal"]["p2_requests"])
        else:
            assert case["pause"]["originalClocksContinue"] is True
            assert case["pause"]["event"]["searchId"] == case["searchId"]
            assert case["pause"]["resumedAt"]
            expected_kind, expected_boundary, expected_unit = {
                "CLAIM": ("W1_NATIVE_FALLBACK_APPLIED", None, "EXECUTE_P1"),
                "USE": ("PHYSICAL_ATTEMPT_SUBMITTED", None, "EXECUTE_P1"),
                "CHECK": ("W1_BOUNDARY_CURRENTNESS_CHECKED", "USE", "VERIFY_P1"),
                "PUBLISH": ("W1_BOUNDARY_CURRENTNESS_CHECKED", "CHECK", "VERIFY_P1"),
                "DISPATCH": ("UNIT_COMPLETED", None, "VERIFY_P1"),
            }[case["boundary"]]
            pause = case["pause"]["event"]
            cut = case["preRevocation"]
            committed = [row for row in cut["p2_events"] if row["id"] == pause["eventId"]]
            assert len(committed) == 1, "W007_EXACT_COMMITTED_PAUSE_EVENT_REQUIRED"
            event = committed[0]
            assert event["search_id"] == case["searchId"]
            assert event["kind"] == pause["kind"] == expected_kind
            assert event["body"].get("boundary") == pause.get("boundary") == expected_boundary
            assert event["body"]["unitId"] == pause["unitId"]
            units = [row for row in cut["p2_units"] if row["id"] == pause["unitId"]]
            assert len(units) == 1 and units[0]["search_id"] == case["searchId"]
            assert units[0]["kind"] == expected_unit
            searches = [row for row in cut["p2_requests"] if row["id"] == case["searchId"]]
            assert len(searches) == 1 and searches[0]["program_id"] == target["program"]["programId"]
            # DISPATCH is search-scoped and deliberately has no unitId.
            assert not any(row["search_id"] == case["searchId"] and
                           row["kind"] == "W1_BOUNDARY_CURRENTNESS_CHECKED" and
                           row["body"].get("boundary") == case["boundary"] and
                           (case["boundary"] == "DISPATCH" or row["body"].get("unitId") == pause["unitId"])
                           for row in cut["p2_events"]), "W007_INTENDED_BOUNDARY_ALREADY_CROSSED"
            instant = lambda value: datetime.fromisoformat(value.replace("Z", "+00:00"))
            # pausedAt and resumedAt are JavaScript instants truncated to the
            # millisecond; PostgreSQL instants carry microseconds. Compare a
            # database instant against a JavaScript one at the coarser
            # resolution, or a pause delivered within the same millisecond as
            # its committed event reads as preceding it.
            floor = lambda value: value.replace(microsecond=value.microsecond // 1000 * 1000)
            assert (floor(instant(event["created_at"])) <= instant(case["pause"]["pausedAt"]) <=
                    instant(cut["observedAt"]) <= instant(case["revocationCut"]["observedAt"]) and
                    floor(instant(case["revocationCut"]["observedAt"])) <=
                    instant(case["pause"]["resumedAt"])), "W007_ORIGINAL_PAUSE_REVOCATION_ORDER_REQUIRED"
            if case["boundary"] == "CLAIM":
                assert cut["p2_attempts"] == []
            if case["boundary"] == "USE":
                attempts = [row for row in cut["p2_attempts"] if row["unit_id"] == pause["unitId"]]
                assert len(attempts) == 1 and attempts[0]["status"] == "SUBMITTED"
                assert attempts[0]["id"] == event["body"]["attemptId"]
            assert case["fencedRead"]["body"]["capsule"] is None
            assert case["fencedRead"]["body"]["currentness"] == "STALE"
            assert case["programRead"]["body"]["program"] is None
            assert case["programRead"]["body"]["status"] != "TESTED"
            assert not any(event["request_id"] == target["program"]["programId"]
                           and event["kind"] == "OWNER_OPERATION_ATTEMPT" for event in case["terminal"]["p1_events"])
            before = {row["id"]: row for row in case["preRevocation"]["p2_attempts"]}
            after = {row["id"]: row for row in case["terminal"]["p2_attempts"]}
            assert before.keys() <= after.keys()
            for identity, attempt in before.items():
                assert after[identity]["body"]["chargedNativeAttempts"] == attempt["body"]["chargedNativeAttempts"] == 1
                assert after[identity]["body"]["grantDigest"] == attempt["body"]["grantDigest"]
        original_episodes = {row["id"]: row for row in case["before"]["p1_episodes"]}
        terminal_episodes = {row["id"]: row for row in case["terminal"]["p1_episodes"]}
        for identity, episode in original_episodes.items():
            current = terminal_episodes[identity]
            for key in ("deadline_at", "max_attempts", "max_steps", "max_candidates"):
                assert current[key] == episode[key]
            assert current["attempts_used"] >= episode["attempts_used"]
            assert current["steps_used"] >= episode["steps_used"]
        unaffected = case["unaffected"]
        assert unaffected["work"]["workId"] != target["work"]["workId"]
        assert unaffected["read"]["body"]["status"] == "TESTED"
        values = unaffected["read"]["body"]["program"]["result"]["values"]
        assert Fraction(values["netEquity"]["value"]) == Fraction(43)
        assert Fraction(values["leverage"]["value"]) == Fraction(7, 2)
        assert unaffected["request"]["ownerBindings"]["allocationRef"] == case["originalGrant"]
        attempts = case["terminal"]["p2_attempts"]
        spent = sum(int(row["spent"]) for row in case["terminal"]["p2_grant_usage"])
        assert spent == len(attempts) <= 8
        assert all(attempt["body"]["costUSD"] is None for attempt in attempts)
        if case["boundary"] == "DISPATCH":
            assert any(event["search_id"] == unaffected["searchId"] and
                       event["kind"] == "W1_BOUNDARY_CURRENTNESS_CHECKED" and
                       event["body"]["boundary"] == "DISPATCH" for event in case["terminal"]["p2_events"])
            assert any(event["request_id"] == unaffected["program"]["programId"] and
                       event["kind"] == "OWNER_OPERATION_ATTEMPT" for event in case["terminal"]["p1_events"])
    receipt = {"schema": "finnor.w1.independent-six-boundary-oracle.v1",
               "status": "PASS_INDEPENDENT_SIX_BOUNDARY_LINEAGE_AND_LIABILITY",
               "caseIds": ["W007"], "boundaries": [row["boundary"] for row in cases],
               "inputSha256": hashlib.sha256(raw).hexdigest(), "protectedS6OrFieldQualified": False}
    with destination.open("x") as stream:
        stream.write(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"status": receipt["status"], "caseIds": receipt["caseIds"]}))


if __name__ == "__main__":
    main()
