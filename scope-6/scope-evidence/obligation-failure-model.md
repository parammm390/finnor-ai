# Canonical obligation and upstream owner failure model

Registered before production implementation. The DurableObligation joins one native
BusinessEffect, one actual S4 immutable handoff preparation, one S5 reservation and
consumption, exact intervention channels and resource envelopes. It is neither a
new business choice nor a second effect/resource ledger. Preparation grants no
execution or protected append authority. Only an independently admitted boundary
may activate it; no ordinary SQL row or caller admission object supplies that.

Failures: forged or foreign principal/owner/reference; changed preparation/body;
source/model/rights/allocation revision; handoff mismatched demand/node/consumption;
effect linked to different account/target/operation/unit/dose; unsupported semantic
mapping; duplicate consumption bound to multiple effects; changed body under an
existing idempotency key; missing/null preconditions/deadline/settlement predicate;
lease expiry or cancellation losing native possible egress; fake complete/receipt;
expired policy during unresolved responsibility; crash before/after ordinary intent;
deletion/mutation of immutable origin; direct RLS impersonation of hostile callers.

The ordinary database records are retained recovery/projection inputs, not Ring-0.
Use authentic existing owner resolutions at preparation and due/dispatch boundaries.
Historical obligations remain readable when current authority expires only under
current authenticated rights; expiry blocks new egress, never erases responsibility.
The native workflow/effect/physical-operation owners remain lifecycle authorities.

Test authoring answers: (1) actual S1–S5 owner references and native effect identity
remain exactly bound and durable, (2) omit any join/currentness check, overwrite a
retry or create a second effect for a consumed node, (3) upstream tests intentionally
stop before S6 and cannot establish these joins, (4) no production seam for tests;
use exported preparation/read/current-validation owners and real PostgreSQL. Reuse
existing S5 disposable fixture construction as test support, not its expected
certificates or receipts. Each challenge independently reads immutable SQL rows
and native effect identity, records inputs/steps/results, and retains failures.

Bounds: 256 obligations/tenant, 64 members/parents, 16 resources, 8 MiB immutable
body, 30-second preparation budget. Exact semantic changes require a linked new
effect and appropriate authority; they cannot reuse a consumption identity. Recovery
and settlement do not infer costs as zero or release S5 resources. No unit tests
are written after code, and all owner tests stop before editing their sources.

Public integration registration: prepare/read/validate are exposed through the
existing authenticated API boundary. Actual handler requests replace direct calls
in the primary owner E2E. Strict JSON schemas reject widened meanings/authority,
2 MiB streaming cap rejects oversized input, and persisted issuer checks reject
foreign/suspended identities. Preparation always reports no execution authority.
No dispatch or settlement endpoint accepts caller-provided claims. Test gate:
observable HTTP + native owner rows; omission of guard/schema/owner join is a
credible regression; no existing S5 handler owns S6 APIs; no test-only seam.

The requested local Next guide is absent in installed Next 15.5.25 (root and both
app resolution paths checked). Read installed app-route template and official
version-15 route documentation before route code:
https://nextjs.org/docs/15/app/api-reference/file-conventions/route . Async params
and standard Request/Response are retained. No dependency upgrade was performed.
