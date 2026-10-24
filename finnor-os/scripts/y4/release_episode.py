"""E1 against retained native synthetic results, without changing prior state."""
import copy
import datetime as dt
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

from backend import file_digest, source_identity
from compiler import compile_function, digest, canonical
from correspondence import check
from participant import prepare

PACKAGE = Path(__file__).resolve().parents[2] / "packages/private-equity/src/confidential-computation"


def run(evidence, original):
    if original is None or not original.is_absolute():
        raise ValueError("RETAINED_ABSOLUTE_NATIVE_EPISODE_REQUIRED")
    original = original.resolve(strict=True)
    if "PRIVATE-NOT-FOR-HANDOFF" in original.parts or original.name != "numerical" \
            or not str(original).startswith("/home/factory-user/y4-delivery/finite-"):
        raise ValueError("ONLY_RETAINED_TASK_SYNTHETIC_NUMERICAL_EPISODE_ALLOWED")
    previous = json.loads((original / "result.json").read_text())
    if previous["status"] != "PASS" or previous["case"] != "numerical" \
            or previous["identity"] != source_identity() or previous["protectedSubmission"] is not False:
        raise ValueError("CURRENT_SUCCESSFUL_SYNTHETIC_NATIVE_RESULT_REQUIRED")
    bundle = json.loads((original / "public-bundle.json").read_text())
    protocol, binding = bundle["protocol"], bundle["binding"]
    f = protocol["function"]
    check(f, protocol)
    if f["purpose"] != "LOCAL_SYNTHETIC_Y4_ENGINEERING_NO_ECONOMIC_EFFECT" \
            or [p["id"] for p in f["participants"]] != ["p0", "p1", "p2"] \
            or {p["key"] for p in f["inputs"]} != {"a", "b", "c"}:
        raise ValueError("KNOWN_SYNTHETIC_ORIGINAL_REQUIRED")
    private = evidence / "PRIVATE-NOT-FOR-HANDOFF"
    private.mkdir(mode=0o700)
    retained = original / "PRIVATE-NOT-FOR-HANDOFF"
    before = {str(p.relative_to(retained)): file_digest(p) for p in retained.rglob("*") if p.is_file()}
    values = {"a": "-24", "b": "8", "c": "3"}
    cuts = {p["id"]: json.loads((retained / p["id"] / "authority.json").read_text()) for p in f["participants"]}

    def records(function, participant):
        return {port["key"]: {"key": port["key"], "value": values[port["key"]],
                "sourceRef": port["sourceRef"], "validationRef": port["validationRef"]}
                for port in function["inputs"] if port["participantId"] == participant}

    for participant, cut in cuts.items():
        if {key: digest(record) for key, record in records(f, participant).items()} != cut["recordDigests"]:
            raise ValueError("UNKNOWN_SYNTHETIC_ORIGINAL_BYTES")

    def export(participant, state, authority, predicate=None):
        result = subprocess.run([sys.executable, "-B", str(PACKAGE / "participant.py"), "export",
            "--bundle", str(original / "public-bundle.json"), "--participant", participant,
            "--state", str(state), "--authority", str(authority)],
            capture_output=True, text=True, timeout=15,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "FINNOR_Y4_SUPERVISOR_PID": str(os.getpid())})
        body = json.loads(result.stdout)
        if predicate is not None:
            assert result.returncode == 2 and body.get("state") == "REFUSED" \
                and body.get("predicate") == predicate, "RECIPIENT_EXPORT_REFUSAL_MISSED_ITS_BOUNDARY"
        else:
            assert result.returncode == 0, "CURRENT_NATIVE_RECIPIENT_EXPORT_FAILED"
            expected = {o["key"] for o in f["outputs"] if participant in o["recipients"]}
            assert {o["key"] for o in body["outputs"]} == expected, "UNAUTHORIZED_OUTPUT_IN_NATIVE_EXPORT"
        return {"participantId": participant, "status": "PASS",
                "predicate": predicate or "EXACT_NATIVE_RECIPIENT_OUTPUT_SET", "privateBodyOmitted": True}

    observations = []
    for participant in cuts:
        state = retained / participant
        observations.append(export(participant, state, state / "authority.json"))
    observations.append(export("p1", retained / "p0", retained / "p1/authority.json",
                               "EXACT_ORIGINAL_RECIPIENT_AUTHORITY_REQUIRED"))
    denials = []
    for variant in ("same-function", "changed-function", "family-label", "source-version", "grant-handle", "work-label"):
        candidate = copy.deepcopy(f)
        if variant == "changed-function":
            candidate["outputs"][0]["expression"] = {"kind": "add",
                "left": candidate["outputs"][0]["expression"],
                "right": {"kind": "literal", "value": "1", "unit": "count", "currencyCode": None}}
        elif variant == "family-label":
            candidate["release"]["familyId"] = "synthetic-alias-" + str(uuid.uuid4())
        elif variant == "source-version":
            for port in candidate["inputs"]:
                port["sourceRef"].update(version="synthetic-alias-v2", contentDigest=digest({"newVersion": port["key"]}))
        elif variant == "grant-handle":
            for port in candidate["inputs"]:
                port["grantRef"]["id"] = "synthetic-grant-alias-" + str(uuid.uuid4())
        elif variant == "work-label":
            candidate["workRevisionRef"]["id"] = "synthetic-other-work-" + str(uuid.uuid4())
        compiled = compile_function(candidate)
        check(candidate, compiled)
        session = {**binding["session"], "sessionId": uuid.uuid4().hex, "functionDigest": compiled["functionDigest"]}
        for participant in cuts:
            cut = copy.deepcopy(cuts[participant])
            owned = [p for p in candidate["inputs"] if p["participantId"] == participant]
            local_records = records(candidate, participant)
            cut.update(functionDigest=compiled["functionDigest"],
                sourceRefs=[p["sourceRef"] for p in owned], grantRefs=[p["grantRef"] for p in owned],
                validationRefs=[p["validationRef"] for p in owned],
                recordDigests={key: digest(record) for key, record in local_records.items()},
                outputRecipients={o["key"]: o["recipients"] for o in candidate["outputs"]})
            path = private / f"{variant}-{participant}.owner-cut.private.json"
            path.write_text(canonical(cut))
            try:
                prepare(compiled, session, participant, local_records, path, retained / participant)
                raise AssertionError("ADAPTIVE_STABLE_SOURCE_REQUERY_ACCEPTED")
            except ValueError as error:
                assert str(error) == "CUMULATIVE_DISCLOSURE_BUDGET_CONSUMED", "ADAPTIVE_QUERY_MISSED_ITS_LEDGER_BOUNDARY"
                denials.append({"variant": variant, "participantId": participant,
                               "predicate": str(error), "status": "PASS"})
    for variant in ("revoked", "expired"):
        cut = copy.deepcopy(cuts["p0"])
        if variant == "revoked":
            cut["revoked"] = True
        else:
            cut["expiresAt"] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)).isoformat()
        path = private / f"{variant}.owner-cut.private.json"
        path.write_text(canonical(cut))
        observations.append(export("p0", retained / "p0", path, "PARTICIPANT_CONSENT_NOT_CURRENT"))
    after = {str(p.relative_to(retained)): file_digest(p) for p in retained.rglob("*") if p.is_file()}
    assert before == after, "RELEASE_CHECK_MODIFIED_PRIOR_PRIVATE_STATE"
    return {"status": "PASS", "scope": "PARTICIPANT_LOCAL_CURRENT_NATIVE_OUTPUTS_AND_DISCLOSURE_HISTORY",
            "originalEpisode": str(original), "originalResultSha256": file_digest(original / "result.json"),
            "originalDeadlineAt": binding["session"]["deadlineAt"], "recipientChecks": observations,
            "adaptivePrepareDenials": denials, "priorPrivateStateBytesUnchanged": True,
            "originalDeadlineNotRenewed": True, "outputsAndNoncesOmitted": True,
            "sourceTruthProven": False, "protectedCases": 0, "separatelyAdministered": False,
            "canonicalApiRevocationIsSeparateLifecyclePredicate": True}
