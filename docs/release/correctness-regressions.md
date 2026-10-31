# Correctness regression commands

These checks exercise the five repaired issue groups. Each driver writes inputs, observed results, source identity or qualification limits, and a rerun command to its output folder. Use fresh evidence folders outside the repository. The prior architecture reports describe the pre-repair source; they are retained historical evidence.

| Issue | Command | Verification scope |
|---|---|---|
| Concurrent private session memory | From `finnor-os`: `npm run verify:memory -- --out <directory>` | Real disposable Redis; concurrent shared-client and eight-process appends, principal isolation, exact JSON values, cap, deduplication, TTL and corrupt-data refusal. Requires loopback `REDIS_URL` and `FINNOR_TEST_REDIS_DISPOSABLE=1`. |
| Named operation delivery | From root: `node scripts/audits/verify-capability-proxy.mjs --out <existing-directory>` | Real proxy, matcher and installed NextRequest over loopback; every actual named operation, unknown-operation denial, no-caller denial and current generated catalogue. Upstream business results are fixtures. |
| Browser OAuth transport | From `finnor-os`: `npm run verify:oauth-proxy -- --out <directory>` | Chromium, real Google start/callback owner, one-time PostgreSQL state and connection rows; explicit local auth, provider and secret-store adapters. Includes missing/tampered/foreign/replayed state and redirect refusal. No real OAuth consent or cloud effect. |
| Nested lease renewal | From `finnor-os`: `npm run verify:job-heartbeats -- --out <directory>` | Actual job queue, compute permits, real elapsed lease periods, serial renewals, retirement, expiry and successor fencing in disposable PostgreSQL. |
| Scheduled-tool correctness | From `finnor-os`: `npm run verify:tenant-probe -- --out <directory>` and `npm run verify:planner-eval -- --out <directory>`; from root: `node scripts/audits/verify-k6-probe.mjs --k6 <executable> --out <directory>` | Actual native tenant routes and CLI; complete 41-case planner/compiler run with local provider adapter and deliberately bad proposals; actual k6 runtime with positive and negative protocol controls. These results do not certify live model quality or staging performance. |

Run disposable checks with a minimal environment. Do not pass production connection strings, owner-transport configuration, cloud credentials or provider credentials to fixture drivers. The native database helper creates an isolated PostgreSQL instance. Tenant and OAuth checks use the application role. The queue proof explicitly uses the separate finnor_worker role, with administrator access limited to fixture setup and expiry challenges.

## Scheduled jobs

`planner-live-evals.yml` now invokes the present `eval:planner:live` script. It evaluates current Core/Private Equity candidate plans through the actual planner and compiler, requiring all 41 labeled cases and a provider call per case. It performs no business execution or database seeding. The scheduled job supplies the explicit Groq route, credential and pacing. A local fixture pass establishes that the evaluator detects wrong/rejected output; it is not a passing live Groq score.

`tenant-isolation-nightly.yml` calls the current read-only PE root probe. Configure distinct tenant JWTs and these **current** marker secrets:

- `TENANT_PROBE_STAGING_MARKER_ROOT_REF`
- `TENANT_PROBE_PRODUCTION_MARKER_ROOT_REF`

Each is JSON such as `{"entityType":"external_organization","entityId":"<UUID>"}` for an independently provisioned root visible to tenant A and absent from tenant B. Retired household marker secrets cannot qualify the current PE runtime. Existing environment URL, JWT and deployment-protection secrets remain step-scoped. Missing configuration fails the job and produces a failed evidence artifact.

`k6-nightly-lite.yml` uses the current action intake, Work readback, attention and exact effect confirmation contracts. Configure a dedicated disposable staging tenant and:

- `K6_STAGING_FIXTURE_DEAL_ID`
- `K6_STAGING_FIXTURE_WORKSTREAM_ID`

The corresponding Deal and Workstream must belong to that staging tenant. The caller must be its owner. The script refuses canonical production origins and a target whose release metadata does not identify staging. It creates only synthetic run-labeled Findings for approval, checks that the effect belongs to the Work it created, and confirms its exact reviewed hash. It never picks an unrelated pending action. The retired marketing webhook secret is no longer used.

Provider live quality, real tenant JWT visibility and actual staging load results require those configured scheduled jobs to run on the final committed source. Local fixture proofs do not replace them. No scheduled live run, deployment, new secret provisioning or production mutation is performed by the regression commands above.

## Release and type checking

The retained legacy release aliases are documented in [legacy-command-aliases.md](legacy-command-aliases.md). They invoke actual canonical release checks. The mutation inventory still fails closed on unclassified release/governance paths and retains the same seven production writer mechanisms.

Backend TypeScript checking now includes audit `.mts` drivers. Microsoft live-test source kinds are narrowed through the actual provider capability catalogue; unsupported Nango source kinds are refused rather than cast to Microsoft kinds. If an iCloud placeholder prevents a canonical check from reading a source file, record that limitation explicitly. An available-source compiler result cannot be presented as the unmodified full command.
