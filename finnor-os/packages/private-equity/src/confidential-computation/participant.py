"""Participant-local commitment, durable leakage fence and native supervision.

Local owner cuts are explicit development witnesses, NOT an S1/S6 replacement,
source-truth proof, protected attestation or permission for an economic effect.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import resource
import secrets
import signal
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

from backend import (PROFILE, bind_supervisor, monitor_supervisor, canonical, check, deadline, digest, emit, file_digest,
                     output_commitment, prefix_for, require, source_identity,
                     verify_backend, verify_binding, verify_session)
from compiler import decimal

SUPERVISOR_PID = os.getpid()
NATIVE_CPU_SECONDS = None
NATIVE_MEMORY_BYTES = None

def private_directory(path):
    path = Path(path).resolve()
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(path.stat().st_mode & 0o077 == 0, "PARTICIPANT_DIRECTORY_MUST_BE_PRIVATE")
    return path


def ledger(root):
    db = sqlite3.connect(root / "participant.sqlite", timeout=5)
    os.chmod(root / "participant.sqlite", 0o600)
    db.execute("PRAGMA secure_delete=ON")
    db.execute("CREATE TABLE IF NOT EXISTS disclosure (family TEXT PRIMARY KEY, function_digest TEXT NOT NULL)")
    db.execute("""CREATE TABLE IF NOT EXISTS attempts
      (session TEXT PRIMARY KEY, function_digest TEXT NOT NULL, state TEXT NOT NULL,
       public_json TEXT NOT NULL, secret_json TEXT, owner_digest TEXT NOT NULL,
       original_deadline TEXT NOT NULL, receipt_json TEXT, release_nonce TEXT, verification_json TEXT)""")
    return db


def owner_cut(authority_path, protocol, participant, records=None):
    cut = json.loads(Path(authority_path).read_text())
    function = protocol["function"]
    p = next(p for p in function["participants"] if p["id"] == participant)
    owned = [i for i in function["inputs"] if i["participantId"] == participant]
    require(cut["schema"] == "finnor.y4.local-owner-cut.v1"
            and cut["participantId"] == participant and cut["institutionId"] == p["institutionId"]
            and cut["authorityRef"] == p["authorityRef"]
            and cut["functionDigest"] == protocol["functionDigest"]
            and cut["purpose"] == function["purpose"] and cut["releasePolicyRef"] == function["release"]["policyRef"],
            "PARTICIPANT_LOCAL_OWNER_SCOPE_MISMATCH")
    require(cut["revoked"] is False and deadline(cut["expiresAt"]) > time.time(), "PARTICIPANT_CONSENT_NOT_CURRENT")
    require(type(cut["epoch"]) is int and cut["epoch"] >= 1, "OWNER_REVOCATION_EPOCH_REQUIRED")
    require(cut["sourceRefs"] == [i["sourceRef"] for i in owned]
            and cut["grantRefs"] == [i["grantRef"] for i in owned]
            and cut["validationRefs"] == [i["validationRef"] for i in owned]
            and cut["outputRecipients"] == {o["key"]: o["recipients"] for o in function["outputs"]},
            "EXACT_INPUT_GRANTS_AND_OUTPUT_CONSENT_REQUIRED")
    for port in owned:
        require(deadline(port["freshUntil"]) > time.time(), "PARTICIPANT_INPUT_STALE")
        if records is not None:
            record = records[port["key"]]
            require(set(record) == {"key", "value", "sourceRef", "validationRef"}
                    and record["key"] == port["key"] and record["sourceRef"] == port["sourceRef"]
                    and record["validationRef"] == port["validationRef"]
                    and digest(record) == cut["recordDigests"][port["key"]],
                    "LOCAL_VALIDATION_OR_SOURCE_BYTES_MISMATCH")
    return cut


def public_owner_identity(cut):
    # An unsalted hash containing recordDigests would enable guessing a small
    # private numeric domain. Full record digests stay only in the local ledger.
    return digest({key: value for key, value in cut.items() if key != "recordDigests"})


def prepare(protocol, session, participant, records, authority, state):
    check(protocol["function"], protocol)
    verify_session(protocol, session)
    root = private_directory(state)
    cut = owner_cut(authority, protocol, participant, records)
    own = [p for p in protocol["function"]["inputs"] if p["participantId"] == participant]
    require(set(records) == {p["key"] for p in own}, "ONLY_OWN_INPUTS_ACCEPTED_LOCALLY")
    public, private = [], []
    for port in own:
        n, scale = decimal(records[port["key"]]["value"])
        require(scale <= port["decimalPlaces"], "PRIVATE_INPUT_OFF_LATTICE")
        n *= 10 ** (port["decimalPlaces"] - scale)
        low, ls = decimal(port["lower"])
        high, hs = decimal(port["upper"])
        low *= 10 ** (port["decimalPlaces"] - ls)
        high *= 10 ** (port["decimalPlaces"] - hs)
        require(low <= n <= high and -(2 ** 63) < n < 2 ** 63, "LOCAL_PRIVATE_INPUT_BOUND_REJECTED")
        prefix = prefix_for(protocol, session, port["key"])
        nonce = secrets.token_bytes(16)
        commitment = hashlib.sha256(bytes.fromhex(prefix) + nonce + n.to_bytes(8, "big", signed=True)).hexdigest()
        public.append({"key": port["key"], "bindingPrefix": prefix, "commitment": commitment})
        private.append({"key": port["key"], "n": str(n), "nonce": nonce.hex()})
    f = protocol["function"]
    # Stable policy/mandate identity, intentionally excluding caller-selected
    # family labels, input versions and policy versions. These cannot reset history.
    families = sorted({digest({"institutionId": cut["institutionId"], "owner": p["sourceRef"]["owner"],
                               "sourceId": p["sourceRef"]["id"]}) for p in own})
    with ledger(root) as db:
        db.execute("BEGIN IMMEDIATE")
        for family in families:
            previous = db.execute("SELECT function_digest FROM disclosure WHERE family=?", (family,)).fetchone()
            require(previous is None, "CUMULATIVE_DISCLOSURE_BUDGET_CONSUMED")
        uncertain = db.execute("SELECT session FROM attempts WHERE state IN ('PREPARED','VERIFYING','VERIFIED','RUNNING','UNKNOWN')").fetchone()
        require(uncertain is None, "PRIOR_SESSION_REQUIRES_LOCAL_RECONCILIATION")
        for family in families:
            db.execute("INSERT INTO disclosure VALUES (?,?)", (family, protocol["functionDigest"]))
        db.execute("""INSERT INTO attempts
                   (session,function_digest,state,public_json,secret_json,owner_digest,original_deadline,receipt_json)
                   VALUES (?,?,?,?,?,?,?,NULL)""",
                   (session["sessionId"], protocol["functionDigest"], "PREPARED", canonical(public),
                    canonical(private), digest(cut), session["deadlineAt"],))
        if any(participant in output["recipients"] for output in protocol["outputs"]):
            db.execute("UPDATE attempts SET release_nonce=? WHERE session=?",
                       (secrets.token_hex(16), session["sessionId"]))
    return {"participantId": participant, "sessionId": session["sessionId"],
            "functionDigest": protocol["functionDigest"], "inputs": public,
            "ownerCutDigest": public_owner_identity(cut), "qualification": "LOCAL_ENGINEERING_ONLY",
            "sourceTruthProven": False, "executionAuthority": False}


def stop(child):
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


def bounded_child():
    bind_supervisor(SUPERVISOR_PID, signal.SIGKILL)
    inherited = resource.getrlimit(resource.RLIMIT_AS)[0]
    allocation = NATIVE_MEMORY_BYTES if NATIVE_MEMORY_BYTES is not None else inherited
    bound = min(2 * 1024 ** 3, allocation) if allocation != resource.RLIM_INFINITY else 2 * 1024 ** 3
    resource.setrlimit(resource.RLIMIT_AS, (bound, bound))
    if NATIVE_CPU_SECONDS is not None:
        resource.setrlimit(resource.RLIMIT_CPU, (NATIVE_CPU_SECONDS, NATIVE_CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def bounded_auxiliary():
    bind_supervisor(SUPERVISOR_PID, signal.SIGKILL)
    resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def verify_program(protocol, binding, manifest, participant, authority, state, backend,
                   compile_memory_bytes=None, compile_cpu_seconds=None):
    """Reconstruct native tapes locally before delivering any private inputs."""
    root = private_directory(state)
    check(protocol["function"], protocol)
    verify_binding(protocol, binding)
    require(manifest["sourceIdentity"] == source_identity(), "LOCAL_COMPILER_OR_CHECKER_IDENTITY_CHANGED")
    cut = owner_cut(authority, protocol, participant)
    session = binding["session"]["sessionId"]
    with ledger(root) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT state,public_json,owner_digest FROM attempts WHERE session=?",
                         (session,)).fetchone()
        require(row is not None and row[0] == "PREPARED" and row[2] == digest(cut),
                "FRESH_PREPARED_NATIVE_VERIFICATION_REQUIRED")
        require(all(item in binding["inputs"] for item in json.loads(row[1])), "OWN_COMMITMENT_SUBSTITUTED")
        db.execute("UPDATE attempts SET state='VERIFYING' WHERE session=?", (session,))
    verification = root / "checked-native" / session
    workspace = verification / "workspace"
    created = False
    try:
        verification.mkdir(mode=0o700, parents=True, exist_ok=False)
        created = True
        local = emit(protocol, binding, backend, verification / "emitted",
                     compile_memory_bytes, compile_cpu_seconds, workspace)
        fields = ("schema", "name", "protocolDigest", "bindingDigest", "sourceIdentity", "backendIdentity",
                  "files", "sourceDigest", "command", "correspondence")
        require(all(local[field] == manifest[field] for field in fields),
                "INDEPENDENT_NATIVE_RECONSTRUCTION_MISMATCH")
        require(digest(owner_cut(authority, protocol, participant)) == digest(cut),
                "POST_VERIFICATION_OWNER_CURRENTNESS_FAILED")
        verify_binding(protocol, binding)
        receipt = {"schema": "finnor.y4.native-verification.v1", "participantId": participant,
                   "sessionId": session, "programDigest": digest(manifest), "bindingDigest": digest(binding),
                   "emissionFilesDigest": digest(local["files"]), "sourceIdentity": local["sourceIdentity"],
                   "nativeCompileCpuSeconds": local["nativeCompileCpuSeconds"],
                   "nativeCompilePeakRSSBytes": local["nativeCompilePeakRSSBytes"],
                   "independentlyReconstructed": True, "physicalCompilerStopped": True}
        with ledger(root) as db:
            db.execute("UPDATE attempts SET state='VERIFIED',verification_json=? WHERE session=? AND state='VERIFYING'",
                       (canonical({"workspace": str(workspace), "receipt": receipt}), session))
        return receipt
    except BaseException:
        with ledger(root) as db:
            db.execute("UPDATE attempts SET state='ABORTED',secret_json=NULL,release_nonce=NULL WHERE session=?",
                       (session,))
        if created and workspace.is_dir() and not workspace.is_symlink() \
                and workspace.resolve().is_relative_to(verification.resolve()):
            # This directory was created by this invocation with exist_ok=False.
            # Keep its manifest/log outside it, but not duplicate disposable tapes.
            shutil.rmtree(workspace)
        raise

def status(state, session):
    """Read-only reconciliation. Never restart or load retained secret inputs."""
    require(re.fullmatch(r"[a-f0-9]{32}", session) is not None, "EXACT_SESSION_REQUIRED")
    path = Path(state).resolve(strict=True) / "participant.sqlite"
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        row = db.execute("SELECT state, receipt_json FROM attempts WHERE session=?", (session,)).fetchone()
    if row is None:
        return {"state": "NOT_OBSERVED", "sessionId": session, "automaticResubmission": False}
    return json.loads(row[1]) if row[1] else {
        "state": row[0], "sessionId": session, "automaticResubmission": False}

def dispose_session(protocol, binding, participant, state):
    """Owner-local abort after peers stop. Never refund or inspect stored inputs."""
    root = private_directory(state)
    session = binding["session"]["sessionId"]
    require(re.fullmatch(r"[a-f0-9]{32}", session) is not None
            and participant in [p["id"] for p in protocol["function"]["participants"]]
            and digest(protocol["function"]) == protocol["functionDigest"]
            and binding["session"]["functionDigest"] == protocol["functionDigest"],
            "EXACT_ABORTED_SESSION_REQUIRED")
    with ledger(root) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT function_digest,state FROM attempts WHERE session=?", (session,)).fetchone()
        if row is None:
            return {"state": "NOT_OBSERVED", "sessionId": session, "disclosureRefunded": False}
        require(row[0] == protocol["functionDigest"], "EXACT_ABORTED_SESSION_REQUIRED")
        if row[1] == "FINISHED":
            # Earlier private knowledge cannot be recalled because a peer failed.
            return {"state": "FINISHED", "sessionId": session, "disclosureRefunded": False}
        db.execute("UPDATE attempts SET state='ABORTED',secret_json=NULL,release_nonce=NULL WHERE session=?", (session,))
    for path in (root / "checked-native" / session / "workspace", root / "sessions" / session):
        require(not path.is_symlink(), "PARTICIPANT_DISPOSABLE_CUSTODY_CHANGED")
        if path.is_dir():
            shutil.rmtree(path)
    return {"state": "ABORTED", "sessionId": session, "secretsBurned": True, "disclosureRefunded": False}


def run(protocol, binding, manifest, participant, authority, state, backend, port_base, cancel=None):
    root = private_directory(state)
    require(type(port_base) is int and 20000 <= port_base <= 60000, "ENGINEERING_PORT_RANGE_REQUIRED")
    require(manifest["sourceIdentity"] == source_identity(), "LOCAL_COMPILER_OR_CHECKER_IDENTITY_CHANGED")
    check(protocol["function"], protocol)
    verify_binding(protocol, binding)
    backend = verify_backend(backend)
    require(manifest["protocolDigest"] == digest(protocol) and manifest["bindingDigest"] == digest(binding)
            and re.fullmatch(r"y4_[a-f0-9]{40}", manifest["name"]), "EMITTED_ARTIFACT_BINDING_MISMATCH")
    participants = [p["id"] for p in protocol["function"]["participants"]]
    player = participants.index(participant)
    ssl = root / "Player-Data"
    for index, identity in enumerate(participants):
        require(file_digest(ssl / f"P{index}.pem") ==
                binding["session"]["participantCertificateDigests"][identity], "PEER_TLS_IDENTITY_MISMATCH")
    require((ssl / f"P{player}.key").stat().st_mode & 0o077 == 0, "PRIVATE_TLS_KEY_PERMISSIONS_REQUIRED")
    require(not any((ssl / f"P{i}.key").exists() for i in range(len(participants)) if i != player),
            "PARTICIPANT_MUST_NOT_HOLD_PEER_PRIVATE_KEYS")
    cut = owner_cut(authority, protocol, participant)
    session = binding["session"]["sessionId"]
    with ledger(root) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT state,public_json,secret_json,owner_digest,release_nonce,verification_json FROM attempts WHERE session=?",
                         (session,)).fetchone()
        require(row is not None and row[0] == "VERIFIED" and row[3] == digest(cut), "FRESH_VERIFIED_SESSION_REQUIRED")
        verification = json.loads(row[5])
        witness = verification["receipt"]
        require(witness["programDigest"] == digest(manifest) and witness["bindingDigest"] == digest(binding)
                and witness["participantId"] == participant and witness["independentlyReconstructed"] is True,
                "PARTICIPANT_LOCAL_NATIVE_VERIFICATION_REQUIRED")
        workspace = Path(verification["workspace"]).resolve(strict=True)
        require(workspace.is_relative_to(root)
                and workspace == (root / "checked-native" / session / "workspace").resolve(strict=True),
                "EXACT_PARTICIPANT_PROGRAM_CUSTODY_REQUIRED")
        programs = (workspace / "Programs").resolve(strict=True)
        for name, expected in manifest["files"].items():
            path = (workspace / name).resolve(strict=True)
            require(path.is_relative_to(programs) and file_digest(path) == expected,
                    "EXECUTABLE_TAPE_IDENTITY_MISMATCH")
        public, private = json.loads(row[1]), json.loads(row[2])
        release_nonce = row[4]
        require(all(p in binding["inputs"] for p in public), "OWN_COMMITMENT_SUBSTITUTED")
        db.execute("UPDATE attempts SET state='RUNNING',secret_json=NULL,release_nonce=NULL WHERE session=?", (session,))
    # No Player-Data/OT/MAC/preprocessing directory ever crosses a session.
    runtime_root = root / "sessions" / session
    runtime_ssl = runtime_root / "Player-Data"
    input_path = runtime_ssl / f"Input-P{player}-0"
    runtime_created = False
    try:
        runtime_root.mkdir(parents=True, mode=0o700, exist_ok=False)
        runtime_created = True
        runtime_ssl.mkdir(mode=0o700)
        for index in range(len(participants)):
            shutil.copyfile(ssl / f"P{index}.pem", runtime_ssl / f"P{index}.pem")
        shutil.copyfile(ssl / f"P{player}.key", runtime_ssl / f"P{player}.key")
        os.chmod(runtime_ssl / f"P{player}.key", 0o600)
        subprocess.run(["openssl", "rehash", str(runtime_ssl)], check=True, capture_output=True,
                       preexec_fn=bounded_auxiliary)
        (runtime_root / "Programs").symlink_to(workspace / "Programs", target_is_directory=True)
        require(not input_path.exists(), "NO_REUSED_INPUT_FILE")
        with input_path.open("x") as file:
            os.chmod(input_path, 0o600)
            for item in private:
                n = int(item["n"]) % (2 ** 64)
                bits = [(n >> i) & 1 for i in range(64)]
                bits += [(b >> j) & 1 for b in bytes.fromhex(item["nonce"]) for j in range(7, -1, -1)]
                file.write(" ".join(map(str, bits)) + "\n")
            if release_nonce is not None:
                bits = [(byte >> shift) & 1 for byte in bytes.fromhex(release_nonce) for shift in range(7, -1, -1)]
                file.write(" ".join(map(str, bits)) + "\n")
        command = [str(backend / "local/runtime-libs/ld-linux-x86-64.so.2"),
                   "--library-path", str(backend / "local/runtime-libs"),
                   str(backend / "mascot-party.x"), "-e", "-N", str(len(participants)),
                   "-p", str(player), "-h", "127.0.0.1", "-pn", str(port_base),
                   "-P", PROFILE["backend"]["prime"], "-S", "40", "-b", "1000", "-OF", ".", "-v",
                   manifest["name"]]
        started = time.monotonic()
        log_path = root / f"runtime-{session}.private.log"
        with log_path.open("xb") as log:
            os.chmod(log_path, 0o600)
            child = subprocess.Popen(command, cwd=runtime_root, stdout=log, stderr=subprocess.STDOUT,
                                     env={"PATH": os.environ["PATH"], "MALLOC_ARENA_MAX": "2"}, start_new_session=True,
                                     preexec_fn=bounded_child)
            failure = None
            try:
                while child.poll() is None:
                    if time.time() >= deadline(binding["session"]["deadlineAt"]):
                        failure = "ORIGINAL_DEADLINE_EXPIRED"
                        break
                    if cancel is not None and Path(cancel).exists():
                        failure = "PHYSICAL_CANCELLATION"
                        break
                    try:
                        current = owner_cut(authority, protocol, participant)
                        require(digest(current) == digest(cut), "OWNER_EPOCH_OR_CONSENT_CHANGED")
                    except (ValueError, OSError, KeyError):
                        failure = "AUTHORITY_OR_FRESHNESS_REVOKED"
                        break
                    if log.tell() > 16 * 1024 ** 2 or log_path.stat().st_size > 16 * 1024 ** 2:
                        failure = "OUTPUT_BYTE_BOUND"
                        break
                    try:
                        child.wait(timeout=0.2)
                    except subprocess.TimeoutExpired:
                        pass
            finally:
                stop(child)
        try:
            current = owner_cut(authority, protocol, participant)
            require(digest(current) == digest(cut), "POST_EXECUTION_OWNER_CURRENTNESS_FAILED")
        except (ValueError, OSError, KeyError):
            failure = failure or "POST_EXECUTION_AUTHORITY_OR_FRESHNESS_REVOKED"
        text = log_path.read_text(errors="replace")
        result_lines = re.findall(r"Y4_RESULT:(\d+):(-?\d+)", text)
        permitted = {i for i, o in enumerate(protocol["outputs"]) if participant in o["recipients"]}
        observed = [int(i) for i, _ in result_lines]
        commitment_lines = re.findall(r"Y4_OUTPUT_COMMITMENT:(\d+):(\d+):(\d+):(\d+):(\d+)", text)
        output_commitments = {}
        for index, *words in commitment_lines:
            require(0 <= int(index) < len(participants)
                    and all(0 <= int(word) < 2 ** 64 for word in words),
                    "NATIVE_OUTPUT_COMMITMENT_ENCODING_INVALID")
            identity = participants[int(index)]
            require(identity not in output_commitments, "DUPLICATE_NATIVE_OUTPUT_COMMITMENT")
            output_commitments[identity] = "".join(f"{int(word):016x}" for word in words)
        required_commitments = {identity for identity in participants
                                if any(identity in output["recipients"] for output in protocol["outputs"])}
        accepted = failure is None and child.returncode == 0 and set(observed) == permitted \
            and len(observed) == len(permitted) and set(output_commitments) == required_commitments
        prime = int(PROFILE["backend"]["prime"])
        results = []
        if accepted:
            for index, encoded in result_lines:
                n = int(encoded)
                n = n - prime if n > prime // 2 else n
                require(abs(n) < 2 ** 80, "RELEASED_VALUE_RANGE_INVALID")
                output = protocol["outputs"][int(index)]
                results.append({"key": output["key"], "mantissa": str(n), "scale": output["scale"]})
        if accepted and results:
            require(output_commitment(protocol, binding, participant, release_nonce, results)
                    == output_commitments[participant], "MPC_AUTHENTICATED_OUTPUT_OPENING_MISMATCH")
        receipt = {"schema": "finnor.y4.participant-runtime.v1", "participantId": participant,
                   "sessionId": session, "state": "COMPLETED" if accepted else "ABORTED",
                   "functionDigest": protocol["functionDigest"], "programDigest": digest(manifest),
                   "bindingDigest": digest(binding), "ownerCutDigest": public_owner_identity(cut),
                   "ownerEpoch": cut["epoch"],
                   "outputCommitment": output_commitments.get(participant) if accepted else None,
                   "outputCommitments": output_commitments if accepted else {},
                   "nativeVerificationDigest": digest(witness), "nativeIndependentlyReconstructed": True,
                   "releasedOutputKeys": [r["key"] for r in results], "wallSeconds": time.monotonic() - started,
                   "exitCode": child.returncode, "abort": failure or (None if accepted else "NATIVE_PROTOCOL_ABORT"),
                   "physicalProcessStopped": child.poll() is not None, "preprocessingReusePermitted": False,
                   "qualification": "LOCAL_ENGINEERING_ONLY", "sourceTruthProven": False}
        if results:
            release_path = root / f"release-{session}.private.json"
            release_path.write_text(canonical({"receipt": receipt, "outputs": results, "releaseNonce": release_nonce}))
            os.chmod(release_path, 0o600)
        with ledger(root) as db:
            db.execute("UPDATE attempts SET state=?, receipt_json=? WHERE session=?",
                       ("FINISHED" if accepted else "ABORTED", canonical(receipt), session))
        return receipt
    except BaseException:
        with ledger(root) as db:
            db.execute("UPDATE attempts SET state='ABORTED',secret_json=NULL,release_nonce=NULL WHERE session=?", (session,))
        raise
    finally:
        # Exact file created by this participant in this invocation, never a
        # wildcard cleanup. OT/MAC state is not resumed by any subsequent session.
        if runtime_created and runtime_root.is_dir() and not runtime_root.is_symlink():
            shutil.rmtree(runtime_root)
        # No native process remains, and no accepted session can be replayed.
        # The public emission and independent reconstruction witness are retained.
        if workspace.is_dir():
            shutil.rmtree(workspace)


if __name__ == "__main__":
    os.umask(0o077)
    def interrupted(_signal, _frame):
        signal.setitimer(signal.ITIMER_REAL, 0)
        raise RuntimeError("PARTICIPANT_SUPERVISOR_CANCELLED")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    bind_supervisor()
    monitor_supervisor()
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("prepare", "verify-program", "run", "status", "export", "dispose-session"))
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--participant", required=True)
    parser.add_argument("--authority", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--records", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--backend", type=Path)
    parser.add_argument("--port-base", type=int, default=29000)
    parser.add_argument("--cancel", type=Path)
    parser.add_argument("--compile-memory-bytes", type=int)
    parser.add_argument("--compile-cpu-seconds", type=int)
    parser.add_argument("--native-memory-bytes", type=int)
    parser.add_argument("--native-cpu-seconds", type=int)
    args = parser.parse_args()
    NATIVE_MEMORY_BYTES, NATIVE_CPU_SECONDS = args.native_memory_bytes, args.native_cpu_seconds
    try:
        if args.action == "dispose-session" and str(args.bundle) == "-":
            body = sys.stdin.buffer.read(1048577)
            require(len(body) <= 1048576, "PUBLIC_DISPOSAL_BUNDLE_BYTE_BOUND")
            bundle = json.loads(body)
        else:
            bundle = json.loads(args.bundle.read_text())
        if args.action == "prepare":
            result = prepare(bundle["protocol"], bundle["session"], args.participant,
                             json.loads(args.records.read_text()), args.authority, args.state)
        elif args.action == "verify-program":
            result = verify_program(bundle["protocol"], bundle["binding"], json.loads(args.manifest.read_text()),
                                    args.participant, args.authority, args.state, args.backend,
                                    args.compile_memory_bytes, args.compile_cpu_seconds)
        elif args.action == "dispose-session":
            result = dispose_session(bundle["protocol"], bundle["binding"], args.participant, args.state)
        elif args.action == "status":
            result = status(args.state, bundle["binding"]["session"]["sessionId"])
            if result["state"] == "COMPLETED":
                require(result["participantId"] == args.participant
                        and result["bindingDigest"] == digest(bundle["binding"])
                        and result["functionDigest"] == bundle["protocol"]["functionDigest"],
                        "EXACT_PARTICIPANT_STATUS_REQUIRED")
        elif args.action == "export":
            session = bundle["binding"]["session"]["sessionId"]
            receipt = status(args.state, session)
            check(bundle["protocol"]["function"], bundle["protocol"])
            verify_binding(bundle["protocol"], bundle["binding"])
            cut = owner_cut(args.authority, bundle["protocol"], args.participant)
            path = args.state.resolve(strict=True) / "participant.sqlite"
            with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
                original = db.execute("SELECT owner_digest FROM attempts WHERE session=?", (session,)).fetchone()
            require(original is not None and original[0] == digest(cut)
                    and receipt["ownerEpoch"] == cut["epoch"],
                    "EXACT_ORIGINAL_RECIPIENT_AUTHORITY_REQUIRED")
            require(receipt["state"] == "COMPLETED" and receipt["participantId"] == args.participant
                    and receipt["bindingDigest"] == digest(bundle["binding"])
                    and receipt["functionDigest"] == bundle["protocol"]["functionDigest"],
                    "COMPLETED_LOCAL_RECIPIENT_RECEIPT_REQUIRED")
            release = args.state / f"release-{session}.private.json"
            result = json.loads(release.read_text())
            require(result["receipt"] == receipt, "EXACT_RECIPIENT_RELEASE_REQUIRED")
        else:
            result = run(bundle["protocol"], bundle["binding"], json.loads(args.manifest.read_text()),
                         args.participant, args.authority, args.state, args.backend, args.port_base, args.cancel)
        print(canonical(result))
    except (ValueError, KeyError, OSError, sqlite3.Error, TypeError, StopIteration) as error:
        code = str(error) if re.fullmatch(r"[A-Z][A-Z0-9_]{0,127}", str(error)) else "PARTICIPANT_LOCAL_PREMISE_UNPASSED"
        print(canonical({"state": "REFUSED", "predicate": code, "protectedAdmission": False}))
        sys.exit(2)
    finally:
        # No child remains after an operation returns. Do not leave an interval
        # timer armed while interpreter teardown restores default dispositions.
        signal.setitimer(signal.ITIMER_REAL, 0)
