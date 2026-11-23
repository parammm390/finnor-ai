"""Exercise the public database journey's original deadline with real PostgreSQL."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

ROOT = Path(__file__).resolve().parents[3]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    assert args.output.is_absolute() and not args.output.exists()
    args.output.mkdir(mode=0o700, parents=True)
    output = args.output
    driver_output = output / "driver"
    node = shutil.which("node")
    assert node and subprocess.check_output([node, "--version"], text=True).strip() == "v22.22.3"
    module = (ROOT / "finnor-os/node_modules/embedded-postgres/dist/index.js").as_uri()
    preload = output / "stall-startup.mjs"
    preload.write_text(
        "import EmbeddedPostgres from " + json.dumps(module) + ";\n"
        "import {writeFile} from 'node:fs/promises';\n"
        "import {dirname,join} from 'node:path';\n"
        "const original=EmbeddedPostgres.prototype.start;\n"
        "EmbeddedPostgres.prototype.start=async function(){\n"
        " await original.call(this);\n"
        " await writeFile(join(dirname(this.options.databaseDir),'startup-stall.json'),"
        "JSON.stringify({databaseDirectory:this.options.databaseDir,actualPostgresStarted:true}));\n"
        " await new Promise(()=>{setInterval(()=>{},1000)});\n"
        "};\n"
    )
    command = [node, "--import=tsx", "scripts/postz-w2/run-participant-authority-e2e.mts",
               "--output", str(driver_output)]
    environment = {"PATH": str(Path(node).parent) + ":/usr/bin:/bin:/usr/sbin:/sbin",
                   "HOME": str(Path.home()), "LANG": "C.UTF-8",
                   "NODE_OPTIONS": "--max-old-space-size=2048 --import=" + preload.as_uri()}
    record = {"schema": "finnor.w2.participant-authority-timeout-control.v1", "status": "RUNNING",
              "command": command, "expected": "OWN_JOURNEY_TIMEOUT_AND_VERIFIED_POSTGRES_CLEANUP",
              "originalBodySeconds": 180, "outerControlSeconds": 195,
              "sourceSha256": hashlib.sha256((ROOT / "finnor-os/scripts/postz-w2/run-participant-authority-e2e.mts").read_bytes()).hexdigest(),
              "controlledOnly": True}
    receipt = output / "receipt.json"
    save = lambda: receipt.write_text(json.dumps(record, indent=2) + "\n")
    started = time.monotonic()
    child = None
    save()
    try:
        with (output / "driver.log").open("x") as log:
            child = subprocess.Popen(command, cwd=ROOT / "finnor-os", env=environment,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            record["pid"] = child.pid
            save()
            try:
                child.wait(timeout=195)
                record["outerWatchdogNeeded"] = False
            except subprocess.TimeoutExpired:
                record["outerWatchdogNeeded"] = True
                raise AssertionError("ORIGINAL_JOURNEY_DEADLINE_NOT_ENFORCED")
        record["driverExitCode"] = child.returncode
        marker = driver_output / "startup-stall.json"
        assert marker.is_file(), "ACTUAL_STARTED_POSTGRES_STALL_NOT_REACHED"
        result = json.loads((driver_output / "receipt.json").read_text())
        record["journey"] = result
        assert child.returncode != 0 and result["status"] == "FAIL"
        assert result["supervision"]["timedOut"] is True
        assert result["supervision"]["deadlineMilliseconds"] == 180000
        assert result["supervision"]["cleanupStatus"] == "PASS"
        assert result["supervision"]["elapsedMilliseconds"] < 195000
        record["status"] = "PASS"
    except BaseException as error:
        record.update(status="FAIL", errorType=type(error).__name__, error=str(error))
    finally:
        if child and child.poll() is None:
            rows = [tuple(map(int, line.split())) for line in
                    subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True).splitlines()]
            owned = {child.pid}
            while True:
                more = {pid for pid, parent in rows if parent in owned}
                if more <= owned:
                    break
                owned |= more
            for number in (signal.SIGTERM, signal.SIGKILL):
                for pid in sorted(owned, reverse=True):
                    try:
                        os.kill(pid, number)
                    except ProcessLookupError:
                        pass
                if number == signal.SIGTERM:
                    time.sleep(1)
            child.wait(timeout=5)
        pidfile = driver_output / "owned-postgres/postmaster.pid"
        try:
            record["controlStoppedLeftoverPostgres"] = False
            if pidfile.exists():
                lines = pidfile.read_text().splitlines()
                pid = int(lines[0])
                assert lines[1] == str(pidfile.parent), "OWNED_DATABASE_IDENTITY_CHANGED"
                identity = subprocess.run(["ps", "-ww", "-p", str(pid), "-o", "command="],
                                          capture_output=True, text=True).stdout.strip()
                if identity:
                    assert str(ROOT / "finnor-os/node_modules/@embedded-postgres/") in identity
                    assert "-D " + str(pidfile.parent) in identity
                    record["controlStoppedLeftoverPostgres"] = True
                    record["status"] = "FAIL"
                    os.kill(pid, signal.SIGTERM)
                    until = time.monotonic() + 10
                    while pidfile.exists() and time.monotonic() < until:
                        time.sleep(0.1)
                    assert not pidfile.exists(), "OWNED_DATABASE_DID_NOT_STOP"
            record["controlledCleanupStatus"] = "PASS"
        except BaseException as error:
            record.update(status="FAIL", cleanupErrorType=type(error).__name__)
        record["elapsedSeconds"] = time.monotonic() - started
        save()
    print(json.dumps({"status": record["status"], "outerWatchdogNeeded": record.get("outerWatchdogNeeded"),
                      "error": record.get("error"), "receipt": str(receipt)}))
    return 0 if record["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
