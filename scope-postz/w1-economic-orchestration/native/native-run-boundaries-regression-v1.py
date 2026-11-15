"""Failure-first boundary regression for native-run.py M2/M3.

Drives the REAL imperative blocks extracted from the current
finnor-os/scripts/postz-w1/native-run.py against synthetic fixtures:

M2: the subprocess execution block must reap the whole bootstrap process
    group on FINITE_BOOTSTRAP_TIMEOUT, not only the direct child.
    Defect signature M2_ORPHANED_BOOTSTRAP_PROCESS_GROUP: a grandchild of
    the timed-out bootstrap is still alive after the block returns.

M3: the final gating block must derive success only from the owning
    artifacts (native-story.json, independent-oracle.json PASS, mounted
    results.json PASS_LOCAL when mounted), not the child exit code.
    Defect signature M3_CHILD_EXIT_CODE_MASKS_OWNING_ARTIFACTS: a nonzero
    child exit code (embedded-postgres beforeExit crash after all owning
    artifacts passed) makes the receipt fail.

Usage: native-run-boundaries-regression-v1.py --output <abs results.json>
Status ALL_PASS only when both blocks behave to contract; otherwise
DEFECTS_PRESENT with per-case observed signatures.
"""
import argparse, json, os, signal, subprocess, sys, tempfile, time
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[3] / "finnor-os"
SOURCE = BACKEND / "scripts/postz-w1/native-run.py"
TEXT = SOURCE.read_text()


def block(start: str, end: str) -> str:
    a = TEXT.index(start)
    b = TEXT.index(end, a)
    return TEXT[a:b]


class _Popen(subprocess.Popen):
    """Real process-group semantics with the block's wait bounded to 2s."""
    def wait(self, timeout=None):
        return super().wait(timeout=min(timeout, 2) if timeout is not None else None)


class _SubprocessShim:
    """Keeps the real TimeoutExpired semantics but bounds the block's wait."""
    TimeoutExpired = subprocess.TimeoutExpired
    STDOUT = subprocess.STDOUT
    Popen = _Popen

    @staticmethod
    def run(cmd, **kwargs):
        kwargs["timeout"] = 2
        return subprocess.run(cmd, **kwargs)


def m2_case() -> dict:
    with tempfile.TemporaryDirectory(prefix="w1-m2-") as tmp:
        dest = Path(tmp)
        grandchild_pid = dest / "grandchild.pid"
        # Direct child: bash that spawns a long-lived grandchild then sleeps.
        command = ["bash", "-c", f"sleep 60 & echo $! > {grandchild_pid}; sleep 60"]
        receipt: dict = {}
        namespace = {"subprocess": _SubprocessShim, "destination": dest, "command": command,
                     "backend": BACKEND, "env": dict(os.environ), "receipt": receipt,
                     "json": json, "Path": Path, "os": os, "signal": signal}
        exec(block('with (destination / "runner.log").open("w") as log:',
                   'story = destination / "w1-scored-native/native-story.json"'), namespace)
        time.sleep(0.2)
        pid = int(grandchild_pid.read_text()) if grandchild_pid.exists() else None
        alive = False
        if pid is not None:
            try:
                os.kill(pid, 0)
                alive = True
            except ProcessLookupError:
                alive = False
        if alive and pid is not None:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        defect = alive
        return {"case": "M2.process-group-reaping", "timeoutExit": receipt.get("exitCode"),
                "failure": receipt.get("failure"), "grandchildAliveAfterTimeout": alive,
                "observed": "M2_ORPHANED_BOOTSTRAP_PROCESS_GROUP" if defect else "PROCESS_GROUP_REAPED",
                "defect": defect}


def m3_case() -> dict:
    with tempfile.TemporaryDirectory(prefix="w1-m3-") as tmp:
        dest = Path(tmp)
        story_dir = dest / "w1-scored-native"
        story_dir.mkdir()
        (story_dir / "native-story.json").write_text(json.dumps({"status": "PASS_LOCAL"}) + "\n")
        (story_dir / "independent-oracle.json").write_text(json.dumps({"status": "PASS"}) + "\n")
        # Owning artifacts all pass, but the child exited nonzero (e.g. the
        # embedded-postgres beforeExit hook crashed during teardown).
        receipt: dict = {"exitCode": 42}
        namespace = {"destination": dest, "receipt": receipt, "json": json, "mounted": False}
        code = None
        try:
            exec(block('story = destination / "w1-scored-native/native-story.json"',
                       "print(json.dumps(receipt))"), namespace)
            code = receipt.get("exitCode")
        except SystemExit as exited:
            code = exited.code
        defect = code != 0
        return {"case": "M3.owning-artifacts-gate", "childExitCode": 42, "finalExitCode": code,
                "observed": "M3_CHILD_EXIT_CODE_MASKS_OWNING_ARTIFACTS" if defect else "OWNING_ARTIFACTS_AUTHORITY",
                "defect": defect}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    assert not output.exists(), "NEW_ABSOLUTE_OUTPUT_PATH_REQUIRED"
    cases = [m2_case(), m3_case()]
    defects = [c["case"] for c in cases if c["defect"]]
    result = {"schema": "finnor.w1.native-run-boundaries-regression.v1",
              "source": str(SOURCE), "sourceSha256": __import__("hashlib").sha256(SOURCE.read_bytes()).hexdigest(),
              "cases": cases, "defects": defects,
              "status": "DEFECTS_PRESENT" if defects else "ALL_PASS"}
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    return 0 if not defects else 1


if __name__ == "__main__":
    sys.exit(main())
