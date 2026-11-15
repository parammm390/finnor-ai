"""Independent original-row recovery oracle; standard library only.

No imports from the driver, production selection, or production checkers.
The baseline intentionally exits 1 with an independently identified failure.
"""
import argparse
import hashlib
import json
from datetime import datetime
from fractions import Fraction
from pathlib import Path

API = "finnor-os/packages/private-equity/src/compute-search/api.ts"
BROKEN_SHA = "9432cef52e0431c3543c3811cfdcf2fd038b67b6ef9717050fc344b7ff6fdb13"
REPAIRED_SHA = "2914d5fd14a85b91bf742d3a1878b77a8f894835164a781300298b3a195ed192"


class Failed(Exception):
    def __init__(self, predicate, detail=""):
        super().__init__(detail or predicate)
        self.predicate = predicate


def need(value, predicate, detail=""):
    if not value:
        raise Failed(predicate, detail)


def when(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def fraction(value):
    return Fraction(str(value))


def unique(rows, key="id"):
    result = {row[key]: row for row in rows}
    need(len(result) == len(rows), "DUPLICATE_ORIGINAL_ROW")
    return result


def one(rows, predicate):
    need(len(rows) == 1, predicate)
    return rows[0]


def file_in(root, relative):
    target = (root / relative).resolve()
    need(target.is_relative_to(root.resolve()), "EVIDENCE_PATH_ESCAPE")
    return target


def expression(e, inputs):
    kind = e["kind"]
    if kind == "input":
        return inputs[e["key"]]
    if kind == "literal":
        return fraction(e["value"])
    if kind == "if":
        c = e["condition"]
        left, right = expression(c["left"], inputs), expression(c["right"], inputs)
        holds = {"lt": left < right, "lte": left <= right, "eq": left == right,
                 "gte": left >= right, "gt": left > right}[c["comparison"]]
        return expression(e["whenTrue" if holds else "whenFalse"], inputs)
    a, b = expression(e["left"], inputs), expression(e["right"], inputs)
    if kind == "add":
        return a + b
    if kind == "subtract":
        return a - b
    if kind == "multiply":
        return a * b
    if kind == "ratio":
        return a / b
    if kind == "min":
        return min(a, b)
    if kind == "max":
        return max(a, b)
    raise Failed("UNSUPPORTED_ORIGINAL_ACCEPTANCE", kind)


def spent(cut):
    need(len(cut["usage"]) <= 1, "EXACT_ORIGINAL_GRANT_USAGE_REQUIRED")
    return int(cut["usage"][0]["spent"]) if cut["usage"] else 0


def active_leases(cut):
    return [row for row in cut["leases"]
            if row["released_at"] is None and when(row["expires_at"]) > when(cut["clock"]["at"])]


def head_plan(cut):
    return one([p["body"] for p in cut["plans"] if p["id"] == cut["search"]["head_id"]],
               "ORIGINAL_STORED_PLAN_HEAD_REQUIRED")


def source_values(cut):
    p = cut["parent"]
    versions = unique(cut["sourceVersions"])
    values = {}
    for source in p["request"]["sources"]:
        descriptor = source["source"]
        rows = [r for r in cut["sources"] if r["series"]["metric_key"] == descriptor["metricKey"]
                and r["series"]["active"] and r["observation"]["superseded_at"] is None
                and when(r["observation"]["period_start"]) == when(descriptor["periodStart"])
                and when(r["observation"]["period_end"]) == when(descriptor["periodEnd"])]
        row = one(rows, "EXACT_ORIGINAL_SOURCE_OBSERVATION_REQUIRED")
        s, o = row["series"], row["observation"]
        need(s["tenant_id"] == o["tenant_id"] == p["tenant_id"], "SOURCE_TENANT_CUSTODY")
        need(s["subject_type"] == p["request"]["root"]["entityType"]
             and s["subject_id"] == p["request"]["root"]["entityId"]
             and descriptor["subject"] == p["request"]["root"], "SOURCE_ROOT_CUSTODY")
        need(s["unit"] == descriptor["unit"] and s["currency_code"] == descriptor["currencyCode"]
             and s["frequency"] == descriptor["frequency"], "SOURCE_SEMANTICS_CHANGED")
        need(o["value_type"] == "number" and o["metric_series_id"] == s["id"], "RAW_NUMERIC_SOURCE_REQUIRED")
        version = versions[o["evidence_version_id"]]
        need(version["tenant_id"] == p["tenant_id"] and version["source_id"] == o["evidence_source_id"],
             "SOURCE_VERSION_CUSTODY")
        value = fraction(row["valueNumeric"])
        need(fraction(version["snapshot"]["values"][source["key"]]) == value, "SOURCE_SNAPSHOT_DISAGREEMENT")
        need(fraction(cut["search"]["context"]["input"][source["key"]]) == value, "P4_INPUT_DISAGREEMENT")
        values[source["key"]] = value
    need(values == {"EV": Fraction(120), "debt": Fraction(70), "EBITDA": Fraction(20), "liability": Fraction(7)},
         "REGISTERED_ORIGINAL_FIXTURE_CHANGED")
    expected = {t["key"]: expression(t["expression"], values) for t in p["request"]["acceptance"]["targets"]}
    need(expected == {"netEquity": Fraction(43), "leverage": Fraction(7, 2)}, "ORIGINAL_ACCEPTANCE_RECOMPUTATION")
    derivation = one(cut["derivations"], "ACTUAL_P4_DERIVATION_REQUIRED")
    d = derivation["body"]
    need(d["status"] == "TESTED" and d["work"]["id"] == p["work_id"]
         and d["work"]["revision"] == p["work_input_id"], "P4_WORK_CUSTODY")
    need(d["result"]["digest"] == cut["search"]["context"]["sourceResultDigest"], "P4_RESULT_CUSTODY")
    for key, value in values.items():
        need(fraction(d["result"]["outputs"][key]["value"]) == value, "P4_RAW_SOURCE_DISAGREEMENT")
    return expected


def common(record, case, root):
    need(not case.get("error") and not case.get("cleanupError"), "DRIVER_DID_NOT_REACH_REGISTERED_CUT",
         str(case.get("error") or case.get("cleanupError") or ""))
    need(case["auth"] == {"bypass": False, "anonymousStatus": 401, "foreignStatus": 404}, "SIGNED_AUTH_BOUNDARY")
    calls = case["calls"]
    need(any(x["identity"] == "anonymous" and x["status"] == 401 for x in calls), "ACTUAL_ANONYMOUS_401")
    need(any(x["identity"] == "other" and x["status"] == 404 for x in calls), "ACTUAL_FOREIGN_404")
    need(any(x["operation"] == "economic-orchestration-submit" and x["identity"] == "actor" and x["status"] == 202 for x in calls),
         "ACTUAL_SIGNED_SUBMISSION")
    app = case["boundaries"]["app"]
    need(app["role"] == "finnor_app" and not app["rolsuper"] and not app["rolbypassrls"] and not app["app_inherits_worker"],
         "ACTUAL_APP_ROLE_SEPARATION")
    need(case["engineering"]["wallMs"] <= 120000 and case["engineering"]["wallMs"] > 0, "OBSERVER_120S_BOUND")
    need(case["engineering"]["costUSD"] is None and case["engineering"]["completeChildUsage"] is None
         and case["engineering"]["additiveWithWorkerIntervals"] is False, "UNKNOWN_ENGINEERING_COST_NOT_ZERO")
    cuts = unique(case["cuts"], "label")
    required = {"selected", "contended", "killed", "released", "lease-expired", "queue-recovered", "reconciled", "final"}
    need(required <= set(cuts), "MISSING_ORIGINAL_SQL_CUT")
    directory = file_in(root, case["artifactDirectory"])
    for label, cut in cuts.items():
        need(json.loads(file_in(directory, label + ".json").read_bytes()) == cut, "SQL_CUT_FILE_CUSTODY")
    need(json.loads("[" + ",".join(file_in(directory, "http-calls.jsonl").read_text().splitlines()) + "]") == calls,
         "HTTP_RECEIPT_FILE_CUSTODY")
    original, selected = case["original"], cuts["selected"]
    p, s, e = selected["parent"], selected["search"], selected["episode"]
    need(original["programId"] == p["id"] == s["program_id"] and original["searchId"] == s["id"], "ORIGINAL_PROGRAM_SEARCH")
    need(original["workId"] == p["work_id"] == e["work_id"] == selected["work"]["id"], "ORIGINAL_WORK")
    need(original["workInputId"] == p["work_input_id"] and original["episodeId"] == p["episode_id"] == e["id"], "ORIGINAL_INPUT_EPISODE")
    need(original["grant"] == s["request"]["computeGrant"] == p["request"]["ownerBindings"]["allocationRef"], "ORIGINAL_GRANT")
    need(p["request"]["limits"]["deadlineMs"] == 300000
         and when(p["proposed"]["bounds"]["deadlineAt"]) == when(e["deadline_at"])
         and when(original["deadlineAt"]) == when(e["deadline_at"]), "ORIGINAL_300S_DEADLINE")
    need(s["request"]["orchestration"]["responseRef"] is None and not selected["responses"]
         and not selected["capsules"] and not selected["attempts"], "ORIGINAL_NO_FIT_CUT_REQUIRED")
    need(len(selected["units"]) <= s["request"]["limits"]["maxUnits"], "ORIGINAL_UNIT_BOUND")
    expected = source_values(selected)
    unit = unique(selected["units"])[original["unitId"]]
    job = unique(selected["jobs"])[original["jobId"]]
    need(unit["kind"] == "EXECUTE_P1" and unit["status"] == "QUEUED" and job["status"] == "queued",
         "ORIGINAL_SELECTED_EXECUTION")
    payload = job["payload"]
    need(job["tenant_id"] == payload["tenantId"] == unit["tenant_id"] == p["tenant_id"]
         and payload["principalId"] == unit["principal_id"] == p["principal_id"]
         and payload["searchId"] == unit["search_id"] == s["id"] and payload["unitId"] == unit["id"],
         "EXACT_ORIGINAL_JOB_PAYLOAD_CUSTODY")
    need(int(payload["generation"]) == int(unit["generation"]) == int(original["generation"])
         and int(original["admissionCount"]) == int(unit["attempts"]), "ACTUAL_ADMISSION_COUNT_GENERATION")
    plan_ref = payload["w1SelectionGroupRef"]
    need(isinstance(plan_ref, str) and len(plan_ref) == 64 and original["selectionGroupRef"] == plan_ref, "ORIGINAL_PLAN_REF")
    exact_key = f"p2:{s['id']}:{unit['generation']}:{unit['id']}:admission:{unit['attempts']}:w1-plan:{plan_ref}"
    need(job["idempotency_key"] == exact_key and job["protocol_version"] == 3 and job["retry_safety"] == "reconcilable",
         "EXACT_PLAN_QUALIFIED_PROTOCOL3_KEY")
    selection = one([x for x in selected["events"] if x["kind"] == "W1_NATIVE_FALLBACK_APPLIED"
                     and x["body"].get("unitId") == unit["id"] and x["body"].get("selectionGroupRef") == plan_ref],
                    "ACTUAL_ORIGINAL_FALLBACK_SELECTION_EVENT")
    need(selection["body"]["originalEpisode"] == e["id"] and selection["body"]["originalGrant"] == original["grant"]
         and selection["body"]["authorityGranted"] is False
         and when(selection["body"]["originalDeadline"]) == when(e["deadline_at"]), "ORIGINAL_SELECTION_OWNER_BINDINGS")
    workers = unique(case["workers"], "label")
    victim, replacement, stage = workers["victim"], workers["replacement"], workers["P1-P4-stage"]
    need(len({victim["pid"], replacement["pid"], stage["pid"]}) == 3 and case["victimPid"] == victim["pid"]
         and case["replacementPid"] == replacement["pid"], "DISTINCT_OWNED_PHYSICAL_PIDS")
    traces = {}
    for name, worker in workers.items():
        identity = worker["identity"]
        need(identity["pid"] == worker["pid"] and identity["parentPid"] == case["node"]["pid"]
             and identity["authBypass"] == "0" and identity["identity"]["role"] == "finnor_worker"
             and not identity["identity"]["rolsuper"] and not identity["identity"]["rolbypassrls"]
             and not identity["identity"]["app_inherits_worker"], "RESTRICTED_ACTUAL_WORKER_IDENTITY")
        trace = [json.loads(line) for line in file_in(directory, worker["trace"]).read_text().splitlines()]
        traces[name] = trace
        launch = one([x for x in trace if x["type"] == "launch"], "ACTUAL_CHILD_LAUNCH")
        cold = one([x for x in trace if x["type"] == "cold-start"], "ACTUAL_COLD_START")
        need(launch["pid"] == worker["pid"] and launch["parentPid"] == case["node"]["pid"]
             and launch["profile"] == "P2" and Path(launch["loader"]).is_absolute()
             and Path(launch["executable"]).is_absolute() and launch["costUSD"] is None
             and cold["identity"] == identity and cold["launchWallMs"] > 0, "CHILD_LAUNCH_CUSTODY")
        for event in [x for x in trace if x["type"] == "observation"]:
            need(event["pid"] == worker["pid"] and event["identity"] == identity["identity"]
                 and event["costUSD"] is None and event["completeChildUsage"] is None, "ACTUAL_WORKER_MEASUREMENT")
            need(event["transport"]["installed"] and event["transport"]["blockedExternalAttempts"] == 0, "WORKER_EXTERNAL_NETWORK")
    need(all("run_compute_search_unit_v1" not in x.get("registered", []) for x in traces["P1-P4-stage"]), "STAGING_MUST_NOT_CLAIM_P2")
    kill = case["kill"]
    need(kill["accepted"] is True and kill["request"]["pid"] == kill["exit"]["pid"] == victim["pid"]
         and kill["request"]["signal"] == kill["exit"]["signal"] == "SIGKILL" and kill["exit"]["code"] is None,
         "EXACT_PHYSICAL_SIGKILL_EXIT")
    need(kill["request"] in traces["victim"] and kill["exit"] in traces["victim"], "KILL_EXIT_RECEIPT_CUSTODY")
    need(when(kill["request"]["at"]) <= when(kill["exit"]["at"]) <= when(case["gate"]["releasedAt"]),
         "EXIT_BEFORE_LOCK_RELEASE")
    need(case["victimTick"]["ok"] is False, "KILLED_TICK_MUST_NOT_COMPLETE")
    contended = cuts["contended"]
    claimed = unique(contended["jobs"])[job["id"]]
    delivery = one([d for d in contended["deliveries"] if d["job_id"] == job["id"]
                    and d["claim_token"] == claimed["claim_token"]], "ACTUAL_DURABLE_CLAIM_DELIVERY")
    need(claimed["status"] == "running" and claimed["lease_owner"] == delivery["worker_id"] == "p5-physical-" + str(victim["pid"])
         and int(claimed["claim_fence"]) == int(delivery["claim_fence"]) > 0 and delivery["protocol_version"] == 3,
         "CLAIM_FENCE_OWNER_PROTOCOL")
    waits = [w for w in contended["waits"] if w["application_name"] == victim["applicationName"]
             and w["usename"] == "finnor_worker" and w["wait_event_type"] == "Lock"
             and case["gate"]["holderPid"] in w["blockers"]]
    need(waits, "ACTUAL_BLOCKED_RESTRICTED_BACKEND")
    locks = contended["locks"]
    if case["track"] == "A":
        need(any("pg_advisory_xact_lock" in w["query"] for w in waits), "ACTUAL_S5_OWNER_LOCK_WAIT")
        held = [l for l in locks if l["pid"] == case["gate"]["holderPid"] and l["locktype"] == "advisory" and l["granted"]]
        need(any(any(l["pid"] == w["pid"] and l["locktype"] == "advisory" and not l["granted"]
                     and (l["classid"], l["objid"], l["objsubid"]) == (h["classid"], h["objid"], h["objsubid"])
                     for l in locks for w in waits) for h in held), "SAME_ACTUAL_PORTFOLIO_ADVISORY_LOCK")
    else:
        need(any("INSERT INTO finnor_os.p1_events" in w["query"] for w in waits), "POST_SUBMITTED_REAL_TRACE_INSERT_GATE")
        need(any(l["pid"] == case["gate"]["holderPid"] and l["relation"] in ("p1_events", "finnor_os.p1_events")
                 and l["mode"] == "ShareLock" and l["granted"]
                 for l in locks), "ACTUAL_P1_EVENTS_SHARE_LOCK")
        need(any(l["pid"] == w["pid"] and l["relation"] in ("p1_events", "finnor_os.p1_events")
                 and l["mode"] == "RowExclusiveLock" and not l["granted"] for l in locks for w in waits), "ACTUAL_INSERT_LOCK_WAITER")
    expired_job = unique(cuts["lease-expired"]["jobs"])[job["id"]]
    need(expired_job["status"] == "running" and when(expired_job["lease_expires_at"]) <= when(cuts["lease-expired"]["clock"]["at"]),
         "ORIGINAL_DATABASE_LEASE_NATURAL_EXPIRY")
    recovered_job = unique(cuts["queue-recovered"]["jobs"])[job["id"]]
    need(recovered_job["status"] == "quarantined" and recovered_job["claim_token"] is None, "CANONICAL_PROTOCOL3_QUARANTINE")
    recovered_delivery = unique(cuts["queue-recovered"]["deliveries"])[delivery["id"]]
    need(recovered_delivery["outcome"] == "reconciliation_required" and recovered_delivery["failure_kind"] == "lease_expired"
         and recovered_delivery["finished_at"] is not None, "CANONICAL_DELIVERY_RECONCILIATION_REQUIRED")
    recovery_calls = [x for x in traces["replacement"] if x["type"] == "observation" and x["operation"] == "recover"]
    need(recovery_calls and recovery_calls[0]["result"] >= 1 and case["canonicalRecoveryCount"] >= 1, "REAL_CANONICAL_RECOVERY_CALL")
    need(when(recovery_calls[0]["startedAt"]) >= when(cuts["lease-expired"]["clock"]["at"]), "RECOVERY_AFTER_ORIGINAL_EXPIRY")
    need(any(x["operation"] == "economic-orchestration-reconcile" and x["identity"] == "actor" and x["status"] == 200 for x in calls),
         "ACTUAL_SIGNED_RECONCILE")
    previous = e
    previous_spent = spent(selected)
    previous_attempt_ids = set()
    for cut in case["cuts"]:
        q, search, episode = cut["parent"], cut["search"], cut["episode"]
        for field in ("id", "tenant_id", "principal_id", "work_id", "work_input_id", "work_input_digest", "episode_id",
                      "plan_revision_id", "request", "request_digest"):
            need(q[field] == p[field], "ORIGINAL_PARENT_IDENTITY_RENEWED", field)
        need(search["id"] == s["id"] and search["request"] == s["request"] and search["binding"] == s["binding"]
             and search["context"] == s["context"], "ORIGINAL_SEARCH_OWNER_OR_SOURCE_RENEWED")
        need(cut["inputs"] == selected["inputs"] and cut["sources"] == selected["sources"], "ORIGINAL_INPUT_OR_SOURCE_CHANGED")
        need(cut["sourceVersions"] == selected["sourceVersions"] and cut["derivations"] == selected["derivations"],
             "ORIGINAL_SOURCE_VERSION_OR_DERIVATION_CHANGED")
        current_units = unique(cut["units"])
        for original_id, original_row in unique(selected["units"]).items():
            row = current_units[original_id]
            need(all(row[k] == original_row[k] for k in ("tenant_id", "principal_id", "search_id", "generation", "kind", "body", "digest")),
                 "ORIGINAL_UNIT_OR_ACCEPTANCE_REPLACED")
        for field in ("id", "tenant_id", "principal_id", "work_id", "max_steps", "max_attempts", "max_candidates", "max_depth", "deadline_at"):
            need(episode[field] == e[field], "ORIGINAL_EPISODE_BOUND_RENEWED", field)
        for used, maximum in (("steps_used", "max_steps"), ("attempts_used", "max_attempts"), ("candidates_used", "max_candidates")):
            need(int(previous[used]) <= int(episode[used]) <= int(episode[maximum]), "ORIGINAL_COUNTER_REFUND_OR_OVERSPEND", used)
        need(previous_spent <= spent(cut) <= int(s["binding"]["capacity"]), "ORIGINAL_S5_DEBIT_REFUND_OR_OVERSPEND")
        need(not cut["effects"] and not cut["consumptions"], "UNREQUESTED_BUSINESS_EFFECT_OR_SETTLEMENT")
        reservation = one(cut["reservations"], "ORIGINAL_S5_RESERVATION_REQUIRED")
        need(reservation["reservation_id"] == selected["reservations"][0]["reservation_id"]
             and reservation["status"] == selected["reservations"][0]["status"] != "RELEASED"
             and reservation["envelopes"] == selected["reservations"][0]["envelopes"], "ORIGINAL_RESERVATION_REFUNDED_OR_CHANGED")
        need(cut["reservationOrigins"] == selected["reservationOrigins"], "ORIGINAL_RESERVATION_ORIGIN_CHANGED")
        attempts = unique(cut["attempts"])
        need(previous_attempt_ids <= set(attempts), "PHYSICAL_ATTEMPT_HISTORY_ERASED")
        jobs = unique(cut["jobs"])
        retained_job = jobs[job["id"]]
        need(retained_job["payload"] == job["payload"] and retained_job["idempotency_key"] == job["idempotency_key"]
             and retained_job["protocol_version"] == 3, "ORIGINAL_FAILED_JOB_IDENTITY_CHANGED")
        if cut["label"] != "selected":
            retained_delivery = unique(cut["deliveries"])[delivery["id"]]
            need(retained_delivery["job_id"] == delivery["job_id"] and retained_delivery["claim_token"] == delivery["claim_token"]
                 and retained_delivery["claim_fence"] == delivery["claim_fence"]
                 and int(retained_job["attempts"]) >= int(claimed["attempts"]), "ORIGINAL_CLAIM_COST_OR_HISTORY_ERASED")
        for attempt in attempts.values():
            body, physical_job = attempt["body"], jobs[attempt["body"]["jobId"]]
            need(body["originalEpisode"] == e["id"] and body["grantDigest"] == original["grant"]["contentDigest"]
                 and body["chargedNativeAttempts"] == 1 and body["protocolVersion"] == 3 and body["costUSD"] is None,
                 "ACTUAL_PHYSICAL_ORIGINAL_DEBIT_BINDING")
            need(attempt["tenant_id"] == physical_job["tenant_id"] == p["tenant_id"]
                 and attempt["principal_id"] == p["principal_id"] and attempt["search_id"] == s["id"]
                 and physical_job["protocol_version"] == 3, "PHYSICAL_ATTEMPT_SCOPE_PROTOCOL")
            need(body["deliveryAttemptId"] == attempt["delivery_id"] and int(body["claimFence"]) == int(attempt["claim_fence"]),
                 "PHYSICAL_DELIVERY_FENCE")
            physical_unit = current_units[attempt["unit_id"]]
            delivery_row = unique(cut["deliveries"])[attempt["delivery_id"]]
            payload = physical_job["payload"]
            need(delivery_row["job_id"] == physical_job["id"] and int(delivery_row["claim_fence"]) == int(attempt["claim_fence"])
                 and payload["tenantId"] == p["tenant_id"] and payload["principalId"] == p["principal_id"]
                 and payload["searchId"] == s["id"] and payload["unitId"] == physical_unit["id"]
                 and int(payload["generation"]) == int(physical_unit["generation"]), "PHYSICAL_ORIGINAL_JOB_PAYLOAD_DELIVERY")
            expected_key = (f"p2:{s['id']}:{physical_unit['generation']}:{physical_unit['id']}:admission:"
                            f"{int(body['unitInvocation']) - 1}:w1-plan:{payload['w1SelectionGroupRef']}")
            need(physical_job["idempotency_key"] == expected_key
                 and payload["w1SelectionGroupRef"] == body["w1SelectionGroupRef"], "EXACT_PHYSICAL_PLAN_KEY_AND_ADMISSION_COUNT")
            need(when(body["originalDeadlineAt"]) == when(e["deadline_at"])
                 and when(payload["originalDeadlineAt"]) == when(e["deadline_at"])
                 and when(body["deliveryDeadlineAt"]) <= when(e["deadline_at"]), "PHYSICAL_DEADLINE_EXTENDED")
        need(not any(u["kind"] == "CONTROL_W1" for u in cut["units"]) and not cut["capsules"], "POSITIVE_NATIVE_ORACLE_REQUIRED_NOT_SKIPPABLE")
        previous, previous_spent, previous_attempt_ids = episode, spent(cut), set(attempts)
    return cuts, expected, unit, job, delivery


def track_a(record, case, root):
    cuts, expected, original_unit, original_job, delivery = common(record, case, root)
    uid, jid = original_unit["id"], original_job["id"]
    for label in ("selected", "contended", "killed", "released", "lease-expired", "queue-recovered", "reconciled"):
        cut = cuts[label]
        need(not cut["attempts"], "PRE_ADMISSION_MUST_HAVE_ZERO_PHYSICAL_INTENT")
        need(spent(cut) == spent(cuts["selected"]) and cut["episode"]["attempts_used"] == cuts["selected"]["episode"]["attempts_used"],
             "PRE_ADMISSION_MUST_NOT_DEBIT")
        if label != "reconciled":
            need(unique(cut["units"])[uid]["status"] == "QUEUED", "REAL_PRE_ADMISSION_QUEUED_UNIT")
            need(not any(l["owner_id"].startswith("p2:") for l in cut["leases"]), "NO_PRE_ADMISSION_PHYSICAL_OCCUPANCY")
    reconciled = cuts["reconciled"]
    failure = [x for x in reconciled["events"] if x["kind"] == "W1_PRE_ADMISSION_DELIVERY_RECONCILED"
               and x["body"].get("unitId") == uid and x["body"].get("jobId") == jid]
    final = cuts["final"]
    need(all(not (a["body"]["jobId"] == jid or a["unit_id"] == uid) for a in final["attempts"]), "FAILED_DELIVERY_REPLAYED")
    if unique(reconciled["units"])[uid]["status"] == "QUEUED":
        need(not failure and not final["attempts"] and final["parent"]["status"] != "TESTED"
             and unique(final["jobs"])[jid]["status"] == "quarantined", "WRONG_BASELINE_FAILURE")
        raise Failed("PLAN_QUALIFIED_PRE_ADMISSION_STUCK", "Exact original protocol3 plan key is not reconciled; original unit remains QUEUED.")
    event = one(failure, "TRUTHFUL_PRE_ADMISSION_RECOVERY_EVENT")
    need(event["body"]["physicalCallProvenAbsent"] is True and event["body"]["attemptChargeApplied"] is False
         and event["body"]["originalEpisode"] == case["original"]["episodeId"]
         and event["body"]["originalGrantRetained"] is True and event["body"]["localWorkerCostUSD"] is None,
         "TRUTHFUL_NO_ADMISSION_DISPOSITION")
    units = unique(final["units"])
    need(units[uid]["status"] == "FAILED" and int(units[uid]["attempts"]) == int(original_unit["attempts"]), "FAILED_ORIGINAL_UNIT_MUST_NOT_RETRY")
    dependent = [u for u in units.values() if uid in u["body"]["prerequisites"]]
    need(dependent and all(u["status"] == "CANCELLED" and int(u["attempts"]) == 0 for u in dependent), "FAILED_PREREQUISITE_VERIFIER_NOT_BYPASSED")
    executes = [u for u in units.values() if u["kind"] == "EXECUTE_P1" and u["status"] == "COMPLETED"
                and u["body"]["moduleId"] != original_unit["body"]["moduleId"]]
    execute = one(executes, "ACTUAL_COMPATIBLE_ALTERNATIVE_EXECUTION")
    module = one([m for m in cuts["selected"]["search"]["context"]["program"]["modules"]
                  if m["id"] == execute["body"]["moduleId"]], "COMPATIBLE_MODULE_MUST_BE_IN_ORIGINAL_FRONTIER")
    need(hashlib.sha256(module["compiled"].encode()).hexdigest() == module["compiledDigest"]
         and hashlib.sha256(module["source"].encode()).hexdigest() == module["sourceDigest"],
         "ORIGINAL_COMPATIBLE_MODULE_BYTES")
    verify = one([u for u in units.values() if u["kind"] == "VERIFY_P1" and u["status"] == "COMPLETED"
                  and u["body"]["prerequisites"] == [execute["id"]]], "ACTUAL_COMPATIBLE_SQL_VERIFICATION")
    for target in final["parent"]["request"]["acceptance"]["targets"]:
        key = target["key"]
        need(fraction(execute["result"]["values"][key]["value"]) == expected[key], "ALTERNATIVE_ORIGINAL_EXPRESSION")
        check = one([x for x in verify["result"]["checks"] if x["id"] == "numeric:" + key], "ALL_SQL_ACCEPTANCE_TARGETS_REQUIRED")
        need(check["status"] == "PASS" and check["method"] == "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION"
             and fraction(check["expected"]) == fraction(check["actual"]) == expected[key], "INDEPENDENT_POSTGRES_CHECK")
    physical = unique(final["attempts"])
    need(len(physical) == 2 and all(a["status"] == "COMPLETED" for a in physical.values()), "REAL_ALTERNATIVE_EXECUTE_AND_CHECK_ATTEMPTS")
    for unit in (execute, verify):
        a = one([a for a in physical.values() if a["unit_id"] == unit["id"]], "ACTUAL_ALTERNATIVE_ATTEMPT")
        selection = one([x for x in final["events"] if x["kind"] == "W1_NATIVE_FALLBACK_APPLIED"
                         and x["body"].get("unitId") == unit["id"] and x["body"].get("selectionGroupRef") == a["body"]["w1SelectionGroupRef"]],
                        "ACTUAL_POST_RECOVERY_FALLBACK_DISPATCH")
        need(when(selection["created_at"]) >= when(event["created_at"])
             and selection["body"]["remaining"]["attempts"] >= 1 and selection["body"]["remaining"]["steps"] >= a["body"]["steps"],
             "ACTUAL_CURRENT_REMAINING_BUDGET_FALLBACK")
        j = unique(final["jobs"])[a["body"]["jobId"]]
        need(j["status"] == "completed" and j["payload"]["w1SelectionGroupRef"] == a["body"]["w1SelectionGroupRef"],
             "ALTERNATIVE_PHYSICAL_JOB_COMPLETION")
        d = one([d for d in final["deliveries"] if d["id"] == a["delivery_id"]], "ALTERNATIVE_DURABLE_DELIVERY")
        need(d["worker_id"] == "p5-physical-" + str(case["replacementPid"]) and d["outcome"] == "completed", "REPLACEMENT_ACTUALLY_EXECUTED")
    isolated = one([x["body"] for x in final["p1Events"] if x["kind"] == "ISOLATED_MODULE_EXECUTION"
                    and x["body"]["moduleId"] == execute["body"]["moduleId"]], "ACTUAL_ISOLATED_EXECUTION_RECEIPT")
    need(isolated["execution"]["exitCode"] == 0 and isolated["execution"]["termination"] == "EXITED", "ACTUAL_ISOLATED_EXECUTION_EXIT")
    need(isolated["emittedDigest"] == module["typescript"]["emittedDigest"]
         and hashlib.sha256(module["typescript"]["emitted"].encode()).hexdigest() == isolated["emittedDigest"],
         "ACTUAL_COMPATIBLE_EMITTED_BYTES")
    need(all(fraction(isolated["outputs"][k]) == v for k, v in expected.items()), "ISOLATED_OUTPUT_RECOMPUTATION")
    need(final["parent"]["status"] == "TESTED" and case["programRead"]["status"] == 200
         and case["programRead"]["body"]["status"] == "TESTED", "ORIGINAL_P1_MUST_BE_TESTED")
    program = one([p["body"] for p in final["programs"] if p["id"] == final["parent"]["head_id"]], "ACTUAL_P1_IMMUTABLE_HEAD")
    need(program["status"] == "TESTED" and program["acceptance"] == cuts["selected"]["parent"]["request"]["acceptance"],
         "ORIGINAL_P1_ACCEPTANCE_UNCHANGED")
    for target in program["acceptance"]["targets"]:
        value = program["result"]["values"][target["key"]]
        need(fraction(value["value"]) == expected[target["key"]] and value["semantics"]["unit"] == target["unit"]
             and value["semantics"]["currencyCode"] == target["currencyCode"], "ORIGINAL_FINAL_RESULT")
    need(spent(final) - spent(cuts["selected"]) >= 2
         and final["episode"]["attempts_used"] - cuts["selected"]["episode"]["attempts_used"] >= 2, "REAL_FALLBACK_DEBITS_RETAINED")
    need(not active_leases(final) and not head_plan(final)["outstanding"], "NO_HIDDEN_FINAL_OCCUPANCY_OR_OUTSTANDING")
    return {"status": "PASS", "expected": {k: str(v) for k, v in expected.items()}, "physicalAttempts": 2,
            "failedDelivery": jid, "compatibleExecuteUnit": execute["id"], "sqlVerifyUnit": verify["id"]}


def track_b(record, case, root):
    cuts, _, unit, job, delivery = common(record, case, root)
    need(case["physicalOutcome"] == "MAY_HAVE_EXECUTED", "SUBMITTED_IS_NOT_PROVEN_ABSENT")
    submitted = one(cuts["contended"]["attempts"], "REAL_SUBMITTED_ATTEMPT_REQUIRED")
    need(submitted["status"] == "SUBMITTED" and submitted["unit_id"] == unit["id"]
         and submitted["body"]["jobId"] == job["id"] and submitted["delivery_id"] == delivery["id"], "REAL_SUBMITTED_IDENTITY")
    need(unique(cuts["contended"]["units"])[unit["id"]]["status"] == "RUNNING", "REAL_ADMITTED_RUNNING_UNIT")
    need(spent(cuts["contended"]) == spent(cuts["selected"]) + 1
         and cuts["contended"]["episode"]["attempts_used"] == cuts["selected"]["episode"]["attempts_used"] + 1, "ACTUAL_ORIGINAL_SUBMISSION_DEBIT")
    need(any(l["owner_id"] == "p2:" + submitted["delivery_id"] for l in active_leases(cuts["contended"])), "REAL_SUBMITTED_PHYSICAL_OCCUPANCY")
    for label in ("reconciled", "resumed", "cancelled", "resume-refused", "physical-leases-expired", "final"):
        cut = cuts[label]
        unknown = one(cut["attempts"], "UNKNOWN_MUST_NOT_BE_REPLAYED_OR_ERASED")
        need(unknown["id"] == submitted["id"] and unknown["status"] == "UNKNOWN"
             and unknown["unit_id"] == submitted["unit_id"] and unknown["delivery_id"] == submitted["delivery_id"]
             and unknown["endpoint_key"] == submitted["endpoint_key"] and unknown["claim_fence"] == submitted["claim_fence"],
             "ORIGINAL_UNKNOWN_IDENTITIES_RETAINED")
        for key, value in submitted["body"].items():
            need(unknown["body"].get(key) == value, "ORIGINAL_SUBMITTED_RECEIPT_OR_EFFECT_ID_CHANGED", key)
        need(unknown["body"]["physicalOutcome"] == "UNKNOWN" and unknown["body"]["liabilityRetained"] is True,
             "UNKNOWN_LIABILITY_NOT_SETTLED")
        need(unique(cut["units"])[unit["id"]]["status"] == "UNKNOWN"
             and spent(cut) == spent(cuts["contended"])
             and cut["episode"]["attempts_used"] == cuts["contended"]["episode"]["attempts_used"]
             and cut["episode"]["steps_used"] == cuts["contended"]["episode"]["steps_used"], "UNKNOWN_DEBIT_NOT_REFUNDED")
        exposure = one(head_plan(cut)["outstanding"], "ORIGINAL_UNKNOWN_OUTSTANDING_EXPOSURE")
        need(exposure["attemptId"] == submitted["id"] and exposure["unitId"] == unit["id"]
             and exposure["status"] == "UNKNOWN" and exposure["liabilityRetained"] is True
             and exposure["mayRetry"] is False, "UNKNOWN_EXPOSURE_MUST_NOT_SETTLE_OR_RETRY")
        need(cut["parent"]["status"] != "TESTED" and not any(u["status"] == "COMPLETED" for u in cut["units"]),
             "UNKNOWN_CANNOT_CREATE_SUCCESS")
        need(not any(j["type"] == "run_compute_search_unit_v1" and j["status"] in ("queued", "running") for j in cut["jobs"]),
             "UNKNOWN_MUST_NOT_DISPATCH_ALTERNATIVE")
    need(cuts["reconciled"]["search"]["status"] == cuts["resumed"]["search"]["status"] == "WAITING", "UNKNOWN_RESUME_MUST_WAIT")
    need(cuts["cancelled"]["search"]["status"] == cuts["final"]["search"]["status"] == "CANCELLED", "CANONICAL_CANCEL_RETAINED")
    need(all(unique(cuts[label]["jobs"])[job["id"]]["status"] == "quarantined"
             for label in ("reconciled", "resumed", "cancelled", "resume-refused", "physical-leases-expired", "final")),
         "ORIGINAL_UNKNOWN_JOB_MUST_NOT_REPLAY")
    need(int(cuts["cancelled"]["search"]["generation"]) == int(cuts["selected"]["search"]["generation"]) + 1,
         "ONLY_CANONICAL_CANCELLATION_GENERATION_CHANGE")
    resumes = [x for x in case["calls"] if x["operation"] == "economic-orchestration-resume"]
    need([x["status"] for x in resumes] == [202, 422]
         and resumes[1]["body"].get("predicate") == "P2_TERMINAL_SEARCH_CANNOT_RENEW", "REAL_RESUME_CANCEL_REFUSAL")
    need(case["resumeTick"] is False and case["afterCancelTick"] is False and case["lateTick"] is False, "UNKNOWN_CANNOT_REPLAY_ON_TICK")
    final = cuts["final"]
    need(not active_leases(final), "NATURALLY_EXPIRED_OCCUPANCY_NOT_RENEWED")
    lease_ids = {l["id"] for l in cuts["contended"]["leases"] if l["owner_id"] == "p2:" + submitted["delivery_id"]}
    final_leases = unique(final["leases"])
    need(lease_ids and lease_ids <= set(final_leases), "ORIGINAL_PHYSICAL_LEASE_HISTORY_RETAINED")
    for lid in lease_ids:
        lease = final_leases[lid]
        need(lease["released_at"] is None and when(lease["expires_at"]) <= when(final["clock"]["at"]),
             "PHYSICAL_LEASE_MUST_EXPIRE_NATURALLY_NOT_BE_FORGED_RELEASED")
    event = one([e for e in cuts["reconciled"]["events"] if e["kind"] == "RECOVERY_RECONCILED"
                 and e["body"].get("attemptId") == submitted["id"]], "REAL_UNKNOWN_RECONCILIATION_EVENT")
    need(event["body"]["unknown"] is True and event["body"]["grantChargesRetained"] is True
         and event["body"]["unsafeResubmission"] is False, "NO_UNSAFE_SUBMISSION_RECOVERY")
    return {"status": "PASS", "physicalOutcome": "UNKNOWN", "attemptId": submitted["id"],
            "outstandingExposureRetained": True, "debitRetained": spent(final), "settlementEvidence": None}


def check(record, root):
    need(record["schema"] == "finnor.w1.physical-recovery.v2", "WRONG_OBSERVATION_SCHEMA")
    need(not record.get("freezeFailure"), "FROZEN_SOURCE_CHANGED")
    need(record["productionIdentity"] == record["finalProductionIdentity"], "LOADED_PRODUCTION_IDENTITY_CHANGED")
    need(record["runnerFreezeBefore"] == record["runnerFreezeAfter"], "SCRIPT_OR_PRODUCTION_BYTES_CHANGED_DURING_RUN")
    need(record["runner"]["totalWallMs"] <= 300000, "TOTAL_RUNNER_300S_BOUND")
    need(all(p["exitCode"] == 0 and p["wallMs"] <= 120000 for p in record["runner"]["driverProcesses"]), "PHYSICAL_DRIVER_PROCESS_FAILED_OR_TIMED_OUT")
    need(record["network"]["installed"] and record["network"]["blockedExternalAttempts"] == 0, "EXTERNAL_NETWORK_FORBIDDEN")
    need(record["protectedAdmission"] is False and record["productionActivated"] is False and record["authorityGranted"] is False,
         "DEVELOPMENT_ONLY_SCOPE")
    need(record["billingUSD"] is None and record["completeChildUsage"] is None, "UNKNOWN_DOLLARS_AND_CHILDREN_RETAINED")
    files = {f["path"]: f["sha256"] for f in record["productionIdentity"]["files"]}
    need(files[API] == (BROKEN_SHA if record["phase"] == "broken" else REPAIRED_SHA), "EXACT_API_EPOCH_PREIMAGE")
    cases = unique(record["cases"], "track")
    need(set(cases) == {"A", "B"}, "BOTH_PHYSICAL_RECOVERY_TRACKS_REQUIRED")
    results = {}
    for track, fn in (("A", track_a), ("B", track_b)):
        try:
            results[track] = fn(record, cases[track], root)
        except Exception as error:
            results[track] = {"status": "FAIL", "predicate": getattr(error, "predicate", type(error).__name__), "message": str(error)}
    baseline_match = (record["phase"] == "broken" and results["A"].get("predicate") == "PLAN_QUALIFIED_PRE_ADMISSION_STUCK"
                      and results["B"]["status"] == "PASS")
    passed = all(r["status"] == "PASS" for r in results.values())
    return {"status": "PASS" if passed else "FAIL", "tracks": results, "expectedFailureMatch": baseline_match,
            "predicate": "PLAN_QUALIFIED_PRE_ADMISSION_STUCK" if baseline_match else None,
            "nativePositiveOracle": "NOT_APPLICABLE_NO_CONTROL_OR_CAPSULE",
            "economicGainQualified": False, "protectedAdmission": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("observations", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    raw = args.observations.read_bytes()
    try:
        outcome = check(json.loads(raw), args.observations.parent)
    except Exception as error:
        outcome = {"status": "FAIL", "predicate": getattr(error, "predicate", type(error).__name__),
                   "message": str(error), "expectedFailureMatch": False}
    outcome["originalObservationsSha256"] = hashlib.sha256(raw).hexdigest()
    args.output.write_text(json.dumps(outcome, indent=2) + "\n")
    print(json.dumps(outcome))
    raise SystemExit(0 if outcome["status"] == "PASS" else 1)
