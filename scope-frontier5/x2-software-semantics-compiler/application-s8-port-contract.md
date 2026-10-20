# FRONTIER5.X2 application S8 port — pre-code contract

Frozen before implementing `application-port.ts` or `application-consumer.ts`.
Scope: the existing CapabilityEvolution owner/journal only. This is not a new
authority store, executable-code admission, protected qualification, production
activation, external behavior proof or gain claim. Preserve the existing
evaluator/promoter **principal** separation and legacy S5/P5 behavior.

## Acceptance and failure model

1. Only the existing authenticated S8 service accepts commands. Proposer,
   independent evaluator and promoter are distinct principals; Ed25519 keys
   are distinct as well. Separate keys/tokens on one principal do not suffice.
   A generated model, accepted-looking check or local configuration cannot
   evaluate, admit or activate itself.
2. ApplicationActionModel and ApplicationModelCheck use the existing strict
   native codecs and content identities. S8 candidates contain closed typed
   reference/dependency data, not executable modules, callbacks or credentials.
   Resolve the actual retained model/check through the existing S8 consumer
   route to the native S4 owner commitments. A caller's hash is not an owner
   receipt. Missing native references refuse admission/use.
3. Bind the exact original parent, producer, checker, grammar, independent
   observer contracts and observer code, private binding references, transport
   code/contract, runtime, model/check/semantic revisions, source/lock/schema
   cuts, application/account/acting principal/role/profile grant, rights,
   supported domain, validity code, resources and original deadline.
   Substitution, duplicate coverage, path escape, changed loaded sources,
   stale/revoked keys, unaccepted checks and expired bounds refuse use.
4. Signed registration freezes the independent case commitments, oracle,
   original evidence and dependency digest. Signed evaluation must match that
   registration. Cases are one-use across the journal, including failures and
   restarts. Refused/inconclusive evaluations stay retained. A supported
   development result requires zero reported false-valid/false-invalid,
   authority, duplicate-effect and false-completion violations.
5. Admission and activation are separate signed promoter events. Activation
   has a compare-and-swap generation/predecessor within the exact original
   parent/application domain; replacing one domain cannot revoke unrelated
   domains. Revoke fences future use and recheck. Neither event grants an
   execution right or protected qualification.
6. USE and RECHECK require a current native validity reference, not candidate
   self-declared currentness. Its owner-retained preimage binds the model/check,
   parent, application/profile/grant, request and dependency digests, current
   observation evidence, liabilities, checked time and expiry. Native runtime
   must actually perform canonical Work/grant/resource/application checks
   before publishing that reference and again at physical egress. S8 receipt
   authentication is not an external state or legal-authority oracle.
7. Leases bind the exact target, operations, input/composition, original S5
   allocation/reservation/resource envelope and deadline. Reservations/use
   counts are cumulative and never reset on recheck, restart, revocation,
   reconciliation or failed outcomes. RECHECK retains additional evidence and
   liabilities in the same journal; idempotent USE/RECHECK replies must still
   pass fresh currentness checks, never resurrect cached authority.
8. Reconciliation may retain native S6 transition evidence after revocation
   or expiry, under still-current owner configuration. It cannot undo effects,
   release liability budgets, manufacture a completion oracle, change a
   possible effect identity or grant economic/causal credit.
9. Every application command is development-only. A reviewed protected
   lifecycle policy or a claimed protected artifact is refused. The original
   twenty-application/two-hundred-workflow population, independent custody,
   qualified owner protocol/configuration and promotion authority remain
   external gates and are not present here.
10. Lifecycle costs retain nullable intervals and UNKNOWN basis. Missing
    provider/labor/integration costs are not zero. No material gain, multiplier
    or financial result is inferred from development support.
11. Existing runtime HANDOFF must fail closed while application history exists
    unless it explicitly carries that history/responsibility; an S5-only
    capsule must not silently discard application evidence or liabilities.
12. Consumer policy is independently root-signed, private-file loaded, finite,
    exact-scope and exact-revision bound. It uses the actual S8 `/command`
    endpoint, attenuated CONSUMER token, no redirects, finite timeout and
    response bound. Application credentials/session handles are not serialized
    to that endpoint, candidates, journals or responses.

## Planned native integration protocol

Add typed `APPLICATION_PROPOSE`, `APPLICATION_REGISTER`,
`APPLICATION_EVALUATE`, `APPLICATION_ADMIT`, `APPLICATION_ACTIVATE`,
`APPLICATION_REVOKE`, `APPLICATION_CURRENT`, `APPLICATION_USE`,
`APPLICATION_RECHECK`, `APPLICATION_RECONCILE` in the existing owner.
Reuse its serialized command queue, signed journal, S6 reference commitments,
checkpointing and optional lifecycle event outbox.

Consumer configuration:
`FINNOR_S8_APPLICATION_CONSUMER_CONFIG` (private signed policy file) and
`FINNOR_S8_APPLICATION_CONSUMER_ROOT` (Ed25519 public root).
Owner configuration extends the existing signed lifecycle policy with an
optional `application` source-root/development-contract declaration; no
separate signer, store or service is introduced.

Consumer input contains current `model`, `check`, `originalParent`, `profile`
and `request`. Profile identity is explicitly projected without credentials.
The request includes a native owner-published currentness reference. Export
typed acquire/recheck functions and the exact currentness/request schemas so
the native runtime can implement their preimages without guessing.

## Verification boundaries registered before code

- Narrow TypeScript and lint/syntax checks must actually include the new
  backend files. Root ESLint currently ignores `finnor-os/**`; do not count an
  ignored run as backend lint.
- Existing P5/S8 strongest-boundary native fixtures may be run serially if
  their current sources/readiness permit. Record failures and actual reached
  guards; do not write post-code unit tests or substitute mocks.
- New X2 positive native application use requires the main runtime, worker,
  validity owner and configured S4/S6/S8 references. They are currently
  incomplete/missing in the parent work; source/static success is not an
  end-to-end proof. A fabricated validity receipt does not close this gap.
- No commits, remote actions, protected promotion/activation, real external
  effects, secrets in output or heavy concurrent stacks are authorized here.

## Implemented handoff protocol (addendum; frozen contract above unchanged)

The original pre-code note, before this addendum, has SHA256
`d10fd826ce5cf66ac706608c02ade53b8fc8494d815d242fc04ec2e5f4633f97`.
No post-code unit tests were authored.

### Exact native exports

From `finnor-os/packages/capability-evolution/src/application-consumer.ts`:

```ts
interface ApplicationCapabilityInput {
  model: ApplicationActionModel;
  check: ApplicationModelCheck;
  originalParent: OriginalApplicationParent;
  profile: AuthorizedApplicationProfile;
  request: ApplicationCapabilityRequest;
}
interface ApplicationConsumerScope {
  tenantId: string;
  principalId: string;
  rightsRef: string;
}
applicationConsumerPolicy(scope: ApplicationConsumerScope):
  Promise<ApplicationConsumerPolicy | null>;
acquireApplicationCapability(input: ApplicationCapabilityInput):
  Promise<ApplicationCapabilityUseLease | null>;
recheckApplicationCapability(
  input: ApplicationCapabilityInput,
  lease: ApplicationCapabilityUseLease,
  requestId?: string
): Promise<ApplicationCapabilityRecheckLease>;
type ApplicationCapabilityRecheckLease =
  ApplicationCapabilityRecheckBody & { ref: ApplicationPortRef };
```

The omitted-config acquire result is `null`, **not admission or permission**.
Configured-but-invalid scope/source/reference/admission/currentness throws.
Recheck without configuration throws `S8_APPLICATION_CONSUMER_POLICY_REMOVED`.
Recheck's optional command ID defaults to `x2-recheck:` plus a random UUID.

From `finnor-os/packages/capability-evolution/src/application-port.ts`:

```ts
applicationProfileBinding(profile: AuthorizedApplicationProfile):
  ApplicationProfileBinding;
applicationDependencies(
  model: ApplicationActionModel,
  check: ApplicationModelCheck,
  parent: OriginalApplicationParent
): ApplicationDependencies;
makeApplicationCandidate(input: {
  model: ApplicationActionModel;
  check: ApplicationModelCheck;
  originalParent: OriginalApplicationParent;
  profiles: AuthorizedApplicationProfile[];
  sourcePins: Array<{ path: string; sha256: string }>;
  proposedAt: string;
  parents?: ApplicationPortRef[];
}): ApplicationCandidate;
parseApplicationCandidate(input: unknown): ApplicationCandidate;
applicationRef(kind: string, body: unknown): ApplicationPortRef;
applicationDependencyDigest(candidate: ApplicationCandidateBody): string;
applicationRequestBindingDigest(request: ApplicationCapabilityRequest): string;
```

`APPLICATION_S8_VERSION = "s8-application-capability-v1"`.
`APPLICATION_S8_QUALIFICATION = "PUBLIC_DEVELOPMENT_NOT_PROTECTED_X2"`.
Application references have owner S8, that exact version, and
`application-${kind}:${SHA256(canonical(body))}` identity.
The current model/check codecs remain the canonical native X2 codecs.

Also exported: strict `ApplicationPortConfigurationSchema`,
`OriginalApplicationParentSchema`, `ApplicationProfileBindingSchema`,
`ApplicationDependenciesSchema`, `ApplicationCandidateBodySchema`,
`ApplicationProtocolSchema`, `ApplicationEvaluationSchema`,
`ApplicationAdmissionSchema`, `ApplicationActivationSchema`,
`ApplicationRevocationSchema`, `ApplicationCapabilityRequestSchema`,
`ApplicationCurrentnessBodySchema`, `ApplicationUseCommandSchema`,
`ApplicationUseLeaseSchema`, `ApplicationRecheckCommandSchema`,
`ApplicationRecheckBodySchema`, `ApplicationReconciliationSchema`, plus the
explicitly named inferred types in those modules. Consumer policy schema/type
are exported by the consumer.

### Request and validity preimages the native owner must actually publish

```ts
type ApplicationCapabilityRequest = {
  requestId: string;               // [A-Za-z0-9:_-], 1..200 characters
  inputDigest: string;             // canonical current owner input, SHA256
  operationIds: string[];          // distinct admitted members, 1..8
  applicationRevision: string;     // actual current observed application revision
  target: ScopedApplicationIdentity;
  compositionRef: ExperimentRef | null;
  allocationRef: ExperimentRef;    // original native S5 application allocation
  reservationRef: ExperimentRef;   // exactly parent.resourceGrantRef
  resourceEnvelopeDigest: string;  // SHA256(canonical(certificate.check.envelopes))
  deadlineAt: string;              // no later than original parent/profile deadline
  reservedCost: number;            // finite 0..100; NOT measured cost
  currentnessRef: ExperimentRef;   // actual committed native S4 output below
};
```

Before publishing currentness, the actual native validity owner must check
Work/input/actor/current rights; the original S5 reservation, occupation,
revocation and resources; current authorized profile/account/acting principal/
role/grant/target; the exact model/check/operation/semantic/rendering/source/
runtime cuts; lawful available state and required observations; compositions,
parameters/units and interference; original deadlines and UNKNOWN obligations.
It must charge its checking/observation/S8-call work to the original S5 parent.
Do not use this schema to issue an unchecked `current: true` claim.

The exact committed **body**, without its ref, is:

```ts
type ApplicationCurrentnessBody = {
  schema: "finnor.x2.application-s8-currentness.v1";
  tenantId: string;
  principalId: string;
  rightsRef: string;
  modelRef: ExperimentRef;
  checkRef: ExperimentRef;
  originalParentRef: ExperimentRef;
  dependencyDigest: string;        // applicationDependencyDigest(candidate)
  profileBindingDigest: string;    // digest(applicationProfileBinding(profile))
  requestBindingDigest: string;    // applicationRequestBindingDigest(request)
  applicationRevision: string;     // exactly request.applicationRevision
  checkedAt: string;
  expiresAt: string;
  evidenceRefs: ExperimentRef[];   // nonempty, lawful owner-retained evidence
  liabilityRefs: ExperimentRef[];  // preserve pending/UNKNOWN S6 liabilities
  current: true;
  externalUniversalProof: false;
  protectionDomain: "DISPOSABLE_TEST_AUTHORITY";
  qualification: "PUBLIC_DEVELOPMENT_NOT_PROTECTED_X2";
  protectedAdmission: false;
  executionAuthorityGranted: false;
};
```

Use `x2Ref("S4", "application-s8-currentness", body)` from the canonical X2
contracts, retain the body in existing native storage, and deliver/read back
the exact reference using the configured existing S4→S6 owner transport.
S8 resolves that original preimage through its attenuated CONSUMER route.
Validity must be non-future, unexpired, at most signed `maxCurrentnessMs`
(100..30,000 ms), and not extend the request/original deadline.

`applicationRequestBindingDigest` excludes **only** `currentnessRef`; fresh
observations can recheck the same immutable lease request. A recheck cannot
extend the initial lease expiry, which is bounded by the first currentness
expiry, activation and original request deadline. `requestId` identifies an
S8 acquisition attempt, not a replacement S6 effect/obligation identity.
Changing currentness under the same USE command ID is idempotency substitution;
fresh acquisition IDs still consume cumulative S8 reservations and the same
original S5 parent. They never authorize resubmitting a possible effect.

### Signed owner and consumer configuration

Extend the **existing** `finnor.s8.lifecycle-policy.v1` body with:

```json
{
  "application": {
    "schema": "finnor.s8.application-port-policy.v1",
    "frontier": "FRONTIER5.X2",
    "sourceRoot": "<absolute checkout/install source root>",
    "transportContract": "BOUNDED_CONDITIONAL_APPLICATION_V1",
    "maxCurrentnessMs": 30000,
    "protectionDomain": "DISPOSABLE_TEST_AUTHORITY",
    "qualification": "PUBLIC_DEVELOPMENT_NOT_PROTECTED_X2",
    "protectedAdmission": false,
    "executionAuthorityGranted": false
  }
}
```

The numeric maximum above is a protocol limit, not measured capability.
Root owner policy remains independently signed and supplied via
`FINNOR_S8_LIFECYCLE_CONFIG` / `FINNOR_S8_RELEASE_ROOT`. Its existing actors,
evaluator/promotion keys, journal signer, queue and resource/retention bounds
remain authoritative. No new signer role/store is added. Source pins and
legacy S5 dependency-list capacity are now 128 rather than 64 to fit the
expanded audited closure; no S5 method/domain/effect-authority semantics
change. Policy source pins must include the exact loaded S8 closure plus every
original-parent native pin resolved against signed sourceRoot.

Consumer configuration is a private mode-0600, current-user-owned no-follow
file containing `{body, keyId, signature}`; signature is canonical-body
Ed25519/base64. Set `FINNOR_S8_APPLICATION_CONSUMER_CONFIG` to its absolute path
and `FINNOR_S8_APPLICATION_CONSUMER_ROOT` to the pinned Ed25519 public key.
Production NODE_ENV is refused. The strict body is:

```ts
{
  schema: "finnor.s8.application-consumer-policy.v1";
  tenantId: string; principalId: string; rightsRef: string;
  revisionRef: ApplicationPortRef; modelRef: ExperimentRef; checkRef: ExperimentRef;
  originalParentRef: ExperimentRef; originalParentDigest: string;
  dependencyDigest: string;
  profileBindingDigests: string[];  // distinct, 1..8
  sourceRoot: string;              // absolute
  sourcePins: Array<{path: string; sha256: string}>; // exact signed closure
  endpoint: string;                // http://127.0.0.1:<port> or http://[::1]:<port>
  tokenPath: string; tokenHash: string; // private attenuated CONSUMER credential
  validAfter: string; validUntil: string;
  timeoutMs: number;               // 100..10,000
  maxCurrentnessMs: number;        // 100..30,000
  protectionDomain: "DISPOSABLE_TEST_AUTHORITY";
  qualification: "PUBLIC_DEVELOPMENT_NOT_PROTECTED_X2";
  protectedAdmission: false; executionAuthorityGranted: false;
}
```

Both S8 OWNER and attenuated S8 CONSUMER routes are needed in existing
`FINNOR_S6_OWNER_TRANSPORT_CONFIG` / `FINNOR_S6_OWNER_TRANSPORT_ROOT`.
The latter reads exact S4 model/check/original-parent/currentness/composition,
S5 allocation/reservation and S8 lease/recheck commitments under current
rights. S4/S5 publishers must actually drain their existing owner-delivery
outboxes; a SQL row or local hash alone is insufficient. Credentials and their
values are never to be put in artifacts or responses.

The profile projection contains only id, tenant/principal/application/account,
actingPrincipal, role, grantRef, loopback origin, allowedTargetsDigest,
validUntil and the exact development transport contract/domain. It excludes
headers, credentials, session handles, endpoint templates and locator bodies.
Native `assertProfileTarget` still owns entity/target authorization at egress.

### Actual lifecycle call sequence

All calls use the existing `POST /command` envelope
`{operation, requestId, body}` with the appropriate authenticated Bearer
credential. REGISTER/EVALUATE/ADMIT/ACTIVATE/REVOKE bodies are
`{body: <strict exported schema>, keyId, signature}` signed over canonical body.

1. Independently retain/deliver the native model, accepted check and original
   parent. Make a candidate with **all** original profiles and the complete
   signed S8 source-pin list. PROPOSER calls `APPLICATION_PROPOSE`.
2. Distinct EVALUATOR signs `APPLICATION_REGISTER`; freezes dependency digest,
   exact original evidence, oracle and unique one-use case commitments.
3. Same independent evaluator signs `APPLICATION_EVALUATE` with the matching
   protocol/ref/cases/expectation, actual evidence, disposition and costs.
   UNKNOWN costs remain UNKNOWN. Non-UNKNOWN complete costs require actual
   independently issued nine-category lifecycle cost references, scoped to
   original-parent identity; unsupported/failed results remain retained.
4. Distinct PROMOTER signs `APPLICATION_ADMIT`. Supported development and zero
   false-valid/false-invalid/authority/duplicate/false-completion counters are
   required; evaluator signatures are revalidated.
5. PROMOTER separately signs `APPLICATION_ACTIVATE` with admission/dependency,
   original-parent/application domain generation, exact predecessor, evidence,
   `mode: "DEVELOPMENT"`, finite maxCost/maxUses and bounded validity.
6. Native validity owner publishes currentness as above. Native executor calls
   `acquireApplicationCapability({model, check, originalParent, profile, request})`.
   Consumer emits `APPLICATION_USE`; validates exact typed lease, native
   currentness and independently read-back S8 commitment.
7. Immediately before each consequential boundary, recompute actual native
   validity, publish its currentness reference, and call
   `recheckApplicationCapability({...input, request: {...request, currentnessRef}}, lease)`.
   The returned typed recheck ref, evidence and liabilities are recorded in the
   same S8 journal. Independently enforce S5/S6/current authority **at wire**.
8. PROMOTER `APPLICATION_REVOKE` fences future uses/rechecks, including cached
   request IDs, without releasing resources or erasing observations/liabilities.
   Unrelated original-parent/application domains remain independent.
9. CONSUMER may call `APPLICATION_RECONCILE` with native S6 transition evidence
   after expiry/revocation. That evidence must be actually accessible through
   scoped owner transport; currently private native transition custody must
   not be made public merely to satisfy this reader. Possible mutating effects
   require the original effect/obligation references. No effect replacement,
   liability release, business-completion certification or economic credit is
   supplied by this report.

`APPLICATION_CURRENT` is a fresh, nonjournaled CONSUMER read of activation
metadata, not a lease. Existing READER `READ` adds paged `applications` metadata
only when application history exists. Original journal replay reconstructs
application lifecycle/use/recheck/reconciliation and cumulative root accounting.
S5-only runtime HANDOFF is refused while application history exists; a later
typed responsibility capsule is needed for a policy/source upgrade handoff.
Same-policy restart is implemented, but new X2 restart/use E2E is not yet proved.

### Verification dispositions

- Narrow TypeScript API program: roots `application-port.ts`,
  `application-consumer.ts`, `lifecycle.ts`, `source-closure.ts`,
  `protected-events.ts`, `contracts.ts`; actual backend tsconfig options,
  noEmit/no incremental. Node 22.22.3 / TypeScript 5.9.3; 1,737 transitive
  source files; zero diagnostics on the inspected cut. This is not a whole
  API/worker/installed-runtime build.
- New backend modules: explicit ESLint API flat override (root ignore disabled),
  TypeScript parser, unused-variable/explicit-any/eval/unsafe-finally/
  unreachable/constant-condition/constant-binary-expression/equality rules;
  ESLint 9.39.5, zero errors/warnings. It actually includes both backend files.
- Existing P5 native S8 story: two PASS, zero FAIL, source unchanged and complete,
  including proposal → independent role admission → current read → restart →
  revoke. Initial evidence `/tmp/finnor-x2-s8-legacy-p5-8wQe1O`; repeat evidence
  `/tmp/finnor-x2-s8-final-p5-DbxqIt`. This proves legacy disposable interface
  compatibility, **not** the new X2 positive native path.
- Existing S5 lifecycle driver: FAIL before its first lifecycle case. It tries
  to read nonexistent `finnor-os/packages/db/migrations/0148_portfolio_resource_clearing.sql`
  at `scripts/s8/run-capability-e2e.mts:31`. Empty owned evidence directory:
  `/private/tmp/finnor-x2-s8-legacy-s5-ChTUKc`. No migration/driver repair,
  fabricated asset or protected run was attempted.
- New X2 native activation/use/recheck/restart/negative-role/physical-boundary
  E2E: NOT RUN. At final integration inspection runtime/worker/validity files
  all exist, but none imports these S8 consumer helpers or publishes
  `application-s8-currentness`; the worker records
  `S8_APPLICATION_ADMISSION_SEPARATE_PENDING`. Wiring/publication remains
  unfinished/unproved. Do not infer its proof from the legacy story.
- No protected qualification/production activation/full build/generated/
  migration/security-release suite or cost/gain comparison was run here.
  No package, schema migration, shared-type, runtime/API/frontend/computer or
  test files were changed by this worker. No commits or remote actions.

Existing driver reruns (from the backend directory, fresh owned /tmp evidence):

```sh
cd /Users/paramdave/.factory/worktrees/frontier5-x2-software-semantics-compiler/FINNOR/finnor-os
FINNOR_P5_EVIDENCE_DIR="$(mktemp -d /tmp/finnor-x2-s8-p5-XXXXXX)" \
  node --import=tsx scripts/p5/run-s8-e2e.mts
# Currently blocked at missing historical migration; do not count as PASS:
FINNOR_S8_EVIDENCE_DIR="$(mktemp -d /tmp/finnor-x2-s8-s5-XXXXXX)" \
  node --import=tsx scripts/s8/run-capability-e2e.mts
```

Main integration must complete and verify the actual native currentness
publisher, scoped reference delivery, independent signed development admission,
runtime consumer calls, S5 metering and S6 egress/recovery. The worker's adapter
does not supply those missing owner facts or independent protected custody.

### Sealed worker source cut and final rerun

Branch `codex/frontier5-x2-software-semantics-compiler`; unchanged base HEAD
`517003a4396bc8101a90be4b425ee01de9446740`, base tree
`07ba69b8e96f05944c2f9f14a74b2c400eb89e42`. This historical worker-cut report
predates the local commits. The worker implementation is included in resumed
HEAD `ba92228c5ac74d106118d1bb7a9f887c8d54f27a`; final acceptance is separate.
The parent's pre-existing principal-separation change in lifecycle is retained.

Final selected checks on these source bytes: TypeScript zero diagnostics over
the 1,737-file imported closure; explicit backend lint zero errors/warnings;
`git diff --check` PASS; existing generic P5/S8 process story two PASS, zero
FAIL, source unchanged and complete. Final evidence:
`/tmp/finnor-x2-s8-final-retention-p5-bstm05`.

Final source review corrected a FAILED-report uncertainty downgrade:
replay now uses owner-derived `outcomeResolved`, not merely non-UNKNOWN caller
wording; native UNAVAILABLE/UNKNOWN/PENDING evidence stays unresolved and
retains every original effect/liability reference. DECLINED also requires actual
native DENIED evidence. Selected static/legacy checks were rerun after this
correction; its new native X2 E2E remains NOT RUN.
S8 reservedCost/maxCost accounting is not priced application exposure.
No S8 outcome supplies liability release or business/economic certification.

| Source under `finnor-os/packages/capability-evolution/src/` | SHA256 |
| --- | --- |
| `application-port.ts` | `410ebafba1dbcecbc0c0c2c663f8215f19c44502360a010bd8f058540315f953` |
| `application-consumer.ts` | `194e10bce1272b15d9d9aac461d4270a5f9cf058ea1d2446ce8682a9e84db6b9` |
| `contracts.ts` | `e3c5a2f45ca91ff49cb140a75df89e9698c7a1ebece7a711eb144c8a3ab81a47` |
| `lifecycle.ts` | `a5459cdd4fb9bb60307d78832965f1aef84ba42b52dd71903cd820d65fd2dba7` |
| `protected-events.ts` | `4ec1981da37fe9e718706fe8daef812c59598e14d5a4deae3da8ccf46dfc8427` |
| `source-closure.ts` | `3abc13f7b9599e08e4a944bded693ac1ce88e05e0d7b1d8856a2cb5c7dc42341` |

Final evidence SHA256:

- `results.json`: `74ca826bc6ddec71c6b6c4329c33a7f368a87bb23c2acc0daf68221e5876a2f8`
- `source-check.json`: `c70395dbf6e3d49aa7723f9d2eba5f1b32c2310449b598276cc1a38cf6f9c81d`
- `freeze.json`: `22b247f96d8f1d5cef6d1cd4e7d7b9fad4580cabd9229c9addc7f64d62b6a663`

No owned S8, S6 ledger or P5 target verification process was left running at the
cleanup inspection. Generated private test custody stays in its owned /tmp
directories; nothing was deleted or published.

Repeatable narrow TypeScript check (actual API used, not root ignored lint):

```sh
cd /Users/paramdave/.factory/worktrees/frontier5-x2-software-semantics-compiler/FINNOR
node <<'NODE'
const ts = require('./finnor-os/node_modules/typescript');
const path = require('node:path');
const roots = ['application-port.ts','application-consumer.ts','lifecycle.ts',
  'source-closure.ts','protected-events.ts','contracts.ts'].map(name =>
  path.resolve('finnor-os/packages/capability-evolution/src', name));
const config = ts.getParsedCommandLineOfConfigFile(
  path.resolve('finnor-os/tsconfig.json'), {noEmit:true, incremental:false},
  {...ts.sys, onUnRecoverableConfigFileDiagnostic(d) {
    throw Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  }});
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(roots, config.options));
console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCurrentDirectory:ts.sys.getCurrentDirectory,
  getCanonicalFileName:file=>file, getNewLine:()=>'\n'}));
process.exit(diagnostics.length ? 1 : 0);
NODE
```
