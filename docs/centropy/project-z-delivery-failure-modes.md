# Project Z delivery: failure model before implementation

Current authority permits a new isolated local test stack on an existing owned
computer, not production access, paid provisioning or PR publication. Existing
phase contracts, security stops and resource/admission budgets remain intact.

## Native verification setup

- Never inherit production/provider/remote Auth credentials. Start from a
  minimal explicit environment. Do not load repository .env files.
- Use real pinned Supabase Auth, not a fake owner, mock token verifier or auth
  bypass. Verify the official archive hash before extracting/executing it.
- Bind DB/Auth/gateway/frontend/API only to loopback. Refuse occupied ports
  before initializing, migrating, seeding or starting any process.
- Create fresh exclusive state with private generated secrets. Keep secrets,
  passwords, tokens, raw environment and authenticated responses out of logs,
  source, PR contents and verification artifacts.
- Keep actual test Auth user identity bound to seeded tenant/owner records.
  Both frontend and API must use the same isolated Auth project.
- Disable provider effects. Retain original tenant/Work/provenance identities,
  S5 resources, S6 UNKNOWN and physical recovery obligations.
- Observe actual child exits/readiness; stop only children owned by this stack.
  Initialization, migration, seed, authentication and browser failures are
  failures, never skipped passes. Preserve partial results without retries.
- Bound resources and startup; no dependency/cache cleanup or disk resizing.
  Use existing compiled builds only when the selected profile/build identity
  actually matches. A login check is not phase semantics qualification.
- Retest real Auth after app migrations, not only before them. The first
  owner smoke failed with HTTP500 and an original Auth `users` lookup missing.
  Hypothesis to verify before correction: app migration changes the shared
  cluster role search_path, overriding the Auth database's default. Keep the
  Auth role's database-specific namespace independent; never relax auth.
- The second smoke observed real password login200 and original owner API200,
  but browser login failed. Original OPTIONS returned204 with no CORS headers,
  and the browser sent no password POST. The gateway must advertise only the
  exact owned frontend origin and bounded supported headers/methods, forward
  actual Auth responses unchanged, and continue rejecting other origins.
- A single CI controller must create fresh exclusive private state, execute
  the pinned installer and genuine Auth/app/browser processes, require one
  unskipped owner login/reload, and stop only its own children on every exit.
  Upload only its sanitized result, never private environments, Auth/session
  responses, private logs or browser traces. This is not mechanism admission.
- Measure the unchanged four-GiB available-memory and disk startup guards
  before installer/server children. Required CI invocations must retain the
  two-CPU affinity, not infer it from a thread-count environment variable.
  Refusal starts no stack. The earlier transport pass does not establish
  that these newly recorded preflight measurements were made at that run.

## Automated delivery integration

- Reuse the existing universal PR verdict and production-release graph.
  A Project Z result must be consumed by both, not an optional green badge.
- Run actual original-semantics process commands on fresh checkout-relative
  paths, not coordinator-only receipts, old installed reports or hidden assets.
- Retain failures and reports on CI failure. Secrets stay unavailable to public
  engineering checks. Pin actions/toolchain and keep least-privilege permissions.
- Keep the shared public-process log open until both stdout and stderr close.
  Either pipe ending first must not discard the other pipe's failure output.
- A cancelled, skipped, missing or failing required Project Z result must
  reject the PR/release aggregate. Unrelated changes may be explicitly N/A.
- Preserve existing source/backend/root/security/replay/readiness requirements
  and stable required-pr-verdict name. Do not turn a public engineering check
  into protected/native/business acceptance or fabricate held Z5 delivery.
- Z2's new structural qualification must run from the current checkout, not a
  worker's absolute evidence/reference paths. Freeze all 32-by-8 original
  inputs and independent expectations before candidate execution, retain the
  pre-code critical dispositions, then invoke the actual original-checker
  process mode. Require all 256 dispositions, 248 useful supported positives,
  all 254 critical probes and unchanged source. Partial/empty reports and
  failed registration/process exits must fail CI. Record both controller
  stages and retain failures. A repeatable public CI replay is not a new
  protected admission or another independently accepted qualification.

Verification will use existing process/E2E checks plus a pre-code workflow
integration exercise for required-result failures, source classification and
reusable workflow wiring. No post-code unit-test campaign.
