# Z3 / ViabilityStrategy — Engineering Handoff (second, post-qualification round)

Lane: `factory/project-z3-viability` on `/home/factory-user/repos/finnor-z3`,
base `9f3edfd3b4c6758832c53139da0773218062191e`.
Commits: `11a90a3` (implementation) → `be2c775` (patch/evidence closure) →
`1a4ba45` (disposable DDL validation) → `3ed1a13`/`a019f32` (supervisor
verification batches 2–5 + 93-file freeze) → HEAD (freeze integrity restored +
this handoff). All LLM work gpt-6.1-sol/max. Coordinator remains the only
acceptance authority; the coordinator gate has NOT been written.

## A. IMPLEMENTED (unchanged since first handoff unless noted)

1. Bounded viability producer + checker — `finnor-os/packages/epistemic-runtime/src/project-z/z3-viability/{contracts,producer}.ts`, `checker.py`. 256-state/8-outgoing/2-assumption/2-goal/4-memory/1024-product GR(1) profile; 1 MiB input / 8 MiB artifact caps; bigint-mask safety kernel + ordinary-parity cross-check; Python stdlib-only checker; canonical digests exclude `metrics` (third-party probe: metrics-only mutation does not change any semantic digest).
2. Replay CLI — `finnor-os/scripts/project-z/z3/cli.mts` → committed bundle `scope-z/phase-evidence/z3/build/cli.mjs` (sha256 `43a3d180cf01602ccacfc01147d934a5f3a5a437f5767eccb1a1ce933bdaa4d7`).
3. Native leaves — `finnor-os/packages/private-equity/src/project-z/z3-viability/{contracts,store,worker,api}.ts` (supervisor-hardened worker retained verbatim): dual job types, adopt-fence CAS, 30 s lease floor, one-line-JSON children, SIGKILL + digest re-verification resume, disposable recovery boundary, D1-shaped reads with the 10-gate envelope and `executionAuthorityGranted:false`, S7 metering through `persistEconomicRecordTx` (`finnor.z3.viability-compute.v1`, H0 UNMETERED, money null, s4 only when VIABLE).
4. Worker entry — `finnor-os/scripts/project-z/z3/worker-entry.mts` (sha256 `52fb2b94a7be24e708920483927a2c4dfd0c52b539235a13a09adfec3d2694c3`): only the two Z3 job types, loopback/dev/staging only, refuses AUTH_DEV_BYPASS, runs with the repo's tsx per production worker convention. An esbuild static-bundle alternative was implemented, evaluated, and REJECTED on evidence (shared-platform `economic-attribution.ts` digests its own sources at module load; bundling breaks it) — attempt retained as evidence.
5. Nine preimage-bound coordinator patches under `integration-patches/` (manifest `finnor.z3.integration-patches.v1` is authoritative), covering migration file + bundle-whitelist + regenerated checked-in `migrations-bundle.ts` + migration head, two `compute_job_type_policies` rows, worker registration, company-brain dispatch arm, mounted Work record + panel payload. Verified: `git apply --check` against the live tree, GNU-patch application in an isolated scratch tree reproducing every recorded postimage blob, patched-scratch bundle regeneration byte-identical to the committed bundle. API registration surface verified complete: the route dispatches on the raw path segment through per-lane OPERATIONS lists — no additional whitelist exists.

## B. CHANGED vs base 9f3edfd

- Owned adds only: 4 native leaves, 3 runtime files, worker entry, 19 scripts,
  ~47 committed evidence files/dirs, `ViabilityPanel.tsx` and the other eight
  patch payloads. Zero edits to shared or foreign source files in the lane
  commits; shared-file changes exist ONLY as preimage-bound patches.
- Environment repair (not product code): SONAME symlinks added under
  `finnor-os/node_modules/@embedded-postgres/linux-x64/native/lib/` because the
  locked `--ignore-scripts` install skips the postinstall that creates them;
  without them `libpq.so.5` is unloadable and no disposable PostgreSQL can start.
  Mirrored as `build/pg-libs/` symlinks by the supervisor.

## C. EVIDENCE (all PASS at HEAD unless marked)

- Digest freeze: `native-freeze-v2.sha256`, 93 files, `tail -n +11 … | sha256sum -c -` from repo root → all OK. Frozen at supervisor head `3ed1a13`; verified again after the HEAD handoff commit (the only drift was this lane's own reconstruction.md edit, restored byte-identical).
- Source sweep: 3,892 recorded cases (256 frozen + 3,636 generated), zero checker failures; frozenDigest `75434db94e19e24098d199b8c9eb0e7ec5ea102792ad2845f401ad07229a122b`. Supervised independently: full re-sweep PASS at `03-independent-reverification/`.
- Independence probe: checker AST = stdlib-only {hashlib,json,sys,time}, zero coupling tokens, bundle never references checker; forged arena/binding digests → REJECTED at the digest stage (`Z3_CHECK_ORIGINAL_OR_CURRENTNESS_BINDING`); 3,892/3,892 three-way digest agreement (producer/checker/probe). Supervised independently: PASS at be2c775 (`03b`), PASS with pinned toolchain (`03c`).
- Typechecks (final tree, retained logs): backend `post-code-backend-typecheck-4.log` exit 0; staged entry exit 0 (both harness variants); staged panel exit 0; baseline native leaves exit 0. Post-apply (supervisor batch-5 + writer `build/mount-check.mjs`): patched backend exit 0, patched worker entry exit 0, patched frontend with next-env.d.ts in program exit 0 twice (supervisor worktree + writer full-src mirror), unpatched baseline control exit 0. Batch-4 frontend failure was a staged-config gap (missing `next-env.d.ts`), root-caused and closed.
- Migration DDL (`runs/04-migration-ddl/report.json`, writer validator + disposable embedded PostgreSQL 18, tmpdir deleted): 26/26 PASS — payload applies; progress/fence/generation guards; candidate+preimage immutability; terminal irreversibility; finnor_app-role insert/update under RLS succeeds (REVOKE does not block legitimate DML); cross-tenant invisible + insert refused; requests/events/artifacts append-only; both policy rows; REVOKE confirmed via `information_schema.routine_privileges`. Retained failure chain: supervisor attempt-1 (node-pg multi-statement seed crash after a clean apply), writer attempt-1 (pre-terminal ordering bug), writer attempt-2 (`'PUBLIC'` keyword bug), then PASS. Supervisor independently confirmed the renamed payload digest (`independent-verify-migration-2.log`).
- Historical failure evidence retained verbatim: checker V3 ancestry gap, tsx entry in production-app mismatch, first worker draft, entry-check OOM at 1536 MiB, post-code typecheck failures 1–2, supervisor migration attempt ENOENT (pre-rename), validator attempts above, mount-check harness attempts (typeRoots, relative-import resolution — session logs).

## D. COMPLETION GATE (unchanged)

Engineering closure only. Source and installed native qualification require the
migration + patches applied in the target environment and the guarded native
E2E with SIGKILL recovery proofs; mounted Work requires the patched console;
protected and financial qualification remain separately authorized gates. All
are coordinator/user authority — see F.

## E. REMAINING LIMITATIONS

1. Staging deployment: no organization has `viability_strategy_v1` until the coordinator applies the two policy rows.
2. Native E2E never ran: no disposable-DB/test-owner authorization exists on this Computer; the deliverable authorization JSON (`finnor.z3.existing-disposable-authorization.v1`) is specified verbatim in `integration-patches/README.md` § Authorization contract.
3. Independent installed reconstruction comparator: unwritten by design until a deployment exists to compare against; `reconstruction.md` carries the full recipe.
4. `fs-ext` builds but cannot load in this container (kernel lacks `statx`) — N-API variant inert in the tested processes; pure-JS paths verified; must be re-qualified on the deployment host.
5. Production rollout ordering (migration head vs worker deploy) is the coordinator's release process; two-sided compatibility is documented in the patch README.
6. esbuild-bundled worker entry was rejected on evidence; runtime is repo tsx from the finnor-os cwd.

## F. FRONTIER DELTA this round

Migration-runtime closure completed and validated (file + whitelist + checked-in
bundle + head), disposable-PostgreSQL DDL proof with full RLS/grant/trigger
matrix, libpq environment root cause fixed and mirrored, independence probes
extended and independently re-run (pinned toolchain), post-apply typechecks
closed on all three legs including the frontend CSS-module false failure,
93-file digest freeze by the supervisor. Attempt-1 0199 draft superseded by
`postz_z3_viability.sql` (payload sha256 `9f4234029d0c01aea276f88a9c909e49d984dc5ab8227f12cd392c67e189b265`).

## G. NEXT DEPENDENCIES (external authority)

1. Coordinator: apply the nine patches + migration in the staging environment (order per README).
2. Coordinator/user: deliver the `finnor.z3.existing-disposable-authorization.v1` JSON (schema + fields in README § Authorization contract; env TEST_OWNER_EMAIL/TEST_OWNER_PASSWORD, FINNOR_ENVIRONMENT=staging).
3. Then in this lane: guarded `scripts/project-z/z3/native-e2e.mjs` (sha256 `3bc6bf7d2b62c0a03a9a367aa203861592ca130370f7a20c22a35bd00a85150c`) source/installed/mounted + three SIGKILL recovery proofs; independent reconstruction comparator per `reconstruction.md`.
4. User/coordinator: protected qualification and financial qualification after a green native E2E. This lane never asks for protected custody or protected-material movement.

Nothing further is executable inside this lane's authority. Awaiting the
coordinator's engineering acceptance or corrective feedback.
