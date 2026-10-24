#!/usr/bin/env python3
"""Receipt-bound LOCAL engineering coordination. No remote or product actions.

This records externally observed facts; it cannot authenticate Factory service
observations, grant authority, certify FINNOR, provision, launch or send messages.
Simulation requires --fixture and is permanently marked in every state/output.
"""
import argparse
import copy
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import sys
import uuid

PINNED_PRODUCT = "61d9881ca8059d24d057d1e00d5436ef2059de7889ccd1fd2f92a630075bcebf"
MODEL = {"model": "gpt-6.1-sol", "reasoningEffort": "max"}
PHASES = ("Z0", "Z1", "Z2", "Z3", "Z4", "Z5")
RESERVED = {"LAUNCH_REQUESTED", "LAUNCH_UNKNOWN", "RUNNING", "INTERRUPTED"}
INTERNAL_CHECKS = {
    "mechanism", "independent-checker", "positive-owner-flow",
    "physical-recovery", "mounted-work", "installed-reconstruction", "cost-metering"
}
MAX_JSON_BYTES = 8 * 1024 * 1024


class Rejected(Exception):
    pass


def require(condition, message):
    if not condition:
        raise Rejected(message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=False, allow_nan=False) + "\n").encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    total = 0
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            total += len(chunk)
            require(total <= 64 * 1024 * 1024, "artifact exceeds bounded file size")
            h.update(chunk)
    return h.hexdigest(), total


def safe_path(root, value):
    require(isinstance(value, str) and value and "\\" not in value,
            "invalid artifact path")
    p = pathlib.Path(value)
    require(".." not in p.parts, "path traversal")
    p = p if p.is_absolute() else root / p
    require(p.is_relative_to(root), "path outside selected workspace")
    current = root
    for part in p.relative_to(root).parts:
        current /= part
        require(not current.is_symlink(), "symlink path is not accepted")
    require(p.resolve().is_relative_to(root), "resolved path escaped workspace")
    return p


def read_json(path):
    require(path.is_file(), "required JSON artifact missing: " + str(path))
    require(path.stat().st_size <= MAX_JSON_BYTES, "JSON artifact exceeds bound")
    try:
        value = json.loads(path.read_bytes())
    except (ValueError, UnicodeError) as exc:
        raise Rejected("malformed JSON: " + str(path)) from exc
    require(isinstance(value, dict), "JSON artifact must be an object")
    return value


def no_credentials(value):
    forbidden = {"apikey", "api_key", "password", "authorization", "cookie",
                 "token", "access_token", "secret", "privatekey", "private_key"}
    if isinstance(value, dict):
        require(not forbidden.intersection(k.lower() for k in value),
                "credential-bearing receipt fields are forbidden")
        for item in value.values():
            no_credentials(item)
    elif isinstance(value, list):
        for item in value:
            no_credentials(item)


def verify_members(root, manifest, expected_schema, fixture):
    require(manifest.get("schemaVersion") == expected_schema, "wrong lock schema")
    require(bool(manifest.get("fixtureOnly", False)) == fixture,
            "simulation and live lock modes cannot be mixed")
    rows = manifest.get("members")
    require(isinstance(rows, list) and 0 < len(rows) <= 5000, "invalid lock members")
    result = {}
    for row in rows:
        require(isinstance(row, dict), "invalid member")
        rel = row.get("path")
        require(isinstance(rel, str) and not pathlib.Path(rel).is_absolute(),
                "lock members must be workspace-relative")
        require(rel not in result, "duplicate lock member")
        path = safe_path(root, rel)
        require(path.is_file(), "locked member missing: " + rel)
        actual, size = file_digest(path)
        require(actual == row.get("sha256") and size == row.get("bytes"),
                "locked member changed: " + rel)
        result[rel] = actual
    return result


def verify_locks(root, fixture, expected_execution=None):
    product_path = safe_path(root, "scope-z/locks/product-lock.json")
    product = read_json(product_path)
    product_digest = file_digest(product_path)[0]
    if not fixture:
        require(product_digest == PINNED_PRODUCT, "wrong immutable product trust anchor")
    product_members = verify_members(
        root, product, "finnor.project-z.product-lock.v1", fixture)
    contract_path = "scope-z/contracts/common-contracts.json"
    require(contract_path in product_members, "common contracts are not locked")
    contracts = read_json(safe_path(root, contract_path))
    require(tuple(contracts.get("phases", {})) == PHASES, "wrong phase set/order")
    require(contracts["schedule"]["initialGroup"] == list(PHASES[:3])
            and contracts["schedule"]["refillOrder"] == list(PHASES[3:])
            and contracts["schedule"]["capacity"] == 3, "wrong three-slot schedule")
    require(contracts["modelPolicy"]["model"] == MODEL["model"]
            and contracts["modelPolicy"]["reasoningEffort"] == MODEL["reasoningEffort"],
            "wrong common model policy")
    execution_path = safe_path(root, "scope-z/locks/execution-pack.json")
    execution = read_json(execution_path)
    execution_digest = file_digest(execution_path)[0]
    require(execution.get("productLockSha256") == product_digest,
            "execution pack is bound to a different product lock")
    execution_members = verify_members(
        root, execution, "finnor.project-z.execution-pack.v1", fixture)
    for phase in PHASES:
        require("scope-z/prompts/seeds/" + phase.lower() + ".seed.md" in execution_members,
                "missing complete sealed phase seed")
    if expected_execution:
        require(execution_digest == expected_execution, "wrong execution-pack trust anchor")
    return product_digest, execution_digest, contracts, execution_members


def state_bytes(state):
    value = copy.deepcopy(state)
    value.pop("stateDigest", None)
    value["stateDigest"] = sha(canonical(value))
    return canonical(value)


def validate_state(state, root, fixture, product, execution):
    require(state.get("schemaVersion") == "finnor.project-z.control-state.v1",
            "wrong control-state schema")
    require(state.get("root") == str(root) and state.get("fixtureOnly") is fixture,
            "wrong workspace or simulation mode")
    require(state.get("productLockDigest") == product
            and state.get("executionPackDigest") == execution, "state lock changed")
    require(state.get("modelPolicy") == MODEL, "state model policy changed")
    require(tuple(state.get("phases", {})) == PHASES, "state phase set changed")
    require(isinstance(state.get("sequence"), int) and state["sequence"] >= 0,
            "invalid state sequence")
    require(state_bytes(state) == canonical(state), "state digest changed")
    active = [p for p in PHASES if state["phases"][p]["status"] == "RUNNING"]
    reserved = [p for p in PHASES if state["phases"][p]["status"] in RESERVED]
    require(state.get("active") == active and state.get("reserved") == reserved
            and len(reserved) <= 3, "slot invariant violated")
    events = state.get("events")
    require(isinstance(events, list) and len(events) == state["sequence"],
            "event history/sequence mismatch")
    require(len({e["eventId"] for e in events}) == len(events), "duplicate event IDs")
    require(state.get("refillRequested") == list(PHASES[3:3 + len(state.get("refillRequested", []))]),
            "refill order changed")


def load_state(directory, root, fixture, product, execution, *, recover=False):
    path = safe_path(root, str(directory / "state.json"))
    state = read_json(path)
    validate_state(state, root, fixture, product, execution)
    snapshot = safe_path(root, str(directory / "snapshots" / f"{state['sequence']:06d}.json"))
    require(snapshot.is_file() and snapshot.read_bytes() == path.read_bytes(),
            "current state differs from immutable snapshot")
    verify_stored_receipts(root, state, fixture)
    future = []
    for p in (directory / "snapshots").glob("*.json"):
        safe_path(root, str(p))
        require(re.fullmatch(r"\d{6}\.json", p.name) is not None,
                "unexpected snapshot name")
        if int(p.stem) > state["sequence"]:
            future.append(p)
    if future:
        require(recover and len(future) == 1
                and int(future[0].stem) == state["sequence"] + 1,
                "immutable pending snapshot exists; explicit recovery required")
        pending = read_json(future[0])
        validate_state(pending, root, fixture, product, execution)
        require(pending.get("previousStateDigest") == state["stateDigest"]
                and pending["events"][:-1] == state["events"],
                "pending snapshot is not an exact successor")
        verify_stored_receipts(root, pending, fixture)
        replace_current(directory, future[0].read_bytes())
        return pending
    return state


def replace_current(directory, data):
    temporary = directory / (".state-" + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, directory / "state.json")
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def save_state(directory, state, fixture):
    data = state_bytes(state)
    require(len(data) <= MAX_JSON_BYTES and state["sequence"] < 1000000,
            "bounded control-state capacity reached")
    root = pathlib.Path(state["root"])
    snapshots = safe_path(root, str(directory / "snapshots"))
    snapshots.mkdir(exist_ok=True)
    snapshot = safe_path(root, str(snapshots / f"{state['sequence']:06d}.json"))
    descriptor = os.open(snapshot, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    descriptor = os.open(snapshots, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    if os.environ.get("FINNOR_Z_CONTROLLER_FIXTURE_FAIL_AFTER_SNAPSHOT") == "1":
        require(fixture, "fixture-only interruption cannot run in live mode")
        os._exit(70)
    replace_current(directory, data)
    return json.loads(data)


def evidence(root, row, fixture):
    require(isinstance(row, dict), "missing evidence reference")
    expected = {"SIMULATED"} if fixture else {
        "SERVICE_OBSERVATION", "RUNTIME_OBSERVATION", "NATIVE_OWNER_RECEIPT",
        "SOURCE_PACKAGE", "VERIFICATION_ARTIFACT"
    }
    require(row.get("class") in expected, "wrong evidence class/mode")
    path = safe_path(root, row.get("path"))
    require(path.is_file() and file_digest(path)[0] == row.get("sha256"),
            "evidence missing or changed")


def verify_reference_tree(root, value, fixture):
    if isinstance(value, dict):
        if "sha256" in value and ("file" in value or "path" in value):
            row = {"path": value.get("file", value.get("path")),
                   "sha256": value["sha256"],
                   "class": value.get("class", "SIMULATED" if fixture else "VERIFICATION_ARTIFACT")}
            evidence(root, row, fixture)
        for item in value.values():
            verify_reference_tree(root, item, fixture)
    elif isinstance(value, list):
        for item in value:
            verify_reference_tree(root, item, fixture)


def verify_stored_receipts(root, state, fixture):
    for event in state["events"]:
        row = event["payload"].get("receipt")
        if row:
            evidence(root, {**row, "class": "SIMULATED" if fixture else "VERIFICATION_ARTIFACT"}, fixture)
            verify_reference_tree(root, read_json(safe_path(root, row["path"])), fixture)


def fresh_observation(value):
    try:
        observed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(observed.tzinfo is not None, "observation timestamp has no timezone")
        elapsed = (datetime.datetime.now(datetime.timezone.utc) - observed).total_seconds()
        return -5 <= elapsed <= 300
    except (AttributeError, ValueError):
        return False


def same_parent(original, remaining):
    require(isinstance(original, dict) and isinstance(remaining, dict),
            "missing original-parent resources")
    require(original.get("reference") and remaining.get("reference") == original["reference"]
            and remaining.get("deadline") == original.get("deadline"),
            "original parent/deadline reset")
    old, new = original.get("remaining"), remaining.get("remaining")
    require(isinstance(old, dict) and isinstance(new, dict)
            and set(old) == set(new), "resource meter set changed")
    for key, value in old.items():
        current = new[key]
        if value == "UNKNOWN":
            require(current == "UNKNOWN" or
                    (type(current) is int and current >= 0), "invalid unknown resource disposition")
        else:
            require(type(value) is int and type(current) is int
                    and 0 <= current <= value, "original remaining resource increased")


def check_start(root, receipt, state, contracts, seeds, fixture, resume):
    phase = receipt["phase"]
    lane = state["phases"][phase]
    allowed = {"INTERRUPTED"} if resume else {"LAUNCH_REQUESTED", "LAUNCH_UNKNOWN"}
    require(lane["status"] in allowed, "phase is not an eligible requested slot")
    require(receipt.get("requestIdentity") == lane["requestIdentity"],
            "start does not reconcile the same launch intent")
    if phase in PHASES[3:]:
        require(state["initialStarted"] == list(PHASES[:3]), "initial group has not all started")
    computer, session = receipt.get("computer", {}), receipt.get("session", {})
    require(computer.get("state") == "ready"
            and computer.get("name") == contracts["phases"][phase]["computerName"],
            "Computer is not the dedicated ready Computer")
    require(isinstance(computer.get("id"), str) and computer["id"]
            and isinstance(session.get("id"), str) and session["id"]
            and session.get("computerId") == computer["id"]
            and session.get("status") == "running", "missing actual running session/Computer binding")
    if not fixture:
        require(fresh_observation(receipt.get("observedAt")),
                "live start observation missing, future-dated or stale")
        for identifier in (computer["id"], session["id"]):
            try:
                uuid.UUID(identifier)
            except ValueError as exc:
                raise Rejected("live Computer/session ID must be an observed UUID") from exc
    for other in PHASES:
        if other != phase:
            require(state["phases"][other].get("computer", {}).get("id") != computer["id"],
                    "dedicated Computer reused by another phase")
    roles = receipt.get("modelRoles", {})
    require(set(roles) == {"session", "orchestrator", "worker", "validator"},
            "missing actual/configured model role")
    for role in roles.values():
        require(role.get("model") == MODEL["model"]
                and role.get("reasoningEffort") == MODEL["reasoningEffort"]
                and (role.get("observed") is True or
                     (role.get("configured") is True and role.get("invocationState") == "NOT_INVOKED")),
                "wrong, default or unattested model role")
    source = receipt.get("source", {})
    require(source.get("base") == contracts["sourceBase"]["commit"]
            and source.get("branch") == contracts["phases"][phase]["branch"]
            and all(re.fullmatch(r"[0-9a-f]{40}", str(source.get(k, "")))
                    for k in ("head", "tree")), "wrong source/base/branch identity")
    delivery = receipt.get("delivery", {})
    seed_path = "scope-z/prompts/seeds/" + phase.lower() + ".seed.md"
    require(delivery.get("status") == "ACKNOWLEDGED_READ"
            and delivery.get("receiverSessionId") == session["id"]
            and delivery.get("seedSha256") == seeds[seed_path],
            "complete seed delivery/read is not acknowledged by this session")
    observations = receipt.get("observations")
    require(isinstance(observations, list) and observations, "missing actual observation receipts")
    for row in observations:
        evidence(root, row, fixture)
    parent = receipt.get("originalParent")
    same_parent(parent, parent)
    if resume:
        require(receipt.get("continuationOf") == lane["session"]["id"]
                and computer["id"] == lane["computer"]["id"], "resume changed continuation/Computer")
        same_parent(lane["originalParent"], parent)
    return phase


def check_handoff(root, receipt, state, contracts, fixture):
    phase = receipt["phase"]
    lane = state["phases"][phase]
    require(lane["status"] == "RUNNING", "unfinished/interrupted lane cannot hand off as complete")
    for key in contracts["handoffRequiredFields"]:
        require(key in receipt, "missing handoff field: " + key)
    require(receipt.get("engineeringDisposition") == "INTERNAL_SOFTWARE_COMPLETE",
            "incomplete engineering cannot free a completion slot")
    require(receipt["sourceBase"] == lane["source"]["base"]
            and receipt.get("startedFrom") == lane["source"]["head"]
            and receipt["branch"] == lane["source"]["branch"]
            and all(re.fullmatch(r"[0-9a-f]{40}", str(receipt[k]))
                    for k in ("sourceHead", "sourceTree")), "wrong handoff source cut")
    require(isinstance(receipt["changedFiles"], list), "missing changed-file manifest")
    seen = set()
    prefixes = contracts["phases"][phase]["ownedPrefixes"]
    for row in receipt["changedFiles"]:
        rel = row.get("path", "")
        require(isinstance(rel, str) and rel not in seen
                and not pathlib.Path(rel).is_absolute() and ".." not in pathlib.Path(rel).parts
                and any(rel.startswith(prefix) for prefix in prefixes),
                "phase-authored change outside ownership")
        seen.add(rel)
        evidence(root, {"path": row.get("file"), "sha256": row.get("sha256"),
                        "class": "SIMULATED" if fixture else "SOURCE_PACKAGE"}, fixture)
    require(contracts["schemaVersion"] in receipt["interfaceVersions"],
            "wrong interface version")
    checks = receipt["verification"]
    require(isinstance(checks, list) and len({r.get("name") for r in checks}) == len(checks),
            "invalid/duplicate verification records")
    by_name = {row.get("name"): row for row in checks}
    require(INTERNAL_CHECKS.issubset(by_name), "missing complete internal-software checks")
    for name in INTERNAL_CHECKS:
        require(by_name[name].get("result") == "PASSED", "required internal software remains incomplete")
        evidence(root, by_name[name].get("evidence"), fixture)
    evidence(root, receipt["reconstruction"], fixture)
    require(isinstance(receipt["retainedFailures"], list)
            and isinstance(receipt["integrationRequests"], list)
            and isinstance(receipt["unresolvedObligations"], list)
            and isinstance(receipt["receivedPeerReceipts"], list)
            and isinstance(receipt["costsAndMeterGaps"], dict), "malformed handoff dispositions")
    same_parent(lane["originalParent"], receipt["remainingBudget"])
    return phase


def receipt_input(args, root, product, execution):
    require(args.receipt is not None, "receipt file is required")
    path = safe_path(root, args.receipt)
    value = read_json(path)
    no_credentials(value)
    require(value.get("synthetic") is args.fixture, "receipt simulation mode mismatch")
    require(value.get("phase") in PHASES, "unknown phase")
    require(value.get("productLockDigest") == product
            and value.get("executionPackDigest") == execution, "receipt lock mismatch")
    verify_reference_tree(root, value, args.fixture)
    return value, {"path": str(path.relative_to(root)), "sha256": file_digest(path)[0]}


def apply_event(args, state, root, contracts, seeds, receipt):
    command = args.command
    if command == "request-initial":
        require(state["initialGroupIdentity"] is None, "initial group already requested")
        group = sha(canonical({"event": args.event_id, "product": state["productLockDigest"],
                               "execution": state["executionPackDigest"]}))
        state["initialGroupIdentity"] = group
        for phase in PHASES[:3]:
            state["phases"][phase].update(status="LAUNCH_REQUESTED",
                                         requestIdentity=group + ":" + phase)
    elif command in {"start", "resume"}:
        phase = check_start(root, receipt, state, contracts, seeds,
                            args.fixture, command == "resume")
        lane = state["phases"][phase]
        for key in ("computer", "session", "source", "originalParent"):
            lane[key] = copy.deepcopy(receipt[key])
        lane["lastObservedAt"] = receipt.get("observedAt", "SIMULATED")
        lane["status"] = "RUNNING"
        if phase in PHASES[:3]:
            state["initialStarted"] = sorted(set(state["initialStarted"]) | {phase})
    elif command == "handoff":
        phase = check_handoff(root, receipt, state, contracts, args.fixture)
        require(state["initialStarted"] == list(PHASES[:3]), "initial group was never fully active")
        lane = state["phases"][phase]
        lane.update(status="HANDED_OFF_PENDING_CERTIFICATION",
                    handoffHead=receipt["sourceHead"], handoffTree=receipt["sourceTree"],
                    remainingBudget=copy.deepcopy(receipt["remainingBudget"]))
        index = len(state["refillRequested"])
        if index < 3:
            next_phase = PHASES[3 + index]
            state["refillRequested"].append(next_phase)
            state["phases"][next_phase].update(
                status="LAUNCH_REQUESTED",
                requestIdentity=sha(canonical({"event": args.event_id,
                                               "next": next_phase,
                                               "product": state["productLockDigest"]})))
    elif command in {"interrupt", "launch-unknown"}:
        require(args.phase in PHASES and args.reason, "phase and explicit reason required")
        lane = state["phases"][args.phase]
        allowed = {"RUNNING"} if command == "interrupt" else {"LAUNCH_REQUESTED"}
        require(lane["status"] in allowed, "wrong interruption/unknown transition")
        lane["status"] = "INTERRUPTED" if command == "interrupt" else "LAUNCH_UNKNOWN"
        lane["lastInterruption"] = args.reason
    elif command == "certify":
        phase = receipt["phase"]
        require(receipt.get("model") == MODEL["model"]
                and receipt.get("reasoningEffort") == MODEL["reasoningEffort"],
                "wrong independent-checking model")
        gate, status = receipt.get("gate"), receipt.get("status")
        require(gate in {"independent-scrutiny", "installed-user-testing",
                         "mathematical-security-domain", "protected-admission",
                         "equipped-increment", "operational-100x", "financial-headroom",
                         "financial-100x"}, "unknown or authority-bearing certification gate")
        require(status in contracts["qualificationStates"], "unknown gate disposition")
        observations = receipt.get("observations")
        require(isinstance(observations, list) and observations, "missing certification observations")
        for row in observations:
            evidence(root, row, args.fixture)
        state["certification"][phase][gate] = status
    else:
        raise Rejected("unsupported state transition")
    state["active"] = [p for p in PHASES if state["phases"][p]["status"] == "RUNNING"]
    state["reserved"] = [p for p in PHASES if state["phases"][p]["status"] in RESERVED]
    require(len(state["reserved"]) <= 3, "fourth implementation slot refused")


def summary(state, action):
    active = [p for p in state["active"] if state["fixtureOnly"]
              or fresh_observation(state["phases"][p].get("lastObservedAt"))]
    remaining = sum(state["phases"][p]["status"] != "HANDED_OFF_PENDING_CERTIFICATION"
                    for p in PHASES)
    return {"ok": True, "action": action, "controlOnly": True,
            "fixtureOnly": state["fixtureOnly"], "remoteActionsPerformed": False,
            "productQualificationConferred": False, "sequence": state["sequence"],
            "active": active, "reserved": state["reserved"],
            "activeBasis": "fresh accepted external observations, not a live platform probe",
            "staleRunningObservations": [p for p in state["active"] if p not in active],
            "requestedNotRunning": [p for p in state["reserved"] if p not in active],
            "underfilledActiveSlots": max(0, min(3, remaining) - len(active)),
            "refillRequested": state["refillRequested"],
            "productLockDigest": state["productLockDigest"],
            "executionPackDigest": state["executionPackDigest"]}


def run(args):
    require(pathlib.Path(args.root).is_absolute() and pathlib.Path(args.state).is_absolute(),
            "root and state paths must be absolute")
    root = pathlib.Path(args.root).resolve(strict=True)
    directory = safe_path(root, args.state)
    if os.environ.get("FINNOR_Z_CONTROLLER_FIXTURE_FAIL_AFTER_SNAPSHOT"):
        require(args.fixture, "fixture interruption environment forbidden in live mode")
    product, execution, contracts, seeds = verify_locks(
        root, args.fixture, args.execution_pack_digest)
    if args.command == "verify":
        return {"ok": True, "action": "verified-content-custody-only",
                "fixtureOnly": args.fixture, "productLockDigest": product,
                "executionPackDigest": execution, "remoteActionsPerformed": False,
                "productQualificationConferred": False}
    directory.mkdir(parents=True, exist_ok=True)
    lock_path = safe_path(root, str(directory / ".lock"))
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "r+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        state_path = safe_path(root, str(directory / "state.json"))
        if args.command == "init" and not state_path.exists():
            require(args.fixture or args.execution_pack_digest,
                    "live initialization requires an explicitly reviewed execution-pack digest")
            initial = {
                "schemaVersion": "finnor.project-z.control-state.v1",
                "root": str(root), "fixtureOnly": args.fixture, "sequence": 0,
                "productLockDigest": product, "executionPackDigest": execution,
                "modelPolicy": MODEL, "initialGroupIdentity": None,
                "initialStarted": [], "refillRequested": [], "active": [], "reserved": [],
                "phases": {p: {"status": "PLANNED", "requestIdentity": None} for p in PHASES},
                "certification": {p: {} for p in PHASES}, "events": [],
                "previousStateDigest": None
            }
            return summary(save_state(directory, initial, args.fixture), "initialized-no-launch")
        state = load_state(directory, root, args.fixture, product, execution,
                           recover=args.command == "recover")
        if args.command in {"init", "status", "recover"}:
            return summary(state, args.command)
        require(args.event_id is not None
                and re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", args.event_id),
                "unique bounded event ID required")
        receipt, receipt_ref = None, None
        if args.command in {"start", "resume", "handoff", "certify"}:
            receipt, receipt_ref = receipt_input(args, root, product, execution)
        payload = {"command": args.command, "receipt": receipt_ref,
                   "phase": args.phase, "reason": args.reason}
        fingerprint = sha(canonical(payload))
        for event in state["events"]:
            if event["eventId"] == args.event_id:
                require(event["fingerprint"] == fingerprint, "event ID reused with different payload")
                return summary(state, "idempotent-" + args.command)
        previous = state["stateDigest"]
        apply_event(args, state, root, contracts, seeds, receipt)
        state["sequence"] += 1
        state["previousStateDigest"] = previous
        state["events"].append({
            "eventId": args.event_id, "fingerprint": fingerprint, "payload": payload,
            "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()
        })
        state.pop("stateDigest", None)
        return summary(save_state(directory, state, args.fixture), args.command)


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--state", required=True)
    parser.add_argument("--fixture", action="store_true")
    parser.add_argument("--execution-pack-digest")
    parser.add_argument("command", choices=[
        "verify", "init", "status", "request-initial", "start", "resume",
        "handoff", "interrupt", "launch-unknown", "certify", "recover"])
    parser.add_argument("--event-id")
    parser.add_argument("--receipt")
    parser.add_argument("--phase", choices=PHASES)
    parser.add_argument("--reason")
    return parser.parse_args()


if __name__ == "__main__":
    try:
        print(json.dumps(run(arguments()), sort_keys=True))
    except (Rejected, OSError, ValueError, TypeError, KeyError) as exc:
        print(json.dumps({"ok": False, "error": str(exc), "controlOnly": True,
                          "remoteActionsPerformed": False,
                          "productQualificationConferred": False}, sort_keys=True))
        sys.exit(2)
