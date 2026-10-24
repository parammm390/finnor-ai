"""Worker bridge. Public declarations/commitments only, never local records."""
import json
import os
import re
import resource
import signal
import subprocess
import sys
import time
from pathlib import Path

from backend import (bind_supervisor, monitor_supervisor, canonical, check, deadline, digest, emit, require, source_identity,
                     verify_binding, verify_session)
from compiler import compile_function


def interrupt(_signal, _frame):
    signal.setitimer(signal.ITIMER_REAL, 0)
    # selectors.select() swallows InterruptedError as a syscall interruption.
    raise RuntimeError("PHYSICAL_SUPERVISOR_CANCELLED")


def stop_participants(children, grace_seconds=1, reap_seconds=0.25):
    for child in children:
        if child.poll() is None:
            child.terminate()
    until = time.monotonic() + grace_seconds
    for child in children:
        try:
            child.wait(timeout=max(0, until-time.monotonic()))
        except subprocess.TimeoutExpired:
            pass
    for child in children:
        if child.poll() is None:
            child.kill()
    until = time.monotonic() + reap_seconds
    for child in children:
        try:
            child.wait(timeout=max(0, until-time.monotonic()))
        except subprocess.TimeoutExpired:
            pass
    return all(child.poll() is not None for child in children)


def disposal_limits(memory):
    resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))


def dispose_all(bundle, agents):
    """Dispatch all exact-session owners before any bounded individual wait."""
    children, failed = [], False
    total = resource.getrlimit(resource.RLIMIT_AS)[1]
    memory = min(128 * 1024 ** 2, total // (len(agents)+1)) \
        if total != resource.RLIM_INFINITY else 128 * 1024 ** 2
    until = time.monotonic() + 4
    # Public declarations only. No output path, disk space or private input is
    # required; reopening gives each child its own independent read position.
    with os.fdopen(os.memfd_create("y4-public-abort", os.MFD_CLOEXEC), "w+b") as public:
        public.write(canonical(bundle).encode())
        public.flush()
        try:
            for agent in agents:
                command = [sys.executable, "-B", str(Path(__file__).with_name("participant.py")), "dispose-session",
                           "--bundle", "-", "--participant", agent["participantId"],
                           "--authority", agent["authorityPath"], "--state", agent["stateDirectory"]]
                try:
                    with open(f"/proc/self/fd/{public.fileno()}", "rb") as source:
                        children.append(subprocess.Popen(command, stdin=source,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            env={"PATH": os.environ["PATH"], "PYTHONDONTWRITEBYTECODE": "1",
                                 "FINNOR_Y4_SUPERVISOR_PID": str(os.getpid())},
                            preexec_fn=lambda: disposal_limits(memory)))
                except (OSError, subprocess.SubprocessError):
                    failed = True
            for child in children:
                try:
                    failed = child.wait(timeout=max(0, until-time.monotonic())) != 0 or failed
                except subprocess.TimeoutExpired:
                    failed = True
        finally:
            failed = not stop_participants(children, grace_seconds=0) or failed
    return not failed


def execution_budget(limits, count):
    memory, cpu = int(limits["maxMemoryBytes"]), int(limits["maxCpuSeconds"])
    # Include a one-second kernel accounting margin for each supervisor,
    # compiler/native child and the bounded certificate-rehash children.
    metadata_cpu = (2 * count + 1) * 10 + 5 * count
    require(cpu >= metadata_cpu + 2 * (count + 1) and memory >= 1024 ** 3,
            "ORIGINAL_TOTAL_CANNOT_FUND_NATIVE_SUPERVISION")
    supervisor_memory = memory // (4 * count + 4)
    return {"compilerCpu": (cpu - metadata_cpu) // (2 * (count + 1)),
            "nativeCpu": (cpu - metadata_cpu) // (2 * count),
            "supervisorMemory": supervisor_memory,
            "parallelCompilerMemory": (memory - (count + 1) * supervisor_memory) // count,
            "centralCompilerMemory": memory // 2}


def same_output_commitments(protocol, receipts):
    required = {p["id"] for p in protocol["function"]["participants"]
                if any(p["id"] in o["recipients"] for o in protocol["outputs"])}
    common = receipts[0]["outputCommitments"]
    require(set(common) == required
            and all(r["outputCommitments"] == common and r["nativeIndependentlyReconstructed"] is True
                    and r["outputCommitment"] == common.get(r["participantId"]) for r in receipts),
            "ALL_PARTICIPANTS_MUST_AUTHENTICATE_IDENTICAL_OUTPUT_COMMITMENTS")
    return common


def execute(request):
    bundle = request["bundle"]
    protocol, binding = bundle["protocol"], bundle["binding"]
    output = Path(request["output"])
    public_file = output / "public-bundle.json"
    # Compilation is sequential, before any native participant starts. Its
    # larger soft limit and this supervisor still fit the original total.
    agents = request["agents"]
    children = []
    completed = False
    started = time.monotonic()
    try:
        check(protocol["function"], protocol)
        verify_binding(protocol, binding)
        identities = [p["id"] for p in protocol["function"]["participants"]]
        require([a["participantId"] for a in agents] == identities, "ALL_CONFIGURED_PARTICIPANTS_REQUIRED")
        budget = execution_budget(request["limits"], len(identities))
        output.mkdir(parents=True, mode=0o700, exist_ok=False)
        public_file.write_text(canonical(bundle))
        manifest = emit(protocol, binding, request["backend"], output / "emitted",
                        budget["centralCompilerMemory"], budget["compilerCpu"])
        # Independent participant reconstructions run before private input
        # delivery. Their aggregate allocations, including all supervisors,
        # fit the original nonrenewable grant.
        for agent in agents:
            command = [sys.executable, "-B", str(Path(__file__).with_name("participant.py")), "verify-program",
                       "--bundle", str(public_file), "--participant", agent["participantId"],
                       "--authority", agent["authorityPath"], "--state", agent["stateDirectory"],
                       "--manifest", str(output / "emitted/program.json"), "--backend", request["backend"],
                       "--compile-memory-bytes", str(budget["parallelCompilerMemory"]),
                       "--compile-cpu-seconds", str(budget["compilerCpu"])]
            children.append(subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                             text=True, env={"PATH": os.environ["PATH"],
                                                             "PYTHONDONTWRITEBYTECODE": "1",
                                                             "FINNOR_Y4_SUPERVISOR_PID": str(os.getpid())}))
        verifications = []
        for agent, child in zip(agents, children):
            remaining = deadline(binding["session"]["deadlineAt"]) - time.time()
            require(remaining > 0, "ORIGINAL_DEADLINE_EXPIRED")
            stdout, _ = child.communicate(timeout=remaining)
            require(len(stdout) <= 262144, "INDEPENDENT_NATIVE_VERIFICATION_RECEIPT_BOUND")
            if child.returncode != 0:
                predicate = "INDEPENDENT_NATIVE_VERIFIER_SIGNAL_" + str(-child.returncode) \
                    if child.returncode < 0 else "INDEPENDENT_NATIVE_VERIFIER_EXIT_" + str(child.returncode)
                try:
                    refused = json.loads(stdout)
                    if refused.get("state") == "REFUSED" and re.fullmatch(
                            r"[A-Z][A-Z0-9_]{1,80}", str(refused.get("predicate"))):
                        predicate = "INDEPENDENT_NATIVE_VERIFY_" + refused["predicate"]
                except (ValueError, TypeError, AttributeError):
                    pass
                raise RuntimeError(predicate)
            receipt = json.loads(stdout)
            require(receipt["participantId"] == agent["participantId"]
                    and receipt["programDigest"] == digest(manifest)
                    and receipt["bindingDigest"] == digest(binding)
                    and receipt["independentlyReconstructed"] is True, "EXACT_NATIVE_VERIFICATION_REQUIRED")
            verifications.append(receipt)
        children.clear()
        for agent in agents:
            command = [sys.executable, "-B", str(Path(__file__).with_name("participant.py")), "run",
                       "--bundle", str(public_file), "--participant", agent["participantId"],
                       "--authority", agent["authorityPath"], "--state", agent["stateDirectory"],
                       "--manifest", str(output / "emitted/program.json"), "--backend", request["backend"],
                       "--port-base", str(request["portBase"]),
                       "--native-memory-bytes", str(budget["parallelCompilerMemory"]),
                       "--native-cpu-seconds", str(budget["nativeCpu"])]
            # Neither the local record nor the TLS private key is opened here.
            children.append(subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                             text=True, env={"PATH": os.environ["PATH"],
                                                             "PYTHONDONTWRITEBYTECODE": "1",
                                                             "FINNOR_Y4_SUPERVISOR_PID": str(os.getpid())}))
        receipts = []
        for agent, child in zip(agents, children):
            remaining = deadline(binding["session"]["deadlineAt"]) - time.time()
            require(remaining > 0, "ORIGINAL_DEADLINE_EXPIRED")
            stdout, _ = child.communicate(timeout=remaining)
            require(len(stdout) <= 262144, "PARTICIPANT_RECEIPT_BYTE_BOUND")
            receipt = json.loads(stdout)
            require(child.returncode == 0 and receipt["state"] == "COMPLETED"
                    and receipt["participantId"] == agent["participantId"]
                    and receipt["sessionId"] == binding["session"]["sessionId"]
                    and receipt["bindingDigest"] == digest(binding)
                    and receipt["programDigest"] == digest(manifest)
                    and receipt["nativeVerificationDigest"] == digest(verifications[len(receipts)]),
                    "PARTICIPANT_PROTOCOL_DID_NOT_COMPLETE")
            receipts.append(receipt)
        same_output_commitments(protocol, receipts)
        completed = True
        return {"status": "COMPUTED", "program": manifest, "receipts": receipts,
                "nativeVerifications": verifications,
                "wallSeconds": time.monotonic() - started, "outputs": "RECIPIENT_LOCAL_ONLY",
                "moneyUSD": None, "humanSeconds": None, "aggregatePeakMemoryBytes": None,
                "qualification": "LOCAL_ENGINEERING_ONLY", "protectedAdmission": False}
    finally:
        stopped = stop_participants(children)
        if not completed:
            # Successful verifiers have already exited, so signals alone cannot
            # burn their prepared secrets or dispose their invocation-owned tapes.
            # Each local owner performs this exact-session abort, not the bridge.
            disposed = dispose_all(bundle, agents)
            require(disposed and stopped, "ALL_PARTICIPANT_DISPOSALS_ATTEMPTED_SOME_FAILED")
        else:
            require(stopped, "COMPLETED_PARTICIPANT_SUPERVISORS_NOT_STOPPED")

def reconcile(request):
    """Status only. An expired, aborted or uncertain session is never restarted."""
    protocol, binding = request["bundle"]["protocol"], request["bundle"]["binding"]
    check(protocol["function"], protocol)
    # Deadline expiry must not prevent observing retained responsibility.
    output = Path(request["output"])
    manifest = json.loads((output / "emitted/program.json").read_text())
    require(manifest["protocolDigest"] == digest(protocol) and manifest["bindingDigest"] == digest(binding)
            and manifest["sourceIdentity"] == source_identity(), "RECONCILIATION_IDENTITY_MISMATCH")
    receipts, children = [], []
    observed_until = time.monotonic() + 5
    try:
        for agent in request["agents"]:
            command = [sys.executable, "-B", str(Path(__file__).with_name("participant.py")), "status",
                       "--bundle", str(output / "public-bundle.json"), "--participant", agent["participantId"],
                       "--authority", agent["authorityPath"], "--state", agent["stateDirectory"]]
            children.append(subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                                             env={"PATH": os.environ["PATH"], "PYTHONDONTWRITEBYTECODE": "1",
                                                  "FINNOR_Y4_SUPERVISOR_PID": str(os.getpid())}))
        for agent, child in zip(request["agents"], children):
            stdout, _ = child.communicate(timeout=max(0.001, observed_until-time.monotonic()))
            require(len(stdout) <= 262144 and child.returncode == 0, "PARTICIPANT_STATUS_UNAVAILABLE")
            receipt = json.loads(stdout)
            require(receipt.get("state") != "COMPLETED" or receipt.get("participantId") == agent["participantId"],
                    "EXACT_STATUS_PARTICIPANT_REQUIRED")
            receipts.append(receipt)
    finally:
        require(stop_participants(children), "READ_ONLY_STATUS_SUPERVISORS_NOT_STOPPED")
    completed = all(r.get("state") == "COMPLETED" and r.get("sessionId") == binding["session"]["sessionId"]
                    and r.get("bindingDigest") == digest(binding) and r.get("programDigest") == digest(manifest)
                    for r in receipts)
    if completed:
        same_output_commitments(protocol, receipts)
    return {"status": "COMPUTED" if completed else "RECONCILIATION_REQUIRED", "program": manifest,
            "receipts": receipts, "outputs": "RECIPIENT_LOCAL_ONLY", "wallSeconds": None,
            "automaticResubmission": False, "qualification": "LOCAL_ENGINEERING_ONLY", "protectedAdmission": False}


def main(request):
    action = request["action"]
    if action == "compile":
        protocol = compile_function(request["function"])
        return {"status": "CHECKED", "protocol": protocol, "correspondence": check(request["function"], protocol),
                "sourceIdentity": source_identity()}
    if action == "check":
        return check(request["function"], request["protocol"])
    if action == "session":
        verify_session(request["protocol"], request["session"])
        return {"status": "CHECKED"}
    if action == "binding":
        verify_binding(request["protocol"], request["binding"])
        return {"status": "CHECKED"}
    if action == "execute":
        return execute(request)
    if action == "reconcile":
        return reconcile(request)
    raise ValueError("PUBLIC_DRIVER_OPERATION_UNSUPPORTED")


if __name__ == "__main__":
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    try:
        body = sys.stdin.buffer.read(1048577)
        require(len(body) <= 1048576, "PUBLIC_DRIVER_REQUEST_BYTE_BOUND")
        request = json.loads(body)
        bind_supervisor()
        monitor_supervisor()
        # Conservative per-process limits. Sequential compiler children and all
        # participant/native supervisors share the original, nonrenewable total.
        if "limits" in request:
            limits = request["limits"]
            count = len(request.get("agents", [])) or 1
            memory = int(limits["maxMemoryBytes"]) // (4 * count + 4)
            total_cpu = int(limits["maxCpuSeconds"])
            cpu = min(8, total_cpu) if request["action"] == "execute" else max(1, total_cpu // (count + 1))
            resource.setrlimit(resource.RLIMIT_AS, (memory, int(limits["maxMemoryBytes"])))
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, total_cpu))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        result = main(request)
        print(canonical(result))
    except BaseException as error:
        predicate = str(error) if isinstance(error, (ValueError, RuntimeError)) \
            and re.fullmatch(r"[A-Z][A-Z0-9_]{1,120}", str(error)) else "PUBLIC_OR_NATIVE_PREMISE_UNPASSED"
        print(canonical({"status": "REFUSED", "predicate": predicate, "errorClass": type(error).__name__,
                         "protectedAdmission": False}))
        sys.exit(2)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
