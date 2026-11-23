# POSTX.Y3 engineering handoff

## State

The bounded implementation is present. **Final runtime verification is not
complete.** After disk space fell to about 1.1 GB, the user chose:
“Keep databases; stop disk-heavy verification.”
No more databases were deleted after that decision. No final API rebuild,
mounted browser campaign, fresh dependency installation or clean reconstruction
was run. Do not turn the earlier source diagnostic into installed evidence.
The inherited disposable fixture automatically removed earlier scratch databases
on close; the old `source-owner-5` database was observed absent. This predates
the keep decision. Y3 now explicitly requests persistent fixture storage and a
checked retention receipt for any future authorized campaign. Historical STOPPED
receipts alone do not establish that database bytes were retained.

The exact POST-X PRD, approved S lock, reviewed blueprint, full original R1 and
original boundary-verification skill remain unavailable. Source parity is
**UNKNOWN**, as authorized by the user. `PLAN.md`, `profile.json`,
`failure-model.md` and `verification-plan.json` preserve the pre-implementation
design and finite oracles; this engineering snapshot does not replace them.

The final local commit/tree, source-packet status, emitted worker identity,
low-disk check results and retained evidence hashes are recorded in the ignored
`handoff/release.json`. Its incomplete-seal mode cannot award verified status.
Future evidence may supersede this historical snapshot only through a new seal
that matches the complete committed source preimages.

## Parallel Y4 boundary

Y4 remains active in `/home/factory-user/repos/finnor-postx-y4`. Its files were
inspected read-only, not copied, edited, committed or merged by Y3.
`parallel-integration.json` records the nine shared modified paths, distinct
API/job/migration namespaces and the combined regeneration/verification order.
Both panels and all three Y1/Y3/Y4 dispatch families must survive integration.
This is not evidence that the unfinished combined tree works.

The main checkout was observed at `ed32d200a9459269509f1e40d4e13a3e2a1a4d6a`,
whose tree differs substantially from the pinned starting X cut. Y3 retains
its immutable starting cut plus the pinned Y1 merge. Neither the moving main
tree nor unfinished Y4 work was silently adopted. No production state is
inferred from that local checkout observation.

Shared root storage later fell to about 145 MB free. No peer files or databases
were removed. A source packet may therefore be placed in task-owned `/dev/shm`
space rather than consuming the remaining root space. Such a packet is
**volatile**; its exact location is in the seal. The committed Git source and
persistent custody metadata remain the authority for regenerating it.

## Implemented boundary

* Original finite specifications and supplied actor-model claims enter through
  authenticated S1/Work owners. Runtime chooses disclosure, communication,
  commitment timing and contingent behavior, never caller-supplied strategies.
* Fresh original-byte Python checking proves exact full-continuation regret,
  lawful information and recall, all-history resource/financial constraints,
  and one common completely mixed belief limit per supplied model.
* Native S4 deliveries, physical compute leases, durable episodes/checkpoints,
  immutable artifacts and P7 currentness retain original allocations and costs.
* A separate S8 `INTERACTION_PROTOCOL` development port grants neither protected
  qualification nor effect authority.
* S4 publishes exact terms. Both authenticated principals consent to those
  terms, then separately to the exact derived internal effect. Histories and
  observations are participant-local; a caller cannot select a hidden node.
* Fixed P1/Y1 meanings lower through existing S5 reservations and S6 effects.
  Original Y1 entrypoints enforce the same current Y3 bindings and consent
  heads. Separate S7 canonical observation establishes only the internal result.
* WORLD Work mounts the controls with user/Work/root/token/epoch fences,
  original-request replay, offline/logout/focus handling and private projections.

The only effect adapter is a **disposable internal reservation-right
transition**. It is not a payment, liability engine, settlement, financial
ledger or field-value result. Canonical supplied observation claims remain
development premises, not empirical identification.

## Evidence snapshot

Evidence is under `/home/factory-user/y3-delivery`:

| Evidence | Actual result |
| --- | --- |
| `math-2026-10-21T01-32-05-360Z/report.json` | 20/20 mathematical cases passed; source/math closure is checked again when sealing |
| `source-owner-5/report.json` | Overall FAIL, 14/15 cases passed using source HTTP transport and the emitted native worker |
| `installed-1/report.json` | Failed earlier runtime-pin mismatch; retained, not a completed installed campaign |
| `api-build-2.log` | Earlier API build passed, but predates final fixes and is not the final runtime |
| `api-build-1.log` | Earlier build exited 137; retained |
| `low-disk-validation.json` | Authoritative final permitted static/type/lint results |
| `older-x-cleanup.json` | Earlier explicitly authorized deletion of eight inactive X scratch clusters, not source/reports |

The source diagnostic passed original-input synthesis, restricted roles/RLS,
participant isolation, exact terms revisions and consent heads, resource
contention, local observations/actions, native bypass refusal, a real internal
effect with separate S7 readback, checker/worker/owner death, original-effect
reconciliation, source invalidation and immutable counters. Its last case
stopped on the fixture's unsupported `users.status='disabled'` before the
revocation assertions. The fixture now uses the canonical `suspended` value.
That correction and the final review repairs have **not** received a fresh E2E
run.

Independent read-only review covered mathematics, owner/authority/recovery and
mounted integration. Mathematics had no findings. Verified repair sites and
the still-unrun regression cases are recorded in `review.md`.

## Limits and separate gates

The first profile has two parties, binary private-state values, three dates,
perfect recall and at most 16 information sets per party. It bounds original
nodes, protocol alternatives, arithmetic, search, processes, attempts, history,
retained bytes and episode time.

The producer searches the declared rational behavior grid `{0, 1/2, 1}`.
Deviations are unrestricted by that grid. The checker accepts valid nonunit
common-limit witnesses, but general nonunit, non-grid and algebraic synthesis
are not complete. Search exhaustion is INCOMPLETE/UNKNOWN, not infeasibility.
Only an independently checked whole-family goal bound can earn INFEASIBLE.

DESIGNED, CODE_COMPLETE, E2E_DEV_VERIFIED, DOMAIN_QUALIFIED and
PRODUCTION_ACTIVE remain separate. Final CODE_COMPLETE confirmation and
E2E_DEV_VERIFIED are not claimed by this handoff. The protected 24-game gate
(15/16 feasible successes and all eight infeasibility proofs), qualified
equipped baselines, operational/financial 100x and H0/H1/H2 are not established.
Money, human time and aggregate concurrent peak memory remain unknown.
No push, PR, deployment, protected grant, contact or real economic effect
occurred.

## Low-disk commands

Use Node 22 and the pinned `/usr/bin/python3`. Run backend commands from
`/home/factory-user/repos/finnor-postx-y3/finnor-os`, frontend commands from the
repository root. No dependency or lockfile changes are required.

```sh
cd /home/factory-user/repos/finnor-postx-y3/finnor-os
npm run db:bundle
npm run openapi
node --import=tsx scripts/x3/stamp-source.mts
node --import=tsx scripts/x5/stamp-source.mts
node --import=tsx scripts/x4/stamp-source.mts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p scripts/y3/tsconfig.json
npm run release:pe-domain-boundary
npm run release:manifest

cd /home/factory-user/repos/finnor-postx-y3
npm run centropy:client:check
npm run centropy:manifest:check
npm run centropy:forms:check
npm run centropy:coverage:check
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/eslint/bin/eslint.js src/components/centropy/canvas/InteractionProtocolPanel.tsx src/components/centropy/world/WorldWorkRecord.tsx
git diff --check
```

`build-runtime.mts` emits a small task-owned ESM bundle and source preimages,
not an installed proof. Regenerate source stamps before committing, then build
the worker after the final clean commit so its custody receipt matches.

## Resume disk-heavy verification only with permission and space

The commands below are **not authorization to run them under the current
storage stop**. Use new absolute evidence directories; retain every failed
run. Do not recycle peer dependencies, source, database clusters or artifacts.

1. Complete canonical generation and low-disk checks. Commit the source/stamps.
2. Build the final API and worker from that clean cut:

   ```sh
   cd /home/factory-user/repos/finnor-postx-y3/finnor-os
   FINNOR_Y3_ALLOW_DISK_HEAVY_VERIFICATION=1 node --import=tsx scripts/y3/build-api.mts
   node --import=tsx scripts/y3/build-runtime.mts
   FINNOR_Y3_BUILT_API=1 FINNOR_Y3_EVIDENCE_DIR=/absolute/new/installed node --import=tsx scripts/y3/run-installed.mts
   ```

   The 17-case owner campaign requires the actual built API receipt, current
   complete source preimages and actual emitted worker. It includes the final
   source-head race, exhausted prequeued allocation and production refusal.
   A bare old `.next` directory cannot satisfy the receipt guard.
3. In one terminal, run `scripts/y3/run-mounted.mts` with an explicit
   `FINNOR_Y3_EVIDENCE_DIR=/absolute/new/mounted`. After
   `Y3_MOUNTED_FIXTURE_READY`, run `scripts/y3/browser-checks.mts` in another
   terminal with the same directory. It performs real signed login, scoped
   accessibility audit, actual owner requests, delayed replies, automatic
   token refresh, focus/offline/logout/Work switches, both principals' consents,
   native effect and S7 readback. Success stops the task-owned fixture. A
   stopped fixture without `browser-results.json` is not browser proof.
4. Produce and reconstruct the complete source packet:

   ```sh
   node scripts/y3/package-source.mjs /absolute/new/source-packet
   node scripts/y3/reconstruct-source.mjs /absolute/new/source-packet /absolute/new/checkout /absolute/new/source-reconstruction.json
   ```

   From the reconstructed checkout's `finnor-os` directory:

   ```sh
   FINNOR_Y3_ALLOW_DISK_HEAVY_VERIFICATION=1 \
   FINNOR_Y3_SOURCE_PACKET=/absolute/new/source-packet \
   FINNOR_Y3_RECONSTRUCTION_EVIDENCE=/absolute/new/reconstruction \
   FINNOR_Y3_TMPDIR=/absolute/new/reconstruction-tmp \
   node scripts/y3/run-reconstruction.mjs
   ```

   This uses fresh offline lockfile installs, rebuilds locked native
   dependencies, regenerates/checks owners/contracts, builds API/worker/frontend,
   and reruns exact mathematics and the compiled owner path. It has no donor Git
   alternates or borrowed dependency/build trees. It retains its databases.
   Reconstructed frontend evidence is a build, not a second browser campaign.
5. Seal with `scripts/y3/seal-local.mts`. Supply absolute
   `FINNOR_Y3_DELIVERY_ROOT`, `FINNOR_Y3_MATH_REPORT`,
   `FINNOR_Y3_VALIDATION_REPORT`, and optionally `FINNOR_Y3_SOURCE_PACKET`.
   A verified seal additionally requires `FINNOR_Y3_INSTALLED_EVIDENCE`,
   `FINNOR_Y3_BROWSER_EVIDENCE` and `FINNOR_Y3_RECONSTRUCTION_EVIDENCE`.
   Only `FINNOR_Y3_ALLOW_INCOMPLETE_SEAL=1` permits the current explicitly
   unverified handoff. Neither mode grants qualification or publication.
