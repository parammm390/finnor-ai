"""Independent six-boundary lineage/currentness/counter oracle."""
from fractions import Fraction
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
