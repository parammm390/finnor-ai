# Remaining roots failure contract v1 (D2, C1, M1, M2, M3, M4, R1, R2)

Written before any repair edit, per review protocol. Each section states the
current behavior, the exact first-failure signature that counts as broken
evidence, the repair rule, and what does not count as proof. Broken evidence
for every root must be produced by an isolated driver or an owning end-to-end
run that fails BEFORE the repair and passes after it, with production sources
frozen except the named target file(s).

## D2 - scoped client through owner recheck (compute-search/owners.ts, enterprise-allocation.ts, enterprise-control reads)
Current: `nativeControlSnapshotTx(ctx,s,q,c)` calls `recheckSearchOwners(ctx,q,s,c)`; the helper passes `c` only to `validateEnterpriseAllocation` and calls `readEnterpriseContingentPolicy(ctx, policyRequest)` unscoped, and `validateAllocationState`/`currentPins` perform further unscoped reads. On a one-connection pool (the configured `max: 1` profile for non-loopback disposable URLs) the snapshot transaction holds the only connection and the unscoped read waits for a second one forever.
Broken signature: isolated driver with `Pool({ max: 1 })` and `statement_timeout`/`connect timeout` bounds observes the in-transaction unscoped policy read reject with a pool/statement timeout, recorded as `D2_SNAPSHOT_POOL_STARVATION`; the driver then shows the same read completing when the scoped client is used.
Repair: thread the optional `PoolClient` through `recheckSearchOwners` into `readEnterpriseContingentPolicy` and every read `validateAllocationState`/`currentPins` performs; no behavior change on the unpooled path.
Not proof: passing on a multi-connection pool; mocking the pool.

D2 status 2026-10-29: broken evidence SECURED (review-d2-pool-starvation-0003-broken.json: held-transaction read 5026ms/1 extra pool acquisition vs free-pool control 15ms, identical semantic miss). Repair checklist (established `client ? read(client) : withTenantTransaction(...)` pattern already exists at enterprise-beliefs.ts:57/:70 and world-state.ts internals already take PeClient):
1. enterprise-control.ts: `readEnterpriseContingentPolicy(ctx,value,client?)` (both overloads + impl); `readable(ctx,policy,client?)`; `current(ctx,policy,client?)` (controlSourcesCurrent, validateBeliefViewPin, resolveEnterpriseInterventionModelForControl, unresolvedEffects already has client); `recoverPolicyExperience(ctx,policy,client?)` (nativeOwnerTransportConfigured, enqueueNativeMandate, enqueueNativeReferences).
2. enterprise-beliefs.ts: `validateBeliefViewPin(ctx,pin,client?)`, `loadEnterpriseBeliefView(ctx,input,client?)`, `authorizeBeliefResources`/`authorizeBeliefCandidateCut` client passthrough.
3. world-state.ts: `loadPrivateEquityWorldState(ctx,root,at,client?)` → `readAuthorizedWorldState` → `reconstructPrivateEquityWorldState`; internal readers already take PeClient, only the acquisition sites need `client ??` fallback.
4. enterprise-allocation.ts: `validateAllocationState` passes client to allocationSourcesCurrent (:231), recheckAllocationCapability (:233), readEnterpriseContingentPolicy (:235), currentPins (:236); `currentPins(ctx,resources,client?)` → validateBeliefViewPin.
5. compute-search/owners.ts: `recheckSearchOwners` :48 passes client to readEnterpriseContingentPolicy.
Post-repair proof: rerun review-d2-pool-starvation-v1.mts → exit 0, D2_SCOPED_CLIENT_THREADED (caseA connectAttempts 0, fast, same semantic miss), then integrated typecheck.

## C1 - discriminated native completion variant (orchestration/src/objective-loop.ts)
Current: the completion payload is a single optional-field shape; the completed-plan recovery caller supplies original input + proof + verified result and is rejected by the existing guard because the combination is not a distinct, checked variant.
Broken signature: isolated driver invoking the recovery completion path observes the guard rejection `C1_NATIVE_COMPLETION_VARIANT_REQUIRED` (the current guard error) while supplying a complete original-input/proof/verified-result triple.
Repair: introduce a discriminated union variant that REQUIRES original input, proof and verified result together; migrate the recovery caller to it; the guard accepts exactly that variant and still rejects partial triples.
Not proof: widening the optional-field shape so any combination passes.

## M1 - current evidence bound separately from historical searches (ComputeSearchPanel.tsx)
Current: one binding guard clears the projection (including a fresh eligible program) whenever a stale INVALIDATED historical search is present, hiding reconciliation controls after cancel.
Broken signature: already observed in mounted attempts 0001-0003 (terminal failure with the fresh program present but projection cleared); the repaired mounted gate must show the projection retained with fresh current evidence bound and stale history excluded.
Repair: bind current evidence per search row instead of one panel-wide guard; never clear a CURRENT projection because a historical row is INVALIDATED.
Not proof: removing the guard wholesale (cross-Work leakage must still clear).

## M2 - reap bootstrap process group on timeout (scripts/postz-w1/native-run.py)
Current: `subprocess.run(..., timeout=300)` kills only the direct child on `TimeoutExpired`; grandchildren (node servers, embedded postgres) survive as orphans.
Broken signature: native-run 0007-era observation / fresh broken baseline run shows surviving child processes of the killed bootstrap after `FINITE_BOOTSTRAP_TIMEOUT`, recorded as `M2_ORPHANED_BOOTSTRAP_PROCESS_GROUP`.
Repair: start the bootstrap in its own process group and kill the group on timeout; wait for reaping before returning.

## M3 - gate success on owning artifacts (scripts/postz-w1/native-run.py)
Current: the child exit code can be 0 although the owning artifacts are missing/failed (embedded-postgres beforeExit masking); the receipt must derive success ONLY from the owning artifacts (native-story.json, independent-oracle.json PASS, mounted results.json PASS_LOCAL when mounted).
Broken signature: broken baseline where the child exits 0 with missing/failed owning artifacts must yield receipt failure `M3_OWNING_ARTIFACTS_AUTHORITY`, never success.
Repair: compute the final exit code from owning artifact status alone; keep the child exit code as recorded evidence.

## M4 - bound physical RPC and recheck deadline (scripts/postz-w1/native-drive.mts)
Current: `queue.tick` receives `AbortSignal.timeout(remaining)` (:12) but the physical `admin.query` status read (:13) is unbounded, and the terminal branch (:15) returns success without re-checking the episode deadline.
Broken signature: synthetic driver whose tick resolves after the deadline observes the driver return a terminal status past the 120s bound, recorded as `M4_TERMINAL_STATUS_ACCEPTED_AFTER_DEADLINE`; a hung status query must abort within the bound.
Repair: bound the status query with the remaining-time signal and assert remaining > 0 immediately before accepting a terminal status.

## R1 - financial prose out of ungated conversation history (apps/api actions route + conversation persistence/read)
Current: the success answer text (financial prose) is persisted verbatim via `persistEmployeeAssistantTurn` and mirrored to the ungated thread history/Zep; the thread reader checks ownership only, not current read authorization.
Broken signature: driver records a financial answer, revokes the reader's authorization, and observes the stored/read turn still containing the amounts, recorded as `R1_FINANCIAL_PROSE_IN_UNGATED_HISTORY`.
Repair: persist a non-sensitive reference (work/outcome refs) in place of the prose; hydrate the financial text only after a current authorization check at read time.
Not proof: redacting only the API response while the stored text still carries amounts.

R1 sites pinned 2026-10-29 (packages/orchestration/src/conversation-kernel.ts): persistEmployeeAssistantTurn :402-444 stores params.text verbatim as originalText (:419) and mirrors it to Zep (:434-442, mirrorConversationMessageToZep content=params.text). Callers: apps/api/app/api/actions/route.ts :432, actions/human :72-…, outcome-packs :110/:133, webhooks/vapi :118/:129/:165. Reader: prepareEmployeeConversationTurn :144 (loadEmployeeConversationThread :157 ownership-only; Zep facts :332-368). Repair mechanics: (1) persistEmployeeAssistantTurn accepts a non-sensitive referenceText plus the prose; persistence + Zep mirror carry only the reference (work/workInput/outcome refs already flow via params); (2) hydration at read time re-derives the financial text from the referenced gated outcome records under the reader's current authorization (reader ctx), falling back to the bare reference when authorization fails; (3) driver: disposable-PG fixture persists a financial answer turn, then reads the thread/Zep mirror after revoking the reader's authorization; broken = stored/mirrored text contains the amounts (R1_FINANCIAL_PROSE_IN_UNGATED_HISTORY); repaired = stored + mirrored text is the reference only, and hydration re-derives amounts for an authorized reader while a revoked reader gets the reference alone. Zep is external in the harness: substitute the harness's existing Zep stub/seam (check FINNOR_ZEP_* env or the mirror function's endpoint env) — never a live Zep.

## R2 - material fence before row locks in rearm (packages/db/index.ts)
Current: `objectiveEconomicReadOriginTx` rearm takes ObjectiveLoop/Work row locks first and the material statement fence (`aa_v3_material_statement_fence` / v3-material-cut) second; `controlWorkObjective` takes the fence first and the row locks second; concurrent execution deadlocks.
Broken signature: two-session disposable-PG driver executes both orders concurrently and observes PostgreSQL deadlock detection abort one session (`40P01`), recorded as `R2_REARM_FENCE_LOCK_ORDER_DEADLOCK`.
Repair: acquire the material fence before the ObjectiveLoop/Work row locks in the rearm path, matching controlWorkObjective's order.
Not proof: serial (non-concurrent) success.

R2 driver findings 2026-10-29 (draft driver review-r2-fence-order-v1.mts, NOT evidence): FOR NO KEY UPDATE pairs are mutually compatible in PostgreSQL, so the rearm's :2295/:2296 lock pair alone cannot deadlock against a fence-first owner's FOR NO KEY UPDATE (observed R2_INVERSION_PRESENT_UNDETECTED). The executable 40P01 cycle: session A = fence-first owner order (lockTenantMaterialCutTx :1290 → works UPDATE from transitionWorkTx → loop row lock finishIteration :1843) versus session B = real rearm order (loop FOR NO KEY UPDATE :2295 → works FOR NO KEY UPDATE :2296 → loop UPDATE :2414). Interleave B taking :2295 while A holds the works UPDATE: B blocks at :2296 holding the loop row; A then wants the loop row and blocks — A's loop lock must be UPDATE-strength to conflict with B's FNku, so A should use finishIteration's real loop row UPDATE (not FNku). Repair site unchanged: lockTenantMaterialCutTx(db, params.tenantId) before the objectiveClaim branch in beginWorkQueryExecution (:2378).
