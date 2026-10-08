# Coordinated production workflow audit

Base: `059ecaaba536c6b69732c831c195fb7ddcd6382a`.
Failed production run: `37848678805`.

The run completed, rather than waiting behind an old production run. The
canonical graph and root release gates passed. `phase5-readiness` failed the
domain boundary because it required the native-only `harness_program_v1` intent
in the flat public query schema. Post-merge certification correctly refused
mutation authority. The deployment job never ran.

## Verified repairs

- Check all sixteen public query intents against the actual public request
  schema. Keep the seventeenth, internal P1 reader native-only. Missing public
  branches and accidentally exposing the native branch both fail.
- Preserve authenticated principal, original Work/Input currentness, RLS,
  retired-token negative controls and the complete seventeen-intent registry.
  No public endpoint or authority grant was added to appease the old guard.
- Run the same manifest and domain-boundary guards in required PR CI, before
  the full backend corpus. Retain the new integration evidence with CI logs.
- Verify committed action manifests without rewriting their timestamp or source.
  Intentional regeneration is `npm --prefix finnor-os run release:manifest -- --write`.
- Remove the standalone root push trigger, which repeated the same callable root
  gate already required by the production workflow. Both PR and production
  callers remain.
- Remove the duplicate backend typecheck inside the frontend quality step.
  Preserve the named API typecheck gate and its protected environment.

## Whole-path repairs

- Both active certification runners enable and verify PostgreSQL commit tracking
  before migrations. Scope 5 obtains historical cutoffs as native UTC ISO6 text,
  without a JavaScript `Date` round-trip. Scope 4 keeps its original historical
  assertions and measures a meaningful observed historical benchmark.
- Production preflight checks the exact Supabase project, session port, database,
  and owner/application login identities. It reads only the existing canonical
  managed database secret, without persisting or logging the value, and checks
  effective non-superuser, non-BYPASSRLS, non-owner application access and tenant
  RLS. All production owner consumers use the same positive target check.
- Final P8 runtime verification sends the existing API protection bypass header.
  Credential-free static verification remains credential-free. Final readiness
  uses one policy matching the actual `water_retired` authority contract and
  verifies exact release provenance.
- An exact finalized compute rerun accepts only the standard CloudFormation
  no-change response, then independently rechecks template, parameters, image,
  database fences, four-class fleet and ingress. It emits a verified-no-op receipt
  and never executes an empty change set. Ordinary rollout, drain and rollback
  restrictions remain.
- Canary preparation retains separate SHA/component contexts and hash receipts.
  Later deployment verifies and uses those exact prepared bytes without rebuilding.
  Modified source, lockfile, role, project, output, receipt or symlink is refused.
- P6/P7 certification selects the current executable query-surface proof instead
  of a deleted test path. No mandatory scientific case or original clock changes.
- All new release helpers, declarations and fixtures are inventoried. Seven
  active production writers and four independently scoped AWS sessions remain.

## Validation and limits

Coordinated release governance passes **80/80**, including the original policy
checks and 38 end-to-end compute/artifact fixtures. The four new admission suites
pass **7/7** and write rerunnable JSON evidence. Both TypeScript projects,
deployment truth and mutation inventory pass. Root lint has no errors and retains
three existing React-hook warnings.

Full original Scope 4/5 certification passed after inventory integration with
stable source pins. Scope 4 completed all ten gates, including six bounded
benchmark operations. Scope 5 passed eighteen integration gates and eight
performance/equivalence scenarios. Both retain their external-provider
qualifications. Results from a local uncommitted worktree are not clean exact-SHA CI proof.
Mocked cloud fixtures are not provider deployment proof.

### Explicit AWS permission bootstrap

`infra/deployment/production-database-admission-policy.json` records only the
canonical database-secret read, its same-secret Secrets Manager KMS dependency,
and `GetTemplate` on the production stack. The secret permissions originate from
IAM Policy Autopilot 0.3.0 over the actual SDK helper; resource and encryption
context refinements narrow that output. `GetTemplate` is the named read operation
needed by the independent compute no-op proof.

Both read-only preflight sessions and the declarative deploy role include the
single-secret read. Only the compute session includes the stack-template read.
The CloudFormation template is **50,515/51,200 bytes**; its compact role policy is
**5,781/10,240 bytes**. Simple action-list compaction changes no semantics. No
other resource, parameter, trust condition or rollout allowlist changes.

The existing live deploy role must receive these permissions through an approved
infrastructure baseline update **before** managed-secret preflight. A direct role
change alone does not synchronize the stored CloudFormation template. Do not
self-grant permissions from the workflow or widen the four-class rollout
allowlist to smuggle an IAM update into an application release. Local AWS login
was expired at verification; no live role permission or secret read was proved,
and no IAM/cloud mutation was performed.

The failed production run never deployed. This repair does not prove backup
freshness, recovery rehearsal, external providers, field admission or prior
scientific qualification. Dormant full Scope 3 and PE chains are not invoked by
the production workflow; their stale case/report prerequisites were recorded,
not relabeled as current passing certification or replaced by an optional long
run.

Keep canonical exact-SHA certification, the protected production environment,
OIDC identity, source cleanliness, immutable image binding, backup/restore,
migration locks, both supplier canaries, all four compute classes, parity,
readiness, governed retirement and rollback requirements. Do not delete a gate
because its phase name or historical evidence is old.

Active M5 DecisionKernelCompiler and P8/M6 HarnessEvolution remain outside this
repair. Existing Water-retirement safety controls are not those active phases.
