# Whole pull-request process audit

This supersedes draft-first publication as the next-action policy: no further
push until the applicable process is audited and its coordinated local preflight
passes. Draft #116 already exists; no required gate is weakened or rerun until
its underlying defects are resolved. Active M5 and P8/M6 remain excluded.

## Actual execution and protection

Audited GitHub run `37815908709`, integration head
`4616e24a2fa8c0a587e4a322c2acfd801b64925d`, base
`ed32d200a9459269509f1e40d4e13a3e2a1a4d6a`. The workflow runs for drafts and
targets `main` and the existing `codex/frozen-*` stack. Checkout tests the
synthetic merge, while classification uses the exact base/head Git diff with
NUL-delimited names and lossless Base64 JSON.

The active default-branch ruleset requires `required-pr-verdict` from GitHub
Actions with strict up-to-date checks, blocks deletion/non-fast-forward updates,
requires a PR, and has no bypass actors. Classic branch-protection returned 404;
the ruleset, not that legacy endpoint, provides the protection. Default workflow
permissions are read-only; PR review approval is disabled. Repository-level
mandatory SHA pinning is not enabled, but the source deployment-truth validator
requires immutable action/workflow pins.

## Workflow graph

- `pr-verdict.yml`: exact diff classification → applicable backend/root reusable
  workflows plus universal security → `always()` stable verdict. Failed,
  cancelled or unexpectedly skipped applicable results fail closed.
- `ci.yml`: deployment truth and existing release controls; separate real
  PostgreSQL/Redis job, workspace/install, commit timestamps, authz inventory,
  OpenAPI/types, migration/seed/fixture/checkpointer, full active test corpus,
  21-case Phase-7 certification and retained S7 evidence. Only the already-retired
  Phase-6 integration fixture is excluded.
- `marketing-ci.yml`: both installs, lint/workspace/manifest/forms/unit/types,
  static release/runtime-retirement policy, contrast, production build and real
  production-server public Lighthouse/Playwright. The selected file contains 72
  public cases, not authenticated owner qualification. Preserve original sampling,
  thresholds and exit conditions; add exact-PID cleanup and diagnostic retention.
- `security.yml`: universal Gitleaks and applicable fail-on-vulnerability OSV.
  An independent full history/merge-diff scan is needed because the pinned
  Gitleaks action used an unpaginated 30-commit API page for a 45-commit PR.
- `dealer-zero-replay.yml`: separate PR receipt comparison, observed PASS; not
  silently conflated with the required aggregate.
- `tenant-isolation-nightly.yml`: separately scheduled/manual protected
  production/staging tenant probe, not a PR qualification result.
- `production-release.yml`: main-only canonical graph and Phase-5 readiness plus
  root release gate → exact-SHA post-merge certification → protected production
  environment. Production authority appears only after clean source, dependency,
  worker/build/runtime checks. Existing authorization binds SHA/run/repository/
  environment; preserve ECR/preflight/canary/migration/four-class cutover/parity/
  retirement/readiness/Scope-5 ordering and production concurrency.

## Verified defects, before coordinated publication

1. Backend stopped at stale authz inventory; all later backend commands were
   skipped. Regenerate the inventory from actual guarded route source.
2. Active contract/canary migration head remained `0156`, while canonical source
   is `0170`. Align active provenance; do not change historical SQL or validators.
3. Root passed install/lint/manifest/forms/unit/types, then failed the static
   retired-domain policy. The exact false positive was a local generic transport
   binding beside the S6 `/dispatch` endpoint. Rename that binding only; preserve
   the detector, signature/settlement checks and deadline.
4. Actual current OpenAPI source and both client bodies diverged. Regenerate both
   bodies, not just their source hash comments.
5. Flat ESLint/Next declaration/test/style/instrumentation configurations and
   vendor/Python dependencies could receive incorrect N/A when changed alone.
   Extend applicability conservatively and verify failed gates cannot become PASS.
6. Gitleaks reported seven authored business-metadata false positives. Exact
   match-and-path qualification needs credential-negative controls; no broad
   directory or credential-field exceptions.
7. OSV reported current vulnerabilities in six package/version identities,
   including versions already in main. Historical zero-findings evidence is not
   current proof. Patch the locks, verify compatibility and retain fail-on-vuln.
8. Executed scanner/toolchain pins differ from their inventory. Reconcile actual
   immutable provenance and include separately deployed and Python dependencies.
9. Worker native `fs-ext` needs a Linux build toolchain absent from the slim-image
   contract. Build in a dependency stage, retain native flock and keep compiler
   tools out of the final image. A real container build remains mandatory.
10. Local linked modules, limited disk, PostgreSQL-version differences, missing
    Redis/Docker, missing production-browser execution and blocked desktop native
    pointer input remain explicit validation limitations, not PASS evidence.
11. The full local backend rehearsal retained 1,255 PASS, two failed assertions,
    28 pending and ENOSPC collection failures. The historical P1 coverage snapshot
    omitted `0165`'s temporal Work entity-link owner (49 actual owners, not 48).
    The S7 statistical child hit its unchanged 600-second timeout after 16 of 17
    cases. CPU sampling identified canonical byte counting; optimize only known
    ASCII tokens, verify historical bytes/refusals, and rerun the entire original
    17-case/12,000-trial family. Neither failure is erased or counted as PASS.

## Coordinated repair observations

These are qualified local observations, not a completed required verdict:

- Complete published history: 45 commits, including side parents and merge diffs,
  zero Gitleaks findings. The retained action is supplemented by a pinned,
  checksum-verified independent scan. All 57 exact-path/match policy probes and
  four actual-history controls pass, including late, side-parent and merge-only
  credential detection. Default rules and fail-closed endpoint checks remain.
- Current OSV 2.3.8: zero findings across root/backend locks, the separately
  supplied supplier-canary lock and typed Python requirements. Previous
  advisories remain recorded; neither severity filtering nor advisory exceptions
  were added.
- Root file-dependency repair preserves the exact licensed patched braces fork.
  The npm-packed artifact matches all ten included source/license files.
  Regenerated invalid lock edges and parent-relative overrides remove both
  dangling links. Only fork packaging and its unchanged dependencies' development
  flags changed. Actual owned, scripts-enabled reification, clean-install
  **dry run**, real Tailwind compilation, lint, types, 11 units and 37 release
  controls pass. This is not a fresh installation.
- Executed toolchain: Vercel 50.15.1, AWS credentials action
  `cbe3b392738ccf3f987d68400dafcf4b0624a56c` (verified v6.2.4), OSV reusable
  workflow `9a498708959aeaef5ef730655706c5a1df1edbc2` with scanner/reporter
  `8dc09193bb540e09b23da07ad7e30bd33bf87018`. The upstream workflow also
  contains a mutable `actions/download-artifact@v8` reference. The local inventory
  does not claim every transitive upstream action is immutable.
- Original populated P1 upgrade: three cases pass with all baseline/population/
  idempotence checks retained. Original canonical migration/generator rehearsal:
  11 cases pass, including fresh and populated upgrades and actual interrupted
  P6 transaction rollback/retry.
- S7's second timeout remains FAIL, after 15 of 17 observed PASS cases.
  The subsequent bounded encoder repair reuses only property-name tokens and
  key orders within one call, never values or answers. It matches the actual
  published encoder on 110 vectors and seven refusals, including Unicode,
  collation ties, numeric keys, table bounds, depth/node/byte limits and malformed
  inputs. The complete original statistical replay then passes **17/17** with
  all **12,000** trials, original seeds, oracle and deadlines, and unchanged
  source throughout the run. The four other S7 families were not selected in
  that diagnostic; the full active corpus must still execute them.

The recorded backend installation block required 1,082,028,369 free bytes.
After the user recovered capacity, a separate Git validation checkout received
the exact 2,769 selected source files, with initially absent dependency
directories. Both actual `npm ci` commands passed with lifecycle scripts enabled.
All 1,028 installed version entries match the locks, all patched targets are
present, both locks remain unchanged and no installed links are dangling.
This is fresh Darwin/ARM64 installation proof, not a Linux image result.

On that clean installation, workspace/authz/OpenAPI/types, migration/seed,
fixture seam, checkpointer and generated clients/manifest/forms pass. The
complete original active backend corpus and its conditional 21-case P7
certification are running, not yet PASS. The separately guarded opt-in Scope-3
compute rehearsal passes 34/34 without skipped assertions; its complete
75-case and live AWS certification remain separate. The original load rehearsal
also passes: 100,001 queued jobs, all four indexed claim plans and 30 SSE
connections, with measured SSE health p95 84.458 ms against the original
5,000-ms bound. This is local embedded-PostgreSQL evidence, not live AWS scale.

Do not install into donor-linked modules, lower scientific limits, bypass
guards, discard receipts or publish a full-preflight PASS from narrower
results. Default production build, public browser/Lighthouse, complete patched
backend corpus and post-merge production qualification remain separately
required. Further publication remains held.

## Retained complete fresh-corpus failure and IC repair

The first complete fresh-install rehearsal discovered exactly 214 test files
after the single original exclusion. It executed 1,304 tests: 1,275 PASS,
two FAIL and 27 explicit opt-in skips, with no missing files or collection
errors. All original S7 families passed (statistical 17, integrated 10,
owner eight, protected four, maturity one). The failed full corpus correctly
prevented the conditional 21-case P7 certification.

Both failures occurred while preparing the original P5 IC race/crash fixtures.
A real disposable PostgreSQL reproduction demonstrates the precision defect:
the native cutoff `.123456` becomes a JavaScript `Date` ending `.123`; the
truncated SQL cutoff returns version one instead of committed version two.
`getIcWorkspace` now preserves one native ISO cutoff across all SQL projections
and the returned `asOf`. Date conversion remains only in the preexisting pure
aggregation/membership checks. Expected-version enforcement, row locks, RLS,
snapshot hashes, read limits, future validation and test source remain intact.
No padding, sleeps or stale-version acceptance was added.

The unchanged complete IC file then passes **30/30**, including both originally
failed cases. A new complete original-corpus rehearsal and its conditional P7
step are running on frozen repaired source. The narrower IC PASS is not a
full-corpus or certification PASS. All earlier failed receipts remain retained.

## Nine draft scopes, no duplicates

`#108` cleanup and `#109`–`#115` S1–S7 retain their existing stack/base relationships.
Their latest exact-head required verdicts were PASS at audit time. `#116` is the
completed-source integration against main; its current verdict is FAIL. Do not
rewrite or duplicate the eight existing drafts or mistake historical/older
check runs for their latest exact-head results.

The coordinated revision must include source/runtime hashes, exact commands,
complete denominators, scanner policy controls, current advisory results and
honest blocked/not-run fields. Neither local proof nor green CI establishes
independent S6/S8 admission, physical isolation, economic gain or original GateP6.
