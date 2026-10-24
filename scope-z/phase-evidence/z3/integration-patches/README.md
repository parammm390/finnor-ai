# Z3 ViabilityStrategy — coordinator integration patch set

All identities below are bound to base commit `9f3edfd3b4c6758832c53139da0773218062191e`
(tree `2dc4d5bc13d22853cf4dc9feb5f6ac7fbf6bb9c9`). Nothing in this directory has been
applied to the shared tree; application is coordinator-only.

`manifest.json` (`finnor.z3.integration-patches.v1`) is authoritative. Generator:
`../build/generate-integration-patches.mjs` (re-running reproduces and re-verifies
everything below).

## Patches (apply in order)

| # | patch | target | sha256 |
|---|-------|--------|--------|
| 1 | 0001-postz-z3-migration.patch | + finnor-os/packages/db/migrations/postz_z3_viability.sql | d1f7b746399ae7afb3c2c93227298fe0bd56d9c52a0a9f9d47b8f53e3d7fd1ae |
| 2 | 0001b-bundle-generator-whitelist.patch | finnor-os/scripts/bundle-migrations.ts | eafbb4a000b0acc8485c8673ea2930b0e31f339bdc517cf578262f2e141cf371 |
| 3 | 0001c-migrations-bundle.patch | finnor-os/packages/db/migrations-bundle.ts | 6b3ed6993775014e2b5a94102839e9bd5f49f21da50f568f1e3b4b190c8b1dba |
| 4 | 0001d-migration-head.patch | finnor-os/packages/db/migration-head.ts | 88e5e3cb9388dbe77a3f4eb18126749c3f7a70bc0f28060538ba4e28d67c9b74 |
| 5 | 0002-compute-contract.patch | finnor-os/packages/db/compute-contract.ts | 419a894e719840f4d2a4bbb64c480924004350a66261ed37d018a88f6e90fbfd |
| 6 | 0003-worker-register.patch | finnor-os/apps/worker/src/index.ts | 7154da53325f6c6b831bd38f674f913905ffed80e843e3d048113e63dfe40a18 |
| 7 | 0004-company-brain-route.patch | finnor-os/apps/api/app/api/company-brain/[operation]/route.ts | 30b512139cefe200fc21cfd8731c8f756cb55381ce0823cd15e7733e23cf1f30 |
| 8 | 0005-mounted-work-panel.patch | src/components/centropy/world/WorldWorkRecord.tsx | e43da3c5de8fc69d47eb9e1878f5eeaedcdc1745c13069c37b72f497982161c3 |
| 9 | 0005b-viability-panel-file.patch | + src/components/centropy/world/ViabilityPanel.tsx | 5204d21d3b76c42a2dcd8a7219a18ba82f621a90dcee32efc0b27ef6908aced4 |

Raw payloads beside the patches: `postz_z3_viability.sql`
sha256 `9f4234029d0c01aea276f88a9c909e49d984dc5ab8227f12cd392c67e189b265`,
`ViabilityPanel.tsx` sha256 `be45e0a6f4338ba313ffadcd8c3dd85884b9494372bc435d857d32dc850c9f14`.

Payload history note: the payload was renamed from an earlier `0199_z3_viability.sql`
draft (delta: two header comment lines + one `REVOKE ALL ON FUNCTION ... FROM PUBLIC`
line, nothing else) to follow the committed `postz_z0_*` naming precedent and to advance
the release migration head. The supervisor's disposable-PostgreSQL validator
`../build/validate-migration-0199.mjs` predates the rename: its output label already
expects `postz_z3_viability.sql`, but its `PAYLOAD` path constant still points at the
old filename (its retained run log shows the resulting ENOENT). Re-point that one line to
`integration-patches/postz_z3_viability.sql` to validate the current bytes; the
`embedded-postgres` dependency is lockfile-pinned (package-lock line 4136).

### Migration-runtime closure (0001, 0001b, 0001c, 0001d are one unit)

Migrations take effect through BOTH the on-disk file and the checked-in
`packages/db/migrations-bundle.ts` (serverless runtimes cannot read the directory), and
the bundle generator `scripts/bundle-migrations.ts` whitelists non-numeric migration
names explicitly. The migration follows the committed Z0-lane naming precedent
(`postz_z0_*`), so it sorts after `postz_z0_institution_application_bridge.sql` by the
canonical bytewise order and becomes the release migration head; 0001d advances
`CURRENT_MIGRATION_HEAD` accordingly (fleet heartbeats then agree at the next release —
that rollout is the coordinator's release process, not part of these patches).

Verification performed at generation time (all recorded in manifest.json):
- the unpatched generator reproduces the committed bundle **byte-identically**
  (determinism baseline);
- every patch passes `git apply --check` against the real object store (preimage blob
  identity resolves) and a scratch GNU-patch application hashing to the recorded
  postimage blob (`appliedAndVerified: true`);
- the fully patched scratch tree regenerates `migrations-bundle.ts` byte-identically to
  the 0001c postimage (patch-set/generator coherence).

SQL content was manually reviewed against the platform conventions and pinned to:
policy form of 0162z/0163 (`tenant_id=finnor_os.request_tenant_id() AND
principal_id=nullif(current_setting('app.user_id',true),'')::uuid` in USING and CHECK),
grant pattern of 0197 (SELECT,INSERT on all four tables; UPDATE only on sessions;
sequence USAGE,SELECT), `s5_immutable_record()` (0150) triggers on the three non-session
tables, a `z3_session_progress` trigger protecting preimage immutability, claim-fence
monotonicity, published candidate/check immutability and terminal-status
irreversibility, `REVOKE ALL ... FROM PUBLIC` on the new trigger function, and the two
`compute_job_type_policies` rows matching the 0138 column/check domains. Applying SQL
against any database was NOT run in this lane (no DB authority).

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

- Workspace typecheck (`npm run typecheck`, heap 4096 under the shared lock): exit 0,
  `../post-code-backend-typecheck-3.log`; re-affirmed at the final tree in
  `../post-code-backend-typecheck-4.log`.
- Staged panel typecheck (root tsconfig extended, panel bytes at their future import
  path): exit 0, `../build/ui-check/typecheck.log`.
- Staged proof-entry typecheck (finnor-os tsconfig extended over worker-entry.mts):
  `../build/entry-check/typecheck.log`.
- Math freeze sweep incl. hardening probes: exit 0, `../source-sweep-02.log`,
  `../runs/02-checker-hardening/report.json` (failures: []), 3892 requests.
- Independence/digest-stage probes: `../runs/03-independence-digest/report.json`
  (PASS at commit `11a90a32f1453a4930ef32f0edf2de7d1a4c4fee`): checker stdlib-only with
  zero producer coupling tokens, producer bundle never references the checker, forged
  arena/binding digests rejected at the digest stage
  (`Z3_CHECK_ORIGINAL_OR_CURRENTNESS_BINDING`), metrics-only mutation leaves acceptance
  and candidateDigest unchanged, and all 3892 retained records show three-way digest
  agreement (producer TS, checker Python, probe Python).

## Remaining blockers (coordinator-owned)

1. Apply 0001..0005b in the staging tree and migrate the disposable database.
2. Deliver the authorization JSON; then the guarded native E2E (source, installed,
   mounted, and the three physical kill proofs) can run unmodified.
3. Protected admission (S6) and financial qualification stay coordinator/user authority;
   the read envelope keeps `executionAuthorityGranted:false` and unknown costs are never
   reported as zero.
