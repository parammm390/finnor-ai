# Integration handoff, original P3 BranchFabric

**Original P3 gate UNPASSED.** Tested ordinary software is ready for review and
controlled integration; unfinished independent code is listed in
`completion-audit.md`, not disguised as an external blocker.
No push, PR, provisioning, deployment, extra implementation session or protected
owner mutation was performed.

## Source and installation identity

The feature checkout is
`/Users/paramdave/.factory/worktrees/pm-p3-branch-fabric/FINNOR`,
branch `codex/pm-p3-branch-fabric`. Neutral base commit
`e9c15d65a4a01e81dddbadcbd3449e1a5bd305d5`, tree
`6c5da18df33c41f6a058ee8ee4bb3c673b507f64`, parent
`970b8d66ebdcc09b5eedf78af08c4c15090d76a5`.
Canonical remote is `https://github.com/parammm390/finnor-ai.git`.
Both captured locks are unchanged, eight package realpaths are local, and
153 base migrations remain unchanged.

The independent joined checkout is
`/Users/paramdave/.factory/worktrees/pm-p3-branch-fabric-join/FINNOR`,
base commit `32d7d6ba6e8bfe344a04a63ffee34e4904df654e`, tree
`3f17622a4446428eedfa007fdb6ad53800f7c29c`. Its actual M1 native ancestor
is `485370d403b78b94eaed93f52dd3a800e2bbc2be`, exact P4 import ancestor
`2343bbd63b08b6d0b55fd02dbb19918fdfe4b8ae`. It has independent locks/
dependencies/realpaths and154 base migrations ending P4's0155.
`scope-evidence/join-import-receipt.json` retains exact P3 import/shared hashes.
Terminal join artifacts are copied verbatim into this feature checkout, not
rerun or relabelled by the collection script.

## Validation and evidence

* Latest standalone `scope-evidence/run-2026-10-05T02-28-48-382Z-3bc2d9b1`:
  21 PASS_LOCAL,0 failures,6 unpassed gates.
* Exact authentic P4/M1 joined
  `scope-evidence/run-2026-10-05T02-29-11-152Z-781e6b6c`: T1–T6 pass,
  0 failures,5 unpassed gates. P4 source restatement/replay/cancellation and M1
  bound native slice/late cancellation/Work invalidation are separate from
  either producer's full qualification.
* Unchanged affected Scope-3 owner regression
  `scope-evidence/regression-2026-10-05T02-45-45-315Z`:5 pass,
  17 filter-excluded, source unchanged.
* Phase, Linux, frontend and API typechecks pass; joined phase/Linux closure
  passes. Targeted frontend lint has0 errors and1 generation-ref effect-cleanup
  warning. Git diff whitespace check passes. No claim of a whole-repository
  unrelated test run.
* All failed runs and the unsealed interrupted FD3 run remain unchanged locally.
  `scope-evidence/integrity-audit-*.json` reverify sealed manifests and unchanged
  primary selected bytes/HEAD/tree/index. A checksum is not scientific truth.
* Fixed Linux native/checker/P4 payloads build on Darwin. Their rootfs and actual
  confinement/hostile/resource/egress/raw restore gates remain unpassed.
* Twelve frozen performance pairs/30 checked cells showed no reliable speedup,
  zero isolated accepted, null USD and empty demonstrated frontier.
* Mounted corrected browser workflow/native input/screenshot are unpassed.

## Migration and shared seams

The exact forward body is `migration.sql` in this directory; disposable candidate
name `0156_p3_branch_fabric_candidate.sql`. The real bundled runner applies
153+body on neutral and154+body on joined. This is not a reserved final number.
The integration writer must assign a unique filename/order and regenerate the
shared bundle without changing existing executed migrations. P3 does not require
P4 tables to create its own tables.

The sole applied shared source hunk is the one `run_branch_fabric_v1` HEAVY/pure
job registration in `finnor-os/packages/db/compute-contract.ts`.
The joined exact predecessor SHA256 is
`999e4aa680b4c259333c55c5f0e600441cc31ba8724c313808e58d2f56c5a064`,
new `73e02b0d43bb984777908b11417ca9c4ca0dfe2a255fb8cbb92321fb7dc98fcd`;
P4's registration is preserved. The export receipt records neutral old/new
hashes and patches too. Never replace the shared file or semantic-auto-merge it.

Production worker/Canvas/shared export/authz/OpenAPI/Work events/migration-bundle
registration remains one-writer integration work. The real dedicated
`/branches?workId=…&rootId=…` authenticated view and phase-only queue worker
are mounted/callable, but are not production dispatch/composition completion.
P4/M1 panels and all eight owner semantics must be preserved.

## Repeatable commands

From the appropriate isolated checkout, with no ambient DB authority:

```sh
env -u DATABASE_URL -u POSTGRES_URL -u POSTGRES_URL_NON_POOLING \
  node --import=tsx finnor-os/scripts/p3/run-e2e.mts
env -u DATABASE_URL -u POSTGRES_URL -u POSTGRES_URL_NON_POOLING \
  node finnor-os/scripts/p3/regression.mjs
node finnor-os/scripts/p3/audit-evidence.mjs
```

The raw evidence directory is intentionally local-only and ignored by Git.
For the committed redacted evidence, use:

```sh
node finnor-os/scripts/p3/verify-evidence-export.mjs
```

`redacted-evidence-index.json` points to the exact exported directory. Every
export wraps the observed record with its original SHA256, redaction paths and
explicit non-authoritative qualification. `evidence` holds the decoded original
record with credential-like strings replaced by `xxxxxxxx`. Raw signatures and
content digests refer only to the local original bytes, not to the redacted JSON.
Partial/unparseable historical JSON is withheld, not repaired or counted passed.
The export manifest separately hashes every new export. Verification found
0 changed/missing originals and0 export mismatches.

In the exact independent committed join, run the controlled transfer from the
feature checkout, then:

```sh
env -u DATABASE_URL -u POSTGRES_URL -u POSTGRES_URL_NON_POOLING \
  node --import=tsx finnor-os/scripts/p3/run-e2e.mts --join
```

The `--performance` mode is exclusive. Its retained result should not be
selectively replaced with a favorable run. `--browser` requires the already
assigned desktop session/target; never discover/create other targets or use a
headless replacement to change its gate. Linux build/profile/certify instructions
are complete in `finnor-os/scripts/p3/linux/README.md`; use only an explicitly
authorized compatible Linux host, verified runsc binary and private origin key.
No Linux failure falls back to trusted-native execution.

## Commit/patch delivery and public base

The phase-owned feature and redacted-evidence commit set is based only on the
exact neutral S snapshot. A new `.runtime/p3-handoff-*` directory contains the final
delivery receipt, phase-only binary patch, per-commit patches, candidate SQL,
source hash list, and neutral/join exact shared predecessor patches. Runtime
dependencies, raw evidence containing lease/claim tokens, private DBs, temporary
signing keys, generated `next-env.d.ts` and Linux build output are excluded from
Git. The raw evidence is preserved, never deleted or silently rewritten.
The generated Next file remains
locally ignored, not deleted or imported as a shared source change.

Droid-Shield first refused the oversized raw-evidence diff, then detected
credential-like token fields in a bounded batch. The user authorized the best
truthful completion path. No shield setting/hook was disabled. A separately
labelled redaction/export path resolves the disclosure risk while preserving
the immutable raw artifacts. Bounded export commits keep each scanner input
reviewable. These exports cannot be used as original signed authority.

Remote main was freshly observed at
`ed32d200a9459269509f1e40d4e13a3e2a1a4d6a`.
**PR_PUBLIC_BASE_UNRESOLVED.** A narrow private-base diff does not establish a
published cumulative S predecessor. Do not push the base capture or create a
misbased cumulative-S PR. A later authorized writer must verify actual published
ancestry, exact shared predecessor/migrations/locks, then rerun affected joins.

Remaining production gates: private checkpoint encryption/retention/erasure,
cross-Work grants/aggregate OS accounting, lost acquisition cleanup and complete
control/stream deadlines, Linux/browser evidence, admitted production live-read,
reconciled dollars, independent sealed comparison, S8/environment/funding,
mature S7/H2/financial floors and deployment.
