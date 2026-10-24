# Z3 ViabilityStrategy — coordinator integration patch set

All identities below are bound to base commit `9f3edfd3b4c6758832c53139da0773218062191e`
(tree `2dc4d5bc13d22853cf4dc9feb5f6ac7fbf6bb9c9`). Nothing in this directory has been
applied to the shared tree; application is coordinator-only.

## Patches (apply in order)

`manifest.json` (`finnor.z3.integration-patches.v1`) is authoritative. Every patch was
verified two ways at generation time: `git apply --check` against the real object store
(resolves and binds the preimage blob), and actual GNU-patch application in a scratch tree
whose result hashes to the recorded postimage blob. Generator:
`scope-z/phase-evidence/z3/build/generate-integration-patches.mjs` (kept for reproduction;
re-running re-verifies).

| # | patch | target | sha256 (see manifest.json) |
|---|-------|--------|------------------------------|
| 1 | 0001-migration-0199-z3-viability.patch | + finnor-os/packages/db/migrations/0199_z3_viability.sql | dc11ef6c4000a3a84b22d9e3148a771bd5d4e4522e89a904002bfb2aca0bf6db |
| 2 | 0002-compute-contract.patch | finnor-os/packages/db/compute-contract.ts | 419a894e719840f4d2a4bbb64c480924004350a66261ed37d018a88f6e90fbfd |
| 3 | 0003-worker-register.patch | finnor-os/apps/worker/src/index.ts | 7154da53325f6c6b831bd38f674f913905ffed80e843e3d048113e63dfe40a18 |
| 4 | 0004-company-brain-route.patch | finnor-os/apps/api/app/api/company-brain/[operation]/route.ts | 30b512139cefe200fc21cfd8731c8f756cb55381ce0823cd15e7733e23cf1f30 |
| 5 | 0005-mounted-work-panel.patch | src/components/centropy/world/WorldWorkRecord.tsx | e43da3c5de8fc69d47eb9e1878f5eeaedcdc1745c13069c37b72f497982161c3 |
| 6 | 0005b-viability-panel-file.patch | + src/components/centropy/world/ViabilityPanel.tsx | 5204d21d3b76c42a2dcd8a7219a18ba82f621a90dcee32efc0b27ef6908aced4 |

Raw payloads also stand beside the patches: `0199_z3_viability.sql`
sha256 `2caf73c23eacba002a629ab4c6f73c31e54f92bb10a1f8741c3851ed90239e76`,
`ViabilityPanel.tsx` sha256 `be45e0a6f4338ba313ffadcd8c3dd85884b9494372bc435d857d32dc850c9f14`.

- 0001 creates the four Z3 tables (sessions, requests, events, artifacts), the
  `z3_session_progress` trigger (preimage immutability, claim-fence monotonicity,
  immutable candidate/check publication, terminal-status irreversibility), RLS + grants,
  `s5_immutable_record()` triggers on requests/events/artifacts, and the two
  `compute_job_type_policies` rows. SQL application against a database was NOT run in this
  lane (no DB authority); syntax follows migration 0196 conventions and the trigger
  functions existing at 0150.
- 0002/0003/0004 wire the two job types (`run_z3_viability_synthesis_v1`,
  `run_z3_viability_recovery_v1`, both INTERACTIVE + reconcilable) into the production
  registry, worker registration, and the company-brain dispatch.
- 0005/0005b mount the client panel into WorldWorkRecord below InteractionProtocolPanel.

## Proof-worker runtime contract

- Entry: `finnor-os/scripts/project-z/z3/worker-entry.mts`
  sha256 `52fb2b94a7be24e708920483927a2c4dfd0c52b539235a13a09adfec3d2694c3`.
- Run it through the repo's own tsx runtime from the finnor-os root — the same way the
  production worker app runs (`tsx src/index.ts`). The harness
  `scripts/project-z/z3/native-e2e.mjs` sha256 `3bc6bf7d866df8d7aa47296b60587b562e035a91eb9bf45ef87e623148c68d0b`
  already spawns it as `finnor-os/node_modules/.bin/tsx <worker-entry.mts>` with
  `cwd=<repository>/finnor-os`.
- Single-file esbuild bundling was implemented and then REJECTED (script removed):
  `packages/epistemic-runtime/src/economic-attribution.ts` digests its own source files
  through `import.meta.url` at module load; under a bundle those paths resolve to
  nonexistent files (ENOENT) and the platform's source self-binding would be broken. tsx
  preserves real file paths.
- The entry registers ONLY the two Z3 job types, requires `NODE_ENV` development +
  `FINNOR_ENVIRONMENT=staging`, refuses `AUTH_DEV_BYPASS`, sets
  `WORKER_JOB_LEASE_SECONDS=30` when unset, and aborts on SIGTERM/SIGINT.
- Required pins (the worker refuses to run otherwise):
  - `FINNOR_Z3_PRODUCER_BUNDLE` — absolute path of the producer bundle whose sha256 equals
    `43a3d180cf01602ccacfc01147d934a5f3a5a437f5767eccb1a1ce933bdaa4d7`
    (`scope-z/phase-evidence/z3/build/cli.mjs`, built from
    `finnor-os/scripts/project-z/z3/cli.mts` sha256 `9d4acd16ced00ebfb4240d119d7785e008aa568eb7eb18fb54354886974251db`;
    rebuild: `cd finnor-os && node_modules/.bin/esbuild scripts/project-z/z3/cli.mts --bundle --platform=node --format=esm --outfile=<out>`).
  - `FINNOR_Z3_CHECKER_SOURCE` — absolute path of the checker whose sha256 equals
    `b71c0bec3be5eb1e6218e4b04a26bf07918a3f781e5712800a8ff061497e837e`
    (`finnor-os/packages/epistemic-runtime/src/project-z/z3-viability/checker.py`, stdlib-only).
  - `FINNOR_Z3_PYTHON` — optional, defaults to `python3`.
- Disposable-proof env (set by the harness, not by hand): `FINNOR_Z3_DISPOSABLE_RECOVERY=1`,
  `FINNOR_Z3_FAULT_POINT` in {CLAIM, STRATEGY, OBSERVATION},
  `FINNOR_Z3_AUTHORIZED_SOURCE` = current private-equity `codeIdentity().digest`.
- Environment note: this lane's node_modules were installed with `--ignore-scripts`, so a
  purely local import smoke stops at the `fs-ext` native binding
  (`packages/private-equity/src/decision-slice/store.ts`). The production worker app loads
  the same module, so a staging tree installed with a normal `npm ci` has the binding. Z3
  introduces no new native-module requirement.

## Authorization contract (coordinator supplies at proof time)

`scripts/project-z/z3/native-e2e.mjs --authorization <abs path>` requires a JSON file with
schema `finnor.z3.existing-disposable-authorization.v1` and: `coordinatorAuthorized:true`,
`provisioningAllowed:false`, `effectsAllowed:false`, `workerTerminationAllowed:true`,
`listenersAlreadyOwned:true`, `cases` — exactly 3 (CLAIM, STRATEGY, OBSERVATION) each with
`workId`, `sessionId`, `root`, `sourceDigest` — plus absolute `workerEntry`,
`producerBundle`, `checkerSource`, `repository`, loopback `frontend` URL, and
`sourceDigest`. Environment must also provide real disposable-owner `TEST_OWNER_EMAIL` /
`TEST_OWNER_PASSWORD`, `FINNOR_ENVIRONMENT=staging`, no `AUTH_DEV_BYPASS`.

## Verification already green in this lane

- Workspace typecheck (`npm run typecheck`, heap 4096 under shared lock): exit 0,
  `post-code-backend-typecheck-3.log`.
- Staged panel typecheck (root tsconfig extended, panel bytes at their future import path):
  exit 0, `build/ui-check/typecheck.log`.
- Math freeze sweep incl. hardening probes: exit 0, `source-sweep-02.log`,
  `runs/02-checker-hardening/report.json` (failures: []), 3892 requests.
- Patch dual-verification: see `manifest.json` (all `appliedAndVerified: true`).

## Remaining blockers (coordinator-owned)

1. Apply 0001..0005b in the staging tree and migrate the disposable database.
2. Deliver the authorization JSON; then the guarded native E2E (source, installed,
   and three physical kill proofs) can run unmodified.
3. Protected admission (S6) and financial qualification stay coordinator/user authority;
   the read envelope keeps `executionAuthorityGranted:false` and unknown costs are never
   reported as zero.
