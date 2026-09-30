# Test and unused-code cleanup — 2026-09-30

Baseline: `ed32d200a9459269509f1e40d4e13a3e2a1a4d6a` (remote main checked again before delivery).
Method: [OpenClaw test-audit skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md), candidate evidence before edits, non-test caller search, keeper comparison, history, and validation. All final edits and review were performed by the primary agent after the user requested no further subagents. No independent agent autoreview was run under that constraint.

## Result and limits

- Removed **37 test declarations**: tracked JavaScript/TypeScript declarations changed from **1,237 to 1,200 (2.99%)**; test/spec files changed from **268 to 257 (11 removed, 4.10%)**. The count uses TypeScript AST calls to `it`/`test`, including parameterized declarations once. Runtime loop/parameter expansion is not a declaration count. Two renamed retained cases do not count as deletions.
- The requested **25% deletion target was not reached**. There is insufficient evidence that another 273 declarations can be deleted without losing useful confidence. Conservative inventories of retained tests are not individual manual owner signoffs.
- Removed disconnected private runtime APIs, an unused workspace package, eight unused UI components, three unused orchestrator re-export shims, four unused root dependencies (19 lockfile packages), and three unreferenced Water PDFs plus their index. No dependency versions changed.
- Repaired the existing Vapi owner identity test and routed the retained canonical policy tests through the default release gate.
- Historical migrations, retained business data readers, tenant/security guards, live-provider tests, performance tests, and existing end-to-end suites remain.

## Comparable coverage

The same backend unit/package command and V8 provider were used before and after. This is **backend coverage**, not whole-repository or browser coverage. Both runs exclude console TSX files that the provider cannot parse; those pre-existing warnings were observed in both logs. The root UI has behavioral browser verification, not a measured coverage baseline.

| Metric | Before (covered / total) | After (covered / total) | Change, percentage points |
| --- | --- | --- | --- |
| Lines | 25.20% (7,942 / 31,510) | 25.15% (7,890 / 31,368) | -0.05 |
| Statements | 24.74% (9,596 / 38,786) | 24.66% (9,526 / 38,618) | -0.07 |
| Branches | 18.59% (7,053 / 37,923) | 18.56% (7,018 / 37,802) | -0.03 |
| Functions | 24.05% (1,889 / 7,852) | 23.98% (1,872 / 7,806) | -0.08 |

Line coverage fell **0.05 percentage points**, inside the 2-point allowance. As a conservative denominator check, count every removed covered line as lost and hold the original 31,510-line denominator: 7,890 / 31,510 = 25.04%, a 0.16-point loss. The same fixed-denominator check stays within 0.22 points for all four metrics. This prevents shrinking the source denominator from hiding the loss.

## Deletion evidence and retained owners

All paths below are repository-relative. The historical commits identify introduction or retirement; source callers were checked at the pinned baseline, not inferred from age or naming.

| Candidate | Actual signal and production callers | Retained owner / reason safe | History / risk / validation |
| --- | --- | --- | --- |
| Holt-Winters + forecast examples (3) | Only tests call `holtWinters`; no runtime forecasting caller. | Remove unused `read-models/src/holt-winters.ts` with its export. Active anomaly detector remains. | f63bce4b5 / 53517aa18 introduction; private deep-import risk; caller scan, typecheck, full unit coverage. |
| Zep status/no-op cases (3) | `zepProviderStatus` mirrors one env flag; `mirrorTurnToZep` permanently returns undefined. Zero non-test callers. | Keep real `testZepProviderConnection`, snapshot builder, and the legacy-graph no-query guard. | Status helper added 53992f115; caller scan, memory tests, full unit coverage. |
| Voice persona mirror (2) | Tests only an unused array/map; live health code consumes the literal type aliases. | Remove map/helper, retain `VoiceAgentKey` / `VoicePersona` and active health ownership. | b4e9f1781 renamed the mirror; private-export risk; typecheck and unit suite. |
| Source-adapter inventory (1) | Same Gmail-only registry and retired-provider rejection already protected elsewhere. | Keep `pe5-runtime-boundary.test.ts` and executable `PE-DOMAIN-BOUNDARY`, including negative injection. | Boundary passes after deletion; do not infer this is a reason to delete other architecture tests. |
| Corpus hash-length assertion (1) | Any bytes produce 64 SHA-256 hex characters; no pinned expected hash was checked. | Keep the executable 24-scenario locked corpus and actual digest gates. | Only assertion/import removal; epistemic package suite passes. |
| Reference corpus importer (1) | Only its test calls the private importer; bundled PDFs have no callers. | Remove importer and obsolete Water corpus; keep active artifact parsers and their PDF dependency. | Caller/path scan, typecheck, artifact integration proof; no historical DB rows removed. |
| Detached Voice OS package (5) | Entire private package is unused by current Vapi route; its session/confirmation APIs have zero runtime callers. | Keep actual webhook, schema, active orchestration and all DB tables/migrations/history readers. The old package's session API is retired, not claimed to have an equivalent current implementation. | 86a030673 introduction, PE5 b090e7813 narrowed runtime; private deep-import risk; typecheck and real-DB route/trace proof. |
| Canned planner replay layer (3) | Finds hardcoded replay actions against expectations in the same fixture; no planner call. Canned critic responses repeat parser tests. | Keep real PE isolation, Phase6 planning compiler, critic unit and integration tests. Remove fixture, script, CI step and certification filters/report field together. | 3f87e353d, b090e7813; historical report-field consumer risk; all callers scanned and typecheck/planner keepers pass. No live model evaluation claim. |
| Hybrid retrieval wrapper (7) | Only integration tests call `hybridRetrieve`; current snapshot builder calls semantic owner directly. | Remove wrapper/barrel/test together. Keep semantic, corrections, evidence-version and tenant-isolation owners. | 136c3be07, b090e7813; private-import risk; real DB memory/artifact/corrections/isolation checks pass. Wrapper confidence/citation behavior retires with source. |
| Confidence threshold helper (3) | Water answer-action callers retired; no non-test caller of `readConfidenceThreshold`. | Remove helper/test, preserve `DomainPolicy` and active information-action privacy behavior. | 4142623fe, b090e7813; private-export risk; typecheck/unit coverage. |
| Voice formatters (4) | `diagnoseFailure` and `buildConfirmationScript` are only called by their tests. | Remove helpers/map/cases; retain all 13 real `parseSpokenDecision` cases and active orchestration learning caller. | 53992f115, b090e7813; deep-import risk; parser keepers/full unit coverage pass. |
| Voice objective grammar (2) | `parseVoiceObjectiveCommand` has only a test caller; current route validates structured exact-action tools separately. | Remove unused grammar/type/test and P6 filter. Current objective/authority tests remain. | 459688ed7, be1231805, b4e9f1781; path scan/typecheck/current webhook proof. |
| Underwriting insertion-order example (1) | Same two invariants as retained seeded property test across 100 generated unique-key objects. | Keep all canonical production code, fixtures and `underwriting-property.test.ts`. | Full underwriting unit suite passes; no numerical/business cases removed. |
| Duplicate release policy (1) | Unused duplicate module; actual release callers import `p8-water-retirement-policy.mjs`. | Remove duplicate source/test. Default `test:release` now invokes the canonical 5-case policy file, including exact-release/role/migration/protocol negative guards. | Release suite grows from 33 executed cases to 37; inventory and truth checks pass. |

Additional assertion repair: `informationActionKindsAreNonMutating` only checked that object keys have values, not mutability. Removed that unused function and one assertion, retaining the same case's actual READ_ONLY and privacy checks. This does not reduce declaration count.

The orphan UI modules and root `src/lib/supabase.ts` are unreachable from production entrypoints; real auth uses `src/lib/centropy/supabase-browser.ts`. Removed accordion-only Tailwind config with its component; kept shared `cn` utilities used by Concierge. Current build and browser contract pass.

## Broken GitHub monitor cleanup

Removed `planner-live-evals.yml` and `k6-nightly-lite.yml`, their stale generated CI map, and corresponding mutation-inventory entries. Run [35075063078](https://github.com/parammm390/finnor-ai/actions/runs/35075063078) failed on 2026-09-16 because `eval:planner:live` is absent; [35074722649](https://github.com/parammm390/finnor-ai/actions/runs/35074722649) failed because `scripts/k6-load-test.js` is absent. PE5 b090e7813 retired the k6 script; 4b492667c removed these workflows before an older branch reintroduced them.

These schedules provided no executable signal. **No equivalent live planner or staging HTTP capacity monitor is installed by this cleanup.** Historical capacity/release evidence is preserved. Tenant-isolation nightly and release/security workflows remain.

## Security gate failure and dependency repairs

The first PR security workflow failed its OSV reporter gate: it found **8 findings (4 High, 4 Medium) in 3 locked packages**. Comparing the scanner's versions with the pinned base showed all were already on `main`; the cleanup had not introduced them. The base also failed its OSV gate, so this branch updates the affected lock entries and existing backend pin instead of suppressing the scanner.

| Lock entry on base | Advisories | Patched lock entry |
| --- | --- | --- |
| `finnor-os/package-lock.json`: `ip-address` 10.5.1 | [GHSA-h3mg-xc3c-68pw](https://osv.dev/vulnerability/GHSA-h3mg-xc3c-68pw), [GHSA-j6r3-76f7-8jcv](https://osv.dev/vulnerability/GHSA-j6r3-76f7-8jcv) | 10.7.1; existing `finnor-os/package.json` override also updated |
| `package-lock.json`: `brace-expansion` 1.1.18 | [GHSA-6j4f-fj2g-mc7p](https://osv.dev/vulnerability/GHSA-6j4f-fj2g-mc7p), [GHSA-q2hr-2g5m-vwhr](https://osv.dev/vulnerability/GHSA-q2hr-2g5m-vwhr), [GHSA-qhr7-859c-m2p7](https://osv.dev/vulnerability/GHSA-qhr7-859c-m2p7) | 1.1.21 |
| `package-lock.json`: `brace-expansion` 5.0.9 | Same three brace-expansion advisories | 5.0.12 |

The new versions are the fixed versions reported by OSV. A scan of both updated lockfiles found no remaining affected versions for these packages. Backend typecheck and whitespace checks pass after the update. GitHub's pinned OSV scanner and clean-install CI must confirm the pushed locks; that scanner is unavailable locally.

## Identity test repair and controls

Before repair, the Vapi test populated `tenants.ownerPhone`, while production resolves active callers from `users.phoneNumber`. Its negative assertion excluded an obsolete denial phrase and passed the current identity denial.

1. Original assertion/fixture passed on a disposable local database.
2. Strengthening only the assertion to the exact current missing-action validation response failed: actual result was the active-employee denial. The unknown-caller test remained green.
3. Populating the active seeded owner's `users.phoneNumber` made both cases pass. The test cleans up that phone afterward.

This proves owner identity reaches action validation and unknown callers are denied. It **does not claim successful approval**, cross-action/session idempotency, or a live Vapi call. No webhook production logic was changed.

## Verification

| Check | Observed result |
| --- | --- |
| Backend unit + package coverage | Baseline 108 files / 727 passed; final 101 files / 706 passed; zero skips in these runs |
| Focused real-DB integration | 7 files / 37 passed: Vapi identity/status, tenant isolation, corrections, instruction trace, artifact versions, critic review; no Vitest skips; mocked critic responses, not live Bedrock |
| Root unit tests | 3 files / 11 passed |
| Root release suite + mutation inventory | 37 passed; canonical policy included; 19 inventory classifications / 7 active mutators |
| Root production build | `next build --webpack` passed with Next 16.3.4 |
| Current browser contract | Desktop Chromium: 18 passed; each emits screenshot + proof JSON with inputs/steps/observations/hash/replay command |
| Backend typecheck / root lint | Passed |
| Release truth / workspace consistency / P8 zero-resurrection | Passed |
| PE domain boundary | PASS: 824 files, 32 actions, 14 queries, injected-regression negative control PASS |
| Dependency locks / whitespace | Cleanup removed 19 unused transitive packages. The CI follow-up below patches three vulnerable packages; `git diff --check` passes |

The first browser run had 13 passes / 5 failures because the isolated build lacked browser auth configuration. Rebuilding with explicit dummy local public Supabase values exercised signed-out behavior and passed all 18. No authenticated account/provider was used. Default Turbopack could not follow the shared dependency symlink outside the isolated checkout; the installed documented webpack option built successfully. Neither limitation was worked around by weakening assertions or changing application logic.

## Repeatable commands

In a disposable checkout, install both dependency trees with `npm ci` and `npm ci --prefix finnor-os`. Install a matching coverage provider without saving it to the project (`npm install --no-save --package-lock=false @vitest/coverage-v8@4.1.11` from `finnor-os`). Run the same command on the pinned baseline and cleanup branch, using distinct report directories:

```sh
cd finnor-os
VITE_CONFIG_NATIVE_IGNORE_WARNING=true node node_modules/vitest/vitest.mjs run tests/unit packages \
  --coverage --coverage.provider=v8 --coverage.reporter=json-summary --coverage.reporter=json \
  --coverage.include='packages/**/*.{ts,tsx}' --coverage.include='apps/**/*.{ts,tsx}' \
  --coverage.exclude='**/*.test.ts' --coverage.exclude='**/*.test.tsx' \
  --coverage.reportsDirectory=/tmp/finnor-test-audit-coverage
```

Real DB verification used an isolated embedded Postgres 18 on loopback port 43118 with database `finnor_test_audit`; migrations and the existing disposable vertical-fixture seam run against it. For a disposable local PostgreSQL instance, use its URL (never production):

```sh
cd finnor-os
DATABASE_URL=postgres://finnor:finnor@127.0.0.1:43118/finnor_test_audit \
FINNOR_TEST_MANAGED_EXTENSIONS=omit AUTH_DEV_BYPASS=1 \
node node_modules/vitest/vitest.mjs run \
  tests/integration/vapi-webhook-identity.test.ts tests/integration/vapi-status-update-notify.test.ts \
  tests/integration/tenant-isolation.test.ts tests/integration/corrections-routes.test.ts \
  tests/integration/instruction-trace.test.ts tests/integration/artifact-os.test.ts \
  tests/integration/critic-review.test.ts
```

From repository root:

```sh
npm run test:unit
npm run test:release
npm run lint
npm run release:truth
npm run workspace:check
npm run release:p8-zero-resurrection
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:43119 \
NEXT_PUBLIC_SUPABASE_ANON_KEY=test-audit-anon-key npm run build -- --webpack
npm run start -- --port 43117
# In another terminal:
PLAYWRIGHT_BASE_URL=http://localhost:43117 PLAYWRIGHT_OUTPUT_DIR=/tmp/finnor-browser-proof \
  npx playwright test e2e/private-equity-product-contract.spec.ts --project=desktop-chromium
```

## Explicitly retained audit gaps

- The CI-excluded Phase6 conversation-context suite contains nine historical mixed fixtures plus genuine principal/thread privacy concerns. It needs owner-aligned fixture repair and security keeper mapping; it was not deleted for being excluded or stale.
- The old Phase9 workstation suite still names the removed `.pw-*` UI. Its owner-action/authority scenarios are not individually mapped to current end-to-end keepers, so it remains for repair rather than losing that intent to hit a quota.
- The cancellation predicate and attention-order helper remain because their independent boundary/ordering proof needs a current owner-level keeper before consolidation.
- Credentialed live provider runs, full CI/release certification, mobile browser projects and whole-repository coverage were not executed locally in this cleanup. No claim is made that all remaining tests or historical code are useless or exhaustively certified.

## Exact removed declarations (baseline names)

- `finnor-os/packages/epistemic-runtime/src/locked-corpus.test.ts:16` — has an exact SHA-256 over the checked-in frozen evidence fixture
- `finnor-os/tests/integration/hybrid-retrieval.test.ts:46` — returns structured facts merged by source, and semantic hits alongside them
- `finnor-os/tests/integration/hybrid-retrieval.test.ts:57` — can enforce a canonical-only read boundary when semantic context is not requested
- `finnor-os/tests/integration/hybrid-retrieval.test.ts:69` — citations carry structured facts first, in the receipt-evidence shape {source, ref, timestamp}
- `finnor-os/tests/integration/hybrid-retrieval.test.ts:80` — confidence is high whenever a structured fact exists, regardless of semantic quality
- `finnor-os/tests/integration/hybrid-retrieval.test.ts:89` — confidence is low with no structured facts and no strong semantic hit
- `finnor-os/tests/integration/hybrid-retrieval.test.ts:98` — a semantic-memory failure never breaks retrieval when structured facts alone can ground the answer
- `finnor-os/tests/integration/hybrid-retrieval.test.ts:112` — with zero structured facts, retrieval is semantic-only but still returns real citations
- `finnor-os/tests/integration/voice-os.test.ts:73` — resolves the tenant's registered owner line to role 'owner'
- `finnor-os/tests/integration/voice-os.test.ts:81` — an unrecognized number resolves to role 'unknown' — never silently owner
- `finnor-os/tests/integration/voice-os.test.ts:86` — openVoiceSession is idempotent by callExternalId
- `finnor-os/tests/integration/voice-os.test.ts:92` — a session only ever resolves ITS OWN open confirmations — the cross-session bug fix
- `finnor-os/tests/integration/voice-os.test.ts:129` — createHandoff records an escalation for an unresolved caller
- `finnor-os/tests/planner-evals/replay.test.ts:11` — contains at least 60 labeled golden cases across normal, must-ask, repair, and health-degraded paths
- `finnor-os/tests/planner-evals/replay.test.ts:16` — meets the 95% replay action-type-and-parameter gate
- `finnor-os/tests/planner-evals/replay.test.ts:21` — meets the 90% seeded critic gate
- `finnor-os/tests/unit/confidence-threshold.test.ts:21` — returns the configured number
- `finnor-os/tests/unit/confidence-threshold.test.ts:25` — returns undefined when unset — never fabricates a default
- `finnor-os/tests/unit/confidence-threshold.test.ts:29` — returns undefined for a non-number value rather than coercing it
- `finnor-os/tests/unit/consolidated-memory.test.ts:12` — zepProviderStatus reports not configured when no env var is set
- `finnor-os/tests/unit/consolidated-memory.test.ts:17` — mirrorTurnToZep resolves without throwing and makes no network call
- `finnor-os/tests/unit/consolidated-memory.test.ts:28` — reports configured:true once ZEP_API_KEY is present (still untested against a real account)
- `finnor-os/tests/unit/holt-winters.test.ts:5` — returns 14 non-negative bands for a known weekly seasonal series
- `finnor-os/tests/unit/holt-winters.test.ts:11` — refuses insufficient history
- `finnor-os/tests/unit/intelligence-forecasts.test.ts:5` — keeps 14-day bands unavailable until two weekly seasons of real daily history exist
- `finnor-os/tests/unit/reference-corpus.test.ts:5` — rejects a changed source before parsing or writing any document
- `finnor-os/tests/unit/source-adapters.test.ts:5` — registers no legacy provider-to-business mappings
- `finnor-os/tests/unit/underwriting-core.test.ts:100` — serializes and hashes without object insertion-order drift
- `finnor-os/tests/unit/voice-objective-control.test.ts:5` — recognizes explicit start, inspect, interruption, continuation, and redirect commands
- `finnor-os/tests/unit/voice-objective-control.test.ts:14` — does not reinterpret ordinary customer/action language as objective control
- `finnor-os/tests/unit/voice-personas.test.ts:5` — maps only source-owned personas to safe product keys
- `finnor-os/tests/unit/voice-personas.test.ts:12` — does not create an agent edge for unknown or missing persona values
- `finnor-os/tests/unit/voice.test.ts:85` — names the failing integration and asks for the fix on credential errors
- `finnor-os/tests/unit/voice.test.ts:91` — names the integration on outage errors without asking for a key
- `finnor-os/tests/unit/voice.test.ts:96` — degrades gracefully with no integration tag
- `finnor-os/tests/unit/voice.test.ts:103` — appends the yes/no ask
- `scripts/release/release-evidence-policy.test.mjs:13` — supplier canary proof is exact-release, role, migration, and protocol locked

## Evidence integrity

SHA-256 values for local coverage and validation evidence (raw outputs remain outside source control):

- `test-audit-baseline/coverage-summary.json`: `6fb3c9278269c0ebe022a583c1e0a0cffacbc4a0b24bf771c052500e1a1090fd`
- `test-audit-final/coverage-summary.json`: `735cb719884bcede90a5d8dafd22ac3722d9420043e0a7bbd126dc8ca44b1a73`
- `test-audit-final.log`: `d245cfc96fdeb00503bbc6e84e451feeea851c2df268124f30e34fa614f3a1ac`
- `test-audit-integration-final.log`: `4f8c65241795e24524e5f762255bc2f55abbccbad4105cc10d76ecd0fa0d23c7`
- `test-audit-identity-control.log`: `1f17140dd275bee98c9bf2b717af11e45b6267845b0eaa0f9af1cf796e749611`
- `test-audit-browser-final.log`: `b2c0cc69afb40f520b6640be6ae9ab3df490dd70d2a3144bf31d0dfae652b69e`
- `test-audit-release-tests-final.log`: `41a4b55239d3a54196fbedff56f87b2700e02a444ed11c35b44de4349472eefb`
