# Deferred owner-bound live packet (capacity-pending)

Frozen before the live run. Free disk was below the registered 1.5 GiB
`liveMinimumFreeBytes`, so no service, migration, owner transaction, installed
adapter call or browser session was started. This packet is the exact downstream
runbook; nothing here is passed evidence.

## Preconditions

1. `statfs` free bytes >= `verification-plan.json` `limits.liveMinimumFreeBytes`
   (1,610,612,736). Retain this packet and all offline failures unchanged.
2. Apply the ordered existing migration bundle through
   `0173_x1_institution_s5_reservations.sql` (0172 source authority precedes
   it; 175 files bundled). Expected source relations: `x1_source_grants`,
   `x1_source_acquisitions`, `x1_work_mandates`, `x1_subject_identity_bindings`,
   `x1_subject_consents`, `x1_mapping_admissions`, all with forced tenant RLS.
   `finnor_app` holds no raw `INSERT` on the two immutable receipt tables; the
   driver writes receipts only through the `SECURITY DEFINER` owner functions
   `x1_record_source_acquisition` and `x1_publish_mapping_admission`, which
   re-derive tenant/principal from the request GUCs and cross-check the
   referenced grant/document/Work.
   Migration 0173 extends the existing S5 `s5_proposals` grammar with a
   discriminated institution demand (no numeric certificate), and stores typed
   origin/projection/consumption/state/charge in `s5_reservation_origins`,
   `s5_reservations`, `s5_consumptions`, `s5_consumption_states` and
   `s5_governed_resource_charges`. No `s5_institution_*` parallel table exists.
   Apply only from a fresh 0172 head, 0173 was unapplied at authoring.
   The application role can invoke `s5_reserve_institution`,
   `s5_consume_institution`, `s5_release_untouched_institution`, and tenant-wide
   aggregate `s5_institution_occupancy`; the typed lifecycle guard rejects
   direct app writes. RLS hides another principal's typed preimage/projection.
   Verify native finite reservations and institution reservations contend on
   the same registered resource under the S5 portfolio serializer.
3. One existing tenant, active user (principal) and Work row created by that
   principal; an `authority_states` row for the tenant.

## Seed (restricted owner authority, never the X1 caller)

- `x1_work_mandates`: one current row (work, principal, institution, rules
  from the frozen profile case, valid window covering now).
- `x1_source_grants` core_export rows for the native corpus classes, each
  naming a real Core `documents`/`document_versions` pair whose bytes hash to
  `original_sha256`, with `expected_object_ids` exactly covering the decoded
  object set. A newer `(source_id, version)` row must supersede an older one.
- Sensitive classes (`personnel_benefits`, `expense_administration`):
  `x1_subject_identity_bindings` per source registration ID (EvidenceVersion
  passes `assert_pe_twin_evidence`) and `x1_subject_consents` inserted only
  through `grantInstitutionSubjectConsent` as the bound subject.
- installed_adapter row: `provider=microsoft_graph`, real
  `integration_source_scopes` entry (`outlook_mail_folder`, enabled, current
  `mailboxId`/`folderId`), `external_id` = immutable message ID, `revision` =
  current `changeKey`, `original_sha256` = SHA-256 of the exact `$value` MIME
  bytes, and an active `resolveMicrosoftProviderAuthContext` chain whose
  consented permissions cover the scope's `required_permissions`.

## Positive cases (expected receipts)

1. Core-export CRM fund/vehicle source through
   `reconstructAndAdmitInstitutionSources(ctx, workId, grantIds, profile)`:
   `ACCEPTED_DEVELOPMENT` check; one `x1_mapping_admissions` row; canonical
   `pe_funds`/`pe_vehicles` rows with deterministic IDs and `source_system`
   `x1:<institution>`; `pe_fund_vehicle_links` row with the native
   `effectiveFrom` as `valid_from` and `feeder` kind; EvidenceVersion +
   `pe_evidence_links` (`world_root_type` `pe_fund`/`pe_vehicle`); Work entity
   links. Readback must equal the returned receipts.
2. Exact replay with identical original/candidate digests returns the same
   receipts and inserts nothing (one admission row, stable entity versions).
3. Installed mail source: exact `$value` bytes retained once as a Core
   DocumentVersion; `x1_source_acquisitions` row pins grant -> version ->
   digest; second acquisition reuses the receipt without a second fetch.

## Negative cases (must fail closed, nothing partially admitted)

- Expired/revoked/superseded grant -> `X1_SOURCE_GRANT_MISSING_REVOKED_OR_PROFILE_UNSUPPORTED`.
- Byte or `changeKey` drift -> `X1_ORIGINAL_VERSION_OR_DIGEST_CHANGED` /
  `X1_INSTALLED_SOURCE_VERSION_OR_FOLDER_CHANGED`.
- Missing/expired subject consent -> `X1_SENSITIVE_SUBJECT_CONSENT_MISSING_OR_EXPIRED`.
- Changed mandate or rights revision at admission -> `X1_MANDATE_CHANGED` /
  `X1_AUTHORITY_CHANGED_DURING_PUBLICATION`; no `x1_mapping_admissions` row and
  no evidence link left behind (single serializable transaction).
- A newer `(source_id, version)` grant inserted during the publication window
  aborts the older admission -> `X1_SOURCE_GRANT_CHANGED_DURING_PUBLICATION`
  (the relock carries revision + original digest equality and the
  not-superseded predicate at acquisition strength).
- A subject deactivated between acquisition and admission ->
  `X1_SENSITIVE_CONSENT_CHANGED` (publication rechecks `users.status='active'`).
- Changed digest replay -> `X1_ADMISSION_REPLAY_DIGEST_MISMATCH`.
- Replay after the Source Truth link was re-mapped or tombstoned ->
  `X1_ADMISSION_REPLAY_SOURCE_TRUTH_CHANGED` (readback re-verifies the link
  against `finnor_os.external_refs`, not just the canonical ref and evidence
  version).
- Raw `INSERT` as `finnor_app` into `x1_source_acquisitions` or
  `x1_mapping_admissions` -> permission denied; only the owner functions write.
- Missing Deal prerequisites remain `unresolved`; supported independent
  fund/vehicle mappings in the same candidate still admit.

## 0173 shared-S5 live assertions (NOT RUN below disk floor)

- In one tenant, two active owner principals with separate Works and current
  mandates, register one canonical `COMPUTE/request` pool with 10 available
  units. Principal A reserves eight through `reserveInstitutionDemand`. As
  principal B, confirm direct SELECT of A's typed proposal/origin/projection/
  consumption/charge body returns no row; call
  `s5_institution_occupancy(resource_id)` and observe eight. B's eight-unit
  reservation must reject in the **SQL owner writer**, not merely in a
  principal-filtered TypeScript snapshot. Keep A's original row/digest.
- Try A's direct app-role `UPDATE s5_reservations SET status='RELEASED'` and
  direct app-role `INSERT` of a typed consumption/charge. Both must fail at
  `s5_institution_owner_guard` / `s5_institution_state_guard`. Use the owner
  function for a real charge, then attempt untouched release, which must
  refuse and preserve the original envelope and liability. No direct app-role
  mutation may erase the charge or retroactively change its units/deadline.
- Reserve a finite S5 certificate in the same pool after A's institution
  occupation. Its native snapshot must include A's actual typed reservation
  reference, original envelope and status (not a synthetic
  `institution-occupancy` ref), without disclosing A's Work, demand body or
  charge preimage to B. `readStoredAllocation` on A's typed reservation must
  return the typed native branch; after a charge, `readAllocationConsumptions`
  must return the same native consumption/state/charge identity without a
  finite certificate or policy. Conversely, reserve a finite
  certificate first and assert institution reservation sees the retained
  finite occupation. Check old finite consumption/settlement unchanged.
- Submit a checked institution variant through `submitHarnessProgram` under
  its exact Work/input/principal/current X1 admission receipt and original S5
  parent. Read P1 request/proposed/head/node checkpoints and native plan/loop.
  Sparse mandate without frozen action payload must publish PARTIAL with
  `X1_EXACT_ACTION_PAYLOAD_MISSING`, not TESTED/OBSERVED, and preserve both
  unresolved duty and original reservation/deadline. Exact-payload intent
  remains WAITING until downstream independent canonical observation; do not
  score WAITING as completion or claim ordinary dispatch in this stage.

## 0173 second-pass repair challenges (NOT RUN below disk floor)

- Obtain a checked mapping admission through the actual owner, including its
  immutable `duty_population_digest`. Derive the complete responsibilities and
  unresolved population from the checked original/candidate. Submit P1 once
  unchanged, then use the same genuine admission and S5 parent with one
  altered observer ref, altered postcondition ref, altered derivation revision,
  and omitted unresolved item in separate submissions. Recomputing the
  programme/demand digest for each cannot make it equal the independently
  sealed admission population. Each must fail before P1 request/plan/job
  publication with `X1_P1_CHECKED_DUTY_POPULATION_MISMATCH` or
  `X1_P1_CHECKED_OWNER_ADMISSION_REQUIRED`, not with an unrelated Work denial.
  Older 0172 admissions without a seal remain readable but cannot authorize
  the typed P1 path.
- As `finnor_app` under a valid Work/owner/mandate, call the granted
  `s5_reserve_institution` function directly with an otherwise valid eight-unit
  demand but an envelope `quantities:[null]` and matching minimum. Assert
  owner SQL rejects before any proposal/origin/reservation row. Repeat with
  a nonnumeric later-period quantity. Valid exact integer quantities still
  reserve, preserving the original parent.
- Reserve a live typed row; revise its native resource through
  `putAllocationResource` as its owner. Assert the revision commits, the typed
  reservation still holds its original envelope/charge/identity, and its
  `revocation_reason` becomes `RESOURCE_REVISION_CHANGED`. Attempt a new
  charge and assert stale currentness. A finite live reservation in the same
  update still receives its native invalidation and experience event. Repeat
  with a revoked resource.
- In two physical SQL sessions, call `s5_reserve_institution` directly in A
  without its TypeScript adapter's `FOR SHARE`. Hold A's transaction after
  the SQL writer acquired the authority/mandate row locks, concurrently
  revoke the mandate or bump authority in B, then commit A and B in each
  serialization order. A published reservation must be ordered before the
  change or the writer must refuse; it must never publish against a change
  already committed. Read actual locks/rows and preserve both transactions'
  timestamps. The owner-only typed guard and principal RLS still reject raw
  lifecycle writes.

The runner currently returns `NOT_IMPLEMENTED_NOT_RUN` for `owners`; this
packet is the launch/seed/expected-row contract for its downstream owner
driver. Do not use the old 0173 table names or report a static grep as SQL
contention proof.

## Schema pin (deliberate fail-closed)

`owner-admission.ts` requires the latest applied migration to match
`CURRENT_MIGRATION_HEAD`, currently
`0173_x1_institution_s5_reservations.sql`. Once any newer migration is the
latest applied migration, admission refuses with
`X1_AUTHORITY_SCHEMA_NOT_INSTALLED` until the pin is deliberately advanced.
Update step: review the newer migration for any change to the X1
authority/admission tables or their writer functions, update the pinned name in
`migration-head.ts`, regenerate the bundle if migrations changed
(`npm run db:bundle`), and rerun `--stage kernel` and `--stage static` before
any owner stage. Never weaken the pin to a prefix match or a skip-list to make
a run pass; the schema pin is a deliberate stop, not an obstacle.

## Commands

```
cd /Users/paramdave/.codex/worktrees/frontier5-x1/FINNOR
node finnor-os/scripts/frontier5/x1/verify.mjs --stage kernel     # control, must stay green
node finnor-os/scripts/frontier5/x1/verify.mjs --stage static     # control, must stay green
node finnor-os/scripts/frontier5/x1/verify.mjs --stage owners     # frozen stage; live runner pending
```

`--stage owners` is the frozen A/C owner stage. Its runner drives the seeded
cases above through the real restricted roles and records receipts under a
fresh private evidence directory. VAL-X1-MAP-001 is claimable only after that
stage passes with persisted readback; offline kernel/static passes are not
substitutes.
