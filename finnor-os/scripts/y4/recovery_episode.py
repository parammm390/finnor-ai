"""Read-only reconciliation of actual retained native aborts, not unsafe resume."""
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

from backend import file_digest, source_identity

PACKAGE = Path(__file__).resolve().parents[2] / "packages/private-equity/src/confidential-computation"


def run(evidence, original, backend):
    if original is None or not original.is_absolute() \
            or original.parent != Path("/home/factory-user/y4-delivery") \
            or not original.name.startswith("adverse-") or original.resolve(strict=True) != original:
        raise ValueError("RETAINED_TASK_SYNTHETIC_ADVERSE_EPISODE_REQUIRED")
    previous = json.loads((original / "result.json").read_text())
    assert previous["status"] == "PASS" and previous["case"] == "adverse" \
        and previous["identity"] == source_identity() and previous["protectedSubmission"] is False, \
        "CURRENT_SUCCESSFUL_NATIVE_ABORT_OBSERVATIONS_REQUIRED"
    before = {str(p.relative_to(original)): file_digest(p)
              for p in original.rglob("*") if p.is_file() and not p.is_symlink()}
    observations = []
    for fault in previous["requestedFaults"]:
        episode = original / fault
        observed = json.loads((episode / "result.json").read_text())
        assert observed["states"] == ["ABORTED"] * 3 and observed["nativeRuntimesReached"] == 3 \
            and observed["preprocessingReplayDenied"] == ["FRESH_VERIFIED_SESSION_REQUIRED"] * 3 \
            and observed["nativeProcessesStopped"] is True, "ORIGINAL_FAULT_BOUNDARY_UNPASSED"
        bundle = json.loads((episode / "public-bundle.json").read_text())
        session = bundle["binding"]["session"]
        for p in bundle["protocol"]["function"]["participants"]:
            state = episode / "PRIVATE-NOT-FOR-HANDOFF" / p["id"]
            command = [sys.executable, "-B", str(PACKAGE / "participant.py")]
            options = ["--bundle", str(episode / "public-bundle.json"), "--participant", p["id"],
                       "--state", str(state), "--authority", str(state / "authority.json")]
            env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1",
                   "FINNOR_Y4_SUPERVISOR_PID": str(os.getpid())}
            readings = []
            for _ in range(2):
                result = subprocess.run(command + ["status"] + options, capture_output=True,
                                        text=True, timeout=15, env=env)
                assert result.returncode == 0, "INDEPENDENT_PROCESS_RECONCILIATION_FAILED"
                readings.append(json.loads(result.stdout))
            assert readings[0] == readings[1] and readings[0]["state"] == "ABORTED", \
                "RECONCILIATION_RESTARTED_OR_CHANGED_ORIGINAL_SESSION"
            with sqlite3.connect((state / "participant.sqlite").as_uri() + "?mode=ro", uri=True) as db:
                row = db.execute("SELECT state,original_deadline,secret_json IS NULL,release_nonce IS NULL "
                                 "FROM attempts WHERE session=?", (session["sessionId"],)).fetchone()
                assert row == ("ABORTED", session["deadlineAt"], 1, 1), "ORIGINAL_BURNED_STATE_LOST"
                assert db.execute("SELECT count(*) FROM disclosure").fetchone()[0] == 1, \
                    "FAILED_ATTEMPT_DISCLOSURE_REFUNDED"
            result = subprocess.run(command + ["run"] + options + [
                "--manifest", str(episode / "native/emitted/program.json"),
                "--backend", str(backend)], capture_output=True, text=True, timeout=15, env=env)
            refusal = json.loads(result.stdout)
            assert result.returncode == 2 and refusal["state"] == "REFUSED" \
                and refusal["predicate"] in ("FRESH_VERIFIED_SESSION_REQUIRED", "ORIGINAL_DEADLINE_EXPIRED",
                                              "PARTICIPANT_CONSENT_NOT_CURRENT"), \
                "BURNED_OR_EXPIRED_NATIVE_SESSION_REPLAYED"
            observations.append({"fault": fault, "participantId": p["id"], "state": "ABORTED",
                                 "separateReadProcesses": 2, "replayPredicate": refusal["predicate"],
                                 "originalDeadlineAt": session["deadlineAt"],
                                 "secretsBurned": True, "disclosureReservationsRetained": 1})
    after = {str(p.relative_to(original)): file_digest(p)
             for p in original.rglob("*") if p.is_file() and not p.is_symlink()}
    assert before == after, "RECOVERY_OBSERVATION_MODIFIED_ORIGINAL_EPISDE"
    return {"status": "PASS", "scope": "RETAINED_NATIVE_ABORT_RECONCILIATION_AND_REPLAY_REFUSAL",
            "originalEpisode": str(original), "originalResultSha256": file_digest(original / "result.json"),
            "observations": observations, "priorStateBytesUnchanged": True,
            "originalFailedCpuReservationsSeconds": previous["totalConservativeNativeCpuReservationsSeconds"],
            "automaticResume": False, "plaintextFallback": False, "deadlineRenewed": False,
            "canonicalQueueCrashRecovery": "NOT_RUN", "freshSeparatelyAuthorizedNativeRerun": "NOT_RUN",
            "effectPreservation": "NOT_RUN", "protectedCases": 0}
