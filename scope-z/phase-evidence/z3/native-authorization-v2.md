# Existing-target native execution contract, not an authorization

Current native execution is **NOT_RUN**. The current user prohibition remains
binding. This document, its template and a connected database are not permission
to execute. No target, test owner, grant, listener or database is created here.
Do not run the old v1 contract. Do not write a coordinator acceptance gate.

After explicit user authority for an existing isolated target, the coordinator
can deliver a private JSON file with schema
`finnor.z3.existing-disposable-authorization.v2`. The driver requires:

- `coordinatorAuthorized:true`, `provisioningAllowed:false`, `effectsAllowed:false`.
- `workerTerminationAllowed:true`, `workerSuspensionAllowed:true`,
  `listenersAlreadyOwned:true`, `readOnlyDatabaseObservationAllowed:true`,
  `allZ3JobsOwned:true`, `crossTenantObservationAllowed:true`.
- `requestHistoryExhaustionAllowed:true`, authorizing the final existing test
  Work's finite 256-row request-history saturation, with no new physical job.
- `authProjectDisposable:true`, `frontendApiAuthProjectSame:true`. Loopback
  listeners alone do not establish Auth or provider isolation.
- Absolute `repository`, canonical `workerEntry`
  (`finnor-os/scripts/project-z/z3/worker-entry.mts` within that repository),
  `producerBundle`, and `checkerSource`.
- Exact approved loaded `runtimeDigest`, `tenantId`, `principalId`, loopback
  HTTP `frontend` origin, `databasePort`, and `databaseName`.
- `foreignOwner:{tenantId,principalId}` identifying a different, already
  existing real owner in a different authorized disposable tenant.
- Exactly three distinct pre-existing original Work cases, ordered CLAIM,
  STRATEGY, OBSERVATION:
  `cases:[{workId,mountedWorkPath},{workId,mountedWorkPath},{workId,mountedWorkPath}]`.
  Every original Work must already have the accepted declared native mandate,
  current original P1/compiler/S5 lineage, at least three remaining attempts,
  eleven steps, three original S5 requests and sufficient original deadline.
  The driver refuses inadequate allowance; it never replenishes it.

Environment **names only**: `FINNOR_Z3_DISPOSABLE_DATABASE_URL`,
`TEST_OWNER_EMAIL`, `TEST_OWNER_PASSWORD`, `TEST_FOREIGN_OWNER_EMAIL`,
`TEST_FOREIGN_OWNER_PASSWORD`, `FINNOR_ENVIRONMENT=staging`.
`AUTH_DEV_BYPASS` must be absent and NODE_ENV must not be production.
Credentials and authorization files stay private and outside delivery archives.
The observation connection must be a non-superuser, non-RLS-bypass app role.

Future invocation, only after that separate permission:

```sh
node /absolute/repository/scripts/project-z/z3/native-e2e.mjs \
  --authorization=/absolute/private/authorization.json \
  --output=/absolute/fresh-owned-evidence-directory
```

The finite driver uses mounted submission with only original Work ID and retry
key, actual physical queue claims, real SIGKILL/close observations, a live
lease-expiry suspend/resume refusal without a successor, two observed S4
prefixes, independent original-arena and cursor/memory replay, unchanged S6
UNKNOWN, conserved original P1/S5 debits, nonce-loss deduplication, caller
dependency refusals, mounted reload and real cross-tenant authenticated HTTP
refusal. The Node worker is not a tsx CLI proxy and inherits no provider
credentials or dotenv file. Failures retain original IDs and cost gaps.

This driver does not provision an unsupported/revised mandate, mutate grants,
settle an effect, administer protected cases, or establish infinite physical
progress, equipped superiority or financial qualification. Additional
adversarial native mutations need their own lawful existing owner actions and
current authority. A finite driver's PASS is not coordinator phase acceptance.
