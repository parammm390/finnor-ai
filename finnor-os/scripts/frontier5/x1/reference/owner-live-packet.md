# Deferred owner-bound live packet (capacity-pending)

Frozen before the live run. Free disk was below the registered 1.5 GiB
`liveMinimumFreeBytes`, so no service, migration, owner transaction, installed
adapter call or browser session was started. This packet is the exact downstream
runbook; nothing here is passed evidence.

## Preconditions

1. `statfs` free bytes >= `verification-plan.json` `limits.liveMinimumFreeBytes`
   (1,610,612,736). Retain this packet and all offline failures unchanged.
2. `cd finnor-os && npm run db:bundle && npm run db:migrate` applies migration
   `0172_x1_institution_source_authority.sql` (already bundled as migration
   0172 of 174). Expected new relations: `x1_source_grants`,
   `x1_source_acquisitions`, `x1_work_mandates`, `x1_subject_identity_bindings`,
   `x1_subject_consents`, `x1_mapping_admissions`, all with forced tenant RLS.
   `finnor_app` holds no raw `INSERT` on the two immutable receipt tables; the
   driver writes receipts only through the `SECURITY DEFINER` owner functions
   `x1_record_source_acquisition` and `x1_publish_mapping_admission`, which
   re-derive tenant/principal from the request GUCs and cross-check the
   referenced grant/document/Work.
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

## Schema pin (deliberate fail-closed)

`owner-admission.ts` requires the latest applied migration to be exactly
`0172_x1_institution_source_authority.sql`. Once any newer migration is the
latest applied migration, admission refuses with
`X1_AUTHORITY_SCHEMA_NOT_INSTALLED` until the pin is deliberately advanced.
Update step: review the newer migration for any change to the X1
authority/admission tables or their writer functions, update the pinned name in
`owner-admission.ts`, regenerate the bundle if migrations changed
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
