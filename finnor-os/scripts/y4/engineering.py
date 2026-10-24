"""Finite installed engineering episodes, not protected-campaign submissions.

Only this synthetic verification administrator knows the original records.
Product compiler/checker receive declarations and commitments, never records.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import os
import random
import secrets
import sqlite3
import subprocess
import sys
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from pathlib import Path

APP = Path(__file__).resolve().parents[2]
PACKAGE = APP / "packages/private-equity/src/confidential-computation"
sys.path.insert(0, str(PACKAGE))
from compiler import canonical, compile_function, digest
from correspondence import check
from backend import file_digest, source_identity, output_commitment
from participant import prepare, status
from reference_oracle import evaluate


def owner(owner, id):
    return {"owner": owner, "id": id, "version": "synthetic-1",
            "contentDigest": digest({"synthetic": True, "owner": owner, "id": id})}


def semantics(unit="count"):
    return {"entityType": "joint-programme", "entityId": "10000000-0000-4000-8000-000000000001",
            "periodStart": "2026-10-01T00:00:00Z", "periodEnd": "2026-10-31T00:00:00Z", "unit": unit,
            "currencyCode": None, "frequency": "monthly", "calendar": "GREGORIAN",
            "consolidation": "CONSOLIDATED", "instrument": "explicit-joint-terms", "scale": "1", "sign": "AS_RECORDED"}


def inp(key):
    return {"kind": "input", "key": key}


def literal(n, unit="count"):
    return {"kind": "literal", "value": str(n), "unit": unit, "currencyCode": None}


def binary(kind, a, b):
    return {"kind": kind, "left": a, "right": b}


def conditional(comparison, left, right, yes, no):
    return {"kind": "if", "condition": {"comparison": comparison, "left": left, "right": right},
            "whenTrue": yes, "whenFalse": no}


def function(outputs=None, scale=0, suffix="numerical"):
    a, b, c = map(inp, ("a", "b", "c"))
    expressions = [
        ("sum", binary("add", binary("add", a, b), c), "count", ["p0"]),
        ("delta", binary("subtract", a, binary("add", b, c)), "count", ["p1"]),
        ("product", binary("multiply", binary("add", a, b), c), "count", ["p2"]),
        ("minimum", binary("min", a, binary("min", b, c)), "count", ["p0"]),
        ("maximum", binary("max", a, binary("max", b, c)), "count", ["p1"]),
        ("coverage", binary("ratio", a, b), "multiple", ["p2"]),
        ("conditional", conditional("lt", a, b, binary("min", a, c), binary("max", b, c)), "count", ["p0"]),
        ("tie", conditional("eq", a, a, b, c), "count", ["p1"]),
        ("unselected-invalid", conditional("gt", a, a, binary("ratio", a, literal(0)),
                                          binary("ratio", a, b)), "multiple", ["p2"]),
    ] if outputs is None else outputs
    until = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=55)).isoformat()
    return {"schema": "finnor.confidential-function.v1",
            "functionRef": owner("P1", f"synthetic-function-{suffix}"),
            "workRevisionRef": owner("Work", "synthetic-work-r1"),
            "baselineManifestRef": owner("P1", "synthetic-baseline"),
            "objectiveRef": owner("S4", "synthetic-objective"), "mandateRef": owner("S6", "synthetic-mandate"),
            "jointSemanticsRef": owner("P1", "explicit-joint-terms"),
            "purpose": "LOCAL_SYNTHETIC_Y4_ENGINEERING_NO_ECONOMIC_EFFECT",
            "participants": [{"id": f"p{i}", "institutionId": f"20000000-0000-4000-8000-{i:012d}",
                              "authorityRef": owner("S1", f"synthetic-local-authority-{i}")} for i in range(3)],
            "inputs": [{"key": k, "participantId": f"p{i}", "semantics": semantics(), "lower": "-100",
                        "upper": "100", "decimalPlaces": scale, "sourceRef": owner("P4", f"synthetic-source-{k}"),
                        "grantRef": owner("S1", f"synthetic-grant-{k}"), "validationRef": owner("P4", f"validation-{k}"),
                        "primaryEvidenceRef": None, "sourceStatus": "OWNER_ASSERTED", "freshUntil": until,
                        "rounding": "EXACT_OR_REJECT"} for i, k in enumerate(("a", "b", "c"))],
            "outputs": [{"key": key, "expression": expression, "semantics": semantics(unit),
                         "recipients": recipients} for key, expression, unit, recipients in expressions],
            "release": {"familyId": "synthetic-family", "policyRef": owner("S1", "synthetic-one-query"),
                        "termsRef": owner("S6", "synthetic-terms"), "maxDistinctFunctions": 1}}


def write(path, value):
    Path(path).write_text(canonical(value))
    os.chmod(path, 0o600)


def conformance(backend):
    lines = (backend / "Programs/Circuits/sha256.txt").read_text().splitlines()
    gate_count, wire_count = map(int, lines[0].split())
    initial = bytes.fromhex("6a09e667bb67ae853c6ef372a54ff53a510e527f9b05688c1f83d9ab5be0cd19")
    to_bits = lambda b: [int(c) for c in "".join(f"{v:08b}" for v in b)]
    messages = [bytes(40), bytes(range(40)), b"y4" * 20, secrets.token_bytes(40)]
    messages += [bytes((i * 17 + 3) % 256 for i in range(size)) for size in (0, 1, 55, 56, 64, 80, 128, 208)]
    for msg in messages:
        padded = msg + b"\x80" + bytes((55 - len(msg)) % 64) + (8 * len(msg)).to_bytes(8, "big")
        state = to_bits(initial)
        for offset in range(0, len(padded), 64):
            wires = to_bits(padded[offset:offset + 64])[::-1] + state[::-1] + [0] * (wire_count - 768)
            observed_gates = 0
            for line in lines[3:]:
                if not line.strip():
                    continue
                row = line.split()
                if row[0] == "2":
                    a, b, target = map(int, row[2:5])
                    wires[target] = wires[a] & wires[b] if row[5] == "AND" else wires[a] ^ wires[b]
                else:
                    a, target = map(int, row[2:4])
                    wires[target] = 1 ^ wires[a]
                observed_gates += 1
            assert observed_gates == gate_count
            state = wires[-256:][::-1]
        result = bytes(int("".join(map(str, state[i:i + 8])), 2) for i in range(0, 256, 8))
        assert result == hashlib.sha256(msg).digest()
    return {"status": "PASS", "messages": len(messages), "original40ByteMessages": 4,
            "maxMessageBytes": max(map(len, messages)), "circuitDigest": file_digest(backend / "Programs/Circuits/sha256.txt"),
            "oracle": "CPYTHON_OPENSSL_HASHLIB_SHA256", "protectedCases": 0}


def correspondence_cases(evidence):
    seed = secrets.token_hex(16)
    rng = random.Random(seed)
    accepted, rejected, public_cases = [], [], []
    for i in range(40):
        tree = binary("add", binary("subtract", inp("a"), inp("b")), inp("c"))
        for _ in range(rng.randint(1, 5)):
            tree = binary(rng.choice(("add", "subtract", "min", "max", "multiply")), tree,
                          literal(rng.randint(-9, 9)))
        f = function([("joint", tree, "count", ["p0"])], suffix=f"heldout-{i}")
        protocol = compile_function(f)
        receipt = check(f, protocol)
        public_cases.append({"originalFunction": f, "emittedProtocol": protocol})
        accepted.append({"functionDigest": digest(f), "protocolDigest": digest(protocol),
                         "checkedNodes": receipt["checkedNodes"]})
        bad = copy.deepcopy(protocol)
        bad["outputs"][0]["recipients"] = ["p1"]
        try:
            check(f, bad)
            raise AssertionError("ALTERED_RECIPIENT_ACCEPTED")
        except ValueError:
            rejected.append("recipient")
        bad = copy.deepcopy(protocol)
        node = next(n for n in bad["nodes"] if n["op"] in ("add", "subtract"))
        node["op"] = "subtract" if node["op"] == "add" else "add"
        try:
            check(f, bad)
            raise AssertionError("ALTERED_OPERATOR_ACCEPTED")
        except ValueError:
            rejected.append("operator")
        bad = copy.deepcopy(protocol)
        bad["nodes"][-1]["scale"] += 1
        try:
            check(f, bad)
            raise AssertionError("ALTERED_SCALE_ACCEPTED")
        except ValueError:
            rejected.append("scale")
        bad = copy.deepcopy(protocol)
        bad["nodes"][0]["high"] = str(int(bad["nodes"][0]["high"]) - 1)
        try:
            check(f, bad)
            raise AssertionError("UNSOUND_INTERVAL_ACCEPTED")
        except ValueError:
            rejected.append("interval")
        bad = copy.deepcopy(protocol)
        node = next(n for n in bad["nodes"] if n["op"] == "subtract")
        node["left"], node["right"] = node["right"], node["left"]
        node["leftFactor"], node["rightFactor"] = node["rightFactor"], node["leftFactor"]
        try:
            check(f, bad)
            raise AssertionError("ALTERED_ORDERED_TERM_ACCEPTED")
        except ValueError:
            rejected.append("ordered-term")
    public_cases_path = evidence / "heldout-public-functions.json"
    write(public_cases_path, public_cases)
    return {"status": "PASS", "localHeldOutDefinitions": 40, "generationSeed": seed,
            "compilerFrozenBeforeSeed": True, "accepted": accepted, "rejectedMutations": len(rejected),
            "rejectedMutationKinds": sorted(set(rejected)),
            "publicCasesArtifact": public_cases_path.name, "publicCasesSha256": file_digest(public_cases_path),
            "backendExecutedCases": 0, "protectedCases": 0}


def installed(f, values, backend, evidence, fault=None, *, deadline_at=None, cpu_seconds=3600, port_base=29140):
    private = evidence / "PRIVATE-NOT-FOR-HANDOFF"
    private.mkdir(mode=0o700)
    protocol = compile_function(f)
    correspondence = check(f, protocol)
    certs = {}
    states = []
    until = deadline_at or (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=15)).isoformat()
    for i, p in enumerate(f["participants"]):
        state = private / p["id"]
        ssl = state / "Player-Data"
        ssl.mkdir(parents=True, mode=0o700)
        os.chmod(state, 0o700)
        key = ssl / ("original-P1.private.key" if fault == "tls" and i == 1 else f"P{i}.key")
        subprocess.run(["openssl", "req", "-newkey", "rsa:2048", "-nodes", "-x509", "-days", "1",
                        "-out", str(ssl / f"P{i}.pem"), "-keyout", str(key),
                        "-subj", f"/CN=P{i}"], check=True, timeout=15,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if fault == "tls" and i == 1:
            # Fresh mismatched OWN key, never a peer's key. Keep its original.
            subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048",
                            "-out", str(ssl / "P1.key")], check=True, timeout=15,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.chmod(ssl / f"P{i}.key", 0o600)
        certs[p["id"]] = file_digest(ssl / f"P{i}.pem")
        states.append(state)
    for state in states:
        for i, origin in enumerate(states):
            if origin != state:
                (state / "Player-Data" / f"P{i}.pem").write_bytes((origin / "Player-Data" / f"P{i}.pem").read_bytes())
    session = {"schema": "finnor.y4.session.v1", "sessionId": secrets.token_hex(16),
               "functionDigest": digest(f), "profileDigest": protocol["profileDigest"],
               "releaseCutDigest": digest({"syntheticOriginalCut": "r1"}), "deadlineAt": until,
               "participantCertificateDigests": certs}
    commitments = []
    for p, state in zip(f["participants"], states):
        owned = [port for port in f["inputs"] if port["participantId"] == p["id"]]
        records = {port["key"]: {"key": port["key"], "value": values[port["key"]],
                   "sourceRef": port["sourceRef"], "validationRef": port["validationRef"]} for port in owned}
        authority = {"schema": "finnor.y4.local-owner-cut.v1", "participantId": p["id"],
                     "institutionId": p["institutionId"], "authorityRef": p["authorityRef"],
                     "functionDigest": digest(f), "purpose": f["purpose"], "releasePolicyRef": f["release"]["policyRef"],
                     "revoked": False, "epoch": 1, "expiresAt": until,
                     "sourceRefs": [i["sourceRef"] for i in owned], "grantRefs": [i["grantRef"] for i in owned],
                     "validationRefs": [i["validationRef"] for i in owned],
                     "recordDigests": {k: digest(v) for k, v in records.items()},
                     "outputRecipients": {o["key"]: o["recipients"] for o in f["outputs"]}}
        write(state / "authority.json", authority)
        commitment = prepare(protocol, session, p["id"], records, state / "authority.json", state)
        commitments.extend(commitment["inputs"])
    binding = {"session": session, "inputs": commitments}
    public = {"protocol": protocol, "binding": binding}
    write(evidence / "public-bundle.json", public)
    write(evidence / "correspondence.json", correspondence)
    if fault == "binding":
        # Authorized synthetic adversary alters one participant-local supplied
        # secret AFTER committing, without changing the public commitment.
        db = sqlite3.connect(states[0] / "participant.sqlite")
        row = db.execute("SELECT secret_json FROM attempts").fetchone()
        secret = json.loads(row[0])
        secret[0]["n"] = str(int(secret[0]["n"]) + 1)
        db.execute("UPDATE attempts SET secret_json=?", (canonical(secret),))
        db.commit()
        db.close()
    started = time.monotonic()
    request = {"action": "execute", "bundle": public, "backend": str(backend.resolve()),
               "output": str((evidence / "native").resolve()), "portBase": port_base,
               "agents": [{"participantId": p["id"], "stateDirectory": str(state.resolve()),
                           "authorityPath": str((state / "authority.json").resolve())}
                          for p, state in zip(f["participants"], states)],
               "limits": {"maxCpuSeconds": cpu_seconds, "maxMemoryBytes": 8 * 1024 ** 3,
                          "maxRetainedBytes": 16 * 1024 ** 2}}
    sentinel, blocked = None, None
    if fault == "verification":
        request["agents"][1]["authorityPath"] = str((states[0] / "authority.json").resolve())
    elif fault == "setup":
        sentinel = private / "preexisting-custody-sentinel"
        sentinel.mkdir(mode=0o700)
        (sentinel / "retained.txt").write_text("Retain this exact preexisting test custody.\n")
        blocked = states[0] / "sessions" / session["sessionId"]
        blocked.parent.mkdir(mode=0o700)
        blocked.symlink_to(sentinel.resolve(), target_is_directory=True)
    elif fault == "budget":
        request["limits"]["maxMemoryBytes"] = 1024 ** 3 - 1
    elif fault == "output":
        sentinel = evidence / "native"
        sentinel.mkdir(mode=0o700)
        (sentinel / "retained.txt").write_text("Retain this exact preexisting test custody.\n")
    child = subprocess.Popen([sys.executable, "-B", str(PACKAGE / "public_driver.py")],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                             env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1",
                                  "FINNOR_Y4_SUPERVISOR_PID": str(os.getpid())})
    native_fault = fault in ("dropout", "tls", "message", "cancel")
    pool, observer = None, None
    if native_fault and fault != "tls":
        from fault_observer import inject
        pool = ThreadPoolExecutor(max_workers=1)
        remaining = dt.datetime.fromisoformat(until).timestamp() - time.time()
        observer = pool.submit(inject, child, fault, backend, states, session["sessionId"],
                               time.monotonic() + remaining)
    try:
        remaining = dt.datetime.fromisoformat(until).timestamp() - time.time()
        assert remaining > 0, "ORIGINAL_ADVERSE_DEADLINE_EXPIRED"
        stdout, stderr = child.communicate(canonical(request), timeout=min(900, remaining))
        if stderr:
            (private / "driver.private-stderr.log").write_text(stderr)
        bridge = json.loads(stdout)
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=7)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        if pool:
            pool.shutdown(wait=True)
    if native_fault:
        injected, native_pids = observer.result() if observer else (
            {"injected": True, "target": "OWN_TLS_KEYPAIR_MISMATCH"}, [])
    receipts = [status(state, session["sessionId"]) for state in states]
    write(evidence / "participant-receipts.json", receipts)
    if fault in ("verification", "setup", "budget", "output"):
        from participant import run as participant_run
        assert bridge["status"] == "REFUSED" and child.returncode != 0, "PARTICIPANT_SETUP_FAILURE_ACCEPTED"
        assert all(r.get("state") == "ABORTED" for r in receipts), "LATER_PARTICIPANT_DISPOSAL_SKIPPED"
        assert not list(private.glob("*/release-*.private.json")), "SETUP_FAILURE_RELEASED_RESULT"
        manifest_path = evidence / "native/emitted/program.json"
        manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else None
        disclosure, verified = [], []
        for p, state in zip(f["participants"], states):
            with sqlite3.connect((state / "participant.sqlite").as_uri() + "?mode=ro", uri=True) as db:
                row = db.execute("SELECT state,original_deadline,secret_json IS NULL,release_nonce IS NULL,"
                                 "verification_json IS NOT NULL FROM attempts").fetchone()
                assert row[:4] == ("ABORTED", until, 1, 1), "SETUP_FAILURE_LEFT_PRIVATE_INPUTS_OR_RENEWED_DEADLINE"
                verified.append(bool(row[4]))
                disclosure.append(db.execute("SELECT count(*) FROM disclosure").fetchone()[0])
            assert not (state / "checked-native" / session["sessionId"] / "workspace").exists(), \
                "SETUP_FAILURE_LEFT_DISPOSABLE_TAPES"
            if manifest is not None:
                try:
                    participant_run(protocol, binding, manifest, p["id"], state / "authority.json", state, backend, port_base)
                    raise AssertionError("SETUP_FAILURE_SESSION_REPLAYED")
                except ValueError as error:
                    assert str(error) == "FRESH_VERIFIED_SESSION_REQUIRED", "SETUP_REPLAY_MISSED_DURABLE_BOUNDARY"
        assert disclosure == [1, 1, 1], "PREPARATION_DISCLOSURE_WAS_REFUNDED_OR_MULTIPLIED"
        if fault in ("verification", "setup"):
            assert verified[0], "FIRST_PARTICIPANT_NEVER_DURABLY_VERIFIED"
        else:
            assert not any(verified) and manifest is None, "SETUP_FAILURE_REACHED_NATIVE_VERIFICATION"
            assert not list(private.glob("*/runtime-*.private.log")), "SETUP_FAILURE_REACHED_NATIVE_INPUT"
        if fault == "setup":
            assert blocked.is_symlink() and (sentinel / "retained.txt").read_text() == \
                "Retain this exact preexisting test custody.\n", "PREEXISTING_CUSTODY_WAS_MODIFIED"
        if fault == "output":
            assert (sentinel / "retained.txt").read_text() == \
                "Retain this exact preexisting test custody.\n", "PREEXISTING_OUTPUT_CUSTODY_WAS_MODIFIED"
        return {"status": "PASS", "fault": fault, "states": [r["state"] for r in receipts],
                "firstVerifierDurablySucceeded": verified[0], "allParticipantDisposalsAttempted": True,
                "firstDisposalCustodyRefusalDidNotSkipPeers": fault == "setup",
                "privateInputsAndNoncesBurned": True, "disposableTapesRemoved": True,
                "preexistingCustodyPreserved": fault in ("setup", "output"), "acceptedReleases": 0,
                "originalSessionTerminal": True, "replayBoundaryObserved": manifest is not None,
                "disclosureCountsRetained": disclosure,
                "originalDeadlineAt": until, "nonrenewableCpuReservationSeconds": cpu_seconds,
                "wallSeconds": time.monotonic() - started}
    if native_fault:
        from participant import run as participant_run
        assert bridge["status"] == "REFUSED" and child.returncode != 0, "NATIVE_FAULT_WAS_ACCEPTED"
        assert all(r.get("state") == "ABORTED" for r in receipts), "NATIVE_FAULT_LEFT_UNRECONCILED_PARTICIPANT"
        assert not list(private.glob("*/release-*.private.json")), "NATIVE_FAULT_RELEASED_RESULT"
        logs = list(private.glob("*/runtime-*.private.log"))
        assert len(logs) == 3, "FAULT_DID_NOT_REACH_ALL_NATIVE_RUNTIMES"
        if fault in ("tls", "message"):
            tokens = ("key values mismatch", "private key", "use_privatekey") if fault == "tls" else (
                "bad record mac", "decryption failed", "alert decrypt", "bad_record_mac",
                "cipher operation failed (provider routines)")
            assert any(any(token in path.read_text(errors="replace").lower() for token in tokens) for path in logs), \
                "FAULT_DID_NOT_REACH_INTENDED_NATIVE_TLS_CHECK"
        assert all(not Path(f"/proc/{pid}").exists() for pid in native_pids), "OWN_NATIVE_PROCESS_SURVIVED_ABORT"
        manifest = json.loads((evidence / "native/emitted/program.json").read_text())
        replay_denials = []
        for p, state in zip(f["participants"], states):
            try:
                participant_run(protocol, binding, manifest, p["id"], state / "authority.json", state, backend, port_base)
                raise AssertionError("BURNED_NATIVE_SESSION_REPLAYED")
            except ValueError as error:
                assert str(error) == "FRESH_VERIFIED_SESSION_REQUIRED", "REPLAY_MISSED_ITS_DURABLE_SESSION_BOUNDARY"
                replay_denials.append(str(error))
            with sqlite3.connect((state / "participant.sqlite").as_uri() + "?mode=ro", uri=True) as db:
                row = db.execute("SELECT state,original_deadline,secret_json IS NULL,release_nonce IS NULL FROM attempts").fetchone()
                assert row == ("ABORTED", until, 1, 1), "BURNED_INPUTS_OR_ORIGINAL_DEADLINE_NOT_RETAINED"
                assert db.execute("SELECT count(*) FROM disclosure").fetchone()[0] == 1, "ABORT_REFUNDED_DISCLOSURE"
        assert [status(state, session["sessionId"]) for state in states] == receipts, "REPLAY_CHANGED_RECONCILIATION"
        return {"status": "PASS", "fault": fault, "expected": "ABORT", "injection": injected,
                "states": [r["state"] for r in receipts], "nativeRuntimesReached": 3,
                "nativeFailurePredicate": ("TLS_IDENTITY_REJECTED" if fault == "tls" else
                    "TLS_RECORD_AUTHENTICATION_REJECTED" if fault == "message" else "PARTICIPANT_PROCESS_LOST"),
                "nativeProcessesStopped": True, "acceptedReleases": 0,
                "preprocessingReplayDenied": replay_denials, "privateInputsBurned": True,
                "disclosureReservationsRetained": 3, "originalDeadlineAt": until,
                "nonrenewableCpuReservationSeconds": cpu_seconds, "wallSeconds": time.monotonic() - started}
    expected_abort = fault == "binding"
    expected = {}
    try:
        for output in f["outputs"]:
            expected[output["key"]] = evaluate(output["expression"], values)
    except ValueError:
        expected_abort = True
    if expected_abort:
        assert all(r.get("state") == "ABORTED" for r in receipts), "INVALID_ACCEPTED_OUTPUT_OR_UNRECONCILED_PARTICIPANT"
        assert not list(private.glob("*/release-*.private.json")), "ABORT_RELEASED_RESULT"
        intended = "Y4_INPUT_COMMITMENT_REJECTED" if fault == "binding" else "Y4_EXACT_NUMERICAL_PREMISE_REJECTED"
        assert any(intended in path.read_text(errors="replace") for path in private.glob("*/runtime-*.private.log")), \
            "NEGATIVE_DID_NOT_REACH_ITS_NATIVE_BOUNDARY"
        return {"status": "PASS", "expected": "ABORT", "fault": fault,
                "states": [r["state"] for r in receipts], "nativeBoundary": intended,
                "wallSeconds": time.monotonic() - started}
    assert bridge["status"] == "COMPUTED" and child.returncode == 0, "INSTALLED_PUBLIC_BRIDGE_DID_NOT_COMPLETE"
    assert all(r["state"] == "COMPLETED" for r in receipts), "INSTALLED_PROTOCOL_DID_NOT_COMPLETE"
    comparisons = []
    for p, state in zip(f["participants"], states):
        permitted = {o["key"] for o in f["outputs"] if p["id"] in o["recipients"]}
        release_path = state / f"release-{session['sessionId']}.private.json"
        receipt = next(r for r in receipts if r["participantId"] == p["id"])
        if not permitted:
            assert not release_path.exists(), "NONRECIPIENT_PRIVATE_RELEASE_PRESENT"
            assert receipt["releasedOutputKeys"] == [] and receipt["outputCommitment"] is None
            continue
        release = json.loads(release_path.read_text())
        assert {o["key"] for o in release["outputs"]} == permitted
        assert output_commitment(protocol, binding, p["id"], release["releaseNonce"], release["outputs"]) \
            == release["receipt"]["outputCommitment"], "MPC_OUTPUT_OPENING_MISMATCH"
        for output in release["outputs"]:
            actual = Fraction(int(output["mantissa"]), 10 ** output["scale"])
            assert actual == expected[output["key"]], "INDEPENDENT_NATIVE_RESULT_MISMATCH"
            comparisons.append({"participantId": p["id"], "key": output["key"], "matchesIndependentOracle": True,
                                "recipientOutputCommitment": release["receipt"]["outputCommitment"]})
    return {"status": "PASS", "participants": len(states), "outputs": comparisons,
            "independentNativeReconstructions": len(bridge["nativeVerifications"]),
            "mpcAuthenticatedOutputCommitments": True,
            "wallSeconds": time.monotonic() - started, "separatelyAdministered": False,
            "sourceTruthProven": False, "protectedCases": 0}


def adverse(backend, evidence, faults):
    until = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=3200)).isoformat()
    observer = Path(__file__).with_name("fault_observer.py")
    (evidence / observer.name).write_bytes(observer.read_bytes())
    results = []
    disposal = set(faults) == {"verification", "setup", "budget", "output"}
    total_cpu = 0
    for index, fault in enumerate(faults):
        directory = evidence / fault
        directory.mkdir(mode=0o700)
        f = function([("joint", binary("add", binary("add", inp("a"), inp("b")), inp("c")), "count", ["p0"])],
                     suffix="adverse-" + fault)
        for participant in f["participants"]:
            participant["institutionId"] = str(uuid.uuid4())
        for port in f["inputs"]:
            port["sourceRef"] = owner("P4", "synthetic-original-" + str(uuid.uuid4()))
        cpu = (700 if fault in ("verification", "setup") else 100) if disposal else 800
        total_cpu += cpu
        observed = installed(f, {"a": "-24", "b": "8", "c": "3"}, backend, directory, fault,
                             deadline_at=until, cpu_seconds=cpu, port_base=30140 + index * 20)
        archive = directory / "native-public-program.tar.gz"
        if (directory / "native/emitted/program.json").exists():
            subprocess.run([sys.executable, "-B", str(Path(__file__).with_name("archive-program.py")),
                        "--backend", str(backend), "--manifest", str(directory / "native/emitted/program.json"),
                        "--output", str(archive)], check=True, timeout=60, capture_output=True, text=True)
            observed["publicNativeProgramArchiveSha256"] = file_digest(archive)
        observed["generatedProgramsAndPrivateStateRetained"] = True
        write(directory / "result.json", observed)
        results.append(observed)
        write(evidence / "adverse-progress.json", results)
    return {"status": "PASS", "faults": results, "originalDeadlineAt": until,
            "faultObserverSha256": file_digest(observer), "sequentialNativeEpisodes": True,
            "requestedFaults": list(faults), "allRegisteredFaultsCovered": set(faults) == {"dropout", "tls", "message", "cancel"},
            "allDisposalFaultsCovered": disposal,
            "totalConservativeNativeCpuReservationsSeconds": total_cpu, "protectedCases": 0,
            "separatelyAdministered": False, "sourceTruthProven": False}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", required=True, choices=("hash-conformance", "correspondence", "numerical",
                        "numerical-reject", "binding", "adverse", "release", "recovery", "participant-disposal"))
    parser.add_argument("--backend", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--original-episode", type=Path)
    parser.add_argument("--faults", nargs="+", choices=("dropout", "tls", "message", "cancel"),
                        default=None)
    args = parser.parse_args()
    if args.faults is not None and (args.case != "adverse" or len(set(args.faults)) != len(args.faults)):
        parser.error("--faults requires the adverse case and unique fault names")
    args.evidence.mkdir(parents=True, mode=0o700, exist_ok=False)
    driver_bytes = Path(__file__).read_bytes()
    (args.evidence / "engineering-driver.py").write_bytes(driver_bytes)
    start = time.monotonic()
    result = {"case": args.case, "status": "FAIL", "identity": source_identity(),
              "driverSha256": hashlib.sha256(driver_bytes).hexdigest(), "protectedSubmission": False,
              "backendAssetDirectory": str(args.backend)}
    helper_names = ["reference_oracle.py"]
    if args.case in ("adverse", "participant-disposal"):
        helper_names.append("fault_observer.py")
    elif args.case == "release":
        helper_names.append("release_episode.py")
    elif args.case == "recovery":
        helper_names.append("recovery_episode.py")
    result["additionalDriverInputs"] = {}
    for name in helper_names:
        body = Path(__file__).with_name(name).read_bytes()
        (args.evidence / name).write_bytes(body)
        result["additionalDriverInputs"][name] = hashlib.sha256(body).hexdigest()
    exit_code = 0
    try:
        if args.case == "hash-conformance":
            result.update(conformance(args.backend))
        elif args.case == "correspondence":
            result.update(correspondence_cases(args.evidence))
        elif args.case == "numerical":
            result.update(installed(function(), {"a": "-24", "b": "8", "c": "3"}, args.backend, args.evidence))
        elif args.case == "binding":
            result.update(installed(function(), {"a": "-24", "b": "8", "c": "3"}, args.backend, args.evidence, "binding"))
        elif args.case == "numerical-reject":
            result.update(installed(function(), {"a": "1", "b": "3", "c": "2"}, args.backend, args.evidence))
        elif args.case == "adverse":
            result.update(adverse(args.backend, args.evidence, args.faults or ("dropout", "tls", "message", "cancel")))
        elif args.case == "participant-disposal":
            result.update(adverse(args.backend, args.evidence, ("verification", "setup", "budget", "output")))
        elif args.case == "release":
            from release_episode import run
            result.update(run(args.evidence, args.original_episode))
            result["releaseDriverSha256"] = result["additionalDriverInputs"]["release_episode.py"]
        elif args.case == "recovery":
            from recovery_episode import run
            result.update(run(args.evidence, args.original_episode, args.backend))
    except BaseException as error:
        result["failurePredicate"] = str(error)[:200] if isinstance(error, AssertionError) else type(error).__name__
        private = args.evidence / "PRIVATE-NOT-FOR-HANDOFF"
        private.mkdir(mode=0o700, exist_ok=True)
        (private / "failure.private.txt").write_text(traceback.format_exc())
        exit_code = 1
    result["totalWallSeconds"] = time.monotonic() - start
    result["moneyUSD"] = None
    result["aggregatePeakMemoryBytes"] = None
    result["humanSeconds"] = None
    result["privateEvidenceExcludedFromHandoff"] = "PRIVATE-NOT-FOR-HANDOFF"
    write(args.evidence / "result.json", result)
    print(canonical(result))
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
