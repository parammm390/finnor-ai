# Frozen public-population audit contract

This is a post-code diagnosis and a pre-change contract for the public runner's
receipt correction. It is not a historical pre-code read receipt, a new
population registration, or a unit-test campaign.

## Observed source defect

The original frozen registration SHA-256 is
`74c0d1b3f02e53e3c011f4cf5f976dd62378e04d2fd56b389973078cf6b2f42e`.
The retained `public-sweep-03/report.json` reports 256 correct outcomes under
32 labels. Its per-family counts do not distinguish repeated original inputs
from fresh systems. The generator's `family()` shares the exact pipeline
construction between F01 and F02, and between F30, F31 and F32. F09 uses the
same opposite-order lock input in all eight slots. A nonce outside `input`
does not change the original system.

`costs-and-frontier.md` already disclaims this limitation. The machine receipt
needs the same distinction. Passing the registered semantic outcomes is not
evidence of 32 structurally covered families or independently fresh cases.

## Failure modes, written before the runner change

1. Count fixture IDs, nonces, expected-value prose or family labels as changes
   to the original input.
2. Lose a real input field, reorder an array, or normalize original identities
   when comparing inputs.
3. Treat different input digests as proof of semantic or structural diversity.
4. Accept altered registration members, duplicate/missing IDs, path traversal,
   symlinks, inconsistent expected values or a wrong locked family title.
5. Silently regenerate frozen cases, change expected values, change the
   original denominator, or hide an original failure.
6. Execute producer/checker work in an audit-only invocation, or mislabel this
   post-code static audit as a new semantic/native/protected campaign.
7. Let an absolute but noncanonical output path escape the owned evidence
   directory. The old prefix-only output check permits a `..` escape.
8. Overwrite an existing evidence directory or resolve its parent through a
   symlink outside the owned evidence directory.
9. Emit a source-bound receipt after its audited source or registration
   changes during the invocation.

## Expected behavior and finite execution

The existing public process runner will gain `--audit-only OUTPUT` and run the
same audit before future full sweeps. It must verify all original registered
file hashes, IDs, titles and expected-value consistency before comparing the
complete parsed `input` values. Canonicalization sorts object keys, preserves
array order and every input field, then hashes UTF-8 JSON. The report names
the exact canonicalization method.

The audit reports all 256 case/input digests, exact duplicate groups, unique
input counts within each of the 32 labels, cross-label duplicate groups and
the unchanged 188-positive registration denominator. It does not call unequal
inputs independent structures. F01-01/F02-01 and F30-01/F31-01/F32-01 must
appear in common exact-input groups; F09 must have one distinct input.

One credential-free audit-only CLI invocation reads the actual frozen
population and retains a new report, log, source identities and actual exit.
Expected exit 0 means `AUDIT_COMPLETED`, not population qualification.
Producer/checker executions, DB actions and listeners remain zero.
Structural-family qualification remains `NOT_ESTABLISHED`. A bounded CLI
argument-guard invocation must reject an escaping output path before creating
any destination. This is a process/receipt check, not a new unit suite.

The original sweep, registration, member files, expected values, all failure
reports and protected-custody boundary remain unchanged. No new complete
semantic sweep is justified: kernel, checker and original inputs are
unchanged. No commit, archive, DB/Auth action or Shield workaround is allowed.
