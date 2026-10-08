"""Run the genuine M2 browser fixture, Next frontend and scoped CLI observer.
Usage: python scripts/m2/run-browser.py NEW_EVIDENCE_DIR
No personal environment, bearer session or remote infrastructure is used.
"""
import hashlib
import json
import os
import pathlib
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from source_freeze import freeze, verify

backend = pathlib.Path(__file__).resolve().parents[2]
repo = backend.parent
output = pathlib.Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=False)
node = pathlib.Path(os.environ["FINNOR_TEST_NODE"]).resolve(strict=True)
python = pathlib.Path(os.environ["FINNOR_TEST_PYTHON"]).absolute()
cli = pathlib.Path(os.environ["FINNOR_AGENT_BROWSER"]).resolve(strict=True)
chrome = pathlib.Path(os.environ["FINNOR_BROWSER_EXECUTABLE"]).resolve(strict=True)
for executable in (node, python, cli, chrome):
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise SystemExit("Installed executable required")
for port in (4690, 4691, 4692, 4693):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", port))
env = {k: v for k, v in os.environ.items() if k in ("HOME", "PATH", "TMPDIR")}
env.update(FINNOR_TEST_NODE=str(node), FINNOR_TEST_PYTHON=str(python),
           FINNOR_AGENT_BROWSER=str(cli), FINNOR_BROWSER_EXECUTABLE=str(chrome))
receipt = {"schema": "finnor.m2.browser-orchestration.v1", "status": "INCOMPLETE",
           "startedAt": datetime.now(timezone.utc).isoformat(), "repo": str(repo),
           "runtime": [{"path": str(p), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                       for p in (node, python, cli, chrome)],
           "hostedSupabaseQualified": False, "billingUSD": None}
native = frontend = None
source_before = freeze(repo, output)
receipt["completeSourceDigest"] = source_before["sourceDigest"]
try:
    with (output / "native-driver.log").open("w") as native_log, (output / "frontend.log").open("w") as frontend_log:
        native_command = [str(python), "scripts/m2/run-native.py", "m2", str(output / "native"), "M2-R"]
        receipt["nativeCommand"] = native_command
        native = subprocess.Popen(native_command, cwd=backend, env=env, stdout=native_log, stderr=subprocess.STDOUT)
        end = time.monotonic() + 180
        while not (output / "native/browser/fixture.json").exists():
            if native.poll() is not None:
                raise RuntimeError("Actual native fixture terminated before browser readiness")
            if time.monotonic() > end:
                raise RuntimeError("Actual owner fixture readiness exceeded 180 seconds")
            time.sleep(.25)
        frontend_env = dict(env, NODE_ENV="development", NEXT_TELEMETRY_DISABLED="1", CI="1",
                            NEXT_PUBLIC_OS_API_URL="http://127.0.0.1:4691",
                            NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:4692",
                            NEXT_PUBLIC_SUPABASE_ANON_KEY="disposable-local-auth-key")
        frontend_command = [str(node), str(repo / "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", "4690"]
        receipt["frontendCommand"] = frontend_command
        frontend = subprocess.Popen(frontend_command, cwd=repo, env=frontend_env, stdout=frontend_log, stderr=subprocess.STDOUT)
        end = time.monotonic() + 90
        while True:
            if frontend.poll() is not None:
                raise RuntimeError("Actual Next frontend terminated before readiness")
            try:
                with socket.create_connection(("127.0.0.1", 4690), timeout=1):
                    break
            except OSError:
                if time.monotonic() > end:
                    raise RuntimeError("Actual Next listener readiness exceeded 90 seconds")
                time.sleep(.25)
        observer_command = [str(python), "scripts/m2/browser-e2e.py", str(output / "native/browser")]
        receipt["observerCommand"] = observer_command
        with (output / "observer.log").open("w") as observer_log:
            observed = subprocess.run(observer_command, cwd=backend, env=env, stdout=observer_log, stderr=subprocess.STDOUT, timeout=600)
        receipt["observerExitCode"] = observed.returncode
        receipt["nativeExitCode"] = native.wait(timeout=60)
        if observed.returncode or receipt["nativeExitCode"]:
            raise RuntimeError("Actual browser or native receipt failed")
        browser = json.loads((output / "native/browser/run/results.json").read_text())
        if browser["status"] != "PASS_LOCAL" or len(browser["steps"]) != 9 or any(s["status"] != "PASS" for s in browser["steps"]):
            raise RuntimeError("Missing or incomplete actual nine-step browser qualification")
        receipt["status"] = "PASS_LOCAL_BROWSER_AND_NATIVE"
except BaseException as error:
    receipt.update(status="FAIL", error={"type": type(error).__name__, "message": str(error)})
finally:
    try:
        request = urllib.request.Request("http://127.0.0.1:4693/stop", data=b"{}", method="POST")
        urllib.request.urlopen(request, timeout=3).close()
    except Exception:
        pass
    for process in (frontend, native):
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
    receipt["finishedAt"] = datetime.now(timezone.utc).isoformat()
    receipt["sourceStability"] = verify(repo, output, source_before)
    if receipt["sourceStability"]["status"] != "PASS":
        receipt["status"] = "FAIL_SOURCE_CHANGED_DURING_RUN"
    (output / "orchestration-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps({"output": str(output), "status": receipt["status"], "error": receipt.get("error")}))
raise SystemExit(0 if receipt["status"] == "PASS_LOCAL_BROWSER_AND_NATIVE" else 1)
