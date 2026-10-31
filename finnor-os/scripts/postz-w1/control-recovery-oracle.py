"""Independent original SQL-row oracle. No driver/production checker imports."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

# Reuse the already retained, independent Fraction/source-version arithmetic.
spec = importlib.util.spec_from_file_location("original_recovery_reference", Path(__file__).with_name("recovery-oracle.py"))
reference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reference)
need, one, unique, when = reference.need, reference.one, reference.unique, reference.when
fraction, spent = reference.fraction, reference.spent
Failed = reference.Failed


def int_fence(value):
    """Claim fences compare as integers; a malformed fence is a controlled rejection, not a crash (H9)."""
    try:
        return int(value)
    except (TypeError, ValueError) as error:
        raise Failed("CONTROL_CLAIM_OWNER_FENCE", "malformed claim_fence: %r" % (value,)) from error


def verify(record, root):
    need(record["schema"] == "finnor.w1.control-pre-admission-recovery.v1", "REGISTERED_CONTROL_SCHEMA")
    need(record["sourceUnchanged"] and record["productionIdentity"] == record["finalProductionIdentity"], "CURRENT_PRODUCTION_DRIFT")
    need(not record.get("error") and not record.get("cleanupError"), "CONTROL_DRIVER_OR_CLEANUP_FAILED")
    need(record["auth"] == {"bypass": False, "anonymousStatus": 401, "foreignStatus": 404}, "ACTUAL_SIGNED_CONTROL_AUTH")
    need(record["appIdentity"] == {"role": "finnor_app", "rolsuper": False, "rolbypassrls": False, "app_inherits_worker": False}, "RESTRICTED_APP_IDENTITY")
    need(record["network"]["installed"] and record["network"]["blockedExternalAttempts"] == 0, "CONTROL_NETWORK_BOUNDARY")
    need(0 < record["scoredWallMs"] < 120000 and 0 < record["engineering"]["wallMs"] < 300000, "ORIGINAL_CONTROL_CLOCKS")
    need(record["engineering"]["includesWarmAndSetup"] and record["engineering"]["intervalsNonadditive"]
         and record["engineering"]["billingUSD"] is None and record["engineering"]["completeChildUsage"] is None, "UNKNOWN_CONTROL_COST_NOT_ZERO")
    cuts = unique(record["cuts"], "label")
    need({"selected", "contended", "killed", "released", "lease-expired", "queue-recovered", "reconciled", "final"} <= set(cuts), "ALL_CONTROL_SQL_CUTS_REQUIRED")
    for label, cut in cuts.items():
        need(json.loads((root / (label + ".json")).read_bytes()) == cut, "CONTROL_SQL_FILE_CUSTODY")
    selected, final = cuts["selected"], cuts["final"]
    p, s, e = selected["parent"], selected["search"], selected["episode"]
    original = record["original"]
    uid, jid = original["unitId"], original["jobId"]
    unit, job = unique(selected["units"])[uid], unique(selected["jobs"])[jid]
    need(unit["kind"] == "CONTROL_W1" and unit["status"] == "QUEUED" and unit["attempts"] == 0
         and not selected["attempts"] and not selected["capsules"], "REAL_UNADMITTED_CONTROL_REQUIRED")
    need(job["status"] == "queued" and job["protocol_version"] == 3 and job["retry_safety"] == "reconcilable", "CONTROL_PROTOCOL3_DELIVERY")
    need(job["idempotency_key"] == f"p2:{s['id']}:{unit['generation']}:{uid}:admission:0"
         and job["payload"]["unitId"] == uid and job["payload"]["searchId"] == s["id"], "ORIGINAL_BARE_CONTROL_KEY")
    need(original["programId"] == p["id"] == s["program_id"] and original["searchId"] == s["id"]
         and original["workId"] == p["work_id"] == e["work_id"] == selected["work"]["id"]
         and original["workInputId"] == p["work_input_id"] and original["episodeId"] == p["episode_id"] == e["id"], "ORIGINAL_CONTROL_CUSTODY")
    need(original["grant"] == s["request"]["computeGrant"] == p["request"]["ownerBindings"]["allocationRef"], "ORIGINAL_CONTROL_GRANT")
    need(p["request"]["limits"]["deadlineMs"] == 300000
         and when(p["proposed"]["bounds"]["deadlineAt"]) == when(e["deadline_at"]) == when(original["deadlineAt"]), "ORIGINAL_CONTROL_DEADLINE")
    warm = record["warmEpisode"]
    need(warm["id"] == e["id"] and warm["deadline_at"] == e["deadline_at"]
         and warm["max_attempts"] == e["max_attempts"] and warm["max_steps"] == e["max_steps"], "WARM_EPISODE_NOT_RENEWED")
    intake = record["followUpInput"]
    need(intake["workId"] == p["work_id"] and intake["workInputId"] == p["work_input_id"]
         and intake["created"] is False and intake["duplicate"] is False, "REAL_FRESH_CANONICAL_INPUT")
    expected = reference.source_values(selected)
    selection = one([x for x in selected["events"] if x["kind"] == "W1_CONTROL_QUEUED" and x["body"]["unitId"] == uid], "REAL_CONTROL_SELECTION")
    training = one(record["trainingContinuation"], "RETAINED_TRAIN_CONTINUATION")
    need(training["body"]["ref"] == selection["body"]["continuationRef"]
         and training["body"]["context"]["tenantId"] == p["tenant_id"]
         and training["body"]["context"]["principalId"] == p["principal_id"], "CONTROL_TRAIN_OWNER_CUSTODY")
    need(any(x["split"] == "TRAIN" and x["action"] and all(v is not None for v in x["consumption"].values())
             and when(x["observedAt"]) <= when(selected["clock"]["at"]) for x in training["body"]["samples"]), "ACTUAL_OBSERVED_TRAIN_SUPPORT")
    workers = unique(record["workers"], "label")
    need(set(workers) == {"setup-warm", "victim", "replacement"} and len({x["pid"] for x in workers.values()}) == 3, "DISTINCT_CONTROL_WORKER_PROCESSES")
    traces = {}
    for label, worker in workers.items():
        identity = worker["identity"]
        need(identity["pid"] == worker["pid"] and identity["parentPid"] == record["node"]["pid"]
             and identity["authBypass"] == "0" and identity["identity"]["role"] == "finnor_worker"
             and not identity["identity"]["rolsuper"] and not identity["identity"]["rolbypassrls"], "RESTRICTED_CONTROL_WORKER")
        trace = [json.loads(x) for x in (root / worker["trace"]).read_text().splitlines()]
        traces[label] = trace
        need(any(x["type"] == "worker-exit" and x["pid"] == worker["pid"] for x in trace), "OWNED_CONTROL_WORKER_EXIT")
        for row in (x for x in trace if x["type"] == "observation"):
            need(row["transport"]["installed"] and row["transport"]["blockedExternalAttempts"] == 0, "CONTROL_WORKER_NETWORK")
    kill, victim = record["kill"], workers["victim"]
    need(kill["accepted"] and kill["request"]["pid"] == kill["exit"]["pid"] == victim["pid"]
         and kill["request"]["signal"] == kill["exit"]["signal"] == "SIGKILL" and kill["exit"]["code"] is None, "EXACT_CONTROL_SIGKILL")
    need(kill["request"] in traces["victim"] and kill["exit"] in traces["victim"]
         and not record["victimTick"]["ok"] and when(kill["exit"]["at"]) <= when(record["gate"]["releasedAt"]), "KILL_BEFORE_S5_RELEASE")
    contended = cuts["contended"]
    waits = [x for x in contended["waits"] if x["application_name"] == victim["applicationName"]
             and x["usename"] == "finnor_worker" and x["wait_event_type"] == "Lock"
             and record["gate"]["holderPid"] in x["blockers"] and "pg_advisory_xact_lock" in x["query"]]
    need(waits, "ACTUAL_CONTROL_PORTFOLIO_LOCK_WAITER")
    held = [x for x in contended["locks"] if x["pid"] == record["gate"]["holderPid"] and x["locktype"] == "advisory" and x["granted"]]
    need(any(any(l["pid"] == w["pid"] and l["locktype"] == "advisory" and not l["granted"]
                 and (l["classid"], l["objid"], l["objsubid"]) == (h["classid"], h["objid"], h["objsubid"])
                 for l in contended["locks"] for w in waits) for h in held), "SAME_CONTROL_S5_ADVISORY_LOCK")
    claimed = unique(contended["jobs"])[jid]
    delivery = one([x for x in contended["deliveries"] if x["job_id"] == jid and x["claim_token"] == claimed["claim_token"]], "DURABLE_CONTROL_CLAIM")
    need(claimed["status"] == "running" and claimed["lease_owner"] == delivery["worker_id"] == "p5-physical-" + str(victim["pid"])
         and int_fence(claimed["claim_fence"]) == int_fence(delivery["claim_fence"]) > 0, "CONTROL_CLAIM_OWNER_FENCE")
    expired = unique(cuts["lease-expired"]["jobs"])[jid]
    need(expired["status"] == "running" and when(expired["lease_expires_at"]) <= when(cuts["lease-expired"]["clock"]["at"]), "NATURAL_CONTROL_LEASE_EXPIRY")
    recovered = unique(cuts["queue-recovered"]["jobs"])[jid]
    recovered_delivery = unique(cuts["queue-recovered"]["deliveries"])[delivery["id"]]
    need(recovered["status"] == "quarantined" and recovered["claim_token"] is None
         and recovered_delivery["outcome"] == "reconciliation_required" and recovered_delivery["failure_kind"] == "lease_expired"
         and record["canonicalRecoveryCount"] >= 1, "CANONICAL_CONTROL_QUEUE_RECOVERY")
    previous, previous_spent = e, spent(selected)
    for cut in record["cuts"]:
        q, search, episode = cut["parent"], cut["search"], cut["episode"]
        for field in ("id", "tenant_id", "principal_id", "work_id", "work_input_id", "work_input_digest", "episode_id", "plan_revision_id", "request", "request_digest"):
            need(q[field] == p[field], "CONTROL_PARENT_RENEWED")
        need(search["request"] == s["request"] and search["binding"] == s["binding"] and search["context"] == s["context"], "CONTROL_OWNER_OR_SOURCE_REPLACED")
        for field in ("inputs", "sources", "sourceVersions", "derivations", "reservationOrigins"):
            need(cut[field] == selected[field], "CONTROL_ORIGINAL_SOURCE_OR_RESERVATION_CHANGED")
        for field in ("id", "tenant_id", "principal_id", "work_id", "max_steps", "max_attempts", "max_candidates", "max_depth", "deadline_at"):
            need(episode[field] == e[field], "CONTROL_EPISODE_BOUND_RENEWED")
        for used, maximum in (("steps_used", "max_steps"), ("attempts_used", "max_attempts"), ("candidates_used", "max_candidates")):
            need(previous[used] <= episode[used] <= episode[maximum], "CONTROL_COUNTER_REFUND_OR_OVERSPEND")
        need(previous_spent <= spent(cut) <= s["binding"]["capacity"], "CONTROL_GRANT_REFUND_OR_OVERSPEND")
        need(not cut["effects"] and not cut["consumptions"] and not cut["capsules"], "UNEXPECTED_CONTROL_EFFECT_OR_CAPSULE")
        retained = unique(cut["units"])[uid]
        need(retained["body"] == unit["body"] and retained["digest"] == unit["digest"] and retained["attempts"] == 0, "FAILED_CONTROL_BODY_OR_DEBIT_CHANGED")
        need(all(a["unit_id"] != uid and a["body"]["jobId"] != jid for a in cut["attempts"]), "FAILED_CONTROL_PHYSICAL_REPLAY")
        if cut["label"] != "final":
            need(not cut["attempts"] and spent(cut) == spent(selected) and episode["attempts_used"] == e["attempts_used"], "PRE_ADMISSION_CONTROL_DEBIT")
        previous, previous_spent = episode, spent(cut)
    reconcile = one([x for x in record["calls"] if x["operation"] == "economic-orchestration-reconcile"], "SIGNED_CONTROL_RECONCILE")
    if record["phase"] == "broken":
        need(record["status"] == "RECORDED_CONTROL_RECONCILE_422" and reconcile["status"] == 422, "EXACT_CONTROL_FIRST_HTTP_FAILURE")
        errors = [x for x in record["databaseErrors"] if x["code"] == "23505" and x["constraint"] and x["constraint"].startswith("p2_units_")
                  and when(reconcile["at"]) <= when(x["at"]) <= when(reconcile["completedAt"])]
        need(len(errors) == 1 and "digest" in errors[0]["constraint"], "ACTUAL_CONTROL_DIGEST_UNIQUENESS_23505")
        need(unique(final["units"])[uid]["status"] == "QUEUED" and len([u for u in final["units"] if u["kind"] == "CONTROL_W1"]) == 1
             and not final["attempts"] and final["parent"]["status"] != "TESTED"
             and unique(final["jobs"])[jid]["status"] == "quarantined", "CONTROL_RECOVERY_TRANSACTION_ROLLED_BACK")
        return "CONTROL_PRE_ADMISSION_DUPLICATE_DIGEST_ROLLBACK"
    need(record["phase"] == "repaired" and record["status"] == "RECORDED_CONTROL_FALLBACK_RECOVERED" and reconcile["status"] == 200, "REPAIRED_CONTROL_RECOVERY")
    need(not any(x["code"] == "23505" for x in record["databaseErrors"]), "CONTROL_DUPLICATE_DIGEST_REMAINS")
    need(unique(final["units"])[uid]["status"] == "FAILED"
         and len([u for u in final["units"] if u["kind"] == "CONTROL_W1"]) == 1, "FAILED_CONTROL_NOT_REPLACED_OR_REPLAYED")
    recovery = one([x for x in final["events"] if x["kind"] == "W1_PRE_ADMISSION_DELIVERY_RECONCILED"
                    and x["body"]["unitId"] == uid and x["body"]["jobId"] == jid], "TRUTHFUL_CONTROL_RECOVERY_EVENT")
    need(recovery["body"]["physicalCallProvenAbsent"] is True and recovery["body"]["attemptChargeApplied"] is False
         and recovery["body"]["originalEpisode"] == e["id"] and recovery["body"]["originalGrantRetained"] is True
         and recovery["body"]["localWorkerCostUSD"] is None, "TRUTHFUL_CONTROL_NO_ADMISSION")
    execute = one([u for u in final["units"] if u["kind"] == "EXECUTE_P1" and u["status"] == "COMPLETED"], "ACTUAL_CONTROL_FALLBACK_EXECUTION")
    verify = one([u for u in final["units"] if u["kind"] == "VERIFY_P1" and u["status"] == "COMPLETED" and u["body"]["prerequisites"] == [execute["id"]]], "ACTUAL_CONTROL_SQL_VERIFICATION")
    need(len(final["attempts"]) == 2 and all(a["status"] == "COMPLETED" for a in final["attempts"]), "EXACT_CONTROL_FALLBACK_PHYSICAL_PAIR")
    for key, value in expected.items():
        need(fraction(execute["result"]["values"][key]["value"]) == value, "CONTROL_ORIGINAL_ARITHMETIC")
        check = one([x for x in verify["result"]["checks"] if x["id"] == "numeric:" + key], "CONTROL_ALL_SQL_CHECKS")
        need(check["method"] == "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION" and check["status"] == "PASS"
             and fraction(check["actual"]) == fraction(check["expected"]) == value, "CONTROL_INDEPENDENT_POSTGRES_ACCEPTANCE")
    jobs, deliveries = unique(final["jobs"]), unique(final["deliveries"])
    for physical_unit in (execute, verify):
        attempt = one([a for a in final["attempts"] if a["unit_id"] == physical_unit["id"]], "CONTROL_ONE_ATTEMPT_PER_FALLBACK_UNIT")
        body = attempt["body"]
        need(body["originalEpisode"] == e["id"] and body["grantDigest"] == original["grant"]["contentDigest"]
             and body["chargedNativeAttempts"] == 1 and body["protocolVersion"] == 3 and body["costUSD"] is None, "CONTROL_FALLBACK_PHYSICAL_FUNDING")
        physical_job, delivery_row = jobs[body["jobId"]], deliveries[attempt["delivery_id"]]
        payload = physical_job["payload"]
        need(attempt["tenant_id"] == physical_job["tenant_id"] == p["tenant_id"]
             and attempt["principal_id"] == p["principal_id"] and attempt["search_id"] == s["id"]
             and physical_job["protocol_version"] == 3, "CONTROL_PHYSICAL_ATTEMPT_SCOPE_PROTOCOL")
        need(body["deliveryAttemptId"] == attempt["delivery_id"]
             and int(body["claimFence"]) == int(attempt["claim_fence"]) == int(delivery_row["claim_fence"])
             and delivery_row["job_id"] == physical_job["id"], "CONTROL_PHYSICAL_DELIVERY_FENCE")
        need(payload["tenantId"] == p["tenant_id"] and payload["principalId"] == p["principal_id"]
             and payload["searchId"] == s["id"] and payload["unitId"] == physical_unit["id"]
             and int(payload["generation"]) == int(physical_unit["generation"]), "CONTROL_PHYSICAL_ORIGINAL_JOB_PAYLOAD")
        expected_key = (f"p2:{s['id']}:{physical_unit['generation']}:{physical_unit['id']}:admission:"
                        f"{int(body['unitInvocation']) - 1}:w1-plan:{payload['w1SelectionGroupRef']}")
        need(physical_job["idempotency_key"] == expected_key
             and payload["w1SelectionGroupRef"] == body["w1SelectionGroupRef"], "CONTROL_PHYSICAL_PLAN_KEY")
        need(when(body["originalDeadlineAt"]) == when(payload["originalDeadlineAt"]) == when(e["deadline_at"])
             and when(body["deliveryDeadlineAt"]) <= when(e["deadline_at"]), "CONTROL_PHYSICAL_DEADLINE_EXTENDED")
        dispatch = one([x for x in final["events"] if x["kind"] == "W1_NATIVE_FALLBACK_APPLIED"
                        and x["body"].get("unitId") == physical_unit["id"]
                        and x["body"].get("selectionGroupRef") == body["w1SelectionGroupRef"]], "CONTROL_ACTUAL_FALLBACK_DISPATCH")
        need(when(dispatch["created_at"]) >= when(recovery["created_at"])
             and dispatch["body"]["remaining"]["attempts"] >= 1
             and dispatch["body"]["remaining"]["steps"] >= body["steps"], "CONTROL_CURRENT_REMAINING_FALLBACK_BUDGET")
        need(physical_job["status"] == "completed" and delivery_row["outcome"] == "completed"
             and delivery_row["worker_id"] == "p5-physical-" + str(workers["replacement"]["pid"]), "CONTROL_REPLACEMENT_PHYSICAL_COMPLETION")
    module = one([m for m in selected["search"]["context"]["program"]["modules"]
                  if m["id"] == execute["body"]["moduleId"]], "CONTROL_ORIGINAL_FALLBACK_MODULE")
    need(hashlib.sha256(module["compiled"].encode()).hexdigest() == module["compiledDigest"]
         and hashlib.sha256(module["source"].encode()).hexdigest() == module["sourceDigest"], "CONTROL_ORIGINAL_FALLBACK_MODULE_BYTES")
    isolated = one([x["body"] for x in final["p1Events"] if x["kind"] == "ISOLATED_MODULE_EXECUTION"
                    and x["body"]["moduleId"] == execute["body"]["moduleId"]], "CONTROL_ISOLATED_EXECUTION_RECEIPT")
    need(isolated["execution"]["exitCode"] == 0 and isolated["execution"]["termination"] == "EXITED"
         and isolated["emittedDigest"] == module["typescript"]["emittedDigest"]
         and hashlib.sha256(module["typescript"]["emitted"].encode()).hexdigest() == isolated["emittedDigest"]
         and all(fraction(isolated["outputs"][key]) == value for key, value in expected.items()), "CONTROL_ISOLATED_EXECUTION_BYTES_AND_OUTPUTS")
    need(record["programRead"]["status"] == 200 and record["programRead"]["body"]["status"] == "TESTED", "CONTROL_ORIGINAL_PROGRAM_READ")
    program = one([row["body"] for row in final["programs"] if row["id"] == final["parent"]["head_id"]], "CONTROL_ACTUAL_P1_IMMUTABLE_HEAD")
    need(program["status"] == "TESTED" and program["acceptance"] == p["request"]["acceptance"], "CONTROL_ORIGINAL_P1_ACCEPTANCE_UNCHANGED")
    for target in program["acceptance"]["targets"]:
        value = program["result"]["values"][target["key"]]
        need(fraction(value["value"]) == expected[target["key"]]
             and value["semantics"]["unit"] == target["unit"]
             and value["semantics"]["currencyCode"] == target["currencyCode"], "CONTROL_ORIGINAL_PUBLISHED_RESULT")
    need(final["parent"]["status"] == "TESTED" and final["search"]["status"] == "STOPPED"
         and spent(final) - spent(selected) == 2 and final["episode"]["attempts_used"] - e["attempts_used"] == 2, "ORIGINAL_CONTROL_FINAL_ACCOUNTING")
    need(not reference.active_leases(final) and not reference.head_plan(final)["outstanding"], "CONTROL_NO_HIDDEN_FINAL_OCCUPANCY_OR_OUTSTANDING")
    return "PASS_CONTROL_PRE_ADMISSION_MINIMUM_FALLBACK"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("observations", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    raw = args.observations.read_bytes()
    result = {"schema": "finnor.w1.control-recovery-independent-oracle.v1", "status": "FAIL", "expectedFailureMatch": False,
              "originalObservationsSha256": hashlib.sha256(raw).hexdigest(), "protectedAdmission": False, "economicGainQualified": False}
    try:
        predicate = verify(json.loads(raw), args.observations.parent)
        result.update(predicate=predicate, expectedFailureMatch=predicate == "CONTROL_PRE_ADMISSION_DUPLICATE_DIGEST_ROLLBACK")
        if predicate == "PASS_CONTROL_PRE_ADMISSION_MINIMUM_FALLBACK":
            result.update(status="PASS", originalNetEquity="43", originalLeverage="7/2")
    except Exception as error:
        result.update(predicate=getattr(error, "predicate", type(error).__name__), detail=str(error))
    with args.output.open("x") as out:
        json.dump(result, out, indent=2); out.write("\n")
    print(json.dumps(result))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
