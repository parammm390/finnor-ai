# Phase W current-main compatibility checkpoint

Status: **PRIVATE INTERMEDIATE SOURCE MERGE RESOLVED, FINAL IDENTITIES AND QUALIFICATION PENDING.** The authorized local checkpoint preserves the owned W source. The current-main merge resolves the source contracts below; it is not a combined semantic, native, installed, mounted or admission pass.

## Exact identities and custody

- Both the bounded noninteractive `git ls-remote origin refs/heads/main` and the GitHub `branches/main` API returned main `b13bc6e5409f5e33e973e6dbf6212d09a1b94df1`.
- Its tree is `dad0e81aae74b3af578db5b4f2ae14fe77eda715`.
- The exact content-addressed commit was already present locally. Its commit type and tree were verified, then it was atomically pinned in the previously absent private ref `refs/droid/private/phase-w-main-cf58b9c4-aed9b1c7`.
- At the initial freshness pin, no existing ref, branch, index or dirty source was replaced and HEAD remained `cecec15d64fe8f8fb63a5a29b98979f978ba6138`. The later authorized selective private source checkpoint is `7648e094c0c3e3a389796f5468ebbf0d91a2e99b`, tree `967e48aedd10ae70278231d595a5dc2fb2258d3e`. The intermediate merge joins that checkpoint and the exact pinned main above.
- The first explicit private-ref fetch timed out after 180 seconds without creating that ref. A later bounded noninteractive metadata read succeeded. No blind fetch retry, credential bypass or proxy change was used.

## Divergence

The actual merge base is `df9111da8c7a1170f1f074e43fdf5984eaa55b8b`. Neither current main nor cecec15 is an ancestor of the other.

| Measure | Observed |
| --- | ---: |
| Main-side commits absent from cecec15 | 13 |
| cecec15-side commits absent from main | 21 |
| Main-side changed paths from merge base | 225 |
| cecec15-side changed paths from merge base | 596 |
| Paths changed on both sides | 39 |
| Main-side changes overlapping current dirty paths | 8 |
| Full main-versus-cecec15 tree delta | 782 files |

The full tree delta is 175301 insertions and 67579 deletions. These are source-difference counts, not automatically applicable patches.

### Eight overlaps with currently dirty source

- `finnor-os/apps/api/next.config.mjs`
- `finnor-os/apps/worker/src/index.ts`
- `finnor-os/packages/authority/src/index.ts`
- `finnor-os/packages/db/compute-contract.ts`
- `finnor-os/packages/db/migration-head.ts`
- `finnor-os/packages/db/migrations-bundle.ts`
- `finnor-os/packages/private-equity/src/allocation-store.ts`
- `finnor-os/scripts/bundle-migrations.ts`

### All 39 two-sided paths

```text
.github/workflows/ci.yml
.github/workflows/source-checks.yml
.gitignore
docs/centropy/capability-coverage.json
finnor-os/apps/api/next.config.mjs
finnor-os/apps/supplier-canary/api/index.mjs
finnor-os/apps/worker/src/index.ts
finnor-os/docs/authz-matrix.md
finnor-os/openapi.json
finnor-os/packages/authority/src/index.ts
finnor-os/packages/db/compute-contract.ts
finnor-os/packages/db/migration-head.ts
finnor-os/packages/db/migrations-bundle.ts
finnor-os/packages/epistemic-runtime/src/allocation-producer.ts
finnor-os/packages/epistemic-runtime/src/strategic-response/source-manifest.generated.ts
finnor-os/packages/orchestration/src/capabilities/planner-replay-manifest.json
finnor-os/packages/orchestration/src/index.ts
finnor-os/packages/private-equity/src/allocation-store.ts
finnor-os/packages/private-equity/src/compute-search/worker.ts
finnor-os/packages/private-equity/src/enterprise-allocation.ts
finnor-os/packages/private-equity/src/enterprise-applications/source-manifest.generated.ts
finnor-os/packages/private-equity/src/enterprise-beliefs.ts
finnor-os/packages/private-equity/src/enterprise-control.ts
finnor-os/packages/private-equity/src/owner-context.ts
finnor-os/packages/private-equity/src/policy-learning/source-manifest.generated.ts
finnor-os/packages/private-equity/src/system-identification/source-manifest.generated.ts
finnor-os/packages/private-equity/src/world-state.ts
finnor-os/packages/shared-types/src/index.ts
finnor-os/scripts/bundle-migrations.ts
finnor-os/scripts/generate-openapi.ts
infra/deployment/production-mutation-inventory.json
infra/deployment/production.contract.json
package.json
scripts/centropy/generate-capability-manifest.mjs
scripts/release/release-policy.test.mjs
src/components/centropy/canvas/CanvasDocument.tsx
src/lib/centropy/capability-manifest.generated.json
src/lib/centropy/openapi-types.ts
src/lib/jarvis/openapi-types.ts
```

## Compatibility work before the final cut

Coordinate source reconciliation with the orchestrator. Keep the current dirty integration cut and every peer tree intact. Do not perform a blanket checkout, reset or whole-file donor overwrite.

1. Preserve every main-side source change relative to the actual merge base, including main-only queue, job-heartbeat, execution-deadline, workflow-runtime and worker-handler changes, dependency locks/vendor inputs, Y5 typed owners/UI and correctness repairs.
2. Reconcile the 39 two-sided paths semantically. Keep W1–W5 registration and contracts alongside upstream behavior. Audit the newer queue/deadline/heartbeat callers against every new native owner rather than assuming source additions compose.
3. Resolve reserved UI/authority/allocation/generation overlaps with their owners. Treat all generated manifests, OpenAPI/types/capability coverage, migration bundle/head, production contract and release inputs as combined-cut generation outputs, not donor postimages.
4. Regenerate once all source and migrations are combined. Preserve the original guard and source-generation ordering. A newly tracked release marker and all CI policy files must be present in the final actual Git HEAD, not only in the worktree.
5. Run the appropriate authorized semantic/native/mounted/installed and release-policy checks on that exact reconciled cut. Existing peer evidence and this comparison do not qualify it.

To reconstruct the inventory, compare `git diff --name-only df9111da8c7a1170f1f074e43fdf5984eaa55b8b` separately to each pinned commit. Their path-set intersection gives the 39 two-sided paths. The current dirty-path intersection is a point-in-time snapshot and must be recomputed if source changes.

## Resolved intermediate contracts

- The 39 two-sided paths produced 23 textual conflicts. Each source hunk preserves both owners' behavior. The other source overlaps were inspected against the checkpoint; generated overlaps received structural/path-set checks only.
- API configuration retains main's two-CPU setting, the W2 package-import optimization, the development-aware webpack callback and the original source-custody rules.
- Worker registration retains W1/W2/W3/W4 and upstream Y5. Compute-search retains W1's controller bound alongside main's original-delivery monotone database deadline and the shortest actual acquired-lease heartbeat duration.
- The physical queue retains main's serialized heartbeat loop, expired-lease refusal, captured physical async scope, awaited heartbeat shutdown and live completion fence. Its frozen execution context additionally exposes the actual configured `leaseSeconds`. W2 passes that exact duration to its existing physical-job guard through `registerHeartbeat(callback, { leaseSeconds })`; the required lease descriptor and returned disposer are unchanged.
- S1's `loadEnterpriseBeliefView` accepts either the existing captured `PoolClient` or main's `{ omitAuxiliaryTasks: true }` as the third argument. Both reach the same world-state reader, preserving transaction-client custody and historical source-visibility behavior. Owner context retains both material-cut locking and deadline-error propagation.
- S4's current-policy batch retains its captured optional client and shared immutable dependency reads with current checks. S5 also retains main's separate bounded historical source-reader batch, current source authorization, resource-read authorization and portfolio transaction. Historical readback does not become current-use approval.
- Capability/OpenAPI generators and typed UI retain W and Y5 additions. Dependency locks and every one-sided source postimage are preserved. Release command aliases from main remain available; the stricter read-only release-input chain still checks the API source-stamping stages and planner replay rather than mutating inputs during preflight.
- The exact migration whitelist includes Y7 and all accepted W names. The 254 retained bundled SQL bodies are byte-exact, unique and canonically ordered. W4's `0200_postz_w4_demand_to_business.sql` is deliberately not newly generated into the intermediate bundle. The scalar head is the actual currently retained lexical maximum, `postz_w2_zz_participant_legacy_authority.sql`. Final bundle/head, canary/deployment pins and every source/OpenAPI/capability identity must be regenerated together after the remaining source lands.
- The separately reviewed W4 broker source-closure repair has exact postimage SHA-256 `33c65d17fd5d979d3e615a464eca98c8e2b68289e8030d0fde48c626a1e5a8df`. It only appends the eight demand-to-business source paths to the existing protected source array.
- The existing W3 qualification workflow is explicitly included in the `READ_ONLY` workflow inventory. The original seven active production writers, shared lock and mutation guard remain unchanged. The unrepaired all-W CI transfer has not been applied.

## Bounded validation and remaining work

Actual checks passed: 185 nonexception main-only postimages and 603 nonexception checkpoint-only postimages; seven JSON parse/duplicate-key checks; the complete path-set union in six conflicted generated manifests; all 254 retained SQL bodies and their order; five JavaScript syntax checks; `git diff --check`; production-mutation inventory (22 mechanisms, original seven active mutators); and all 13 existing release-policy cases.

The first postimage audit correctly rejected 33 missing sparse-checkout files: 31 newly tracked Y5 contract documents and the new locked minimatch archive/license. After verifying that each was absent and newly tracked only upstream, those exact pinned Git blobs were materialized and rehashed. No existing source was overwritten and sparse configuration was not changed. The first inventory check correctly refused the unclassified W3 qualification workflow; its explicit classification repaired that failure.

All conflicted generated hashes/counts are provisional branch metadata, not combined-cut identities. No final generation was run. Do not use this intermediate cut for a native, installed or release qualification until the final source and identities are complete. Scoped type diagnostics, owner review of the shared merge hunks, the protected-source changes, W4 UI changes, W5 source/privacy/continuation work, repaired all-W CI and full combined qualification remain open.

Migration ordinals 0201, 0202 and 0203 were absent in both pinned main and the intermediate migration population. Reserve 0201 for the frozen W5 source unchanged, 0202 for the protected W2 specialist if needed, and additive `0203_postz_w5_approver_continuation.sql` for the subsequent W5 cut. The frozen W5 source transfer is static evidence only; its reported native-read privacy gaps are not a privacy pass.
