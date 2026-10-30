# Integration patch serialization failure contract

This diagnosis is after product implementation and before correcting the
owned integration assembler. It does not rewrite any original receipt.

## Actual failures

The broadened preserved-index whitespace check exits 2. Its forty findings
are literal one-space blank context lines in saved unified diffs 01–04,
which are patch data, not trailing spaces added to shared source. The
original check is retained in `staged-whitespace-01.log`. Do not trim or
restage those immutable artifacts to make that outer check pass.

More importantly, actual read-only
`git apply --check --whitespace=error` exits 1 for **each** saved request
01–05 with `error: dev/null: No such file or directory`.
`integration-patch-check-01.json` pins all five failing patch identities.
The exact pre/postimages passed virtual source checks, but this did not
validate their serialized Git patch.

Each request declares one absent preimage, the new
`src/components/centropy/world/InstitutionCompositionPanel.tsx`.
The assembler emits its `diff --git` and `--- /dev/null` headers without
`new file mode 100644`. The correction will explicitly identify creation
in the Git extended header, then verify the hypothesis with the real Git
parser. No shared source is applied.

## Failure modes, recorded before the correction

1. Serialize a new file as an ordinary existing-file Git diff.
2. Mark an existing empty file as absent by using truthiness instead of the
   explicit `before is None` condition.
3. Use a different creation mode from the exact manifest.
4. Change a source postimage, preimage, migration body or API contract while
   fixing only patch serialization.
5. Overwrite historical requests or reuse their patch hash for different bytes.
6. Leave the source packager pinned to the stale request after creating 06.
7. Hide the original failed Git checks or relabel them as passes.
8. Apply the patch, write shared files/index/Git objects, assign a migration,
   execute SQL or infer new DB/Auth/native authority.
9. Weaken Git path/whitespace checks or use a staging/archive workaround for
   the independent Shield denial.

## Expected finite engineering flow

Change only the owned assembler's new-file Git header. Generate fresh
`integration/request-06/` from the same read-only actual baseline. All eleven
preimage hashes, all eleven postimage hashes, modes and migration metadata
must be identical to request 05. Only request-relative artifact paths and
patch identity may differ in the manifest.

The new patch must contain exactly one `new file mode 100644` header and pass
real `git apply --check --whitespace=error` at the unchanged owned baseline.
An independent metadata/byte comparison must verify all pre/postimages,
current baseline preimages and the continued absence of the new shared file.
Keep the original five failures and all requests 01–05 immutable.

Update only the owned packager's active request path to 06 and check Python
syntax without running the blocked packager. Kernel, checker, TS source
graphs and exact virtual postimages do not change, so their existing
source-bound checks are reused. No new unit suite or semantic population is
created. No commit/archive retry, shared application, DB/Auth action,
listener, signer or coordinator gate is authorized.
