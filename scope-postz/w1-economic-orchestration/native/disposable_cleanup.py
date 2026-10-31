"""Final custody of one new child TMPDIR, including a hard-killed PG owner."""
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import time


def cleanup_namespace(directory, *, parent=None, identity=None):
    directory = Path(directory)
    allowed = Path(parent).resolve(strict=True) if parent else Path("/tmp").resolve()
    assert allowed == Path("/tmp").resolve() or (
        allowed.is_relative_to(Path("/tmp").resolve()) and allowed.name.startswith("finnor-w1-run-"))
    assert directory.parent == allowed, "EXACT_RESOURCE_TMPDIR_REQUIRED"
    assert directory.name.startswith("finnor-w1-run-") and not directory.is_symlink()
    stat = directory.stat()
    assert stat.st_uid == os.getuid(), "OWNED_RESOURCE_TMPDIR_REQUIRED"
    assert identity is None or (stat.st_dev, stat.st_ino) == identity, "RESOURCE_TMPDIR_IDENTITY_CHANGED"
    receipt = {"directory": str(directory), "status": "FAIL", "stoppedPids": [], "openPids": []}
    deadline = time.monotonic() + 15

    def processes():
        result = subprocess.run(["/bin/ps", "-ww", "-axo", "pid=,uid=,stat=,command="],
            capture_output=True, text=True, timeout=2, check=True)
        found = []
        for line in result.stdout.splitlines():
            fields = line.strip().split(None, 3)
            if len(fields) != 4 or int(fields[1]) != os.getuid() or fields[2].startswith("Z"):
                continue
            try:
                args = shlex.split(fields[3])
            except ValueError:
                continue
            if not args or Path(args[0]).name not in ("postgres", "initdb"):
                continue
            paths = [Path(arg.partition("=")[2]) for arg in args if arg.startswith("--pgdata=")]
            paths += [Path(args[i + 1]) for i, arg in enumerate(args[:-1]) if arg == "-D"]
            if any(path.is_absolute() and path.resolve().is_relative_to(directory) for path in paths):
                found.append(int(fields[0]))
        return found

    for pid in processes():
        try:
            os.kill(pid, signal.SIGINT)
            receipt["stoppedPids"].append(pid)
        except ProcessLookupError:
            pass
    # This is bounded teardown of this namespace, not host/job admission polling.
    while processes() and time.monotonic() < deadline - 5:
        time.sleep(0.05)
    remaining = processes()
    for pid in remaining:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    while processes() and time.monotonic() < deadline - 3:
        time.sleep(0.05)
    receipt["remainingProcesses"] = processes()
    if receipt["remainingProcesses"]:
        raise RuntimeError("OWNED_TMPDIR_POSTGRES_STILL_RUNNING")
    lsof = shutil.which("lsof")
    assert lsof, "OWNED_TMPDIR_OPEN_FILE_TOOL_UNAVAILABLE"
    opened = subprocess.run([lsof, "-nP", "-t", "+D", str(directory)],
        capture_output=True, text=True, timeout=max(1, deadline - time.monotonic()))
    assert opened.returncode in (0, 1), "OWNED_TMPDIR_OPEN_FILE_CUT_UNAVAILABLE"
    receipt["openPids"] = sorted({int(pid) for pid in opened.stdout.split()})
    assert not receipt["openPids"], "OWNED_TMPDIR_OPEN_FILES_RETAINED"
    current = directory.lstat()
    assert not directory.is_symlink() and (current.st_dev, current.st_ino) == (stat.st_dev, stat.st_ino)
    shutil.rmtree(directory)
    receipt.update(status="PASS", directoryRemoved=not directory.exists())
    return receipt
