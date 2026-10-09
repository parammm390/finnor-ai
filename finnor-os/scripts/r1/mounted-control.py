"""Bounded disposable controls alongside documented mounted browser actions.

This operator never submits an owner run, supplies an owner receipt, changes a
deadline or certifies a UI step. It observes the real fixture and physical PID.
"""
import datetime
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

if len(sys.argv) != 3 or sys.argv[2] not in ("queued-start", "checker-kill"):
    raise SystemExit("mounted-control.py <private browser/fixture.json> queued-start|checker-kill")
fixture_path = pathlib.Path(sys.argv[1]).resolve(strict=True)
mode = sys.argv[2]
fixture = json.loads(fixture_path.read_text())
control = fixture["control"]
parsed = urllib.parse.urlsplit(control)
if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port:
    raise SystemExit("Only the named loopback disposable fixture is supported")
out = fixture_path.parent / (mode + "-operator.json")
if out.exists():
    raise SystemExit("Retained operator evidence already exists")
receipt = {
    "schema": "finnor.r1.mounted-operator.v1",
    "mode": mode,
    "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "scriptSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
    "fixtureSha256": hashlib.sha256(fixture_path.read_bytes()).hexdigest(),
    "status": "ARMED",
    "observations": [],
    "qualification": "DISPOSABLE_CONTROL_ONLY_NOT_MOUNTED_PROOF",
    "ownerRunSubmitted": False,
    "clockOrGrantChanged": False,
}


def request(path, post=False, timeout=8):
    req = urllib.request.Request(
        control + path,
        data=b"{}" if post else None,
        headers={"content-type": "application/json"},
    )
    at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            body = json.load(response)
            receipt["observations"].append(
                {"at": at, "path": path, "status": response.status, "body": body}
            )
    except urllib.error.HTTPError as error:
        receipt["observations"].append({"at":at,"path":path,"status":error.code,"body":error.read(8192).decode(errors="replace")})
        raise
    return body


def census(pid):
    process = subprocess.run(
        ["ps", "-p", str(pid), "-o", "pid=,ppid=,stat=,command="],
        capture_output=True, text=True, timeout=3,
    )
    return {"pid": pid, "exitCode": process.returncode, "output": process.stdout}


print(json.dumps({"mode": mode, "status": "ARMED", "receipt": str(out)}), flush=True)
try:
    if mode == "queued-start":
        start = time.monotonic()
        queued_ui = fixture_path.parent / "queued.txt"
        while not queued_ui.exists():
            if time.monotonic() - start >= 90:
                raise RuntimeError("MOUNTED_QUEUED_EVIDENCE_NOT_OBSERVED_WITHIN_OPERATOR_BOUND")
            time.sleep(.02)
        text = queued_ui.read_text()
        if "Claims remain provisional." not in text or "queued. 0 physical attempts" not in text:
            raise RuntimeError("MOUNTED_QUEUED_EVIDENCE_DID_NOT_SHOW_ORIGINAL_PENDING_STATE")
        receipt["queuedUiSha256"] = hashlib.sha256(queued_ui.read_bytes()).hexdigest()
        observed = request("/observe")
        if len(observed["runs"]) != 1:
            raise RuntimeError("EXPECTED_ONE_UI_ACCEPTED_RUN")
        run = observed["runs"][0]
        due = datetime.datetime.fromisoformat(run["decision_deadline_at"].replace("Z", "+00:00"))
        if run["status"] != "QUEUED" or run["head_id"] is not None or due <= datetime.datetime.now(datetime.timezone.utc):
            raise RuntimeError("ORIGINAL_QUEUE_OR_DECISION_DEADLINE_UNAVAILABLE")
        request("/start-worker", post=True)
    else:
        start = time.monotonic()
        marker = fixture_path.parent / "checker-submit-marker.json"
        while not marker.exists():
            if time.monotonic() - start >= 90:
                raise RuntimeError("MOUNTED_CHECKER_SUBMIT_MARKER_NOT_OBSERVED")
            time.sleep(.02)
        receipt["submitMarkerSha256"] = hashlib.sha256(marker.read_bytes()).hexdigest()
        held = request("/hold-next-checker", post=True, timeout=25)
        pid = held["attempt"]["child_pid"]
        before = census(pid)
        receipt["stoppedProcess"] = before
        if before["exitCode"] != 0 or not re.search(r"\bT\S*\s", before["output"]):
            raise RuntimeError("ACTUAL_CHECKER_WAS_NOT_PHYSICALLY_STOPPED")
        killed = request("/kill-checker", post=True)
        if killed["pid"] != pid or killed["signal"] != "SIGKILL":
            raise RuntimeError("ACTUAL_CHECKER_KILL_IDENTITY_MISMATCH")
        start = time.monotonic()
        after = census(pid)
        while after["exitCode"] == 0 and time.monotonic() - start < 4:
            time.sleep(.02)
            after = census(pid)
        receipt["terminatedProcess"] = after
        if after["exitCode"] != 1:
            raise RuntimeError("ACTUAL_CHECKER_TERMINATION_NOT_OBSERVED")
    receipt["status"] = "PASS_OPERATOR"
except Exception as error:
    receipt.update(status="FAIL", failure=repr(error))
finally:
    receipt["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    out.write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"mode": mode, "status": receipt["status"], "receipt": str(out)}), flush=True)
if receipt["status"] != "PASS_OPERATOR":
    raise SystemExit(1)
