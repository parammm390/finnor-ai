# Production artifact repair

## Observed failure and missing coverage

Production run `37867941882`, release job `113621072740`, failed at API
artifact preparation on merged source `713226e4c37ad83d1fe9745cbb032962a333c841`.
The frontend built. API webpack rejected the native `fs-ext` dependency and
treated `createRequire().resolve("tsx")` as requiring an ESM module.
PR CI had not executed this actual production artifact path.

The prewritten real build/start test also exposed undefined bundled
`import.meta.dirname`, deployment-host absolute source filenames, and the
conflicting `policies/[tenantId]` and `policies/[operation]` route segments.
Fresh, isolated Vercel builds exposed the missing native workspace dependencies
and the API builder's duplicated `finnor-os` tracing prefix. These failures were
retained locally and repaired without another publication.

## Repair

- Preserve native Node resolution, original source bytes, source hashes, dynamic
  producer loading, and the canonical repository layout in emitted functions.
  The source-custody adapter is included in P4's attested source inputs.
- Declare the native private-equity runtime dependencies. Install the locked
  backend root dependencies with `npm ci --include-workspace-root`, scoped to
  installation rather than leaking the option into `npm run build`.
- Build API artifacts from an isolated complete repository context. Normalize
  the observed remote `apps/api` root to that context's `finnor-os/apps/api`.
  Retain durable, hashed API output for the existing later `--deploy-only` step.
  Do not rebuild under production database/AWS credentials.
- Materialize Vercel's local `filePathMap` and the locked native production
  dependency closure before saving output. Keep canonical workspace aliases and
  route aliases as bounded relative links. Reject escaping links and mappings;
  preserve links verbatim during publication. Omit third-party debug source
  maps, not executable inputs or native attestation files.
- Consolidate the policy dynamic directory. Preserve the public tenant URLs,
  tenant comparison, owner restriction, and policy semantics.
- Pin Node 22 in application engines, matching the existing release toolchain
  and native addon ABI instead of the observed Vercel project default Node 24.
- Add a mandatory credential-free Linux artifact job to callable backend CI.
  It uses the actual pinned Vercel CLI to build frontend, API and both canary
  roles. It exercises emitted native functions independently of the checkout,
  source identity and producer loading, compiled API release metadata, and
  fail-closed HTTP routes. JSON receipts and logs are retained on failure.

## Reproduction and qualifications

```sh
FINNOR_ARTIFACT_EVIDENCE_DIR=/absolute/new/evidence \
  node scripts/release/production-artifact.e2e.mjs
node --test scripts/release/api-artifact.e2e.test.mjs
node --test scripts/release/worker-image-layout.e2e.test.mjs
npm run test:release
```

The real artifact test has no production credentials. Its project settings are
explicit read-only observations of the four canonical projects, not live
environment values. The controller lifecycle tests use mock providers and do
not qualify deployment. Local Darwin results do not qualify Linux or external
providers. Native/scientific admission gates and previous unqualified claims
remain unchanged.

Final local `production-artifact-full-09/receipt.json`: PASS, Node 22.22.3,
Vercel CLI 50.15.1. All four real builds succeeded. The emitted function loaded
P4 (725 source files), M4 (727 source files), and both authentic producer ports
without dependencies from the original checkout. Its uncompressed size was
237,134,649 bytes, below 262,144,000. Release metadata returned 200 and all five
unauthenticated protected-route probes returned 401.

Final release governance: 80 tests PASS. Durable API lifecycle: three E2Es PASS,
including retained file mappings/aliases, missing artifacts, tampering, and
output escape refusal. Worker-layout E2E, root types, scoped lint, actionlint,
deployment truth, and mutation inventory passed. Earlier failed build attempts
and the pre-repair file-map lifecycle failure remain retained separately.

The user authorized a normal direct push of the verified repair to `main` if
existing permissions allow. No branch protection, approval policy, production
authorization, or AWS permissions are weakened. No manual AWS action is part of
this repair; the external bootstrap prerequisites remain separate.
