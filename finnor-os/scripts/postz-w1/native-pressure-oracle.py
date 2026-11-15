"""Independent row/counter/time reconstruction. No production runtime imports."""
from datetime import datetime
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import sys


def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def main():
    source, output = map(Path, sys.argv[1:])
    raw = source.read_bytes()
    record = json.loads(raw)
    population = record["population"]
    assert [row["label"] for row in population] == [
        "A_CANCELLED_IN_FLIGHT", "C_ORIGINAL_DEADLINE_MISSED", "B_UNAFFECTED_PROGRESS"]
    assert len({row["workId"] for row in population}) == 3
    assert len({row["programId"] for row in population}) == 3
    search_ids = {row["searchId"] for row in population}
    original = record["before"]
    parents = {row["id"]: row for row in original["p1_requests"]}
    episodes = {row["id"]: row for row in original["p1_episodes"]}
    searches = [row for row in original["p2_requests"] if row["id"] in search_ids]
    assert len(searches) == 3
    assert len({row["tenant_id"] for row in searches}) == 1
    assert len({row["principal_id"] for row in searches}) == 1
    assert {row["request"]["computeGrant"]["contentDigest"] for row in searches} == {
        record["originalGrant"]["contentDigest"]}
    assert len({parents[row["program_id"]]["episode_id"] for row in searches}) == 3
    assert len({row["binding"]["reservationRef"]["id"] for row in searches}) == 1
    capacity = searches[0]["binding"]["capacity"]
    assert capacity == 8
    baseline = {row["id"]: row for row in original["p1_episodes"]}
    cuts = ["before", "held", "contended", "cancellationCut", "expiredWhileHeld", "afterRelease", "missed", "terminal"]
    spent_before = None
    reconstructed = []
    for name in cuts:
        cut = record[name]
        attempts = cut["p2_attempts"]
        assert len({row["id"] for row in attempts}) == len(attempts)
        assert len({row["delivery_id"] for row in attempts}) == len(attempts)
        assert all(row["body"]["chargedNativeAttempts"] == 1 for row in attempts)
        assert all(row["body"]["costUSD"] is None for row in attempts)
        assert all(row["body"]["grantDigest"] == record["originalGrant"]["contentDigest"] for row in attempts)
        spent = sum(int(row["spent"]) for row in cut["p2_grant_usage"])
        assert spent == len(attempts), (name, "Every admitted physical invocation must retain its original debit")
        assert spent <= capacity
        assert spent_before is None or spent >= spent_before
        spent_before = spent
        for parent in cut["p1_requests"]:
            if parent["id"] not in parents:
                continue
            assert parent["episode_id"] == parents[parent["id"]]["episode_id"]
        for episode in cut["p1_episodes"]:
            previous = baseline[episode["id"]]
            for key in ("id", "deadline_at", "max_attempts", "max_steps", "max_candidates"):
                assert episode[key] == previous[key], (name, key)
            assert episode["attempts_used"] <= episode["max_attempts"]
            assert episode["steps_used"] <= episode["max_steps"]
            charged = [row for row in attempts if row["body"]["originalEpisode"] == episode["id"]]
            assert episode["attempts_used"] >= len(charged)
            assert episode["steps_used"] >= sum(row["body"]["steps"] for row in charged)
        reconstructed.append({"cut": name, "admittedUnits": len(attempts), "originalSpent": spent,
                              "remainingSharedEnvelope": capacity - spent})
    a, c, b = population
    held = record["held"]
    assert len(held["p2_attempts"]) == 1
    assert held["p2_attempts"][0]["search_id"] == a["searchId"]
    assert held["p2_attempts"][0]["status"] == "SUBMITTED"
    active = [row for row in held["leases"] if row["resource_key"] == "native:p2"
              and row["released_at"] is None and instant(row["expires_at"]) > instant(held["observedAt"])]
    assert len(active) == 1
    assert held["physicalPolicies"][0]["capacity"] == 1
    assert record["cancellationCut"]["p2_grant_usage"] == held["p2_grant_usage"]
    assert record["cancellationCut"]["p2_attempts"][0]["status"] == "SUBMITTED"
    assert len(record["expiredWhileHeld"]["p2_attempts"]) == 1
    c_parent = parents[c["programId"]]
    c_deadline = instant(episodes[c_parent["episode_id"]]["deadline_at"])
    assert instant(held["observedAt"]) < c_deadline < instant(record["expiredWhileHeld"]["observedAt"])
    assert all(row["search_id"] != c["searchId"] for row in record["terminal"]["p2_attempts"])
    assert record["scheduler"]["priorityAgingSeconds"] == 2
    assert record["scheduler"]["workloadClass"] == "INTERACTIVE"
    assert record["scheduler"]["leaseSeconds"] == 30
    assert record["contenderIdentity"]["scheduler"] == record["scheduler"]
    assert record["contenderIdentity"]["pid"] != record["paused"]["pid"]
    initial_jobs = {job["id"]: job for entry in record["priorityInputs"] for job in entry["rows"]}
    assert {entry["searchId"]: entry["priority"] for entry in record["priorityInputs"]} == {
        a["searchId"]: 300, c["searchId"]: -100, b["searchId"]: 200}
    terminal = record["terminal"]
    jobs = {row["id"]: row for row in terminal["jobs"]}
    deliveries = [row for row in terminal["job_delivery_attempts"]
                  if jobs[row["job_id"]]["payload"].get("searchId") in (b["searchId"], c["searchId"])]
    assert deliveries
    first = min(deliveries, key=lambda row: (instant(row["started_at"]), row["id"]))
    assert jobs[first["job_id"]]["payload"]["searchId"] == c["searchId"]
    assert instant(first["started_at"]) < c_deadline
    assert first["outcome"] == "capacity_deferred"
    assert any(row["outcome"] == "capacity_deferred" for row in record["contended"]["job_delivery_attempts"])
    assert any(jobs[row["job_id"]]["payload"].get("searchId") == c["searchId"]
               and instant(row["started_at"]) > c_deadline for row in deliveries)
    for job_id, original_job in initial_jobs.items():
        assert jobs[job_id]["priority"] == original_job["priority"]
        assert jobs[job_id]["payload"]["originalDeadlineAt"] == original_job["payload"]["originalDeadlineAt"]
    assert record["noDueTimeOrDeadlineMutation"] is True
    assert record["unaffected"]["body"]["status"] == "TESTED"
    values = record["unaffected"]["body"]["program"]["result"]["values"]
    assert Fraction(values["netEquity"]["value"]) == Fraction(120) - 70 - 7
    assert Fraction(values["leverage"]["value"]) == Fraction(70, 20)
    assert record["costs"] == {"usd": None, "completeChildUsage": None, "missingCostIsZero": False}
    receipt = {"schema": "finnor.w1.independent-concurrent-pressure-oracle.v1",
               "status": "PASS_INDEPENDENT_CONSERVATION_AND_MISSED_POPULATION",
               "caseIds": ["W006", "W015"], "inputSha256": hashlib.sha256(raw).hexdigest(),
               "population": population, "counterReconstruction": reconstructed,
               "billingUSD": None, "completeCostQualified": False, "economicsQualified": False}
    with output.open("x") as stream:
        stream.write(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"status": receipt["status"], "caseIds": receipt["caseIds"]}))


if __name__ == "__main__":
    main()
