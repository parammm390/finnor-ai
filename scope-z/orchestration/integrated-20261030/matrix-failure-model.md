# Failure model: the Z0..Z5 requirement-to-case matrix

Written before the matrix, JSON source, or renderer exist. The matrix is a
claim about a finite denominator; each way it can be wrong is listed with the
independent check that must catch it. `render-matrix.py` implements the
mechanical checks (M-codes). The rest are review checks recorded in
`matrix-method.md`.

| Id | Way the matrix can be wrong | Independent oracle / mechanical check |
|----|-----------------------------|----------------------------------------|
| F01 | A PRD requirement (numbered/bulleted requirement, fixture, gate, falsifier, limitation in 3.3-3.8, 4-9, internally achievable parts of 10-11) is missed | Each PRD section's fixture/gate/falsifier paragraphs are enumerated by line range in `matrix-method.md`; renderer lists the PRD line ranges covered and flags lines in the in-scope sections 3.3-9, 11.2-11.4 not covered by any requirement `prd` range (M01) |
| F02 | A requirement has no case and no explicit gap | Renderer rejects (M02) |
| F03 | A case is counted twice (duplicate id, or same evidence+input counted under two requirements toward one denominator) | Duplicate case ids rejected (M03); `countsToward` tallies deduplicate by `(path-of-evidence, input)` and report shared cases (M04) |
| F04 | A case cannot fail (no independent oracle; assertion is "producer ran") | A case with `independentExpected` that is empty, or states the producer as oracle without the label `SAME_CODE_AS_PRODUCER`, is rejected; cases labelled SAME_CODE_AS_PRODUCER cannot be PASS toward a checker/independence requirement (M05) |
| F05 | The oracle is the producer's own output | Same label as F04; additionally `kind=checker` requirements need at least one case whose oracle path differs from the producer path (M05) |
| F06 | Local-file recovery counted as native queue/S5 recovery | Class NATIVE_RECOVERY requires `path` containing queue claim and S5/S6 owners; a recovery case whose path lacks them must use class other than NATIVE_RECOVERY and is never counted toward recovery requirement 3.5 (M06) |
| F07 | 84 distinct Z5 inputs counted as 256 fresh cases | `countsToward` distinguishes `distinct inputs`, `slots`, `fresh cases`; renderer reports the three numbers separately for Z5 and refuses a `fresh cases` count that exceeds the distinct inputs unless the slot rule is cited with evidence (M07) |
| F08 | Public development evidence counted as independent qualification | Public suites carry `countsToward` `public development` only; the `>=32 families x >=8 cases` independent-qualification tally has its own field and every such case is EXTERNAL or NOT_RUN unless protected custody evidence exists (M08) |
| F09 | Evidence from a phase head counted as evidence for the integrated cut | Every PASS names its commit; commit in a phase-head list forces `PHASE_HEAD_ONLY` and the renderer reports those separately from integrated-cut PASS (M09) |
| F10 | PASS without an existing evidence file or with a wrong digest | Renderer re-hashes each cited file (repo path, or remote path via `--remote-root` mount / recorded digest check mode) and rejects mismatch or absence (M10) |
| F11 | A refusal-only/negative check satisfies a positive-path requirement (PRD 3.3) | Requirements of kind `product-behaviour`/`owner-consumption`/`recovery` with positive-path semantics need at least one case of class NATIVE_E2E or NATIVE_RECOVERY or an explicit gap (M11) |
| F12 | Transport-only runs (bringup, runner smoke) counted as phase evidence | `native/int-bringup-01` may only support requirements marked transport; renderer rejects its use for any phase requirement (M12) |
| F13 | Section 10 comparison / 100x / economics folded into software state | Those items appear only in `separateGates`; renderer rejects requirement ids that carry section-10 prd ranges inside phase requirements except 10.5 ablation hooks marked as `separate-gate-hook` (M13) |
| F14 | A truly external item is built around, or an internal gap is mislabelled external | Every `external` references a packet whose text states why it cannot be built internally; `gap` entries never reference a packet (M14) |
| F15 | State inferred from someone's summary instead of evidence | Every non-NOT_RUN state needs `stateBasis` with file+sha256+commit; renderer rejects otherwise (M15) |
| F16 | Family lists invented rather than taken from phase sources | Family ids must be copied from named source files recorded in `generatedFrom`; method note records each source and counts (review) |
| F17 | Non-deterministic rendering (ordering, timestamps) | Renderer sorts nothing implicitly, emits no timestamps; rerun must be byte-identical (checked by running twice) |
| F18 | Later pass erases a failure | FAIL entries remain with their original evidence; a later PASS is a new case id with its own basis (review) |
