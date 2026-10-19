# Whole-change review dispositions

Comparison base: `9ca70e1131e013148c58d5d7bcd14934bc172c0b`.
The initial review captured the complete task-owned intended change, including
unstaged and new files, in `review-1/manifest.json`, `inventory.md`, and the
500,947-byte non-generated `complete.diff` in the local delivery directory.
Generated clients, manifests and migration bundle are checked by regeneration,
not treated as independent handwritten implementations.

Three read-only reviews covered that complete snapshot for reuse, quality and
compatibility provenance, and efficiency. Integration changes and the new
release/recovery probes were inspected inline afterward. Review is static
evidence, not protected custody or E2E certification. See the verification
ledger for actual executions and retained failures.

## Verified findings and fixes

| Finding | Disposition |
| --- | --- |
| Cancelled/terminal canonical Work could leave a model current | Reuse `isImmutableWorkStatus` under a canonical Work row lock. Native Work programme occupation prevents finished transport children from prematurely completing a still-waiting scientific Work. A real terminal Work is never reopened by that occupation. |
| Producer-valid instrument could survive independent-check failure and be reused | Require the immutable independent receipt bound to certificate, checker and control digests. Recheck an unvalidated retained certificate under the original analysis allocation before any trial. |
| S8 candidate changed on retry; external submission preceded durable identity | Register exact immutable candidate, request and policy digests first. Concurrent/recovery submissions reuse it and return the canonical stored result. |
| Worker image omitted required maintained panel source | Add the exact panel COPY. No image execution is claimed without a Docker runtime. |
| Slow useful UI polls could be invalidated repeatedly | Add a separate single-flight read marker. Keep identity, Work, token, manual reload, offline and reconnect epochs. |
| Repeated linear programme lookups and array-copy grouping | Use invocation-local checked indexes and push buckets. Index only after independent closure validation; reject duplicate IDs. No cross-request scientific cache. |
| Unused history hashing and full experiment fetch for one raw record | Read only consumed cost/lease event kinds and the exact authorized experiment row. |
| Duplicate transport canonical encoder and allocation reference projection | Compose the existing governed-execution canonical encoder. Reuse one owner-local allocation reference projection. |
| Queue probe used `succeeded`, not native `completed` | Correct the probe to the actual durable JobQueue status and delivery outcome, without modifying native rows. |
| Native exact-intake conflict escaped as HTTP 500 | Map the existing `ExactWorkIntakeConflict` class to the X4 409 idempotency conflict. The emitted security probe now verifies that exact code. |
| Zod source facade missing from emitted API custody trace | Include the installed Zod tree. Actual trace audit now checks all 163 required scientific paths and native ABI loading. |
| Recovery probe assumed an operation UUID in the scientific effect tuple | Capture the actual native operation before death; compare its exact ID, action, effect and operation key after recovery. Retain the interrupted pre-recovery matrix. Freeze verification-file hashes before the replacement full matrix. |
| Concurrent large HTTP fixture replies interleaved JSONL bytes | Serialize complete native receipt records and drain active handlers/writes on close. Defer only a live unfinished tail, never forgive a malformed complete record. Keep the original corrupted failure. This changes evidence transport, not owner responses. |
| Browser interaction could target a button inside a disabled fieldset | Wait for actual `:disabled` semantics and native form validity. A stopped mounted fixture now requires the separately completed browser artifact before reporting success. Keep the failed no-submit attempt. |

## Helper and compatibility inventory dispositions

| Inventory group | Reuse / keep decision |
| --- | --- |
| Bounded science, model and common-envelope types | Keep new versioned finite-domain shapes. Existing S2 IID and S3 temporal-linear shapes require supplied priors/equations and cannot safely encode this nonprobabilistic profile. |
| Generator grammar, quotient, analysis, forecast and minimax | Keep the bounded executable representation and complete finite closure. Existing supplied-equation fitting is not autonomous grammar generation. Retain full equivalence classes and Cartesian survivors. |
| Independent checker encoding, evaluator, closure, page walk, literal controls and causal reconstruction | Keep independently implemented. Sharing producer or instrument evaluators would destroy the explicitly required independent expectation. Checked local indexes change lookup cost, not scientific semantics. |
| Provider binding parsing, projections and permitted reads | Reuse private-file broker, native egress and canonical wire encoding. Keep exact disposable target/role/version routing and strict bounds locally. No general provider or execution-platform abstraction. |
| Experiment compile/dispatch/reconcile | Reuse native selected PlanNode, DomainAction, BusinessEffect, provider invocation and external operation. Keep one narrow digital adapter; no replacement effect ledger or blind-repeat policy. |
| Original allocations and logical retained bytes | Reuse native DB transactions and shared compute leases. Keep append-only units for this scientific original parent. The existing S5 conditional-JSON envelope has different physical semantics and is not recast as a digital experiment grant. |
| Request/job schemas and parse/error helpers | Compose existing bounded application-data validation, Zod, `ApplicationFault` and native exact-intake conflict. Keep strict new operation shapes; no branch-local legacy union. |
| Owner transaction, principal, root, reference and snapshot helpers | Compose canonical PE/authority/DB primitives. Keep small owner-local projections where importing another owner's private helper would couple unrelated domains or rehash an already committed digest. |
| Currentness, consent, Work, allocation and row-integrity guards | Compose existing canonical rights and immutable Work semantics. Keep the additional scientific identity joins. No cached authorization decision. |
| Family, instrument, model and raw-check assembly | Keep narrowly scoped immutable scientific reconstruction. Instrument receipt lookup is a necessary new certificate-to-check binding, not a second instrument owner. |
| Scientific event, queue, finding and Evidence publication | Reuse durable JobQueue, canonical finding transaction seam and Evidence source/version/chunk owners. Keep scientific lineage; do not infer scientific truth from a generic attachment label. |
| Public intake, lifecycle, reads and complete envelope | Keep the new explicit owner API. Reuse canonical Work intake and scoped authorization. Repeated immutable model releases are current behavior, not an intra-branch compatibility adapter. |
| Instrument measurement | Keep separate from the raw checker and private provider. This deliberate separation prevents a producer normalizer from grading itself. |
| Child interpreter, emitted child and supervisor | Keep fixed data-only instructions and bounded process supervision. Deterministic emission removes loader startup without admitting generated source or changing limits. |
| Physical queue worker and canonical failure WAIT | Reuse native claim/fence/compute ownership and decision writer. Keep scientific sequencing and atomic WAIT; an ACK, failed read, or expired provider cannot become completion. |
| Source paths, source cut and stamp | Keep explicit emitted/current/loaded identities. Compose inherited X3/X5 stamps and native source custody. This is not an authority or model-currentness cache. |
| Typed S8 port, consumer and native proof | Keep an additive sibling. Reuse signed lifecycle transport, separate principals, immutable journal, current-until and sticky revocation. Preserve the deployed allocation grammar's 128-pin limit; scientific closure has a separate 256-pin bound. |
| Maintained Work panel and Canvas wiring | Reuse existing authentication/API client and Canvas/focus. Keep exact uncertain invocation and presentation epochs. No alternate private-data dashboard. |
| HTTP response gate and signed lifecycle fixture extensions | Retain existing R1/X3/X5/S8 callers. Add the scoped identification key, serialized full receipt writes with close-time draining, and optional X4 config forwarding. No old wire shape was removed or silently reinterpreted; native reply bytes remain unchanged. |
| Reserved provider startup and post-exit ADMIN inspection | Keep campaign-only. ADMIN inspection is independent evidence after verified real child exit, never measurement fallback or candidate mechanism input. |
| Installed matrix, security, DB, recovery and mounted probes | Keep real boundary drivers with retained inputs/results. They do not insert scientific terminal rows, patch lease clocks, supply check grades or replace identity/effect owners. |
| Release source audit and standalone reconstruction | Keep release-only drivers. They verify actual trace membership, native ABI loading, ordinary two-lock installs, regeneration and emitted execution. They do not stand in for container/arm64 or protected qualification. |

No compatibility layer exists solely for an earlier shape on this unmerged
branch. Existing S1-S8/P7 contracts, original scopes and ordinary guarded queue
recovery remain authoritative. Broad generated changes must reproduce exactly
from those maintained generators.
