# Scope 2 durable runtime audit

Status: repository-controlled implementation and certification evidence. This record
does not claim a live-provider conformance result and does not claim that a production
database was inspected.

## Canonical execution map

Before Scope 2, the Postgres queue and workflow runtime already had durable jobs,
commands, runs, steps, receipts, effect authorization, observations, waits and
reconciliation. The important defects were in the relationships between those owners:
mutable counters hid delivery history, a step lease lacked a complete claim history and
fence, a logical provider operation could hide several physical requests, provider-key
TTL was not a first-class retry fact, acknowledgement and observation scheduling were
separate commits, and dormant outbox code implied delivery that did not exist.

The canonical path is now:

```text
Scope-1 PlanNode / semantic ExecutionAttempt
  -> immutable DomainAction + BusinessEffect member intent
  -> CAUSAL READY
  -> EXECUTION ELIGIBLE
  -> Job claim + append-only job_delivery_attempt
  -> WorkflowStep claim + append-only workflow_step_claim + fence
  -> CLAIMED
  -> DecisionReceipt opened
  -> Authority/policy/precondition revalidation
  -> effect commit point
  -> ATTEMPTED
  -> external_operations logical provider member
  -> provider_operation_attempts legally authorized runtime try
  -> provider_invocations physical request(s), including wrapped/SDK/HTTP layers
  -> provider acknowledgement/result
  -> observation/readback
  -> exact member verification or divergence/unknown
  -> BusinessEffect aggregate: verified / partially verified / uncertain
  -> reconciliation or explicitly authorized compensation where legal
  -> Scope-1 RecoveryDecision for REPLAN / ESCALATE / CANCEL
```

Scope 2 does not create another semantic ExecutionAttempt owner. Runtime delivery and
provider attempt rows are subordinate evidence beneath Scope 1's semantic identity.

## Canonical ownership

| Concern | Canonical owner | Scope-2 relationship |
|---|---|---|
| Desired orchestration and semantic attempt | Scope-1 Work, PlanRevision, PlanNode and ExecutionAttempt | Preserved; never synthesized from queue retries |
| Permission to execute | Authority and immutable BusinessEffect authorization | Revalidated before effect commit; not treated as PlanGraph causality |
| Consequential intent | BusinessEffect | One effect may own many independently settling provider-operation members |
| Durable execution envelope | Command, WorkflowRun, WorkflowStep | Versioned, immutable-command-bound and restartable |
| Physical scheduling/delivery | Job and job_delivery_attempts | Claim-safe by protocol version; append-only delivery history |
| Physical step ownership | workflow_step_claims | Token + monotonic claim fence + dispatch generation |
| Logical provider member | external_operations | Stable tenant/owner/member identity, exact provider/account and retry-safety facts |
| Legally authorized provider try | provider_operation_attempts | New row only when durable evidence makes repetition legal |
| Actual transport request | provider_invocations | One row per consequential physical request; possible egress is durable |
| Aggregate step effect envelope | integration_operations | Kept distinct from logical provider members; it does not claim provider-call identity |
| Audit evidence | DecisionReceipt plus append-only claim/invocation/control history | Receipt opens before consequential execution and finalizes from durable outcome |
| External evidence and verification | external operation observation plus BusinessEffect verification | Provider ACK is not external verification when readback is required |
| Ambiguity/divergence | ReconciliationCase | Evidence-bearing, version-fenced resolution; no blind retry |
| Durable signal | IntegrationEvent, WorkEventWait, WakeClaim | Scope 1 owns wait meaning; Scope 2 owns durable match/wake mechanics |
| Consequential operator action | runtime_operator_controls | Tenant-scoped, Authority-backed, expected-version/fence-aware and auditable |
| Higher-level recovery choice | Scope-1 work_recovery_decisions | Scope 2 supplies facts; it does not seize REPLAN / ESCALATE / CANCEL ownership |

## KEEP / EXTEND / REFACTOR / REPLACE / DELETE / DEFER ledger

| Disposition | Runtime primitive | Result |
|---|---|---|
| KEEP | Existing Postgres job queue, Command/Run/Step graph, DecisionReceipt, BusinessEffect, reconciliation, integration events and durable waits | Existing canonical owners retained |
| KEEP | `integration_operations` and `external_operations` | Their different layers are now explicit: aggregate step envelope versus logical provider member |
| EXTEND | Job and step claiming | Append-only delivery/claim history, lease heartbeat, tokens, fences and protocol compatibility before claim |
| EXTEND | External operations | Stable owner/member identity, account pinning, protocol version, verification mode, retry-safety and provider-key TTL/scope |
| EXTEND | Provider execution | Append-only runtime attempts and physical invocations; every possible consequential request is tracked |
| EXTEND | BusinessEffect settlement | Multiple members, partial verification, partial uncertainty and no replay of already verified members |
| EXTEND | Reconciliation and compensation controls | Evidence-bearing resolution and Authority/version/fence-audited control rows |
| EXTEND | Runtime inspection | One bounded tenant-scoped query over canonical owners; no new truth ledger |
| REFACTOR | `wrappedCall`, Microsoft Graph mutation transport, artifact and computer adapters | Consequential retries require proven equivalence; physical requests are individually audited; unsafe hidden retries are disabled |
| REFACTOR | Provider ACK/result/readback scheduling | One transaction persists ACK, logical outcome and required observation job |
| REFACTOR | Restart watchdog | Classifies abandoned provider work as pre-egress, acknowledged, or possible-effect from durable facts |
| REPLACE | Mutable attempt counters as sole evidence | Counters remain projections; append-only job, step, provider-attempt and invocation rows carry history |
| DELETE | Production outbox relay and scheduled fake delivery | Retired after forward migration guard checks unresolved events/DLQ/reconciliation; schema remains historical |
| DELETE | Direct unowned notification/provider worker handlers | Removed from worker registration/runtime reachability |
| DEFER | Temporal or Hatchet migration | No dependency or production migration; comparison is a later measured decision |
| DEFER | Live-provider guarantees | `BLOCKED_EXTERNAL`; deterministic fake/fault providers certify runtime semantics only |

## Material gaps found and corrected

- The historical inbox migration retained a global provider-event uniqueness
  constraint despite adding tenant-scoped deduplication. The forward migration drops
  the obsolete global constraint and certifies same provider event ID across tenants.
- Queue and step mutable attempt counts did not preserve who claimed what. Append-only
  delivery and step-claim ledgers now preserve worker, protocol, token, fence and outcome.
- A runtime attempt could conceal `wrappedCall`, SDK or HTTP retries. Physical provider
  invocations are now explicit; consequential retries require active provider
  idempotency or durable proof of pre-egress failure.
- Call-index identity was unsuitable for consequential mutations. Consequential calls
  require a stable semantic member key; call-index fallback remains only for
  non-consequential compatibility calls.
- Provider idempotency keys could be mistaken for permanent protection. The guaranteed
  scope and expiry are durable; an expired/unknown window requires readback or
  reconciliation.
- A BusinessEffect could be incorrectly treated as one provider call. Logical members
  now settle independently and aggregate partial verified/uncertain truth.
- A stale worker could attempt to cross the provider boundary after recovery. Provider
  preparation and possible-egress marking now require the current durable attempt
  state; loss of that fence fails before adapter entry.
- Provider ACK/result persistence and observation-job enqueue were split commits. They
  are now atomic, and duplicate result bookkeeping is an idempotent no-op.
- A dead process could strand `claimed`, `provider_in_flight`, or legacy
  `provider_acknowledged` operations. The watchdog now classifies prepared/no-request
  work as known pre-egress, possible egress as reconciliation-required, and durable ACK
  evidence as resumable bookkeeping.
- Protocol-incompatible workers could claim future-version jobs. The compatibility
  predicate is part of the queue claim itself.
- Cancellation closed the run but could leave an active step claim capable of a stale
  commit. Cancellation now closes the claim and clears its ownership fields when it
  wins before effect commit.
- Governed operator retries initially hashed a freshly issued Authority decision ID,
  preventing an identical HTTP retry from converging. Idempotency now hashes the
  stable authorized request while retaining the exact decision ID on the applied row.
- The outbox had no production producer and its relay only logged hypothetical
  delivery. The runtime path is retired honestly; deployment aborts if persisted
  unresolved obligations exist and never fabricates delivered state.

## Retry-layer audit

- Physical job redelivery reuses the semantic command/effect and is recorded in
  `job_delivery_attempts`.
- Step redelivery requires the current dispatch generation and creates a fenced
  `workflow_step_claim`; it does not create a Scope-1 semantic attempt.
- `wrappedCall` writes a provider invocation before adapter entry and marks possible
  egress before a consequential adapter can run. Inline repetition is legal only for
  definite pre-dispatch failure or active provider-idempotency protection.
- Microsoft Graph consequential mutation auth retry is disabled. Upload redirects and
  other real HTTP requests use transport audit hooks so one logical operation may show
  multiple physical invocations without hiding them.
- Artifact multi-request operations deliberately keep each HTTP invocation distinct
  while one logical provider operation owns the sequence.
- Computer-provider mutations conservatively record possible egress before the UI
  primitive and keep acknowledgement subordinate to post-state observation.
- Observation polls and reconciliation retries never invoke the original mutation.
- Provider-key replay after its guaranteed expiry is not considered equivalent.

## Provider truth vocabulary

The runtime and operator surfaces distinguish:

- WHAT FINNOR ATTEMPTED
- WHAT REQUEST MAY HAVE LEFT FINNOR
- WHAT THE PROVIDER ACKNOWLEDGED
- WHAT FINNOR OBSERVED / READ BACK
- WHAT FINNOR CAN VERIFY ABOUT EXTERNAL STATE
- WHAT REMAINS UNKNOWN

The enforced retry invariant is:

> FINNOR must never knowingly issue a second consequential provider invocation for an unresolved logical operation unless durable evidence proves repetition is legal or provider idempotency makes replay equivalent.

The companion invariant is **NO UNTRACKED POSSIBLE EFFECT**.

## Outbox and migration reality

Repository-wide production-call-site inspection found no active producer or real
destination for the old outbox. The relay and scheduler registration are removed.
Migration `0137_scope2_durable_runtime.sql` refuses retirement when unresolved outbox
rows, open outbox DLQ rows, or relevant open reconciliation cases exist. It records
retirement only after those checks. No historical row is rewritten as delivered or
settled. Production data itself was not queried in this worktree; the deployment-time
guard is the authoritative production check.

## Certification boundary

`npm run release:scope2` creates a disposable fresh PostgreSQL database, applies the
forward migration chain, uses 100 distinct competing sessions for concurrency proofs,
runs the named mandatory registry and focused runtime suites, executes the real
SIGKILL/restart corpus, measures bounded backlog queries, and runs Scope 1 plus the
Phase-15A release regression. Deterministic fake/fault-provider evidence is valid for
runtime semantics. Live-provider conformance is separately `BLOCKED_EXTERNAL` and is
never counted as PASS.
