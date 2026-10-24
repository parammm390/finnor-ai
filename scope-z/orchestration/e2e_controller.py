#!/usr/bin/env python3
"""Failure-first subprocess E2E for the engineering receipt controller.

All Computers, sessions and receipts here are explicitly SIMULATED. This checks
local scheduling and file custody, never FINNOR or remote execution.
"""
import concurrent.futures
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
import uuid

REPO = pathlib.Path(__file__).resolve().parents[2]
CONTROL = REPO / "scope-z/orchestration/control.py"
RUN = REPO / "scope-z/orchestration/evidence" / ("controller-" + uuid.uuid4().hex)
ROOT = RUN / "fixture"
STATE = ROOT / "control-state"
COMMANDS = []
CASES = []
PLANNED = [
    "sealed-fixture-init", "idempotent-init", "draft-missing-lock",
    "mutated-product-lock-member", "symlink-member", "fixture-live-separation",
    "request-exact-initial-group", "reject-early-Z3", "reject-staged-computer",
    "reject-wrong-model", "reject-missing-model-role", "start-initial-three",
    "reject-duplicate-computer", "start-idempotence", "event-payload-conflict",
    "accepted-evidence-byte-substitution", "same-event-changed-descendant-rejected",
    "certification-does-not-release-slot", "interruption-not-completion",
    "resume-same-parent", "reject-reset-parent", "reject-out-of-owner-handoff",
    "reject-wrong-cut", "reject-incomplete-internal-software",
    "atomic-concurrent-handoffs", "ordered-refill-Z3-Z4",
    "reject-fourth-slot", "handoff-refills-Z5-without-certification",
    "replayed-handoff-does-not-refill-twice", "unknown-launch-retains-slot",
    "reconcile-same-launch-intent", "physical-pointer-interruption",
    "orphan-snapshot-fails-closed", "recover-exact-immutable-pending-state",
    "corrupt-state-fails-closed",
    "immutable-snapshots-survive", "final-model-and-three-slot-invariants"
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write(rel, value):
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    data = value if isinstance(value, bytes) else (
        json.dumps(value, sort_keys=True, indent=2) + "\n").encode()
    path.write_bytes(data)
    return {"path": rel, "bytes": len(data), "sha256": digest(data)}


def evidence(rel, value):
    row = write(rel, value)
    return {"path": row["path"], "sha256": row["sha256"],
            "class": "SIMULATED"}


def call(command, *, event=None, receipt=None, ok=True, extra=None, failpoint=False):
    argv = [sys.executable, str(CONTROL), "--root", str(ROOT),
            "--state", str(STATE), "--fixture", command]
    if event:
        argv += ["--event-id", event]
    if receipt:
        argv += ["--receipt", str(ROOT / receipt)]
    argv += extra or []
    before = (STATE / "state.json").read_bytes() if (STATE / "state.json").exists() else None
    env = os.environ.copy()
    if failpoint:
        env["FINNOR_Z_CONTROLLER_FIXTURE_FAIL_AFTER_SNAPSHOT"] = "1"
    result = subprocess.run(argv, capture_output=True, text=True, timeout=20, env=env)
    row = {"argv": argv, "exitCode": result.returncode,
           "stdout": result.stdout, "stderr": result.stderr,
           "beforeStateSha256": digest(before) if before else None}
    after = (STATE / "state.json").read_bytes() if (STATE / "state.json").exists() else None
    row["afterStateSha256"] = digest(after) if after else None
    COMMANDS.append(row)
    assert (result.returncode == 0) == ok, row
    if not ok:
        assert before == after, "rejected command mutated current state"
    return json.loads(result.stdout) if result.stdout else {"exitCode": result.returncode}


def case(name, fn):
    fn()
    CASES.append({"name": name, "status": "PASSED"})


def state():
    return json.loads((STATE / "state.json").read_text())


def start_receipt(phase):
    i = int(phase[1])
    parent = {"reference": "SIMULATED-original-parent",
              "deadline": "2099-01-01T00:00:00Z",
              "remaining": {"milliUSD": 100000, "humanMillis": 900000,
                            "wallMillis": 3600000}}
    return {
        "synthetic": True, "phase": phase,
        "productLockDigest": PRODUCT, "executionPackDigest": EXECUTION,
        "requestIdentity": state()["phases"][phase]["requestIdentity"],
        "computer": {"id": "SIMULATED-computer-" + phase,
                     "name": CONTRACTS["phases"][phase]["computerName"],
                     "state": "ready"},
        "session": {"id": "SIMULATED-session-" + phase,
                    "computerId": "SIMULATED-computer-" + phase,
                    "status": "running"},
        "modelRoles": {role: {"model": "gpt-6.1-sol",
                             "reasoningEffort": "max", "observed": True}
                       for role in ("session", "orchestrator", "worker", "validator")},
        "source": {"base": CONTRACTS["sourceBase"]["commit"],
                   "head": str(i + 1) * 40, "tree": "a" * 40,
                   "branch": CONTRACTS["phases"][phase]["branch"]},
        "delivery": {"status": "ACKNOWLEDGED_READ",
                     "receiverSessionId": "SIMULATED-session-" + phase,
                     "seedSha256": SEEDS[phase]["sha256"]},
        "originalParent": parent,
        "observations": [evidence("facts/" + phase + "-start-observation.json",
                                 {"fixtureOnly": True, "fact": "SIMULATED start"})]
    }


def handoff_receipt(phase):
    p = state()["phases"][phase]
    path = CONTRACTS["phases"][phase]["ownedPrefixes"][0] + "fixture.ts"
    source_file = write("packets/" + phase + "/fixture.ts", b"// SIMULATED fixture\n")
    check = evidence("facts/" + phase + "-checks.json",
                     {"fixtureOnly": True, "result": "SIMULATED checks"})
    package = evidence("packets/" + phase + "/reconstruction.fixture.json",
                       {"fixtureOnly": True, "notAnActualGitBundle": True})
    return {
        "synthetic": True, "phase": phase, "productLockDigest": PRODUCT,
        "executionPackDigest": EXECUTION,
        "sourceBase": p["source"]["base"], "startedFrom": p["source"]["head"],
        "sourceHead": str(int(phase[1]) + 3) * 40,
        "sourceTree": "b" * 40, "branch": p["source"]["branch"],
        "changedFiles": [{"path": path, "file": source_file["path"],
                          "sha256": source_file["sha256"]}],
        "interfaceVersions": ["finnor.project-z.common-contracts.v1"],
        "verification": [{"name": name, "result": "PASSED", "evidence": check}
                         for name in ("mechanism", "independent-checker",
                                      "positive-owner-flow", "physical-recovery",
                                      "mounted-work", "installed-reconstruction",
                                      "cost-metering")],
        "retainedFailures": [], "reconstruction": package,
        "integrationRequests": [], "costsAndMeterGaps": {"fixtureOnly": True},
        "remainingBudget": p["originalParent"],
        "unresolvedObligations": [], "receivedPeerReceipts": [],
        "engineeringDisposition": "INTERNAL_SOFTWARE_COMPLETE"
    }


def put_receipt(name, value):
    write("receipts/" + name + ".json", value)
    return "receipts/" + name + ".json"


def reject_variant(base, name, mutate, command="start"):
    value = json.loads(json.dumps(base))
    mutate(value)
    path = put_receipt(name, value)
    call(command, event=name, receipt=path, ok=False)


def main():
    global CONTRACTS, PRODUCT, EXECUTION, SEEDS
    ROOT.mkdir(parents=True)
    CONTRACTS = json.loads((REPO / "scope-z/contracts/common-contracts.json").read_text())
    members = [
        write("scope-z/contracts/common-contracts.json", CONTRACTS),
        write("scope-z/FINNOR-Z-PRD.md", b"# SIMULATED requirements fixture\n")
    ]
    product = write("scope-z/locks/product-lock.json", {
        "schemaVersion": "finnor.project-z.product-lock.v1",
        "fixtureOnly": True, "members": members})
    PRODUCT = product["sha256"]
    SEEDS = {phase: write("scope-z/prompts/seeds/" + phase.lower() + ".seed.md",
                          ("SIMULATED seed " + phase + "\n").encode())
             for phase in CONTRACTS["phases"]}
    execution = write("scope-z/locks/execution-pack.json", {
        "schemaVersion": "finnor.project-z.execution-pack.v1",
        "fixtureOnly": True, "productLockSha256": PRODUCT,
        "members": list(SEEDS.values())})
    EXECUTION = execution["sha256"]
    case("sealed-fixture-init", lambda: call("init"))
    case("idempotent-init", lambda: call("init"))

    def altered_file(rel, data, name):
        p = ROOT / rel
        old = p.read_bytes()
        p.write_bytes(data)
        try:
            call("verify", ok=False)
        finally:
            p.write_bytes(old)
    case("mutated-product-lock-member", lambda: altered_file(
        "scope-z/FINNOR-Z-PRD.md", b"mutated\n", "mutation"))

    def missing_lock():
        p = ROOT / "scope-z/locks/product-lock.json"
        hold = p.with_suffix(".held")
        p.rename(hold)
        try:
            call("verify", ok=False)
        finally:
            hold.rename(p)
    case("draft-missing-lock", missing_lock)

    def symlink():
        p = ROOT / "scope-z/FINNOR-Z-PRD.md"
        old = p.read_bytes()
        target = ROOT / "symlink-target"
        target.write_bytes(old)
        p.unlink()
        p.symlink_to(target)
        try:
            call("verify", ok=False)
        finally:
            p.unlink()
            p.write_bytes(old)
    case("symlink-member", symlink)

    def live_separation():
        result = subprocess.run(
            [sys.executable, str(CONTROL), "--root", str(ROOT),
             "--state", str(STATE), "verify"], capture_output=True, text=True)
        COMMANDS.append({"argv": result.args, "exitCode": result.returncode,
                         "stdout": result.stdout, "stderr": result.stderr})
        assert result.returncode != 0
    case("fixture-live-separation", live_separation)
    case("request-exact-initial-group", lambda: call("request-initial", event="initial"))
    early = start_receipt("Z3")
    case("reject-early-Z3", lambda: call(
        "start", event="early-Z3", receipt=put_receipt("early-Z3", early), ok=False))
    z0 = start_receipt("Z0")
    case("reject-staged-computer", lambda: reject_variant(
        z0, "staged", lambda r: r["computer"].update(state="staged")))
    case("reject-wrong-model", lambda: reject_variant(
        z0, "wrong-model", lambda r: r["modelRoles"]["worker"].update(model="auto")))
    case("reject-missing-model-role", lambda: reject_variant(
        z0, "missing-role", lambda r: r["modelRoles"].pop("validator")))
    z0_path = put_receipt("start-Z0", z0)
    call("start", event="start-Z0", receipt=z0_path)
    z1 = start_receipt("Z1")
    def duplicate_computer(r):
        r["computer"]["id"] = z0["computer"]["id"]
        r["session"]["computerId"] = z0["computer"]["id"]
    case("reject-duplicate-computer", lambda: reject_variant(
        z1, "duplicate-computer", duplicate_computer))
    call("start", event="start-Z1", receipt=put_receipt("start-Z1", z1))
    z2 = start_receipt("Z2")
    call("start", event="start-Z2", receipt=put_receipt("start-Z2", z2))
    case("start-initial-three", lambda: (
        None if state()["active"] == ["Z0", "Z1", "Z2"] else
        (_ for _ in ()).throw(AssertionError("wrong initial active group"))))
    case("start-idempotence", lambda: call("start", event="start-Z0", receipt=z0_path))
    def substituted_observation(command):
        p = ROOT / "facts/Z0-start-observation.json"
        original = p.read_bytes()
        p.write_bytes(b'{"fixtureOnly":true,"tampered":true}\n')
        try:
            if command == "status":
                call("status", ok=False)
            else:
                call("start", event="start-Z0", receipt=z0_path, ok=False)
        finally:
            p.write_bytes(original)
    case("accepted-evidence-byte-substitution", lambda: substituted_observation("status"))
    case("same-event-changed-descendant-rejected", lambda: substituted_observation("start"))
    conflict = json.loads(json.dumps(z0))
    conflict["session"]["id"] = "SIMULATED-conflicting-session"
    case("event-payload-conflict", lambda: call(
        "start", event="start-Z0", receipt=put_receipt("event-conflict", conflict), ok=False))

    def certify():
        cert = {"synthetic": True, "phase": "Z2", "gate": "independent-scrutiny",
                "status": "IN_PROGRESS", "productLockDigest": PRODUCT,
                "executionPackDigest": EXECUTION,
                "model": "gpt-6.1-sol", "reasoningEffort": "max",
                "observations": [evidence("facts/cert.json", {"fixtureOnly": True})]}
        before = state()["active"]
        call("certify", event="cert-Z2", receipt=put_receipt("cert-Z2", cert))
        assert state()["active"] == before
    case("certification-does-not-release-slot", certify)
    case("interruption-not-completion", lambda: call(
        "interrupt", event="interrupt-Z2", extra=["--phase", "Z2", "--reason", "SIMULATED interruption"]))
    assert state()["phases"]["Z3"]["status"] == "PLANNED"
    resume = start_receipt("Z2")
    resume["continuationOf"] = z2["session"]["id"]
    bad_resume = json.loads(json.dumps(resume))
    bad_resume["originalParent"]["reference"] = "SIMULATED-reset-parent"
    case("reject-reset-parent", lambda: call(
        "resume", event="bad-resume", receipt=put_receipt("bad-resume", bad_resume), ok=False))
    case("resume-same-parent", lambda: call(
        "resume", event="resume-Z2", receipt=put_receipt("resume-Z2", resume)))

    h0, h1 = handoff_receipt("Z0"), handoff_receipt("Z1")
    case("reject-out-of-owner-handoff", lambda: reject_variant(
        h0, "bad-owner", lambda r: r["changedFiles"][0].update(path="finnor-os/packages/db/migrations/999.sql"), "handoff"))
    case("reject-wrong-cut", lambda: reject_variant(
        h0, "wrong-cut", lambda r: r.update(startedFrom="f" * 40), "handoff"))
    case("reject-incomplete-internal-software", lambda: reject_variant(
        h0, "incomplete", lambda r: r["verification"][0].update(result="NOT_RUN"), "handoff"))
    paths = [put_receipt("handoff-Z0", h0), put_receipt("handoff-Z1", h1)]

    def racing_handoffs():
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(call, "handoff", event="handoff-Z" + str(i), receipt=paths[i])
                       for i in range(2)]
            for future in futures:
                future.result()
        assert set(state()["reserved"]) == {"Z2", "Z3", "Z4"}
    case("atomic-concurrent-handoffs", racing_handoffs)
    case("ordered-refill-Z3-Z4", lambda: (
        None if state()["refillRequested"] == ["Z3", "Z4"] else
        (_ for _ in ()).throw(AssertionError("refill order"))))
    z5_early = start_receipt("Z5")
    case("reject-fourth-slot", lambda: call(
        "start", event="early-Z5", receipt=put_receipt("early-Z5", z5_early), ok=False))
    for phase in ("Z3", "Z4"):
        call("start", event="start-" + phase,
             receipt=put_receipt("start-" + phase, start_receipt(phase)))
    case("handoff-refills-Z5-without-certification", lambda: call(
        "handoff", event="handoff-Z2", receipt=put_receipt("handoff-Z2", handoff_receipt("Z2"))))
    assert state()["refillRequested"] == ["Z3", "Z4", "Z5"]
    case("replayed-handoff-does-not-refill-twice", lambda: call(
        "handoff", event="handoff-Z0", receipt=paths[0]))
    assert len(state()["refillRequested"]) == 3
    case("unknown-launch-retains-slot", lambda: call(
        "launch-unknown", event="unknown-Z5",
        extra=["--phase", "Z5", "--reason", "SIMULATED lost acknowledgement"]))
    assert set(state()["reserved"]) == {"Z3", "Z4", "Z5"}
    reconcile = start_receipt("Z5")
    case("reconcile-same-launch-intent", lambda: call(
        "start", event="start-Z5", receipt=put_receipt("start-Z5", reconcile)))

    interrupted_cert = {
        "synthetic": True, "phase": "Z3", "gate": "independent-scrutiny",
        "status": "IN_PROGRESS", "productLockDigest": PRODUCT,
        "executionPackDigest": EXECUTION, "model": "gpt-6.1-sol",
        "reasoningEffort": "max",
        "observations": [evidence("facts/interrupted-cert.json", {"fixtureOnly": True})]
    }
    pending_path = put_receipt("interrupted-cert", interrupted_cert)
    case("physical-pointer-interruption", lambda: call(
        "certify", event="interrupted-cert", receipt=pending_path,
        ok=False, failpoint=True))
    case("orphan-snapshot-fails-closed", lambda: call("status", ok=False))
    case("recover-exact-immutable-pending-state", lambda: call("recover"))
    assert state()["certification"]["Z3"]["independent-scrutiny"] == "IN_PROGRESS"

    def corrupt():
        p = STATE / "state.json"
        old = p.read_bytes()
        p.write_bytes(b"{broken")
        try:
            result = subprocess.run(
                [sys.executable, str(CONTROL), "--root", str(ROOT),
                 "--state", str(STATE), "--fixture", "status"],
                capture_output=True, text=True)
            COMMANDS.append({"argv": result.args, "exitCode": result.returncode,
                             "stdout": result.stdout, "stderr": result.stderr})
            assert result.returncode != 0 and p.read_bytes() == b"{broken"
        finally:
            p.write_bytes(old)
    case("corrupt-state-fails-closed", corrupt)
    case("immutable-snapshots-survive", lambda: (
        None if len(list((STATE / "snapshots").glob("*.json"))) >= 10 else
        (_ for _ in ()).throw(AssertionError("missing immutable snapshots"))))
    final = state()
    case("final-model-and-three-slot-invariants", lambda: (
        None if final["active"] == ["Z3", "Z4", "Z5"] and
        final["modelPolicy"] == {"model": "gpt-6.1-sol", "reasoningEffort": "max"}
        else (_ for _ in ()).throw(AssertionError("final invariant"))))
    assert set(PLANNED) == {c["name"] for c in CASES}


if __name__ == "__main__":
    started = time.time()
    failure = None
    try:
        main()
    except Exception as exc:
        failure = repr(exc)
    RUN.mkdir(parents=True, exist_ok=True)
    report = {
        "schemaVersion": "finnor.project-z.controller-e2e.v1",
        "evidenceClass": "deterministic-local-SIMULATED-platform-fixtures",
        "source": str(CONTROL),
        "sourceSha256": digest(CONTROL.read_bytes()) if CONTROL.exists() else None,
        "driverSha256": digest(pathlib.Path(__file__).read_bytes()),
        "planned": PLANNED, "cases": CASES, "commands": COMMANDS,
        "elapsedSeconds": time.time() - started, "failure": failure,
        "productRuntimeEvidence": False, "remoteExecutionEvidence": False,
        "rerun": [sys.executable, str(pathlib.Path(__file__).resolve())]
    }
    destination = RUN / "report.json"
    destination.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(destination), "passed": len(CASES),
                      "planned": len(PLANNED), "failure": failure}))
    sys.exit(1 if failure else 0)
