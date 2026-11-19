# Phase W CI routing, failure model before implementation

## Observed missing boundary

The current W1/W2/W3 workflows are feature-branch or partial owner slices.
The newly authored W3 qualification caller is still specific to `cloud/postz-w3`.
None is a cohesive all-W verification gate for one committed W1–W5 source cut.
The production release caller currently certifies source, backend, security,
readiness and root jobs, without requiring any Phase W result.

The missing all-W workflow and release dependency are routing failures.
They are not a failed product assertion and do not establish a runtime pass.
Retain these two pre-code refusals independently before adding the route:

1. `.github/workflows/phase-w-verification.yml` must exist and expose the
   reusable all-W verification entry point. Its current absence must fail
   with `PHASE_W_ALL_OWNER_CALLER_NOT_REACHABLE`.
2. The explicit Phase W candidate's production path must require the strict
   `phase-w-release-gate` before its existing post-merge certification can
   authorize release. Preserve unrelated legacy release policy; do not invent a
   branch-name or changed-path bypass. The current missing dependency in
   `.github/workflows/production-release.yml` must fail with
   `PHASE_W_RELEASE_VERIFICATION_GATE_MISSING`. Freeze the authoritative
   candidate selector with the release owner before editing that path.

## Interfaces that must arrive before workflow code

Reuse the independently reviewed owner jobs, their actual command interfaces,
existing isolation/authentication/cleanup behavior and artifact rules. A W2
compensation slice is not all of W2, and a W3 native or cold slice is not all of
Phase W. Resolve the actual W2/W4/W5 owning job interfaces with their owners;
do not invent a job name, a replacement driver or an apparent passing wrapper.

The integration owner has supplied this stable native interface, to run from
`finnor-os` without `--fast` or challenge flags:

```sh
node --import=tsx scripts/postz/w3/native.mts --integrated-company \
  --output <new-absolute-evidence-directory>
```

Its profile classification is
`CONTROLLED_DEV_SHARED_COMPANY_REAL_NATIVE_OWNERS`. The aggregate body is 7200
seconds with at most thirty seconds of owned termination/cleanup. This is the
preregistered aggregate harness bound from the integration failure contract,
not a CI-derived sum or an enlargement of an engine deadline. W3's own 1200-second
native observer and W1's 120-second programme observer remain unchanged, as do
every business deadline, lease, grant, resource guard and effect identity.

The actual combined native runtime remains NOT_RUN. Wire the frozen terminal
receipt contract below, never CLI zero alone or the presence of an unknown flag
which an older native driver can silently ignore.

## Frozen native terminal receipt, before caller implementation

Require `<output>/integrated/result.json` with:

- schema `finnor.w.integrated-native-e2e.v1`;
- exact status `PASS_CONTROLLED_SHARED_COMPANY_NATIVE_OWNERS` and exitCode 0;
- `profile.classification` equal to the exact classification above;
- `completionGate` equal to `PHASE_W_RELEASE_BLOCKED`;
- admitted, productionActive and fieldValidated all false;
- exactly the five engines W1, W2, W3, W4 and W5, bound respectively to
  `finnor.orchestration-policy-capsule.v1`,
  `finnor.workforce-execution-program.v1`, `finnor.real-world-service.v1`,
  `finnor.market-validated-operating-program.v1` and
  `finnor.organization-transformation-program.v1`, as read from the integration
  owner's frozen `scripts/postz/integrated/profile.mts`;
- all six exact PASS predicates:
  `W049-W1-actual-capsule-native-consumption`,
  `W049-W2-actual-workforce-native-consumption`,
  `W049-W3-actual-service-native-consumption`,
  `W049-W4-actual-market-native-consumption`,
  `W049-W5-actual-organization-native-consumption` and
  `W049-shared-business-original-custody`.

Read and validate the actual fixed files and original tenant/principal/company,
Work/input, immutable output references and native-consumption witnesses. An
absent file, engine, expected schema, required predicate or native witness fails
even when the CLI returns zero. The complete typed writer was subsequently read
from `scripts/postz/integrated/evidence.mts` before implementing the validator:
terminal `outputs` is an ordered five-element array, `results` is an ordered
six-element `{id,status,evidencePaths}` array, and `scope` binds the canonical
tenant/principal/company plus original service Work/input. Each receipt's
`evidence.{path,sha256}` binds its exact public file; that file omits its own
self-reference. The consumption wrapper repeats the same outputs/results/scope
and adds one original-custody row per engine. Every public output deliberately
states incomplete cost and no independent protected custody.

The independent verifier checks the fixed public bytes and, locally only, the
fixed private output hashes and consumed-by witness hashes. It never prints or
uploads private payloads, and rejects unexpected public fields rather than
letting raw SQL, auth or observations enter the public projection. A parser
fixture accepted in an isolated control is not an actual native episode.

The integrated upload allowlist is exactly `integrated/profile.json`,
`integrated/result.json`, `integrated/native-consumption.json`, and each fixed
`integrated/w1/actual-native-output.json` through
`integrated/w5/actual-native-output.json`. Do not upload engine directories or
raw W1 observations/SQL, auth, database or browser data. Existing credential-free
W3 source-cut/result/cleanup/cases may be retained separately under their W3 scope.
The combined job must not upload its outer W3 result/cases: integration can put
raw owner observations there even though the default W3-only receipts are safe.
Keep the complete-program typecheck receipt in a separate scoped artifact.

## Native DEV is not the Phase W release gate

A clearly named NativeControlledDEV gate may pass the frozen controlled native
chain slice. It does not complete all W049 costs, W050–W053, installed
qualification, the whole Phase W PRD or any genuine/field/comparison/economic
requirement. Its receipt must continue to say `PHASE_W_RELEASE_BLOCKED`.

The separate Phase W release gate fails closed until genuine all-five-engine
installed qualification and every other PRD-required field, comparison and
economic predicate exist for the exact candidate. A skipped, neutral,
hard-coded passing or W3-only cold job cannot masquerade as ready. The existing
W3 installed/headed/cold route remains only W3 proof, never W4/W5 reconstruction.
Do not invent a stub W4/W5 workflow: no such reusable jobs currently exist.

## Selected release marker, before release-path edits

The release owner selected the committed fixed path
`scope-postz/phase-w-ci/release-candidate.json`. Its entire supported version-one
content is:

```json
{
  "schema": "finnor.w.release-candidate.v1",
  "releaseProfile": "PHASE_W_FULL_PRD"
}
```

Only verified absence from both the exact committed tree and its checkout
selects `LEGACY_VERIFIED_MARKER_ABSENT`. Preserve the five existing legacy
prerequisite jobs, their actual commands, production permissions and deployment
job unchanged. Present malformed JSON, duplicate or unexpected keys, unknown
schema/profile, symlink/nonregular marker, uncommitted marker, SHA mismatch or
failed selector must fail closed, never fall back to legacy.

Bind runtime `GITHUB_SHA` to the actual checkout's HEAD and committed marker
bytes; do not insert a self-referential commit pin in the marker. Post-merge
certification must depend on both selection and the strict Phase W gate. For
the explicit full-PRD marker, only an actual successful strict gate may permit
certification. A skipped/cancelled/failed/missing gate or passing NativeDEV
result alone must refuse it. At the current proof cut, all-five installed plus
the remaining mandatory field/comparison/economic predicates are absent, so the
strict gate explicitly returns `PHASE_W_RELEASE_BLOCKED`; it is not a dummy
passing W4/W5 job. Do this cheap refusal before attempting production authority.

Freeze controls before classifier or certification changes:

1. Absent marker selects legacy; the five unchanged legacy jobs must all pass.
2. Present exact version/profile selects Phase W, never legacy.
3. Malformed, null, array, extra/duplicate keys or unknown version/profile refuse.
4. Failed selector, mismatched SHA and unknown/empty selected profile refuse
   certification even when every legacy job passed.
5. A full-PRD candidate with a failed, skipped, cancelled or missing strict gate
   refuses, including when its controlled native result says PASS.
6. The current strict gate must actually exit nonzero with
   `PHASE_W_RELEASE_BLOCKED` for the missing all-five installed and other PRD
   proofs. This is a deliberate release hold, not a runtime product failure.
7. Parsed legacy prerequisite/deployment jobs, top-level authority and triggers
   must equal their original committed definitions; no remote execution.

The receipt verifier's isolated controls also precede its implementation. They
cover missing terminal/public/private files; missing/duplicate/reordered engines
or predicates; wrong schema/status/profile/bounds; cross-tenant/principal/company
or original Work/input custody; changed public/private/consumer hashes; unsafe
paths/symlinks; incomplete cleanup; and a false release/field/cost/protected claim.
All synthetic parser receipts remain explicitly fixture-only and never count
as five actual native flows.

The small independent verifier has a 180-second step envelope and a 256 MiB
JavaScript heap, below the inherited small-check 768 MiB process budget. It reads
at most 1 MiB per public JSON file and 16 MiB per private JSON file, serially;
these are verifier-input bounds, not new engine/service deadlines or grants.
The CLI binds clean actual HEAD before and after verification, then records the
actual SHA/tree, lock and Node identities with the eight public file hashes in
the CI step summary. The public receipt parser's synthetic positive is only a
shape/hash control. A positive whole-CLI acceptance on the final committed
Linux cut remains NOT_RUN.

The combined CI job's 180-minute envelope covers its separately finite
preparation, existing 180-second S6 prerequisite, 300-second complete typecheck,
7200-second native body plus at most thirty seconds of termination, independent
verifier and selective retention. It is not an engine or aggregate-body limit
and cannot be copied into one. Native DEV runs for main candidates and relevant
integration PRs; the production selector/strict release hold remains separate.

The supplied W2 inventory distinguishes actual source drivers from qualified
runtime evidence. Full native/bound are registered at 1200 seconds and recovery
at 900 seconds; existing elapsed flags or swallowed closer errors do not
establish external supervision or honest cleanup. The qualification owner is
repairing those boundaries, the supported CDP route and real cold reconstruction.
Await its exact fixed interfaces before adding a reusable full-W2 job. The
current compensation calls and one integrated W2 native-consumption leaf remain
explicitly partial, not full W2/cold/campaign qualification. All twelve vendor
files on the W2 source cut are committed; sparse omission is materialization,
not missing dependency closure.

## Failure families and required observations

1. Only a W3 feature push can reach the gate. The completed route must also be
   reachable for the broader changed Phase W source and the actual main release
   verification path, not merely as a disconnected manually invocable workflow.
2. Different jobs verify different moving branches or commits. Each owner,
   combined driver, installed build and final verifier must retain the exact
   caller-selected committed SHA/tree and lock identities. The release gate must
   qualify the exact merged SHA already used by post-merge certification, never
   a previous successful run or another feature branch.
3. Several owner slices are relabeled as the combined original journey. Keep
   their scope explicit and require the integration owner's actual combined
   registered native chain and independent predicates. Reuse real owners, not mocks,
   direct database success insertion or a second production adapter.
4. A skipped, cancelled, missing or failed owner/matrix/combined/qualification
   job becomes aggregate success. The final verifier must require every
   registered prerequisite result to equal success. `always()` may collect
   evidence and inspect failure; it must not convert failure into a pass.
5. A transport exit or uploaded file becomes the verdict without its original
   receipt. Require the exact command's terminal status, expected source identity,
   complete required case population and owned cleanup status. Missing or partial
   evidence refuses the gate. Do not count subassertions as independent episodes.
6. Source changes during install, migration generation, build or verification.
   Preserve clean committed source and exact generated-contract checks. Do not
   make a replacement commit, omit required source, discard inherited work, or
   use donor dependency trees/Git alternates to make reconstruction appear cold.
7. Deadline or resource refusal is retried under larger bounds until success.
   Keep each governing profile unchanged, supervise the registered finite
   command/process group, retain actual failures and require an admitted host or
   runner for qualified evidence. Asset preparation and artifact retention need
   separate finite envelopes; neither enlarges the original body.
8. Verification gains production authority or uses saved identities. The new
   verification jobs require no inherited repository secrets, production
   credentials, deployment write permission, production adapter, personal browser
   session or real participant contact. Keep their permission surface read-only
   and preserve disposable canonical authentication and independent owned teardown.
9. Full raw evidence is uploaded for convenience. Retain allowlisted source,
   expected/observed case, bounded command and cleanup receipts only. Exclude raw
   databases, signing keys, auth configuration, browser profiles and package or
   runtime directories. Keep controlled observations explicitly controlled.
10. A Linux/browser/confinement failure is hidden by a platform fallback.
    Preserve actual Linux kernel controls, installed bytes and fresh headed
    browser predicates wherever their owning job requires them. Authoring or
    statically parsing the route does not establish any of those predicates.
11. Adding the gate changes outward release behavior beyond verification.
    Preserve existing triggers, exact-SHA certification, permissions and release
    authority boundaries. Only the requested fail-closed verification dependency
    is in scope; do not dispatch, publish, deploy, push or grant new authority.

## Static and runtime acceptance remain separate

After the supplied interfaces are frozen, parse every changed workflow, validate
every shell/inline program, and traverse the actual caller/release dependency
graph. Require the all-W reuse paths and final fail-closed result aggregation to
be reachable. Check action pins, committed-SHA custody, finite original bounds,
no secret forwarding, always-run preservation/retention and selective artifacts.
Retain exact preimage/postimage hashes and a clean fixture patch-application
check for independent integration review.

These are static routing checks, not native, installed, mounted, cold or
all-W engineering qualification. The complete committed Linux cut still needs
its actual owning and combined receipts. Genuine human, field, protected,
admission, production, comparison and economic gates remain separate.

## CI002 upload-privacy counterexamples, before repair

Independent review found an actual publication boundary failure: the native
uploader always publishes the producer's eight originals even if the strict
verifier rejects raw SQL/auth fields or never runs after a native failure.
An allowlisted filename is not a sanitized artifact. Even a structurally valid
receipt can carry a secret in its permitted rationale or opaque reference value.

Replace every upload in the combined job with exact newly owned staged files.
The independent stager must revalidate the actual native/public/private set,
then construct a fixed-shape public CI projection using only known literals,
the caller's actual checked SHA and hashes of the validated original files.
Never copy original bytes, free-form values, error messages, identities or
private payloads into staging. Stage the type receipt as a separate fixed-shape
status/hash projection, not the original diagnostic JSON.

A malformed, incomplete or ineligible receipt produces a fixed safe FAIL_CLOSED
projection with no original file hashes or original diagnostics. A failed or
skipped verifier/native/type step cannot become a native PASS merely because
the independent parser accepts a leftover file. Staging success means only
that safe public bytes were written. A separate mandatory step requires actual
staged native and complete-type PASS; a safe failure artifact never greens the
job. Uploads require the staging step itself to succeed, with no original-path
fallback if staging fails, is skipped or is cancelled.

Freeze these controls before implementing the stager:

1. Actual workflow uploads only two exact staged projections, and only after
   successful staging; native/type originals never appear in an upload path.
2. Native/verifier/type failure, skip, cancellation or missing result refuses
   native acceptance even with otherwise valid files.
3. Malformed JSON, absent terminal/public/private evidence, partial FAIL_CLOSED
   and unexpected raw/auth keys yield safe failure, never producer bytes.
4. Secret values in a valid rationale/opaque reference and private evidence
   never occur in staged bytes; secret-bearing type diagnostics are not copied.
5. An existing/symlink staging root, nested input/output root or unsafe path
   refuses without reading, overwriting or cleaning another invocation's files.
6. The actual all-W graph must run this boundary CLI as a mandatory predecessor
   of the combined job and require its success in NativeControlledDEV.
7. Remove unused workflow/job outputs and their GITHUB_OUTPUT writes. Keep only
   stage outputs with a real local verdict consumer.
8. Preserve actual main legacy policy, not the stale feature baseline. Exact
   main b13bc6e5409f5e33e973e6dbf6212d09a1b94df1 omits migration-head.ts from its
   disposable smoke diff; do not reintroduce the stale rule. The control CLI may
   select an explicit immutable legacy SHA for local change review and records
   it; CI uses its exact committed checkout as the default baseline.

Keep the 7200-second native body, all engine deadlines and protected guards
unchanged. Increase only the CI preparation/retention envelope from 180 to 185
minutes to cover the independently finite staging and verdict steps. No runtime,
installed, protected or release acceptance follows from these fixture controls.
