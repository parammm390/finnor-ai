> Historical original-worktree audit, retained for provenance. Current publication scope, base, migration and verification are recorded in [publication-audit.md](publication-audit.md); original final pins are in prepublication-final-source-manifest.json.

# S6 interface audit for S7

Inspected 2026-10-04. Read the supplied S7 mission, root AGENTS.md, S6 plan/status,
the current source below and retained late S6 manifests/results. Repository alias
`/Users/paramdave/FINNOR` resolves to `/Users/paramdave/Desktop/FINNOR`; current HEAD
is `6ade745cfaca88bb199ed9cac2b37b86e6d5ef9a`. No production source changed in this audit.
No S7 implementation existed when inspection began. Root captures working changes.

## Registered extension failure model (before source edits)

Observable contracts: S7 can commit its exact typed immutable H0/H1/H2 record
through the existing protected append; foreign owners retain their namespace and
H0/H1 restriction; genuine dependency preimages must be read independently with
pinned receipts; S7 append credentials never gain attenuated execution-reader
authority. A separate read-purpose credential retains the same semantic principal.

Credible failures: absent S7 vocabulary rejects new capability; H2 accidentally
widened for S1–S6; event.detail authenticated by a different revision digest;
duplicate route scope prevents distinct read credential; consumer configuration
silently falls back to append token; swapped/foreign/changed reference accepted;
signed receipt from wrong owner/principal, unregistered release or rights cut
accepted; empty pre-INTENT history rejected; received bytes or projections altered;
concurrent retry/restart mints a second receipt; late correction overwrites original.
Existing S6 E2E owns immutable transport, crash recovery and attenuated handoff,
but lacks S7 event/H2 capability and dual-purpose routes. New verification extends
the actual separate ledger/API boundary; no production seam exists solely for tests.
The S7 test-audit lane records preimplementation unsupported behavior before this
extension. New generic reference-read helper has a real S7 persistence caller and
asserts accepted owner commitments, not causal/economic truth. Local signed test
authority remains explicitly nonproduction.

## Qualification reconciliation

S6 status explicitly says IN_PROGRESS and frozen completion unpassed, but it is
stale. `completion-closure.json` records CLOSED, all 23 repository items passed,
at the exact current HEAD; its protected ledger and native obligation source
digests match this inspected baseline. It records all six PRs open/attached/green
at a later publication head and remainingRepositoryTask=null. The full external
frozen gate remains false, X1–X4 external, productionAdmissionEstablished=false.
`pr-publication/recovery/github-s6-backend-summary.json`
records successful Linux clean-install CI at a different head, 1308 passed and 27
skipped. That does not establish the current source or protected production admission.
`pr-publication/recovery/ledger-qualified-final/results.json` records 19 passes;
the corresponding manifest's ledger.ts/server/protocol/request-verifier/adapter
digests match the inspected files, but its owner-transport.ts digest does not.
`pr-publication/recovery/native-owner-final/owner/results.json` records eight passes
under genuine native-owner/disposable/separate-process qualification.
The integrated release candidate is UNSIGNED_NOT_DEPLOYED_NOT_ADMITTED and records
productionAdmission.established=false with external dependencies X1–X4. Existing
mechanical commitments and local process proofs neither certify H2 value nor grant
production release, independent valuation, economic credit or live-provider semantics.

## Exact reusable seams

| Seam | Current contract | S7 use and limit |
| --- | --- | --- |
| `packages/governed-execution/src/ledger.ts` | `registerReference(owner,{reference,relatedReferences?,rightsRefs,sealed?})`; descriptor `{id,owner,version,contentDigest,content,digestEncoding?}` | Immutable S7 preregistration, assignment/assessment/cost/correction preimages under S7 credentials. References cannot be registered on behalf of foreign owners. Canonical JSON SHA256 or declared native UTF8 encoding is verified. |
| same | `append(owner,{event,parents,references,sealed?})` | Enforces authenticated tenant/principal/semantic owner, rights, immutable identity, exact signed parent receipts, committed dependencies, source cuts and provenance digests. Current preparedTypes supports S1–S6 only and H0/H1 only; S7 is absent. |
| same | `read(owner,eventId)` / `readReference(owner,id)` | Accepted bytes and signed receipt; no business truth certification. Tenant, sealed evaluator rights and rights cuts enforced. Journal/head/witness integrity checked before reads. |
| `packages/governed-execution/src/ledger-server.mts` | bearer-authenticated `/references`, `/append`, `/events/:id`, `/references/:id`, `/execution-handoff/:obligationId` | Fixed existing protected process transport. No new economic ledger or bypass needed. |
| `packages/governed-execution/src/owner-transport.ts` | `ownerTransportRoute(scope)`, `readOwnerTransportReference/Event`, `deliverOwnerTransportIntent`, `recoverOwnerTransportIntent` | Signed route and origin validation, no-follow private credential files, release/verifier/policy receipt pins, bounds, redirect refusal and read-only recovery authenticate original bytes. S7 detail digest must join strict typed read verification. |
| `packages/governed-execution/src/owner-delivery-store.ts` | `enqueueOwnerDeliveryInTransaction(pgClient,scope,{kind,identity,payload})`; `deliverOwnerTransportBatch(scope,{limit?})` | Enqueue in the actual S7 owner transaction. Original signed outbox is immutable; SQL leases, 64 append attempts, 64 recovery reads and operator responsibility survive restart. Ordinary ACCEPTED rows never substitute for verified protected receipts. No schema extension needed merely for S7 semantic_owner. |
| `packages/private-equity/src/native-experience-transport.ts` | nativeReference/nativeRecordReference; enqueueNativeReferences/enqueueNativePreparedEvents | Existing helpers preserve native owner preimages. They open their own transactions: use the direct in-transaction outbox API for atomic S7 registration/assignment. Foreign references must originate from their actual owner; submitted JSON is insufficient. |
| `packages/private-equity/src/enterprise-obligations.ts` | `readEnterpriseDurableObligation(ctx,ref)`; `readEnterpriseDurableObligationExecutionHandoff(ctx,input)` | Native SQL owner resolves and hashes immutable origin; handoff wrapper currently uses S6 transport scope. Preserve S6 obligation/effect responsibility and S5 consumption/release ownership. |
| `apps/api/lib/auth.ts` | `requireContext(req)` plus native owner checks | Production JWT verification resolves tenant/principal/role, rate limits and runtime authority; development header bypass applies only outside production. Economic mutation should recheck actual active owner in tenant transaction, following enterprise-obligations. Independent valuer authority needs an explicit authenticated authorization contract, not a submitted name. |

## Authenticated execution consumer

`ExperienceLedger.readExecutionHandoff` and
`readOwnerTransportExecutionHandoff(scope,obligationId)` already support S7/S8.
The signed handoff includes exact native obligation, request/method admissions,
accepted protected history, separately projected attempts/observations/settlements,
cost/funding records, foreign reference receipt availability, checkpoint/release and
witness qualification. It explicitly returns attributionGranted=false,
resourceReleaseGranted=false and executionAuthorityGranted=false. It is H0 evidence;
actual exposure must remain separately qualified. Missing foreign preimages remain
OWNER_PREIMAGE_OR_AUTHORIZED_ACCESS_PENDING. Do not convert these into source facts.

S7/S8 handoff access is deliberately attenuated: append, protectedExecution,
dispatch and sealedAppend must all be false. The existing route resolver allows
only one `(semanticOwner,tenantId,principalId)` route and handoff requires the same
principal as the native S6 obligation. Therefore one route cannot both emit S7
events and consume the handoff. Minimal safe extension: a separately signed
read-purpose transport configuration/resolver with a distinct bearer token while
preserving semantic principal and the existing attenuated protected reader check.
Do not remove that check or reuse an append token as a consumer.

## Minimal ownership-preserving extension

1. Add the final S7 experience vocabulary to protected preparedTypes; accept H2
   only for S7, leaving S1–S6 horizon rules unchanged. This authenticates a horizon
   label; S7 remains responsible for mature evidence and admissibility.
2. Authenticate S7 contentDigest against exact event.detail, independently of its
   revision subject, in append and owner typed read verification. Preserve generic
   immutable parent/reference and receipt enforcement.
3. Add separate attenuated S7/S8 consumer route selection and robust signed handoff
   verification. Existing `list(history)` requires nonempty history: authentic
   obligations before an INTENT need an explicit empty-history test/representation.
4. Have the actual S7 owner persist immutable versions and outbox references/events
   in the same SQL transaction; preregistration requiring protected admission must
   refuse assignment while that original commitment is unaccepted or unavailable.
5. Resolve S2/S3/S4/S5/S6 and BUSINESS_OWNER references from native owners plus
   authenticated accepted readbacks. Preserve missing transport qualification.
   Protected ledger guarantees byte commitments, not causal identification.

## Existing verification machinery

`scripts/s6/run-ledger-e2e.mts` exercises separate-process authenticated append,
immutable retries/concurrency, typed-detail substitution, source/parent enforcement,
sealed access, protected storage failures, physical kill/restart and witness behavior.
It requires successful actual native obligation results via
FINNOR_S6_NATIVE_OBLIGATION_RESULTS. `run-owner-transport-e2e.mts` exercises actual
native owner/outbox/protected ledger delivery, SIGKILL after accepted protected
commit before local receipt persistence, and exact recovery/readback. It also
requires native owner fixtures/database. `governed-dispatch-proof.mts` includes
an actual signed S7 attenuated handoff challenge. `scripts/s6/run-native-tests.py`,
`run-obligation-owner-local.py`, `run-ledger-writer-e2e.mts` and the disposable
database runner retain repeatable source/runtime/inputs/results. Script compilation
uses `npx tsc -p scripts/s6/tsconfig.json --noEmit`; root compilation uses npm
typecheck. New tests should be separate-process E2E with preregistered failure
model and retained evidence, not postimplementation unit tests.

## Inspected source digests

| Path | SHA256 |
| --- | --- |
| finnor-os/packages/governed-execution/src/ledger.ts | 28c199524740d227f2f5d4fd4e6ca8c9c93d529bff472f18826e83045e2a06ae |
| finnor-os/packages/governed-execution/src/owner-transport.ts | bf818ea3557bf141751b9f86794125c639a00888986df6ef988f134cd5275f4f |
| finnor-os/packages/governed-execution/src/owner-delivery-store.ts | 804c0017874e0d57de15557afc93b7c37118d5a080f26ff3e58f7dd11dd46649 |
| finnor-os/packages/private-equity/src/enterprise-obligations.ts | a9b73f6e3ee16928ad994fed2ae935955c32f27b7af717a1c456e19c96a2ea6d |
| finnor-os/packages/private-equity/src/native-experience-transport.ts | 7ca59e3a7ce6734d8d0d020a56397b1efbfa0b4ef4aee8f0d2bd125d58a235be |
| finnor-os/packages/db/migrations/0150_authenticated_owner_transport.sql | 9497f2420ddeb9ce0f978ebacd9cc1224786d7fff7244cc8d71944476b65e4d1 |
