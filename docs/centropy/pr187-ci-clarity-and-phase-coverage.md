# PR 187 CI clarity and phase coverage repair

Base source: 8c45362f77666457afeeb2697918d3342553b490.
This review changes CI presentation and connects the existing W1 and W3
verification to the integration branch. It does not establish phase completion.

## Failure model recorded before changes

- A job title made only of an internal identifier hides its product purpose.
- W1 and W3 implementation and existing drivers are present, but their workflow
  push filters exclude the integration branch. An absent run is missing evidence.
- A single successful positive episode cannot replace recovery, refusal or
  publication controls.
- Failed, cancelled, skipped and absent required episode results must fail the
  phase's CI result, including when a prerequisite prevents later jobs running.
- Renaming required-pr-verdict would break the protected check identity.
- The existing Z0, W2 and reporting job identities bind completion receipts;
  presentation edits must preserve those identities and the exact marker.
- A new W1 or W3 result must send its own source-bound completion receipt through
  the existing reporter. Reporting grants PR-comment permission only.
- Job IDs, commands, inputs, limits, action pins, artifact names, original
  episode matrices, production authority and CI cancellation behavior must stay
  unchanged. Only W1/W3 integration triggers and their terminal results are added.
- A CI result covers only the listed checks. Protected qualification and measured
  business acceptance remain separate. Missing W4/W5 governing implementation
  cannot be supplied by a passing CI title.

## Validation required

Parse all workflow files, compare each existing job after excluding display
names, and run the existing CI process policy on the captured repository
snapshot. Extend the existing damaged-workflow controls before adding the
wiring. Exercise the actual new JavaScript result programs for success and
failure/cancelled/skipped/missing outcomes. Test the actual reporting program
against finite API fixtures, retaining stale-source and duplicate refusal.
Hosted actionlint, real HTTP reporter tests and original native journeys must
execute in GitHub Actions on the published commit; this session has no executor.


## Verified changes and limits (17 November 2026, India)

All 20 workflows and their 60 existing jobs receive explicit purpose-based
titles. Job IDs, paths and commands remain stable. The protected
`required-pr-verdict`, `post-merge-certification`, the existing Z0/W2 gate
identities and `notify-ci-completion` reporting identity remain compatible.

W1's original native journey and six recovery/refusal episodes, and W3's fast,
full native and publication-challenge episodes, now run on
`codex/zw-integration-quality-20261115` as well as their original phase branches.
Each workflow adds an unconditional terminal result consuming every original
job, and reports that result through the existing source-bound bot relay.
This adds no provider credential, production permission or business authority.
GitHub branch protection configuration is not changed.

The Z0 job summary spells out every mounted case instead of presenting bare
M identifiers. The original required-case population, result loop and failing
predicates are byte-for-byte retained outside this added display block.

Validation in the available JavaScript runtime used a captured GitHub source
snapshot, not a filesystem checkout or a native test environment:

- All 20 workflow files parse with js-yaml 4.1.0 from its published source tag.
  The repository's locked parser and pinned actionlint must still run in CI.
- The complete existing CI-process policy plus the added coverage/name rules
  accepts the changed snapshot. Before correction it records 68 failures.
- All 28 actual damaged-workflow transformations from the extended existing
  process test are rejected; ten address these naming and coverage defects.
- Existing job objects retain every non-name field. Z0 only adds the finite
  summary; the reporter only extends its allowlist by the two W1/W3 results.
- Actual W1/W3 JavaScript terminal programs are exercised for all 150 combinations
  of success, failure, cancellation, skip and absent prerequisite results.
  Only the two all-success combinations pass; 148 combinations fail.
- The actual reporting JavaScript is exercised with in-memory API fixtures:
  20 terminal gate/result combinations report the correct result, and seven
  invalid/pending/stale/foreign/duplicate/refused contexts emit no comment.
  These are not the existing real-HTTP/child-process tests; those run in CI.
- All five callers retain the same narrow reporting permissions. The protected
  check, Z0/W2 source-bound gate names and reporting job remain stable.
- The finite Z0 summary excludes arbitrary outcome strings and private payloads.

This session has no execution workspace. No native repair, package-lock rewrite,
official generator run, native acceptance or hosted pass is claimed. The next
published source requires fresh hosted evidence for all affected gates.

## Reading CI

| Visible workflow/check | What a result establishes |
| --- | --- |
| PR - Code, build, tests and security | Existing source/build/test/security aggregate |
| required-pr-verdict | Stable protected identifier for that PR aggregate |
| Z0 - Work display, reload, sign-in and privacy | Original eleven-case mounted journey; see its readable case table |
| original-owner (default) | Stable receipt identity inside the Z0 workflow |
| Z1 - Shared work compiler - public semantics | Public semantic checks; installed/protected acceptance remains separate |
| Z2 - Coalition incentives - public semantics | Public semantic checks; installed/protected acceptance remains separate |
| Z3 - Long-term viability - public semantics | Public semantic checks; installed/protected acceptance remains separate |
| Z4 - Execution proof public semantics | Public proof checks; security and installed/protected acceptance remain separate |
| W1 - Economic orchestration and recovery | Existing native journey and original recovery/refusal episodes |
| W2 - Payment settlement and rejection checks | Exact settlement plus baseline and wrong-amount/payee/receipt comparisons |
| w2-pair-verdict | Stable receipt identity requiring all five W2 comparisons |
| W3 - Real-world fulfillment and publication | Existing fast/full native journey and invalid-publication challenge |
| CI results - Report completion to the PR | Sends the completed result; grants no phase acceptance |

### Z0 case names

| Case | Product behavior |
| --- | --- |
| M-00 | Prepare authenticated native Work and worker |
| M-01 | Show original Work, terms and remaining resources |
| M-02 | Show accounting and independently observed completion |
| M-03 | Distinguish supported facts from predictions |
| M-04 | Keep blocked or needs-action state after reload |
| M-05 | Switch Works through Investigations |
| M-06 | Switch user and protect private Work |
| M-07 | Refresh the authentication token |
| M-08 | Sign out and sign back in |
| M-09 | Recover after losing the connection |
| M-10 | Reject a delayed response from the previous user |

## Product completion ledger

Existing implementation is substantial. Open acceptance means evidence remains
incomplete or a product defect remains; it does not mean zero implementation.

| Capability | Existing implementation/source | Remaining acceptance |
| --- | --- | --- |
| Z0 - Converged institution runtime | scope-z/FINNOR-Z-PRD.md section 4; orchestration and mounted Work/application runtime | Current mounted display/session failures must be repaired and all eleven cases verified |
| Z1 - Collective semantic work compiler | scope-z/FINNOR-Z-PRD.md section 5; project-z/z1-shared-work | Installed owner, protected qualification and business evidence |
| Z2 - Coalition-resilient interaction compiler | scope-z/FINNOR-Z-PRD.md section 6; project-z/z2-coalitions | Installed owner, protected qualification and business evidence |
| Z3 - Infinite-play viability compiler | scope-z/FINNOR-Z-PRD.md section 7; project-z/z3-viability | Installed owner, protected qualification and business evidence |
| Z4 - Succinct execution integrity compiler | scope-z/FINNOR-Z-PRD.md section 8; project-z/z4-execution-proof and Rust owner | Dependency security, positive installed proof, protected qualification and business evidence |
| Z5 - Contextual institution linker | scope-z/FINNOR-Z-PRD.md section 9; project-z/z5-institution-linker | Installed linker, code correspondence and recovery; no full current phase verdict |
| W1 - Economic orchestration | scope-postz/w1-economic-orchestration; existing native and recovery drivers | New current-source hosted results plus the remaining governing campaign and business gates |
| W2 - Accountable workforce | scope-postz/w2-accountable-workforce; compiler, participant and settlement owners | Repair observed 40P01 contention and complete current-cut settlement/recovery acceptance |
| W3 - Real-world fulfillment | scope-postz/w3-real-world-fulfillment; service, owner, publication and recovery drivers | Current hosted original journeys plus installed/browser/human/longitudinal evidence |
| W4 | Governing implementation unavailable in reviewed published/supplied sources | Recover and review actual governing source before any completion judgment |
| W5 | Governing implementation unavailable in reviewed published/supplied sources | Recover and review actual governing source before any completion judgment |

### Parent evidence and next actual repair

The last fully reviewed source is 8c45362f77666457afeeb2697918d3342553b490.
Universal run 43956251660, W2 run 43956232845 and Z0 run 43956232907 all fail.
The S4 original owner/replay succeeds in hosted job 133613862045.
W2's wrong-payee job 133614644828 records 40P01 at assertClosingCurrent;
wrong-receipt succeeds on this source after failing on the parent. Code review
finds opposing Work/instruction/material-fence lock order. A deterministic
PostgreSQL regression is still needed to verify the actual cycle and its repair;
the episode shift alone is not a database deadlock graph.

Security job 133611687514 reports Next 16.4.1
(GHSA-mfr8-8qww-v76h; reported fix 16.4.5), bincode 2.0.1
(RUSTSEC-2025-0141) and paste 1.0.15 (RUSTSEC-2024-0436).
These remain open. Source/process, installed-owner, protected-effect and measured
business gates remain distinct. This CI correction does not close any phase.

Future CI work should extend the same readable titles and terminal-outcome
checks. The existing process guard rejects unnamed jobs, opaque workflow titles,
missing W1/W3 integration coverage and omitted phase-result prerequisites.
