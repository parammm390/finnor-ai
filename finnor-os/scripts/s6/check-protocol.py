"""Finite safety exploration. See protocol-model-registration.md for assumptions.

The provider oracle is independent of executor reports. This is not a production
verifier and does not manufacture admission, signatures, or provider guarantees.
"""
from __future__ import annotations
from collections import deque
from dataclasses import dataclass, replace, asdict
import datetime
import hashlib
import json
import pathlib
import resource
import sys
import time

@dataclass(frozen=True)
class Member:
    intent: bool = False
    attempts: int = 0
    pending: int = 0
    effects: int = 0
    uncertain: bool = False
    absence: bool = False
    verified: bool = False
    responsible: bool = False

@dataclass(frozen=True)
class Execution:
    members: tuple = (Member(), Member())
    authorized: bool = True
    cancelled: bool = False
    lease_owner: int = 0
    lease_live: bool = True
    window_live: bool = True
    producer_success: bool = False
    completed: bool = False
    unauthorized_egress: bool = False
    stale_egress: bool = False

def execution_transitions(s, mutation):
    if s.authorized:
        yield "revoke-authority", replace(s, authorized=False)
    if not s.cancelled:
        members = tuple(replace(m, responsible=False) for m in s.members) if mutation == "erase_on_cancel" else s.members
        yield "cancel", replace(s, cancelled=True, members=members)
    if s.window_live:
        yield "expire-provider-window", replace(s, window_live=False)
    if s.lease_live:
        members = tuple(replace(m, uncertain=m.uncertain or bool(m.pending or (m.effects and not m.verified))) for m in s.members)
        yield "worker-crash-response-may-be-lost", replace(s, lease_live=False, members=members)
    if not s.lease_live and s.lease_owner == 0:
        yield "takeover-new-fence", replace(s, lease_live=True, lease_owner=1)
    if not s.producer_success:
        yield "executor-reports-success", replace(s, producer_success=True)
    if not s.completed and (all(m.verified for m in s.members) or mutation == "trust_executor" and s.producer_success):
        yield "complete-parent", replace(s, completed=True)
    for i, m in enumerate(s.members):
        def member_changed(changed, **kw):
            members = list(s.members)
            members[i] = changed
            return replace(s, members=tuple(members), **kw)
        if not m.intent and s.authorized and not s.cancelled:
            yield f"member-{i}:persist-intent", member_changed(replace(m, intent=True, responsible=True))
        can_retry = m.attempts == 0 or m.absence or mutation == "blind_retry"
        for worker in range(2):
            authority_ok = s.authorized and not s.cancelled
            fence_ok = s.lease_live and worker == s.lease_owner
            if m.intent and not m.verified and m.attempts < 2 and can_retry and (authority_ok or mutation == "omit_last_authority") and (fence_ok or mutation == "omit_fence"):
                yield f"member-{i}:worker-{worker}:persist-may-have-left-and-egress", member_changed(
                    replace(m, attempts=m.attempts+1, pending=m.pending+1, absence=False, uncertain=True),
                    unauthorized_egress=s.unauthorized_egress or not authority_ok,
                    stale_egress=s.stale_egress or not fence_ok)
        if m.pending:
            # The local worker fence is deliberately irrelevant after real egress.
            count = m.effects if s.window_live and m.effects else m.effects+1
            yield f"member-{i}:provider-accept-response-lost", member_changed(replace(m, pending=m.pending-1, effects=count, uncertain=True))
            yield f"member-{i}:provider-definite-rejection", member_changed(replace(m, pending=m.pending-1))
        if m.attempts and not m.pending and not m.effects and not m.absence:
            yield f"member-{i}:qualified-readback-no-effect-no-delayed-request", member_changed(replace(m, absence=True, uncertain=False))
        if m.effects and not m.pending and not m.verified:
            yield f"member-{i}:independent-exact-member-readback", member_changed(replace(m, verified=True, uncertain=False))
        # A partition is an inconclusive observation; it grants no retry permission.
        if m.attempts and not m.verified and not m.uncertain:
            yield f"member-{i}:observation-partition", member_changed(replace(m, uncertain=True, absence=False))

def execution_invariant(s):
    if s.unauthorized_egress:
        return "unauthorized egress after revocation/cancellation"
    if s.stale_egress:
        return "stale worker crossed current fence"
    if any(m.effects > 1 for m in s.members):
        return "duplicate consequence after unsafe retry/window expiry"
    if s.completed and not all(m.verified for m in s.members):
        return "parent completion with unsettled members"
    if any((m.pending or m.effects and not m.verified) and not m.responsible for m in s.members):
        return "possible delivery lost durable responsibility"
    return None

@dataclass(frozen=True)
class Ledger:
    # Records are (identity, owner, content); two identities, two owner identities.
    journal: tuple = ()
    protected_head: tuple = ()
    acknowledged: tuple = ()
    pending: tuple | None = None
    stage: int = 0
    blocked: bool = False
    unauthorized: bool = False

def ledger_transitions(s, mutation):
    if s.blocked:
        return
    if s.pending is None:
        for identity in range(2):
            for owner in range(2):
                for content in range(2):
                    for authenticated in (False, True):
                        for reference_matches in (False, True):
                            if (not authenticated or not reference_matches or owner != identity) and mutation != "omit_append_auth":
                                continue
                            record = (identity, owner, content)
                            previous = next((r for r in s.journal if r[0] == identity), None)
                            if previous:
                                if previous == record:
                                    acknowledged = tuple(sorted(set(s.acknowledged + (record,))))
                                    yield "retry-original-receipt", replace(s, acknowledged=acknowledged)
                                elif mutation == "mutable_identity":
                                    yield "accept-changed-identity", replace(s, pending=record, stage=1)
                                continue
                            if len(s.journal) < 2:
                                yield f"append-owner-{owner}:id-{identity}:content-{content}", replace(s, pending=record, stage=1,
                                    unauthorized=s.unauthorized or not authenticated or not reference_matches or owner != identity)
    else:
        if s.stage == 1:
            yield "ordinary-content-fsync", replace(s, stage=2)
        elif s.stage == 2:
            yield "journal-fsync", replace(s, journal=s.journal+(s.pending,), stage=3)
        elif s.stage == 3:
            yield "protected-checkpoint-fsync", replace(s, protected_head=s.journal, stage=4)
        if s.stage == 4 or mutation == "ack_before_checkpoint" and s.stage == 2:
            ack = tuple(sorted(set(s.acknowledged+(s.pending,))))
            yield "return-signed-receipt", replace(s, acknowledged=ack, pending=None, stage=0)
        # Recovery adopts only a valid suffix and never regresses the protected head.
        yield "process-kill-and-recover", replace(s, protected_head=s.journal, pending=None, stage=0)
    if s.journal:
        shortened = s.journal[:-1]
        mismatch = len(shortened) < len(s.protected_head) or shortened[:len(s.protected_head)] != s.protected_head
        yield "ordinary-journal-rollback", replace(s, journal=shortened, pending=None, stage=0, blocked=mismatch)

def ledger_invariant(s):
    if s.unauthorized:
        return "unauthenticated owner/reference accepted"
    identities = [r[0] for r in s.journal]
    if len(identities) != len(set(identities)):
        return "accepted identity content changed"
    if any(r not in s.protected_head for r in s.acknowledged):
        return "acknowledged history lacks durable protected checkpoint"
    if not s.blocked and any(r not in s.journal for r in s.protected_head):
        return "serving inconsistent or rolled-back history"
    return None


@dataclass(frozen=True)
class PhysicalRequest:
    attempt: int
    step: int
    outcome: str = "prepared"
    delivery: str = "not_sent"


@dataclass(frozen=True)
class ProviderHistory:
    requests: tuple = ()
    attempts: int = 0
    active: bool = False
    logical: str = "idle"
    responsible: bool = False
    absence_barrier: int = 0
    window_live: bool = True
    # Independent provider oracle, never inferred from native ACKs or classifications.
    accepted_steps: tuple = (0, 0)


def unresolved_history(s, mutation=None):
    requests = [r for r in s.requests if r.attempt > s.absence_barrier]
    if mutation == "newest_physical_only":
        requests = requests[-1:]
    elif mutation == "newest_attempt_only":
        requests = [r for r in requests if r.attempt == s.attempts]
    return any(r.outcome in ("may_have_left", "acknowledged", "unknown") for r in requests)


def provider_history_transitions(s, mutation, delayed_delivery=False):
    pending = any(r.delivery == "pending" for r in s.requests)
    # Retention starts after the first accepted request, not at key generation.
    if s.window_live and any(s.accepted_steps) and (delayed_delivery or not pending):
        yield "expire-provider-window", replace(s, window_live=False)

    # A provider-key retry may be claimed while the actual protection is live.
    # A native qualified absence barrier is independent of that protection window.
    if not s.active and s.logical != "complete" and s.attempts < 2:
        if not unresolved_history(s, mutation) or s.window_live:
            yield "claim-native-attempt", replace(s, attempts=s.attempts+1, active=True,
                                                  logical="in_flight", responsible=True)

    current = [(i, r) for i, r in enumerate(s.requests) if r.attempt == s.attempts]
    latest = current[-1] if current else None
    if s.active and s.logical == "in_flight" and len(current) < 2:
        if not latest or latest[1].outcome == "acknowledged" and latest[1].step == 0:
            step = len(current)
            yield f"attempt-{s.attempts}:step-{step}:persist-physical-intent", replace(
                s, requests=s.requests+(PhysicalRequest(s.attempts, step),))

    def changed_request(index, request, **kw):
        requests = list(s.requests)
        requests[index] = request
        return replace(s, requests=tuple(requests), **kw)

    def fail_logical(state):
        uncertain = unresolved_history(state, mutation)
        if mutation == "trust_last_wrapper_refusal":
            uncertain = False
        return replace(state, active=False, logical="unknown" if uncertain else "known_failed")

    if s.active and latest:
        index, request = latest
        if request.outcome == "prepared":
            refused = changed_request(index, replace(request, outcome="pre_dispatch_failure"))
            yield "wrapper-definite-pre-egress-refusal", fail_logical(refused)
            retry_needs_window = s.attempts > 1 and unresolved_history(s)
            if not retry_needs_window or s.window_live:
                yield "native-last-boundary-may-have-left", changed_request(
                    index, replace(request, outcome="may_have_left", delivery="pending"))
            else:
                yield "native-last-boundary-refuses-expired-retry", fail_logical(refused)
        if request.outcome == "may_have_left":
            yield "lose-transport-response", changed_request(index, replace(request, outcome="unknown"),
                                                            active=False, logical="unknown")
            if request.delivery == "accepted":
                completed = request.step == 1 or mutation == "intermediate_ack_completes"
                yield "native-physical-ack-final" if request.step == 1 else "native-physical-ack-intermediate", changed_request(
                    index, replace(request, outcome="acknowledged"), active=not completed,
                    logical="complete" if completed else "in_flight")
            if request.delivery == "rejected":
                rejected = changed_request(index, replace(request, outcome="provider_rejected"))
                yield "native-definite-provider-rejection", fail_logical(rejected)

    # External service decisions can occur after a local crash or a lost response.
    # Neither a native lease nor a later caller classification cancels these requests.
    for index, request in enumerate(s.requests):
        if request.delivery == "pending":
            accepted = list(s.accepted_steps)
            if not s.window_live or accepted[request.step] == 0:
                accepted[request.step] += 1
            yield f"provider-accept-step-{request.step}", changed_request(
                index, replace(request, delivery="accepted"), accepted_steps=tuple(accepted))
            yield f"provider-reject-step-{request.step}", changed_request(
                index, replace(request, delivery="rejected"))

    if s.active:
        recovered = s
        if latest and latest[1].outcome == "prepared":
            recovered = changed_request(latest[0], replace(latest[1], outcome="pre_dispatch_failure"))
        latest_outcome = latest[1].outcome if latest else "no_invocation"
        if latest_outcome in ("prepared", "pre_dispatch_failure", "no_invocation"):
            recovered = fail_logical(recovered)
        elif latest_outcome == "acknowledged" and (latest[1].step == 1 or mutation == "intermediate_ack_completes"):
            recovered = replace(recovered, active=False, logical="complete")
        else:
            if latest_outcome == "may_have_left":
                recovered = changed_request(latest[0], replace(latest[1], outcome="unknown"))
            recovered = replace(recovered, active=False, logical="unknown")
        yield "physical-SIGKILL-native-whole-history-recovery", recovered

    if s.attempts and not s.active and not pending and not any(s.accepted_steps):
        yield "qualified-whole-operation-absence-no-delayed-request", replace(
            s, absence_barrier=s.attempts, logical="known_failed")
    if not pending and all(s.accepted_steps) and s.logical != "complete":
        yield "independent-exact-completion-readback", replace(s, active=False, logical="complete")
    if s.responsible and s.logical in ("known_failed", "complete"):
        yield "settle-native-responsibility", replace(s, responsible=False)


def provider_history_invariant(s):
    if s.logical == "known_failed" and unresolved_history(s):
        return "known failure hides whole-operation possible delivery"
    if s.logical == "complete" and not all(s.accepted_steps):
        return "intermediate ACK fabricates logical completion"
    if any(count > 1 for count in s.accepted_steps):
        return "duplicate physical step accepted after protection-window expiry"
    if s.attempts and s.logical != "complete" and unresolved_history(s) and not s.responsible:
        return "unresolved provider delivery lost durable responsibility"
    return None

def explore(initial, transitions, invariant, mutation):
    started = time.monotonic()
    queue = deque([initial])
    predecessor = {initial: None}
    edges = 0
    terminal = 0
    while queue:
        state = queue.popleft()
        failure = invariant(state)
        if failure:
            trace = []
            current = state
            while predecessor[current] is not None:
                previous, action = predecessor[current]
                trace.append({"transition": action, "state": asdict(current)})
                current = previous
            return {"status": "COUNTEREXAMPLE", "invariant": failure, "trace": list(reversed(trace)), "states": len(predecessor), "edges": edges, "elapsedSeconds": time.monotonic()-started}
        children = list(transitions(state, mutation))
        if not children:
            terminal += 1
        for action, child in children:
            edges += 1
            if child not in predecessor:
                predecessor[child] = (state, action)
                queue.append(child)
        if len(predecessor) > 2_000_000:
            return {"status": "INCOMPLETE_STATE_BUDGET", "states": len(predecessor), "edges": edges}
        if time.monotonic()-started > 120:
            return {"status": "INCOMPLETE_WALL_BUDGET", "states": len(predecessor), "edges": edges}
    return {"status": "EXHAUSTIVE_WITHIN_REGISTERED_FINITE_MODEL", "states": len(predecessor), "edges": edges, "terminalStates": terminal, "elapsedSeconds": time.monotonic()-started}

root = pathlib.Path(__file__).resolve().parents[2]
output = pathlib.Path(sys.argv[1]).resolve()
output.mkdir(parents=True, exist_ok=False)
source_paths = ["scripts/s6/check-protocol.py", "packages/workflow-runtime/src/steps.ts", "packages/orchestration/src/durable-execution.ts", "packages/governed-execution/src/ledger.ts", "packages/governed-execution/src/ledger-server.mts", "packages/tools/src/idempotent-call.ts"]
def snapshot():
    return {p: hashlib.sha256((root/p).read_bytes()).hexdigest() for p in source_paths}
sources = snapshot()
usage_before = resource.getrusage(resource.RUSAGE_SELF)
checks = []
for name, initial, transitions, invariant, mutations in [
    ("obligation", Execution(), execution_transitions, execution_invariant,
     ["omit_last_authority", "omit_fence", "blind_retry", "trust_executor", "erase_on_cancel"]),
    ("append", Ledger(), ledger_transitions, ledger_invariant,
     ["omit_append_auth", "mutable_identity", "ack_before_checkpoint"]),
    ("provider-history-conditional-no-pending-expiry", ProviderHistory(), provider_history_transitions, provider_history_invariant,
     ["newest_physical_only", "newest_attempt_only", "intermediate_ack_completes", "trust_last_wrapper_refusal"]),
]:
    result = explore(initial, transitions, invariant, None)
    checks.append({"model": name, "mutation": None, **result})
    for mutation in mutations:
        checks.append({"model": name, "mutation": mutation, **explore(initial, transitions, invariant, mutation)})
    print(json.dumps({"model": name, "positive": result["status"], "states": result["states"]}), flush=True)

arrival = explore(ProviderHistory(), lambda s, m: provider_history_transitions(s, m, delayed_delivery=True), provider_history_invariant, None)
checks.append({"model": "provider-history-actual-delayed-arrival", "mutation": None,
               "expected": "COUNTEREXAMPLE", "qualification": "UNRESOLVED_TRANSPORT_WINDOW; NOT_A_SAFE_POSITIVE_RESULT", **arrival})
print(json.dumps({"model": "provider-history-actual-delayed-arrival", "status": arrival["status"], "invariant": arrival.get("invariant")}), flush=True)

def process_mapping(directory, case_fragments, transcript_names):
    base = root.parent / "scope-6/scope-evidence" / directory
    paths = [base/"results.json", base/"manifest.json", *[base/"native-readbacks"/name for name in transcript_names]]
    digests = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths}
    results = json.loads(paths[0].read_text())
    manifest = json.loads(paths[1].read_text())
    cases = [case for suite in results["testResults"] for case in suite["assertionResults"]
             if any(fragment in case["fullName"] for fragment in case_fragments)]
    return {"directory": str(base), "sourceFreeze": manifest["sourcesUnchanged"],
            "providerOwnerMatchesCurrentSource": manifest["sources"].get("packages/tools/src/idempotent-call.ts") == sources["packages/tools/src/idempotent-call.ts"],
            "cases": [{"name":case["fullName"], "status":case["status"]} for case in cases],
            "evidenceDigests": digests, "qualification": "ACTUAL_NATIVE_OWNER_AND_LOCAL_HTTP_SIGKILL; BOUNDED_TOKEN_PROVIDER_FIXTURES; NO_WIRE_WINDOW_OR_PRODUCTION_ADMISSION_PROOF"}

mapping = process_mapping(sys.argv[2] if len(sys.argv)>2 else "provider-expiry-owner-final",
    ["retry_refusal", "retry_expiry_at_dispatch", "provider-intermediate-ack-before-kill", "provider-intermediate-ack-prepared-tail", "provider-uncertain-retry-prepared-tail", "native absence reconciliation"],
    ["provider-history-retry_refusal.json", "provider-history-retry_expiry_at_dispatch.json", "provider-intermediate-ack-before-kill.json", "provider-intermediate-ack-prepared-tail.json", "provider-uncertain-retry-prepared-tail.json"])
usage_after = resource.getrusage(resource.RUSAGE_SELF)
report = {"schema": "finnor.s6.bounded-protocol.v2", "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "bounds": {"workers": 2, "members": 2, "attemptsPerMember": 2, "leaseTakeovers": 1, "ledgerIdentities": 2, "ledgerOwners": 2, "ledgerContentsPerIdentity": 2, "providerAttempts":2, "physicalRequestsPerAttempt":2, "providerSteps":2, "maxStatesPerExploration": 2000000, "wallSecondsPerExploration":120},
    "assumptions": ["trusted final authority/fence verifier", "payload-bound provider deduplication only within its registered window", "qualified readback excludes delayed requests", "independent exact-member observation", "protected monotonic checkpoint cannot be rolled back", "cryptographic unforgeability"],
    "conditionalProviderHistoryAssumption": "WINDOW_CANNOT_EXPIRE_WHILE_ANY_REQUEST_PENDING; NOT_ESTABLISHED_BY_CURRENT_NATIVE_HTTP_TRANSPORT",
    "providerRetentionStart":"FIRST_ACCEPTED_REQUEST; EXPIRY_BEFORE_ANY_ACCEPTANCE_IS_NOT_AN_ORACLE_EVENT",
    "qualification": "FINITE_PROTOCOL_SAFETY_ONLY; NO_LIVENESS_OR_DEPLOYED_PROVIDER_PROOF", "python": sys.version,
    "sources": sources, "sourcesUnchanged": snapshot()==sources, "checks": checks, "processMappings":[mapping],
    "completionGatePassed":False, "unresolvedCounterexamples":["provider-history-actual-delayed-arrival"],
    "resources":{"cpuUserSeconds":usage_after.ru_utime-usage_before.ru_utime,"cpuSystemSeconds":usage_after.ru_stime-usage_before.ru_stime,"maxRss":usage_after.ru_maxrss,"maxRssUnit":"bytes" if sys.platform=="darwin" else "KiB","qualification":"MODEL_PROCESS_RUSAGE; NOT_EXECUTOR_QUOTAS_OR_PROVIDER_BILLING"},
    "rerun": "python3 scripts/s6/check-protocol.py <new-absolute-evidence-directory> [current-provider-owner-evidence-directory]"}
(output/"results.json").write_text(json.dumps(report, indent=2))
valid = report["sourcesUnchanged"] and len(mapping["cases"])==6 and mapping["sourceFreeze"] and mapping["providerOwnerMatchesCurrentSource"] and all(case["status"]=="passed" for case in mapping["cases"]) and all(c["status"] == c.get("expected", "COUNTEREXAMPLE" if c["mutation"] else "EXHAUSTIVE_WITHIN_REGISTERED_FINITE_MODEL") for c in checks)
print(json.dumps({"output": str(output), "enumerationAndControlsValid": valid, "completionGatePassed":False}), flush=True)
sys.exit(0 if valid else 1)
