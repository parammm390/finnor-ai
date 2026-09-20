# Scope 2 runtime conformance contract

This contract defines a later repository-controlled comparison of the canonical
Postgres runtime with Temporal or Hatchet. It is not a migration decision, does not
add either engine as a dependency, and makes no unmeasured claim about either product.

## Admission rule

An adapter is comparable only if it preserves FINNOR's existing semantic owners.
Scope-1 PlanNode/ExecutionAttempt, Authority, BusinessEffect, DomainAction,
DecisionReceipt, Observation, Verification and RecoveryDecision remain canonical.
An engine may implement durable mechanics beneath them; it may not replace their
meaning with engine-native workflow history.

## Required conformance surface

| Surface | Required observable contract | Repository-controlled evidence |
|---|---|---|
| Command submission | Immutable/versioned command, run, steps and first delivery commit atomically; conflicting idempotency fails closed | command transaction and duplicate-submission cases |
| Claiming | Real multi-session/process contention yields one current claim; incompatible protocol is filtered before claim | 100-session job/step proofs and rolling-version case |
| Retries | Physical delivery, step claim, logical operation, provider invocation, observation and reconciliation remain distinct | append-only histories and retry taxonomy tests |
| Signals/waits | Event persistence precedes match; wait/wake claim/job are durable; duplicate and deadline races converge | event/wait/wake concurrency cases |
| Timers | Correctness survives process loss; durable rows, not JS timers, determine deadlines | restart/deadline cases |
| Effect integration | Immutable BusinessEffect may own several provider members; no verified member is replayed due to aggregate incompleteness | multi-member partial-settlement cases |
| Provider idempotency | Key, scope and guaranteed TTL are durable; replay outside the window requires stronger evidence | active/expired TTL cases |
| Unknown outcome | Possible egress is tracked and cannot be repeated before readback/reconciliation or proven equivalence | physical invocation + reconciliation cases and SIGKILL corpus |
| Observation/verification | ACK is separate from readback; exact tenant/provider/account/effect/member binding; monotonic verified truth | observation and out-of-order evidence cases |
| Explanation/replay | Operator can inspect canonical intent, claims, attempts, physical requests, receipts, observations, controls, waits and DLQ | `inspectRuntimeTruth()` bounded read model |
| Versioning | Current/minimum protocol is explicit; supported old payloads remain interpretable; future incompatible work fails closed before claim | version/redeploy gate |
| Worker restart | Queued, leased, possible-effect, observation, reconciliation, wait and DLQ state recover from PostgreSQL alone | real child-process SIGKILL matrix and watchdog recovery |
| Throughput/latency | Same fixtures, connection limits, row counts and page bounds; correctness assertions remain enabled | performance gate JSON facts |
| Operational complexity | Required services, schemas, deployment steps, runbooks, failure modes and on-call actions are counted explicitly | future bakeoff artifact |

## Measurement protocol

Any later adapter must run the same immutable case IDs and fixture semantics. Results
must report:

- engine and adapter version;
- exact commit and configuration;
- database/service topology and connection limits;
- p50, p95 and p99 latency where the sample is large enough;
- throughput and error counts;
- process count and proof that sessions were genuinely independent;
- all skipped, blocked and externally unavailable cases;
- operational dependencies and manual recovery actions;
- whether a failure was known pre-egress, possible effect, provider ACK, observed,
  verified, divergent or unknown.

No fake-provider result may be relabeled live-provider conformance. No engine may be
credited with exactly-once external delivery; business-effect safety must derive from
logical identity, provider guarantees, readback and reconciliation.

## Current repository-controlled finding

The existing Postgres runtime is the only implemented adapter and remains canonical.
It has repository-controlled evidence for command atomicity, claim contention,
version-safe preclaim, durable waits, effect protocol, unknown-outcome recovery,
restart, inspection and bounded backlog behavior. Temporal and Hatchet have not been
installed, benchmarked or connected to this repository. Their comparative result is
therefore **DEFERRED**, not PASS or FAIL. Live-provider conformance remains
**BLOCKED_EXTERNAL** until exact credentials/accounts and provider-specific guarantees
are available to a separate conformance layer.
