"""Failure model: shared-output check/mkdir race may kill another journey's real
PostgreSQL, truncate its evidence, or let an unclaimed body write. Exercise two
public invocations with controlled import scheduling, never a production hook.
Require one atomic owner, loser zero shared effects, live winner PG unchanged,
and the winning actual seven-case journey plus owned cleanup to finish PASS.
"""
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


def wait_for(condition, seconds, reason):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if condition():
            return
        time.sleep(0.025)
    raise AssertionError(reason)


def identity(pid):
    return subprocess.run(["ps", "-ww", "-p", str(pid), "-o", "command="],
                          capture_output=True, text=True, timeout=2).stdout.strip()


def stop_family(child):
    if child.poll() is not None:
        return
    rows = [tuple(map(int, line.split())) for line in
            subprocess.check_output(["ps", "-axo", "pid=,ppid="], text=True, timeout=2).splitlines()]
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
            time.sleep(0.5)
    child.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    output = parser.parse_args().output
    assert output.is_absolute() and not output.exists()
    output.mkdir(mode=0o700, parents=True)
    shared = output / "shared-journey"
    node = shutil.which("node")
    assert node and subprocess.check_output([node, "--version"], text=True).strip() == "v22.22.3"
    module = (ROOT / "finnor-os/node_modules/embedded-postgres/dist/index.js").as_uri()
    command = [node, "--import=tsx", "scripts/postz-w2/run-participant-authority-e2e.mts",
               "--output", str(shared)]
    children = []
    started = time.monotonic()
    record = {"schema": "finnor.w2.participant-output-ownership-control.v1", "status": "RUNNING",
              "command": command, "expected": "ONE_OWNER_LOSER_ZERO_EFFECTS_WINNER_ACTUAL_DB_7_PASS",
              "originalBodySeconds": 180, "outerControlSeconds": 210, "controlledOnly": True}
    save = lambda: (output / "receipt.json").write_text(json.dumps(record, indent=2) + "\n")
    source = ROOT / "finnor-os/scripts/postz-w2"
    record["sourceHashes"] = {name: hashlib.sha256((source / name).read_bytes()).hexdigest() for name in
                              ["run-participant-authority-e2e.mts", "participant-authority-body.mts",
                               "participant-authority-supervisor.mts", Path(__file__).name]}

    def launch(role):
        preload = output / (role + "-schedule.mjs")
        gate = json.dumps(str(output))
        preload.write_text(
            "import EmbeddedPostgres from " + json.dumps(module) + ";\n"
            "import {existsSync,writeFileSync} from 'node:fs';\n"
            "import {join} from 'node:path';\n"
            "const gate=" + gate + ",role=" + json.dumps(role) + ";\n"
            "const wait=async name=>{while(!existsSync(join(gate,name)))"
            "await new Promise(r=>setTimeout(r,25));};\n"
            "if(process.argv[1]?.endsWith('/participant-authority-body.mts')){\n"
            " writeFileSync(join(gate,role+'-body-entered'),'actual-owned-body');\n"
            " if(role==='winner'){\n"
            "  await wait('release-winner-body');\n"
            "  const start=EmbeddedPostgres.prototype.start;\n"
            "  EmbeddedPostgres.prototype.start=async function(){\n"
            "   await start.call(this);\n"
            "   writeFileSync(join(gate,'winner-postgres.json'),"
            "JSON.stringify({pid:this.process.pid,directory:this.options.databaseDir,actualPostgresStarted:true}));\n"
            "   await wait('release-winner-start');\n"
            "  };\n"
            " } else await wait('release-loser-body');\n"
            "}\n"
        )
        environment = {"PATH": str(Path(node).parent) + ":/usr/bin:/bin:/usr/sbin:/sbin",
                       "HOME": str(Path.home()), "LANG": "C.UTF-8",
                       "NODE_OPTIONS": "--max-old-space-size=2048 --import=" + preload.as_uri()}
        with (output / (role + ".log")).open("x") as log:
            child = subprocess.Popen(command, cwd=ROOT / "finnor-os", env=environment,
                                     stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        children.append(child)
        return child

    def snapshot():
        return {name: hashlib.sha256((shared / name).read_bytes()).hexdigest()
                if (shared / name).is_file() else None
                for name in ["receipt.json", "supervised-child.log", ".owner.json"]}

    save()
    try:
        winner = launch("winner")
        wait_for(lambda: (output / "winner-body-entered").exists(), 30, "WINNER_BODY_NOT_READY")
        loser = launch("loser")
        wait_for(lambda: (output / "loser-body-entered").exists() or loser.poll() is not None,
                 15, "LOSER_DID_NOT_REACH_CLAIM_BOUNDARY")
        (output / "release-winner-body").touch()
        wait_for(lambda: (output / "winner-postgres.json").exists(), 60, "ACTUAL_WINNER_POSTGRES_NOT_STARTED")
        pg = json.loads((output / "winner-postgres.json").read_text())
        assert pg["actualPostgresStarted"] and pg["directory"] == str(shared / "owned-postgres")
        before_identity = identity(pg["pid"])
        assert "-D " + pg["directory"] + " -p " in before_identity
        before = snapshot()
        (output / "release-loser-body").touch()
        loser.wait(timeout=15)
        after = snapshot()
        record.update(loserExitCode=loser.returncode,
                      loserBodySpawned=(output / "loser-body-entered").exists(),
                      winnerPostgresPid=pg["pid"], winnerPostgresAliveAfterLoser=identity(pg["pid"]) == before_identity,
                      sharedBefore=before, sharedAfterLoser=after, loserSharedEffects=before != after)
        (output / "release-winner-start").touch()
        winner.wait(timeout=max(1, 210 - (time.monotonic() - started)))
        result = json.loads((shared / "receipt.json").read_text())
        record.update(winnerExitCode=winner.returncode, winnerJourneyStatus=result["status"],
                      winnerCases=len(result.get("cases", [])), winnerSupervision=result.get("supervision"))
        assert loser.returncode != 0, "LOSER_NOT_REFUSED"
        assert record["winnerPostgresAliveAfterLoser"], "LOSER_KILLED_WINNER_POSTGRES"
        assert before == after, "LOSER_OVERWROTE_WINNER_ARTIFACTS"
        assert not record["loserBodySpawned"], "LOSER_SPAWNED_UNCLAIMED_BODY"
        assert winner.returncode == 0 and result["status"] == "PASS" and len(result["cases"]) == 7
        assert result["supervision"]["cleanupStatus"] == "PASS"
        record["status"] = "PASS"
    except BaseException as error:
        record.update(status="FAIL", errorType=type(error).__name__, error=str(error))
    finally:
        try:
            for child in children:
                stop_family(child)
            pidfile = shared / "owned-postgres/postmaster.pid"
            if pidfile.exists():
                lines = pidfile.read_text().splitlines()
                pid = int(lines[0])
                current = identity(pid)
                if current:
                    assert lines[1] == str(pidfile.parent)
                    assert str(ROOT / "finnor-os/node_modules/@embedded-postgres/") in current
                    assert "-D " + str(pidfile.parent) + " -p " in current
                    os.kill(pid, signal.SIGTERM)
                    wait_for(lambda: not identity(pid), 10, "OWNED_CONTROL_POSTGRES_DID_NOT_STOP")
                    record["status"] = "FAIL"
                    record["controlStoppedLeftoverPostgres"] = True
            record["cleanupStatus"] = "PASS"
        except BaseException as error:
            record.update(status="FAIL", cleanupErrorType=type(error).__name__)
        record["elapsedSeconds"] = time.monotonic() - started
        save()
    print(json.dumps({"status": record["status"], "error": record.get("error"),
                      "winnerPostgresAliveAfterLoser": record.get("winnerPostgresAliveAfterLoser"),
                      "loserSharedEffects": record.get("loserSharedEffects"), "receipt": str(output / "receipt.json")}))
    return 0 if record["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
