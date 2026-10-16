# Release #207: pinned Vercel CLI authentication repair

Failure cut: merged `0e06b7e6fb1f2fde4b907887043f010903d5f8a7`, run
38948730290, release job 117139298567, 2026-10-16 19:47:30 UTC.
All post-merge gates and exact Linux image smoke passed. The first production
artifact pull failed with `No existing credentials found`. No mutation
authorization, ECR publication, live migration, Vercel deployment or ECS rollout
was reached.

Cause: installed/pinned Vercel 50.15.1 checks its auth file / token argument
before assigning VERCEL_TOKEN from the environment. The old source checks merely
asserted that environment plumbing existed. The later protected-configuration
pull had the same defect.

Finite repair boundary, registered before implementation:

- Authenticated pull and guarded deploy must use the actual CLI's global auth
  configuration, with a fresh private directory outside source/build output.
- Never put the token in OS arguments, command logs, build environment or
  prepared artifacts. Delete the private configuration before returning, on
  success, child failure, missing executable and write failure.
- Missing/empty tokens fail before child execution. Preserve the exact child
  failure status and redact accidental token echoes from captured output.
- Standalone wrapper permits read-only identity/project inspection and pull,
  not deploy; actual deployment remains behind the existing mutation guard.
- Check the real pinned CLI authentication boundary before expensive image
  work. Keep original source/image/database/security/production gates intact.
- Cover all four preparation/deployment targets and the protected API config
  pull with the same helper. No new AWS permissions or protected activation.

Verification: finite child-process boundary scenarios (explicitly mock-provider,
not deployment proof), existing governed artifact handoff and release-policy
checks, real installed 50.15.1 CLI credential recognition, then the exact hosted
candidate checks and governed production workflow. Retain original failure;
rerun only after this supported repair. Final live parity and authenticated
deployed Work remain mandatory; neither a local fixture nor a green PR is live.

Observed local checks:

- Actual installed CLI is 50.15.1. With the private auth config and an explicitly
  invalid fixture token it reaches Vercel token validation (`specified token is
  not valid`), rather than failing the earlier missing-credentials bootstrap.
- The locally saved token alone was rejected by the isolated, non-refreshing
  probe; no project access or deployment success is inferred. The GitHub secret is
  separate and its validity is unknown until the new early hosted check runs.
- Existing canary durable artifact scenarios and release policy checks passed.
- The new child-process E2E passed after resolving macOS `/var` vs `/private/var`
  path spelling with filesystem identity; all failure evidence was retained in
  the command results. Receipt: `/tmp/finnor-vercel-auth-e2e-receipt.json`.
- CodeRabbit reviewed all ten changed files. Its two findings prompted refusal
  of short token/config overrides and argument separators, plus explicit launch
  failure diagnostics. Follow-up review completed with zero findings. The
  release harness passed 81/81; the affected API/auth run passed 6/6; the final
  auth E2E and workflow validation passed. Mock-provider evidence remains
  explicitly separate from actual deployment acceptance.
