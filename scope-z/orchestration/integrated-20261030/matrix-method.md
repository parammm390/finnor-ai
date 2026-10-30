# Z0-Z5 requirement-case matrix: method

Source of truth: `requirement-case-matrix.json`. `render-matrix.py` validates it and renders `requirement-case-matrix.md` deterministically (stdlib only). Failure model: `matrix-failure-model.md` (F01-F18, mechanical checks M01-M15), committed before the matrix.

Nothing here claims acceptance, 100x, or activation. Base: `a5209abc15fe40c68f30336c60d95dbfc343c13a`, branch `w/matrix`.

## Sources read

- PRD (973 lines by `wc -l`, 974 per the reader/brief; see A01), Z0-Z5 phase plans, request packets, and the phase drivers under the product tree.
- Evidence on remote `fzv:/home/factory-user/repos/fzv-int-out/` (integrated checkout `fzv-int-01`, HEAD a5209ab). Product Z source between 073202e and a5209ab is unchanged apart from run-native-scenario.mjs, start-isolated-app.mjs, native/bringup.mjs, vercel-build-context.mjs.
- Protected originals verified unchanged in the worktree: z3 checker.py b71c0bec...837e, reference.py fa267cb6...f84e, transition.ts b4047f30...9029.

## Derivation

1. Each in-scope PRD requirement gets an id: phase-specific `Zn-R01..R20`, shared per phase `R40` positive chain, `R41` currentness (6 points), `R42` recovery (3.5), `R43` identity preservation, `R44` remaining-budget fallback, `R45` mounted Work (11.4), `R46` reconstruction (11.3), `R47` meters (11.2), `R48` qualification (3.7). Cross-cutting: `CC-T01`, `CC-R01..R11`, `CC-G01..G02`. Z5 additionally has `Z5-R49` (local-file recovery).
2. Each requirement is expanded into cases (positive, negative, fresh/independent, native, recovery, mounted).
3. A case state is PASS only when it cites an existing evidence file, its sha256, and the commit it ran on. Otherwise NOT_RUN, FAIL, INCOMPLETE, or EXTERNAL (needs a party outside this repo; packets EP-01..EP-10 in the JSON).
4. Every PASS is scope INTEGRATED_ANCESTOR with `finalCutRerunRequired` true. Zero PASS rely on phase heads (PHASE_HEAD_ONLY). Evidence commits are verified ancestors of a5209ab.
5. Section 10 comparisons, 100x and economics are only in `separateGates`.
6. PRD line coverage (M01): structural lines (headings, blank, `---`, fences, `$$`) are exempt. Covered: 197-255, 259-303, 307-380, 384-470, 474-562, 566-650, 654-735, 823-871; lines 71-83 (1.4) cited by CC-G01/G02.

## Exclusions

PRD section 1 narrative; section 2 baseline/credits/out-of-scope; section 10 (to separateGates); 11.5-11.10 roles/schedule/delivery/finish (process, not product); section 12 sources.

## Counting rules and evidence handling

- Shared evidence is counted once in distinct keys; case tallies count per case.
- native-ci-02 and int-bringup-01 are transport-only, cited only under CC-T01. production-artifact-04 is build plus emitted native custody only.
- Z4 runci executed only 12 negative obligations (positives 0, proofs 0), so it is not counted for Z4 positives.
- First-attempt `fcz01-z5-*` rc=1 runs were invocation errors (EXPLICIT_FRESH_OWNED_EVIDENCE_DIRECTORY_REQUIRED) and stay FAIL. `fcz01-centropy-coverage-check` FAIL is a stale generated audit (coordinator restamps at final cut); Z0-R03-C03 and CC-R09-C07 record the same observation. Regression shard2 and shard3 FAIL; shard1 PASS 525/525; targeted regression-fix-01 PASS 16/16 on 3 files only (shards not rerun in full).
- Every native per-phase case (queue/S5/S6/S7/mounted) is NOT_RUN: no scenario program exists for run-native-scenario, and phase drivers are authority/manifest gated. Z4 needs https Auth (replay-authority.mts:87); no integrated evidence for `start-isolated-auth-tls.mjs`.
- Z5 local-file journal recovery (Z5-R49) is deliberately not counted toward native recovery (nativeQueueRecovery NOT_RUN).
- A manifest self-parity check is not counted as PASS.
- Handoff-28 claims (Z3 negative native refusal, Z4 https work, Z1/Z2 native) were read but not cited; they are not on the integrated cut.

## Unresolved ambiguities (not guessed)

- A01: PRD line count 973 (`wc -l`) vs 974 (reader/brief); coverage uses the reader's numbering. Needs coordinator confirmation.
- A02: No PRD "slot rule" for Z5 found; fresh was treated as at most the number of distinct inputs (84 distinct of 256 slots; 2/32 families reach 8 distinct; 188 positive slots/50 distinct positive inputs).
- A03: Distinct-input hashes include identity/id fields, so structural distinctness of Z1/Z2/Z3/Z4 256 cases is not independently verified (Z4: 256 requests are only 32 distinct programmes).
- A04: Z3 "24 inapplicable" slots and a 58 positive denominator vs the PRD 95% rule: whether the denominator reduction is admissible is undecided.
- A05: Z4 PRD wants at least 40 unseen definitions vs 32 public programmes and 9 proof representatives (EP-02).
- A06: The "measured access gap" that selects Z0's second scientific family is not identified in any source read (Z0-R12 INCOMPLETE).
- A07: Z0 "additional foundational failures" (PRD 4.3 item 8 / 4.2) is open-ended with no finite denominator (Z0-R16 gap).
- A08: Mapping of the Z0 plan's "54 closed obligations" (3+7+1+1+1+8+28+1+1+3) to PRD 3.4's six binding points: checker acceptance and artifact publication have no Z0 case (Z0-R07-C05 INCOMPLETE).
- A09: Request 07 (Z5, 11 shared files): at a5209ab only 2/11 files (policies/[operation]/route.ts, InstitutionCompositionPanel.tsx) byte-equal their postimage; 9 differ. Whether other merges or a different application explain this is unverified. Observed locally, not retained as evidence (Z5-R18-C01 NOT_RUN). Manifest sha256 fb88fe4dc4b23d46927a92c716f8d64c2edfc2f33389f9282b4285fdd9a35f5c.
- A10: Z0 D1/D2/G1 revocation-race case is missing from the Z0 plan (Z0-R11 gap).
- A11: Artifact-field-set parse cases (Z1-R02, Z2-R02, Z3-R02, Z4-R02) have no public case.
- A12: PRD 3.1 envelope conformance check is absent (CC-R01).
- A13: It is unclear which Z4 negative is the confidentiality row.
- A14: How the PRD 10.5 ablation is handled: placed in separateGates, not as a per-phase requirement.
- A15: Z5 per-family distinct input counts use F-index order; an alternative ordering is not excluded.

## Host and rerun notes

Evidence digests were recorded from remote `sha256sum` on fzv. Locally `python3 render-matrix.py` reports 0 validation errors and `UNVERIFIED_REMOTE` for the cited files. Run `python3 render-matrix.py --require-remote` where `fzv-int-out` is mounted. All PASS must be rerun on the final cut.
