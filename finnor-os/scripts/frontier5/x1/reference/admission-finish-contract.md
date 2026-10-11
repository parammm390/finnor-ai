# Admission finish contract (pre-repair, independent)

Frozen before the six owner-admission repairs on 24e5aa64c, from the
independent read-only review dd2c1dd7-3b42-4363-8c04-d0f573ac4d09 (mission
library `admission-finish.md`). Each case below is an observable invariant over
the actual owner source, migration and packet text, checkable by the offline
kernel. The live A/C owner driver (`--stage owners`) remains the only authority
for runtime proof; these cases are the offline-expressible subset and their
pre-repair failures are retained as defective observations.

## Cases (admission-finish-cases.mts)

1. **seam-closed** — `admitCheckedInstitutionMappings` is exported nowhere:
   not from the package barrel (`packages/private-equity/src/index.ts`) and not
   from `owner-admission.ts` itself. Publication is reachable only through
   `reconstructAndAdmitInstitutionSources`, which builds the original and its
   retained handles server-side.
2. **rehydrated-write-inputs** — the admission body contains no caller
   `retained` array at all. Preflight target resolution, native evidence
   decode, `sourceClass`, `purpose`/`institutionId`, consent rechecks and
   Source Truth bindings read only the server-rehydrated `sources` produced by
   `rereadSources`, whose entries are digest- and revision-pinned against the
   handles.
3. **publication-grant-relock** — the publication-time grant relock matches
   acquisition strength (owner-currentness-contract.md): `FOR SHARE` with
   `revision` and `original_sha256` equality, a valid window, and the
   not-superseded `NOT EXISTS` newer-version predicate. A v2 grant issued
   during the publication window aborts a v1-based admission.
4. **owner-knowledge-cut** — `knowledgeCut` derives from server-side retention
   facts (Core version `created_at` / acquisition receipt), carried on each
   rehydrated source as `retainedAt`; the loader never mints
   `new Date().toISOString()` as the cut and the admission never overwrites the
   fresh owner read's cut with caller input.
5. **replay-source-truth-readback** — replay readback re-verifies each
   receipt's Source Truth link against `finnor_os.external_refs` (same tenant,
   same canonical entity, not tombstoned) and refuses with
   `X1_ADMISSION_REPLAY_SOURCE_TRUTH_CHANGED` on mismatch, in addition to the
   existing canonical-ref and evidence-version comparisons.
6. **receipt-write-least-privilege** — migration 0172 grants `finnor_app` no
   raw `INSERT` on `x1_source_acquisitions` or `x1_mapping_admissions`. Writes
   route through the `SECURITY DEFINER` owner functions
   `x1_record_source_acquisition` (cross-checks the referenced grant is
   current, unsuperseded and digest-equal, and the document version carries the
   same digest) and `x1_publish_mapping_admission` (cross-checks the referenced
   Work is the calling principal's own), both with `PUBLIC` execute revoked and
   `finnor_app` execute granted. No product source performs a raw `INSERT` into
   either table, and the generated bundle carries the same migration text.
7. **publication-consent-active-subject** — the publication consent recheck
   joins `finnor_os.users` and requires `u.status='active'`, restoring the
   active-subject predicate enforced at acquisition; a subject deactivated
   between acquisition and admission fails with `X1_SENSITIVE_CONSENT_CHANGED`.
8. **schema-pin-documented** — `owner-live-packet.md` documents the deliberate
   latest-migration schema pin update step: admission refuses with
   `X1_AUTHORITY_SCHEMA_NOT_INSTALLED` once any migration newer than the pinned
   `0172_x1_institution_source_authority.sql` is the latest applied, until the
   pin is reviewed and advanced.

Verified-sound behavior that must not regress: atomic serializable admission,
deterministic tenant-sealed IDs, no invented Deal prerequisites, idempotent
digest-bound replay, Graph pin enforcement, forced tenant RLS, and fail-closed
unsupported provider families (frozen profile declares
`installed_source_adapter` only under email).
