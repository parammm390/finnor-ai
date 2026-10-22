"""Pinned native emission and public binding utilities. No input-value channel."""
from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import hashlib
import json
import os
import re
import resource
import signal
import subprocess
import sys
import time
from pathlib import Path

from compiler import PROFILE, PROFILE_BYTES, canonical, digest, require
from correspondence import check

ROOT = Path(__file__).parent
IDENTITY = json.loads((ROOT / "backend-identity.json").read_text())
HASH_FILES = ("compiler.py", "correspondence.py", "secure_runtime.py", "backend.py", "public_driver.py",
              "participant.py", "profile.json", "backend-identity.json")


def file_digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_identity():
    return {name: file_digest(ROOT / name) for name in HASH_FILES}

def bind_supervisor(expected=None, death_signal=signal.SIGTERM):
    """Linux parent-death fencing also covers an uncatchable supervisor crash."""
    expected = expected or os.environ.get("FINNOR_Y4_SUPERVISOR_PID")
    if expected is None:
        return
    expected = int(expected)
    require(sys.platform == "linux" and os.getppid() == expected, "PHYSICAL_SUPERVISOR_LOST")
    require(ctypes.CDLL(None, use_errno=True).prctl(1, int(death_signal), 0, 0, 0) == 0,
            "PARENT_DEATH_FENCE_UNAVAILABLE")
    require(os.getppid() == expected, "PHYSICAL_SUPERVISOR_LOST")


def monitor_supervisor():
    """Independent Python-level parent-loss fence; never arm in native preexec."""
    expected = os.environ.get("FINNOR_Y4_SUPERVISOR_PID")
    if expected is None:
        return
    expected = int(expected)

    def check_parent(_signal=None, _frame=None):
        if os.getppid() != expected:
            signal.setitimer(signal.ITIMER_REAL, 0)
            raise RuntimeError("PHYSICAL_SUPERVISOR_LOST")

    check_parent()
    signal.signal(signal.SIGALRM, check_parent)
    signal.setitimer(signal.ITIMER_REAL, 0.25, 0.25)
    check_parent()


def deadline(value):
    require(isinstance(value, str), "ABSOLUTE_DEADLINE_REQUIRED")
    result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(result.tzinfo is not None, "UTC_DEADLINE_REQUIRED")
    return result.timestamp()


def prefix_for(protocol, session, key):
    port = next(p for p in protocol["function"]["inputs"] if p["key"] == key)
    return digest({"schema": "finnor.y4.input-binding.v1", "sessionId": session["sessionId"],
                   "functionDigest": protocol["functionDigest"], "profileDigest": protocol["profileDigest"],
                   "releaseCutDigest": session["releaseCutDigest"], "deadlineAt": session["deadlineAt"],
                   "participantCertificateDigests": session["participantCertificateDigests"],
                   "port": port})[:32]


def output_layout(protocol, participant):
    result = []
    for output in protocol["outputs"]:
        if participant not in output["recipients"]:
            continue
        node = protocol["nodes"][output["register"]]
        low, high = int(node["low"]), int(node["high"])
        size = max(1, ((high - low).bit_length() + 7) // 8)
        result.append({"key": output["key"], "scale": output["scale"], "low": str(low),
                       "high": str(high), "bytes": size})
    return result


def output_prefix(protocol, binding, participant):
    return digest({"schema": "finnor.y4.output-binding.v1", "protocolDigest": digest(protocol),
                   "bindingDigest": digest(binding), "participantId": participant,
                   "outputs": output_layout(protocol, participant)})[:32]


def output_commitment(protocol, binding, participant, nonce, outputs):
    """Recipient-local opening check, never an evaluation of private inputs."""
    layout = output_layout(protocol, participant)
    require(re.fullmatch(r"[a-f0-9]{32}", nonce) is not None, "EXACT_PRIVATE_OUTPUT_NONCE_REQUIRED")
    require(len(outputs) == len(layout) and {o["key"] for o in outputs} == {o["key"] for o in layout},
            "EXACT_RECIPIENT_OUTPUT_TUPLE_REQUIRED")
    by_key = {o["key"]: o for o in outputs}
    message = bytes.fromhex(output_prefix(protocol, binding, participant)) + bytes.fromhex(nonce)
    for port in layout:
        output = by_key[port["key"]]
        require(output["scale"] == port["scale"], "EXACT_RECIPIENT_OUTPUT_SCALE_REQUIRED")
        n = int(output["mantissa"])
        require(int(port["low"]) <= n <= int(port["high"]), "RECIPIENT_OUTPUT_DOMAIN_REQUIRED")
        message += (n - int(port["low"])).to_bytes(port["bytes"], "big")
    return hashlib.sha256(message).hexdigest()


def verify_session(protocol, session):
    require(set(session) == {"schema", "sessionId", "functionDigest", "profileDigest", "releaseCutDigest",
                             "deadlineAt", "participantCertificateDigests"}, "EXACT_SESSION_SHAPE_REQUIRED")
    require(session["schema"] == "finnor.y4.session.v1"
            and re.fullmatch(r"[a-f0-9]{32}", session["sessionId"]) is not None, "FRESH_SESSION_ID_REQUIRED")
    require(session["functionDigest"] == protocol["functionDigest"]
            and session["profileDigest"] == protocol["profileDigest"], "SESSION_ARTIFACT_MISMATCH")
    require(re.fullmatch(r"[a-f0-9]{64}", session["releaseCutDigest"]) is not None, "RELEASE_CUT_REQUIRED")
    require(deadline(session["deadlineAt"]) > time.time(), "ORIGINAL_DEADLINE_EXPIRED")
    certs = session["participantCertificateDigests"]
    require(set(certs) == {p["id"] for p in protocol["function"]["participants"]}, "PINNED_ALL_PARTICIPANT_CERTS_REQUIRED")
    require(all(isinstance(c, str) and re.fullmatch(r"[a-f0-9]{64}", c) for c in certs.values()),
            "PINNED_CERTIFICATE_DIGEST_REQUIRED")


def verify_binding(protocol, binding):
    require(set(binding) == {"session", "inputs"}, "EXACT_BINDING_SHAPE_REQUIRED")
    verify_session(protocol, binding["session"])
    require(len(binding["inputs"]) == len(protocol["function"]["inputs"]), "COMPLETE_COMMITMENTS_REQUIRED")
    require({b["key"] for b in binding["inputs"]} == {p["key"] for p in protocol["function"]["inputs"]},
            "EXACT_COMMITMENT_PORT_SET_REQUIRED")
    for b in binding["inputs"]:
        require(set(b) == {"key", "bindingPrefix", "commitment"}, "PUBLIC_COMMITMENT_ONLY")
        require(b["bindingPrefix"] == prefix_for(protocol, binding["session"], b["key"])
                and re.fullmatch(r"[a-f0-9]{64}", b["commitment"]) is not None,
                "COMMITMENT_BINDING_MISMATCH")


def verify_backend(backend):
    require(IDENTITY["otExtension"] == PROFILE["backend"]["otExtension"], "SECURE_OT_BUILD_NOT_INSTALLED")
    backend = Path(backend).resolve(strict=True)
    for name in ("mascot-party.x", "libSPDZ.so", "Programs/Circuits/sha256.txt",
                 "local/lib/liblibOTe.a", "local/lib/libcryptoTools.a"):
        require(file_digest(backend / name) == IDENTITY[name], "INSTALLED_BACKEND_IDENTITY_MISMATCH")
    require(IDENTITY["runtimeLoader"] == "ld-linux-x86-64.so.2" and len(IDENTITY["runtimeLibraries"]) >= 10,
            "COMPLETE_PINNED_NATIVE_LIBRARY_CLOSURE_REQUIRED")
    for name, expected in IDENTITY["runtimeLibraries"].items():
        require(Path(name).name == name
                and file_digest(backend / "local/runtime-libs" / name) == expected,
                "INSTALLED_NATIVE_LIBRARY_IDENTITY_MISMATCH")
    compiler_files = IDENTITY["compilerFiles"]
    actual = {str(p.relative_to(backend)) for p in backend.glob("*.py")}
    actual.update(str(p.relative_to(backend)) for p in (backend / "Compiler").rglob("*.py"))
    require("compile.py" in compiler_files and actual == set(compiler_files),
            "COMPLETE_PINNED_NATIVE_COMPILER_REQUIRED")
    for name, expected in compiler_files.items():
        path = (backend / name).resolve(strict=True)
        require(path.is_relative_to(backend) and file_digest(path) == expected,
                "INSTALLED_NATIVE_COMPILER_IDENTITY_MISMATCH")
    return backend


def write_public(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    value = value.encode() if isinstance(value, str) else value
    try:
        with path.open("xb") as stream:
            stream.write(value)
    except FileExistsError:
        require(path.read_bytes() == value, "PUBLIC_ARTIFACT_CONTENT_COLLISION")


def emit(protocol, binding, backend, output, compile_memory_bytes=None,
         compile_cpu_seconds=None, program_workspace=None):
    receipt = check(protocol["function"], protocol)
    verify_binding(protocol, binding)
    backend = verify_backend(backend)
    output = Path(output).resolve()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    workspace = backend
    if program_workspace is not None:
        workspace = Path(program_workspace).resolve()
        workspace.mkdir(mode=0o700, parents=True, exist_ok=False)
        # Compiler.program resolves its default Programs root from its own
        # __file__. A symlinked compiler would also discover the coordinator's
        # source and could select or reject that foreign copy.
        for name in IDENTITY["compilerFiles"]:
            write_public(workspace / name, (backend / name).read_bytes())
        circuits = workspace / "Programs/Circuits"
        circuits.mkdir(parents=True, mode=0o700)
        (circuits / "sha256.txt").symlink_to(backend / "Programs/Circuits/sha256.txt")
        for directory in ("Bytecode", "Functions", "Public-Input", "Schedules", "Source"):
            (workspace / "Programs" / directory).mkdir(mode=0o700)
    identity = source_identity()
    public = {"protocol": protocol, "binding": binding}
    name = "y4_" + digest({"public": public, "sources": identity})[:40]
    source = ("import json\nfrom secure_runtime import execute\n"
              f"with open('Programs/Public-Input/{name}.json') as f:\n    bundle = json.load(f)\n"
              "execute(bundle['protocol'], bundle['binding'], 'Programs/Circuits/sha256.txt')\n")
    write_public(workspace / "Programs/Source" / f"{name}.mpc", source)
    write_public(workspace / "Programs/Public-Input" / f"{name}.json", canonical(public))
    # A fixed argv and hash seed make schedule and tape identity reproducible
    # across independently located participant installations. Never load a
    # pre-existing Python bytecode cache instead of the pinned compiler source.
    command = [sys.executable, "-B", "-X", f"pycache_prefix={output / 'unused-pycache'}",
               "compile.py", "-F", "84", name]
    started = time.monotonic()
    remaining = deadline(binding["session"]["deadlineAt"]) - time.time()
    require(remaining > 0, "ORIGINAL_DEADLINE_EXPIRED")
    with (output / "native-compile.log").open("wb") as log:
        parent = os.getpid()
        def bound_compiler():
            bind_supervisor(parent, signal.SIGKILL)
            if compile_memory_bytes is not None:
                hard = resource.getrlimit(resource.RLIMIT_AS)[1]
                require(hard != resource.RLIM_INFINITY and compile_memory_bytes <= hard,
                        "ORIGINAL_COMPILER_MEMORY_ALLOCATION_REQUIRED")
                resource.setrlimit(resource.RLIMIT_AS, (compile_memory_bytes, hard))
            if compile_cpu_seconds is not None:
                require(compile_cpu_seconds >= 1, "ORIGINAL_COMPILER_CPU_ALLOCATION_REQUIRED")
                resource.setrlimit(resource.RLIMIT_CPU, (compile_cpu_seconds, compile_cpu_seconds))
        usage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
        child = subprocess.Popen(command, cwd=workspace, stdout=log, stderr=subprocess.STDOUT,
                                 env={"PATH": os.environ["PATH"], "PYTHONPATH": str(ROOT),
                                      "PYTHONDONTWRITEBYTECODE": "1", "PYTHONHASHSEED": "0"},
                                 start_new_session=True,
                                 preexec_fn=bound_compiler)
        try:
            code = child.wait(timeout=min(remaining, 600))
        except (subprocess.TimeoutExpired, BaseException):
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
            raise
    require(code == 0, "NATIVE_COMPILATION_FAILED_SEE_RETAINED_LOG")
    usage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
    files = [workspace / "Programs/Schedules" / f"{name}.sch",
             *sorted((workspace / "Programs/Bytecode").glob(f"{name}-*.bc"))]
    require(len(files) >= 2 and all(p.is_file() for p in files), "EMITTED_NATIVE_FILES_REQUIRED")
    manifest = {"schema": "finnor.y4.emitted-program.v1", "name": name,
                "protocolDigest": digest(protocol), "bindingDigest": digest(binding),
                "sourceIdentity": identity, "backendIdentity": IDENTITY,
                "files": {str(p.relative_to(workspace)): file_digest(p) for p in files},
                "sourceDigest": hashlib.sha256(source.encode()).hexdigest(),
                "command": ["python3", "-B", "compile.py", "-F", "84", name],
                "wallSeconds": str(time.monotonic() - started), "correspondence": receipt,
                "nativeCompileCpuSeconds": format(usage_after.ru_utime + usage_after.ru_stime
                    - usage_before.ru_utime - usage_before.ru_stime, ".9f"),
                "nativeCompilePeakRSSBytes": usage_after.ru_maxrss * 1024,
                "qualification": "LOCAL_ENGINEERING_ONLY", "executionAuthority": False}
    write_public(output / "program.json", canonical(manifest))
    write_public(output / "public-bundle.json", canonical(public))
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True, type=Path)
    parser.add_argument("--backend", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    bundle = json.loads(args.bundle.read_text())
    print(canonical(emit(bundle["protocol"], bundle["binding"], args.backend, args.output)))
