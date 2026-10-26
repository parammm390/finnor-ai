# Capability additions: delivery and rollout

This change adds Docling, Nango, Langfuse, Modal Sandboxes, DuckDB, GEPA, ShinkaEvolve, PyWhy, PageIndex, and Parallel to the existing API, HEAVY queue, worker and Centropy document/source views. WorkOS is outside this change.

Authenticated submissions freeze permitted inputs, retain idempotency and remote execution identities, and publish private derived evidence only after current authority and lease checks. The five appended migrations follow the existing Y4 head. Existing runtime owners and numerical libraries remain intact. Reviewed planner candidates can affect owner background planning only; they do not confer business execution authority.

## Verification

- The local delivery harness passed 57 cases using actual HTTP route handlers, ordinary-role PostgreSQL, durable jobs and Python engines. It uses development-header identity and explicit provider protocol fixtures; it is not a deployed identity or hosted-service certification.
- Six actual React/Chromium component cases passed with local transport fixtures.
- A real provider-origin signed Nango sync callback reached the native handler, woke the HEAVY job and materialized public records; the initial auth-binding notification remained a local test. The owned test connection was deleted.
- Hosted qualification separately exercised Langfuse export/readback, Modal sandbox isolation/termination, PageIndex source-bound results and cleanup, and Parallel operations with owned-resource cleanup. These results do not establish generalized quality gains, private-source access or an invoice ceiling.
- Full frontend TypeScript compilation and the backend compiler checkpoint passed. Release preparation additionally verifies deployment truth, mutation inventory, CloudFormation semantics, and relocated worker source custody.
- The exact production worker image, required GitHub checks, production deployment and authenticated deployed journey are mandatory remaining release gates until their actual results exist.

Rerun local delivery from `finnor-os/` with a provisioned Python environment and offline Docling model cache:

```sh
FINNOR_CAPABILITY_PYTHON=/absolute/path/to/python \
FINNOR_VERIFY_MODAL_PROTOCOL=1 \
FINNOR_CAPABILITY_EVIDENCE_DIR=/absolute/path/to/fresh-evidence \
node --import=tsx scripts/release/run-capability-delivery-e2e.mts
```

Use `scripts/release/run-capability-ui-e2e.mjs` from the repository root for component verification. Every driver retains its input/source cut, cases, qualifications and rerun command. Hosted drivers require explicit opt-in and create only owned synthetic resources.

## Deployment configuration

`topology.capabilityUpgrades` in the production contract owns the non-secret flags and eight Secrets Manager references. HEAVY receives the execution references; INTERACTIVE/BACKGROUND receive only Langfuse telemetry references; REALTIME receives none of the additions. The existing isolated model-runtime CloudFormation stack supplies read permissions for those references. API configuration preserves existing managed references before adding the capability references. Secret values must never be committed or embedded into builds.

Before enabling the release, provision all eight references in the selected project Region and apply the reviewed provider permission stack. Then use the canonical protected production release workflow, which retains clean-main source, exact image, certification, OIDC, migrations, fleet and parity checks. No local authorization substitute or direct main push is provided.

The daily submission limits default to one for the hosted computation paths. They bound accepted submissions, not provider billing. The Nango catalog initially permits the fixed read-only public-repository sync; private provider enrollment is not claimed.

The production CloudFormation template uses shallower indentation in its top mapping levels to remain within the existing inline quota. The expanded and compact forms were parsed and compared as complete structures before acceptance; no resource semantics were changed by that formatting step.
