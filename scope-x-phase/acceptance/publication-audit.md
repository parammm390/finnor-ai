# Publication audit, preregistered 20 October 2026

Publication and a truthful production approval request are authorized.
Deployment, protected admission, provisioning and Mission effects are not.

Before any push, scan the complete proposed tracked/untracked source tree
(excluding ignored local dependencies/private evidence) and every newly
reachable commit in `HEAD MERGE_HEAD --not cf18f3491993564a5acbc28a62188699a2b29a31`.
The unresolved merge index must not silently omit reconciled working bytes.
Build a fresh local snapshot using the union of cached and nonignored untracked
paths, deduplicated by pathname. Preserve regular file bytes and safe symlinks,
reject unexpected file types, escaping paths or symlinks. Record source,
configuration, scanner and snapshot hashes plus exact commands.

Use Gitleaks 8.24.3, the existing `.gitleaks.toml`, full redaction and no
fingerprint exclusions. The official release archive is checksum-verified
against its versioned release checksums; record this provenance without
claiming an independently signed supply-chain attestation. Reports and logs
stay in a new private local evidence directory. Never print matched content,
credentials, bearer tokens, private receipts or connection strings.

Fail closed on scanner errors, missing paths, partial history, unexpected
source mutation, or unexplained findings. Triage by rule/path/line only, then
inspect necessary source privately. Do not weaken policy or rewrite authentic
history to make a result green. Report a scan as detection evidence, not proof
that no possible secret exists. Repeat on the final commit/source cut before
publishing, and separately review the staged diff and status.

Native failures, missing five-engine parent bindings, qualification/economic
unknowns and production blockers must remain explicit in PRs and requests.
Publishing a draft for review must not imply completion or authorize deployment.

## Clone-boundary preflight

Attempt one stops before scanning because the shared clone is shallow.
Do not reclassify it as a pass. The sole shallow boundary is
`ed32d200a9459269509f1e40d4e13a3e2a1a4d6a`; it is outside the proposed
newly reachable range. The next attempt must prove this by intersecting every
recorded shallow boundary with the complete `rev-list HEAD MERGE_HEAD --not`
range, retaining both sets and the excluded frontier. Refuse any intersection
or missing commit object. This permits a complete proposed-range audit, not a
claim to have scanned the already-published repository's full history.

## Initial detection and disposition

Attempt two scans 4,030 proposed files (153,551,871 bytes) and all 222 newly
reachable commits, with unchanged source custody and no shallow boundary in
that range. Raw Gitleaks returns five tree findings and one history finding.
These remain nonzero scanner results, not a zero-finding pass.

Source-bound triage identifies two published release commit IDs, two
published local-test fixture values, the merge-parent IDs in this delivery's
Markdown and a historical typed CandidatePlan identity. All six are reviewed
as noncredentials. The policy and fingerprint exclusions remain unchanged.
Exact source/line hashes, provenance, commands and redacted reports stay in the
private audit artifact. Repeat detection and disposition at the final cut;
do not carry these six dispositions over to changed matching bytes.

## Published CI correction

The earlier local history commands omitted `-m`. They enumerated all proposed
commits but did not inspect every parent-relative merge patch. CI correctly
finds the exact peer Markdown field twice in the authentic two-parent merge,
plus the historical typed CandidatePlan identity. Do not describe attempts
two or three as complete merge-parent history audits. Subsequent commands
must use CI's exact `-m base..head` range. The new preregistration and exact
metadata-policy proof are in `published-ci-repairs.md`; original nonzero
reports and source-bound dispositions remain preserved.
