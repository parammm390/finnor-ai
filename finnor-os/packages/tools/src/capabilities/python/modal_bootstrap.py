"""Trusted entrypoint INSIDE the Modal VM; candidate code is never imported here."""
import base64
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import selectors
import signal
import subprocess
import sys
import time

deadline = float(sys.argv[1]) / 1000
remaining = min(300, math.ceil(deadline - time.time()))
if remaining < 1:
    raise SystemExit(124)
signal.alarm(remaining)
if os.getuid() != 0:
    raise SystemExit("MODAL_IMAGE_REQUIRES_TRUSTED_ROOT_BOOTSTRAP")
raw = sys.stdin.buffer.readline(16_777_217)
if len(raw) > 16_777_216:
    raise SystemExit("MODAL_INPUT_LIMIT")
payload = json.loads(raw)
code = payload["code"]
if not isinstance(code, str) or len(code.encode()) > 100_000:
    raise SystemExit("MODAL_CODE_LIMIT")
if hashlib.sha256(code.encode()).hexdigest() != payload["codeSha256"]:
    raise SystemExit("MODAL_CODE_DIGEST_MISMATCH")
root = Path("/tmp/finnor-execution")
root.mkdir(mode=0o755)
programs, inputs, work = root / "program", root / "input", root / "work"
for directory in [programs, inputs, work]:
    directory.mkdir(mode=0o755)
os.chown(work, 65534, 65534)
os.chmod(work, 0o700)
program = programs / "candidate.py"
program.write_text(code, encoding="utf-8")
program.chmod(0o444)
total = 0
sources = []
for index, source in enumerate(payload.get("sources", [])):
    data = base64.b64decode(source["bytesBase64"], validate=True)
    total += len(data)
    if total > 10_485_760 or hashlib.sha256(data).hexdigest() != source["sha256"]:
        raise SystemExit("MODAL_SOURCE_INVALID")
    path = inputs / (str(index).zfill(4) + ".bin")
    path.write_bytes(data)
    path.chmod(0o444)
    sources.append({"path": str(path), "sha256": source["sha256"], "source": source["source"]})
(inputs / "manifest.json").write_text(json.dumps(sources), encoding="utf-8")
(inputs / "manifest.json").chmod(0o444)
for directory in [programs, inputs]:
    directory.chmod(0o555)
stdin = payload.get("stdin", "").encode()
if len(stdin) > 100_000:
    raise SystemExit("MODAL_STDIN_LIMIT")


def limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    cpu = max(1, math.ceil(deadline - time.time()))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    resource.setrlimit(resource.RLIMIT_FSIZE, (16_777_216, 16_777_216))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_NPROC, (32, 32))
    resource.setrlimit(resource.RLIMIT_AS, (2_147_483_648, 2_147_483_648))


process = subprocess.Popen([sys.executable, "-I", "-B", str(program)], cwd=work, user=65534, group=65534, extra_groups=[],
    env={"PATH": "/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1", "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1", "FINNOR_INPUT_MANIFEST": str(inputs / "manifest.json")},
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, preexec_fn=limits)
selector = selectors.DefaultSelector()
for stream, label in [(process.stdout, "stdout"), (process.stderr, "stderr")]:
    os.set_blocking(stream.fileno(), False)
    selector.register(stream, selectors.EVENT_READ, label)
if stdin:
    os.set_blocking(process.stdin.fileno(), False)
    selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
else:
    process.stdin.close()
captured = {"stdout": bytearray(), "stderr": bytearray()}
max_bytes = {"stdout": 1_048_576, "stderr": 131_072}
offset = 0
failure = None
while selector.get_map():
    if time.time() >= deadline:
        failure = "DEADLINE_EXCEEDED"
        break
    for key, _ in selector.select(0.05):
        if key.data == "stdin":
            try:
                offset += os.write(key.fd, stdin[offset:offset + 4096])
            except BrokenPipeError:
                offset = len(stdin)
            if offset >= len(stdin):
                selector.unregister(key.fileobj)
                key.fileobj.close()
            continue
        block = os.read(key.fd, 4096)
        if not block:
            selector.unregister(key.fileobj)
            key.fileobj.close()
        else:
            captured[key.data].extend(block)
            if len(captured[key.data]) > max_bytes[key.data]:
                captured[key.data] = captured[key.data][:max_bytes[key.data]]
                failure = "OUTPUT_LIMIT_EXCEEDED"
                break
    if failure:
        break
if failure:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
try:
    exit_code = process.wait(timeout=max(0.01, deadline - time.time()))
except subprocess.TimeoutExpired:
    os.killpg(process.pid, signal.SIGKILL)
    exit_code = process.wait(timeout=2)
    failure = "DEADLINE_EXCEEDED"
selector.close()
signal.alarm(0)
print(json.dumps({"schema": "finnor.modal-program-result.v1", "exitCode": exit_code, "failure": failure,
    "stdoutBase64": base64.b64encode(captured["stdout"]).decode(), "stderrBase64": base64.b64encode(captured["stderr"]).decode(),
    "codeSha256": payload["codeSha256"], "sources": sources, "candidateUid": 65534}, allow_nan=False, separators=(",", ":")))
