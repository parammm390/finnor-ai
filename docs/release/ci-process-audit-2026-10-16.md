# CI/CD process repair — 16 October 2026

Scope: GitHub triggers, required verdict, Git diff classification, disposable
database execution, security scanning, artifacts and production promotion for
both the cumulative R candidate (#129) and V candidate (#128). This work does
not deploy either application candidate.

## Observed baseline

- Main is protected by the stable `required-pr-verdict` check, with strict
  up-to-date checks and no bypass actors (ruleset 23520739).
- The latest 100 runs contain 43 universal verdicts, 44 Dealer Zero runs and
  11 historical invalid-production-workflow failures. No run in that sample is
  currently running. The current seven workflows pass actionlint 1.7.12;
  historical validation failures are not production deployments.
- V #128 head `069a3372987e43678d12246eef543d2fe59cad25` passed its latest
  universal verdict (run 38830725817). GitHub currently reports it ready for
  review, despite its description saying draft. Its product acceptance remains
  explicitly incomplete; passing CI does not complete V1–V5 acceptance.
- In that V run, the backend job took 825 seconds: 630 seconds in the serialized
  default suite and 99 seconds in P7 certification. Root checks took 268 seconds,
  production artifacts 257, and the worker image 159.
- Backend and security workflows independently trigger on main while the
  production workflow does not depend on their results. Production repeats
  frontend source checks already run by its root gate.
- PR classification compares two tips, not the PR merge-base diff, and rename
  detection can hide the original affected path. A backend-only change can
  also break root types imported from that workspace.
- Workflow syntax/semantics are not a mandatory early check. Source failures
  are discovered while unrelated image/artifact jobs continue using runners.
- Dealer Zero is a separate PR run and is absent from the stable verdict.
  Its configured receipt comparison is not fresh candidate execution proof.

## Finite verification, registered before implementation

Failure cases: drifted base pollutes classification; renamed/deleted code is
missed; empty or invalid Git endpoints pass; source/security/replay failures
are omitted from the verdict; backend shards accidentally share a database;
P7 repeats in every shard; standalone main triggers duplicate production gates;
production mutates without backend/security success; invalid workflow syntax
reaches publication; mutable tool versions enter preflight; diagnostic artifacts
collide across shards; a cancellation suppresses the stable verdict.

Required verification:

1. Real temporary Git repositories: diverged base, code-to-doc rename,
   deletion, invalid endpoint and unusual filenames. Run the production
   classifier against the actual Git objects.
2. Actual workflow policy against the repository and deliberately damaged
   copies: duplicate main trigger, missing source dependency, missing security
   dependency, unsafe production cancellation and missing shard coverage.
3. Pinned actionlint on every workflow and reusable call; bash syntax on the
   worker smoke; existing credential-free release-policy regression suite.
4. Reconstructible JSON receipt: commands, input hashes, observed results,
   duration and rerun instructions. No credentials or provider payloads.

Local budget: 120 seconds for process E2E and release-policy checks, 60 seconds
for workflow acquisition/validation. No full application, native runtime or
browser rerun is justified for this process patch. Rerun only a failed boundary
after diagnosis or after changing its inputs. Hosted application execution and
production deployment are separate evidence and must be reported honestly.

## Publication boundary

Keep the existing R and V source histories. Preserve the required check name,
security predicates, active test inventory, worker image smoke, Vercel compiled
artifact proof, production authorization and protected effects policy. A local
patch does not change GitHub until published and does not change main until
merged. R and V must receive the shared process repair without overwriting
their own migration heads, generated contracts or product code.

## Implemented repair

- One early source gate validates every workflow with a checksum-pinned
  actionlint before package/image work. Node, Vercel and container-image pins
  are checked against the toolchain. It then checks both workspace type graphs,
  applicable source inventories, lint and generated-source drift.
- PR classification uses the real merge base and both sides of a rename.
  Source failures prevent expensive image, artifact, test and readiness jobs.
- The full backend inventory runs in three independent PostgreSQL/Redis jobs,
  retaining serialized files inside each database. P7 runs once in a fourth
  isolated job. Shard-specific artifact names avoid upload collisions.
- Vitest's actual installed execution sequencer partitions all 219 active test
  files into 73/73/73, with no omissions or overlap. The CLI's files-only listing
  ignores `--shard`, so it is used only as an independent full-inventory oracle.
- The historical-upgrade, canonical graph and Scope-4/5 disposable certifications
  now live in one reusable readiness workflow called before merge and again on
  canonical merged source. Their predicates and production-source guard remain.
- Backend/security main pushes become called gates of the production workflow.
  Their results now block production mutation, rather than running independently.
  The same release job still builds/smokes its exact publishable worker image.
- Dealer Zero becomes part of the stable required PR verdict. Daily/manual runs
  remain. One pinned complete-history Gitleaks scan replaces the overlapping
  first-page action; merge-parent and side-parent scanning remain enabled.
- Repeated source checks inside the protected release job are removed only
  after their exact merged-source results become required dependencies.
- Root dependency downloads use npm caching. Server readiness uses bounded Node
  fetch instead of downloading an unpinned `wait-on` package during CI.

These changes reduce duplicate runs and the serialized backend critical path.
They do not promise a particular hosted duration. The first hosted execution
must measure it; adding the previously release-only rehearsal makes the PR
verdict more complete and may itself be a substantial part of the critical path.

## Recorded verification and limits

Local process E2E: three cases pass, including five deliberately damaged workflow
copies and 18 applicable failure/cancellation/skip verdict controls. Pinned
actionlint accepts all nine workflows and their reusable calls. The real Vitest
sequencer verifies 219 files exactly once. Deployment truth, mutation inventory,
root lint and whitespace checks pass.

The existing 80-case release suite passed in 41.8 seconds before extracting
readiness into the shared workflow; its changed policy cases were then rerun
(13 release-policy and four verdict-policy cases, all passing). The other
fixture inputs were unchanged. This is local process verification, not a new
full application, Docker, mounted-Work, R or V acceptance run.

Retained failures: the first graph probe exposed an incomplete dependency-list
check, corrected before publication. The first shard probe showed that files-only
listing ignores shard flags; the verifier now calls the installed execution
sequencer. actionlint rejected job-level `runner.temp`; it is correctly scoped
to step environments. The mutation inventory rejected an unclassified new
workflow; all new support paths are now explicitly classified, with no new
production writer or bypass.

Security condition carried forward: live AWS deployment-role base permissions
were previously observed to permit broad mutation, including IAM role changes.
This process patch does not claim to have narrowed that live role. The user's
prior instruction to narrow it before production remains outstanding.

Application integration fixes already present in the R checkout are outside
this process-only commit. GitHub has not executed this patch and main has not
changed. Once the shared process reaches main, V must integrate that main
revision and preserve its own additive migrations and product acceptance ledger.

## Efficiency follow-up — registered verification

The user requested completion of the efficiency work after the first local
commit. Remaining concrete costs: governance fixtures serialize before source
checks; Scope-4 and Scope-5 certifications serialize despite independent
databases; several release Git reads have no deadline or prompt suppression.

Required cases before changing those paths: retain every governance/source
predicate while running independent work concurrently; retain both readiness
certifications in separate matrix jobs and retain distinct artifact names;
exercise a real Git success, non-repository refusal and a deliberately delayed
Git subprocess, requiring a bounded failure. Re-run the affected release
fixtures because their shared Git helper changes. Keep the local verification
budget at 120 seconds per bounded run; no full application suite is added.

Read-only AWS Access Analyzer validation is also required for all four current
session policies. Validation is not an AWS permission update and does not prove
that live role policies, project controls or KMS configuration permit deployment.

## Efficiency follow-up — observed results

Governance and source work now run concurrently after pinned workflow validation.
Scope-4 and Scope-5 run in separate database-isolated matrix jobs with distinct
artifacts. Production calls the complete readiness workflow once. No predicate,
protected required verdict or production authorization was removed.

Release Git reads now have a 30-second maximum deadline, disable interactive
credential prompts and redact command arguments/errors. The Vercel version
probe has a 10-second deadline. Process E2E passes four cases, seven damaged
workflow controls and 18 negative verdict controls. All nine workflows pass
pinned actionlint, including their reusable calls.

The full release fixture suite was rerun after changing the shared Git helper:
the first run had 70 passes and 10 failures because the Vercel version probe
still needed the execFileSync import. Restoring that import fixed the diagnosed
failure. The final run passed 80/80, with zero skipped cases, in 40.514 seconds;
the production mutation inventory also passed (19 mechanisms, seven mutators,
break-glass false).

Gitleaks 8.24.3 passed 108 policy probes, including real credentials on the same
line/path as R3 public hash metadata. Complete candidate history scanning covered
89 commits / 43.29 MB and found zero leaks with the candidate policy. Relocated
worker-owner imports/source-custody E2E passed in 7.8 seconds; this is not an
actual Linux image or mounted-Work acceptance claim.

AWS Access Analyzer ValidatePolicy returned zero findings for all four actual
deployment session policies. The receipt records four successful read-only
operations. This does not narrow the live base role or prove deploy permission.

The bounded local backend typecheck timed out after 120.005 seconds without
compiler output. It is NOT a pass. Hosted clean-runner types, full application
execution, actual image/artifact execution and wall-clock improvement remain
unverified for this update. Existing hosted timing is only a baseline, not a
speed promise. R/V merge and production deployment remain stopped.

## First hosted result and diagnostic aggregation repair

Run 38847850231 on e4c66513 passed pinned workflow validation, governance,
full-history Gitleaks, OSV and actual shard-inventory verification. The backend
compiler finished in 37 seconds and reported four missing exports, all on one
allocation-route import: the symbols belong to capital-program/r5-allocation-owner,
not enterprise-allocation. The source job failed in about 98 seconds; expensive
backend/image/artifact/root/readiness jobs were skipped. No production ran.

Before changing diagnostic aggregation, required failure cases are: an applicable
backend failure must not hide independent frontend diagnostics; every required
failure, cancellation, skipped result or missing outcome must still fail the final
source gate; only explicitly inapplicable backend/shard/lint checks may be skipped;
no changed graph may omit the final aggregate. Dependency-install failures must
still prevent execution and fail the gate. Retain the failed hosted run as evidence,
not a passing application check. Repair the single owner import without weakening
the type gate or adding an export to the wrong semantic owner.

The correction imports the four functions directly from their actual R5 owner.
Independent source groups now retain original step outcomes and run through
errors; an always-running final aggregate requires every applicable outcome to
be successful. Both failed install and skipped/missing required-check paths
remain fail-closed. Backend and frontend inventory command groups also collect
all command failures rather than stopping at the first command.

Updated process E2E passes 5/5, including 28 negative aggregate outcomes and
eight damaged workflow copies. The first new damaged-copy case exposed that
checking for a function name alone was insufficient; the graph verifier now
requires both its exact import and invocation. Pinned actionlint, 17 affected
release/verdict policy cases, targeted lint and whitespace checks pass. No
full application or production acceptance is claimed by this correction.

## Publication hold after hosted run 162

The user explicitly rejected another one-error/fix/push/hope cycle. No further
release-branch push is to occur until the candidate-wide preflight is assembled
and all observed failures are consolidated. The release goal remains paused.

Run 38848324196 on 358e03b3 passed backend contracts/types, root types,
workspace/shard inventories, lint and generated drift, along with governance,
workflow validation, Gitleaks and OSV. The source aggregate correctly failed on
one remaining inventory predicate: the generated capability manifest was stale.
OpenAPI clients, typed forms and P8 runtime/zero-resurrection guards passed on
the hosted runner. Expensive tests/images/artifacts/readiness remained skipped.

The generator was run locally; the resulting 28-line addition records the
existing policies/coalition-read route, admin-only and not model/user callable.
Workspace, client, capability-manifest and typed-form checks pass locally.
The local P8 runtime check timed out after 30 seconds; that is not a local pass.
The generated change remains UNPUBLISHED pending the batch preflight.

Local execution prerequisites were inspected rather than repeatedly retried:
the dependency directories are symlinks into the Desktop checkout; the previously
stalled steel-sdk/resource.d.ts and undici-types/header.d.ts files are marked
compressed,dataless by macOS. Docker, Podman, Colima, PostgreSQL/Redis command-line
servers and Homebrew were not found. The Data volume reports only 2.0 GiB free.
No shared dependency directory was deleted or replaced, no full reinstall was
started on that nearly-full volume, and no user data was cleaned up.

Full database/backend, actual Linux image, compiled artifact/browser and shared
readiness execution are NOT established for this candidate. A clean Linux batch
runner is needed to collect those results together. The remaining local manifest
patch must not be represented as a completed whole-candidate preflight.

## Batch follow-up: real test resolver boundary

Before another publication, inspect the actual installed Vitest resolver as well
as TypeScript and relocated tsx. Four representative new owner subpaths resolved
to nonexistent index.ts/subpath paths under the broad bare-package aliases:
memory/evidence, workflow-runtime/steps, computer/broker, orchestration/objective-loop.
The actual resolver returned vite:alias.noResolved=true. This would break tests
despite passing TypeScript and worker-layout checks. Required finite proof before
the fix: exercise every explicit runtime export of the four changed owner packages
with installed Vitest, compare to the package's exact source path inside this
candidate, reject unresolved/escaped targets, and retain the actual full-inventory
shard proof. No database tests may be silently excluded or rewritten for the fix.

The resolver E2E reproduced failures in 25 subpath exports. Vitest aliases now
derive those subpaths from the four packages' own runtime exports and put them
before bare aliases. All 29 exports (including package roots) resolve to exact
candidate files; the 219-file inventory still partitions 73/73/73. The verifier
now checks both resolution and inventory in the existing source gate, so this
class of mismatch fails before the full test/image jobs. Original failed and
corrected receipts are retained; no test assertion or exclusion was relaxed.

The root unit suite passed 11/11, and the two existing authenticated-intake route
unit files passed without a database (counts in batch-checks.json). Workspace,
OpenAPI client, capability-manifest, human-form, deployment truth, production
mutation inventory and contrast checks passed together. The affected process,
release-policy and PR-verdict fixtures passed 22/22 with no skips. These are
finite candidate checks, not Linux image/database/browser acceptance.

The user rejected the extra permission question and requested immediate work.
No separate diagnostic branch, workflow dispatch or PR is being created. The
known manifest and resolver failures are consolidated with their verification
before updating existing PR #129. Production stays paused; no activation changes.

CodeRabbit 0.9.0 raised one minor issue in this batch: an export target outside
the owner could become the check's expected path. The corrected guard validates
both lexical and physical containment, rejecting traversal, absolute targets,
backslashes and escaping symlinks. All 29 real exports still pass. The real-filesystem
E2E rejects six invalid targets; all six process cases and 17 affected policy cases
pass (23/23 combined). Its first fixture comparison exposed macOS /var → /private/var
normalization; the independent expected path now uses realpath, matching the guard's
physical-source contract. The original fixture failure receipt is retained.

No further code change is being justified by an assumed clean review. The next
publication is the combined known-failure repair on the existing release branch,
followed by its existing hosted gates, not a new isolated diagnostic run. Exact
Linux/database/artifact acceptance and production completion remain unclaimed.

## Full hosted batch 163: Docker boundary

The complete source aggregate passed on a598606b, and all independent expensive
jobs began. The worker job passed relocated owner imports, QEMU and builder setup,
then failed Docker buildx --check with FromPlatformFlagConstDisallowed at the
intentionally ARM64 S6 native-callee stage. No image compilation or smoke pass is
inferred. Preserve that fixed native ABI and the x86_64 scientific/runtime image;
do not skip the check or remove QEMU. Before editing, require the layout E2E to
check a default-ARM64 platform argument and an actual aarch64 build-stage assertion,
with no literal FROM platform flags. Collect remaining batch results before push.

The completed batch passed every other applicable job: source/governance/security,
all three backend shards, P7, canonical upgrade/isolation, both readiness certificates,
compiled production artifacts, public build/browser and Dealer Zero receipt diff.
The default suite reported 1,285 passing and 27 explicitly skipped tests across
213 passing / six skipped files. Skips and per-job timings are preserved in
hosted-batch-163.json, not silently represented as passed coverage. Separate Scope-3
focused cases ran within Scope-4; no live-provider acceptance is inferred.

The S7 native proof file, not a stuck Git command, dominated the final shard:
416.263 seconds total, including a 342.193-second statistical owner proof and
66.666-second integrated proof. All five native families passed. Logs retained
their generated/disposable qualification; this is not field economic gain.

The Docker correction expresses the ARM64 helper through a default-ARM64 build
argument and asserts uname=aarch64 inside that stage; pins, QEMU, other stages,
source custody, image checks and smoke predicates remain. Docker's documented
variable-platform form is used, not a skipped build rule:
https://docs.docker.com/reference/build-checks/from-platform-flag-const-disallowed/
Read-only current Debian package indexes confirmed both pinned OpenSSL packages
3.0.22-1~deb12u1 and bubblewrap 0.8.0-2+deb12u1, including ARM64 bubblewrap.
Relocated worker E2E passed after the edit in 4.057 seconds. CodeRabbit raised
zero issues on the Docker/test correction. The actual Docker check/build/smoke
still requires execution on the corrected source; no pass is inferred from review.

## Hosted batch 165: exact allocation IPC boundary

Commit 8afbf9c passed Docker checks and built the final linux/amd64 image
sha256:41b7e0370bed42eb3a72445a4d704d29869bf2fb779768371c85e327bee8bc4e.
All four service classes passed exact identity health and SIGTERM shutdown.
The authenticated built-API R1 runtime then failed during its original S5 grant:
NUMERICAL_FAILURE / ValueError:NONCANONICAL_FINITE_DECIMAL. Original evidence:
run 38851153809, artifact 12025124841 (29 files, ZIP SHA-256
39b61720d3f317d3929c37719bf1427646f6a55bf965f6d3f928719414a52201).
R3/R4 image flows were not reached; every other applicable CI job passed.

Before editing, register one bounded replay of that actual HTTP input, issued
S4 policy and issued resource revisions through compiler -> real pinned Python
solver -> independent canonical checker. Expected selection is the original
policy, objective 7, exact capital demand one third; never float-round it.
Also require legacy decimal wire input to remain decimal, reject a missing v2
binding and malformed ledger values, and preserve raw solver/compiled inputs.
Failure cases: internal ledger prefix crossing IPC, absent version binding,
changed policy/resource refs, wrong selection, exact-check rejection, unavailable
or wrong backend, deadline/child failure. The replay reconstructs a canonical
problem from saved issued inputs, not a new authenticated grant or image pass.
Run the affected proof before publishing. The existing full image smoke remains
required on the changed exact image. No deadline or acceptance predicate changes.

The replay reproduced the original NUMERICAL_FAILURE before repair. The compiler
now translates validated internal r3q:n/d to the solver's n/d only under the
explicit v2 schema; decimal v1, independent checking and durable ledgers stay
unchanged. The real Python solver and original checker passed after repair with
objective 7 and the exact one-third resource envelope. Local backend versions:
Python 3.12.14, NumPy 2.3.3, SciPy 1.16.2, HiGHS 1.8.0; this is not the installed
Linux Python 3.12.13 image proof. Raw before/after receipts and wire inputs retained.

CodeRabbit found one replay-harness concern: an assumed empty outstanding list
could change the problem. The corrected replay reconstructs the original owner
knowledge cut within its retained request/child start window and requires its
entire canonical hash to match the actual solver's original inputRef
21bab16f08e2c2ab4bba1d77c7b6b35f02155de19119e6d350ae5420b6a21e6f.
It passed with that exact original commitment, not a newly invented problem.
Missing v2 and four malformed ledger encodings were rejected. Original ZIP bytes
were independently SHA-256 checked against GitHub's artifact digest.

The broader local authenticated owner selection was interrupted after 108 seconds
before setup: the exact Node process was idle reading redis-parser/index.js,
verified compressed,dataless. SIGTERM did not finish; the owned child was reaped
with SIGKILL. No database was started and no owner result exists; retained driver
receipt says FAIL/MISSING_DECISIVE_RECEIPT, not PASS. No shared dependencies changed.

The affected process/layout E2E passed seven cases, zero skips, in 3.865 seconds;
nine workflows pass pinned actionlint and the smoke shell passes syntax checks.
R1/R3/R4 failed receipt gates now emit visible bounded diagnostics instead of a
bare exit code. Full exact-image acceptance remains required and production paused.

## Combined R/V source and production-process repair

User confirmed both phases and explicitly requested production pipeline repair.
Reconcile candidate a93de09f with canonical V merge 938c9fe3 in this one writer.
The separately started V production run 38853190970 failed certification and
skipped release. No deployed V completion is inferred.

Failure model before combined verification: lost R/V handler or owner export;
duplicate native-attempt debit; unversioned/rounded exact allocation;
loss of V approval/currentness fences; missing packaged source; duplicate schema
ordinal or destructive modification of canonical V migrations; generated client
drift; source guards hiding errors; release jobs outrunning required checks;
duplicate image builds or stale image/SHA proof; accidental protected activation.

Keep all canonical V migrations byte-identical. Serialize the six unmerged R
migrations after V's 0181 at 0182–0187, preserve their SQL bytes and update actual
runtime/upgrade references. No existing deployed migration name is changed.
Finite checks: migration inventory/hash preservation and generated bundle,
generated API/client/authz/manifest/forms, source/type gates, actual relocated
worker with both job inventories, original exact-allocation replay, existing
process/release/verdict E2Es and one exact-source hosted workflow. Required
database/image/readiness/security gates remain; unchanged prior greens do not
qualify this combined source. No new PR, isolated diagnostic workflow or live
business-effect authority. Re-run only affected local proofs after a diagnosed
repair; the existing hosted graph checks the full combined cut before release.

The combined source exposes a second exact-quantity boundary: V's native S1
allocation authority expects decimals, while R1 retains one-third USD. Preserve
the S1 approval/resource/revision fence and extend only allocate_resource's
exact ledger codec, using integer cross-products, never a rounded dollar amount.
Pre-edit failure cases: 1/3 must exceed a 0.33 ceiling and fit 0.34; invalid,
negative, noncanonical or oversized fractions must deny even for unlimited
grants; other financial capabilities retain decimal-only input. Existing R1
authenticated grant flow is the positive real-owner proof; preserve old failure
receipts and require hosted exact-image and authority regression checks.

V's failed production Scope-4 run reached its old benchmark corpus, attempted
legacy closes on the current V3 schema, then failed the unchanged holding guard.
Repair the benchmark, not V3: create its 200 historical synthetic closes on the
pre-V3 schema in a separate disposable database, upgrade it to the full current
schema, require every closed Deal and holding identity/status to survive, then
measure the same current-schema graph operations and original p95 thresholds.
The fresh/current-schema and populated-upgrade gates remain independent. This
does not prove or bypass a new V3 transaction close, and does not seed a V3 proof.

## Finite independent-review disposition

The combined package review returned 15 findings. Before the remaining repairs,
register these failure modes: a source/version mismatch must not enter either
observation ledger; temporary compute contention must defer without charging an
unstarted child; non-UUID authority actors must fail before SQL; acknowledged or
cancelled contact facts must not regress; exact member intent must win over a
primary fallback; invalid authority dates must deny; the dispatched S5 request
must be the stored approved bytes, not reconstructed array order. Missing native
verifier identity must produce an unsatisfied criterion, never fabricated identity
or privacy bypass. Use existing owner, migration and process drivers; preserve
all earlier failures. Do not add post-implementation unit tests.

Review suggestions about removing material/egress fences, broadening private
evidence custody, making effect hashes optional, and changing historical signature
canonicalization are not automatically accepted. They require actual caller and
codec evidence; financial authority and privacy safeguards remain intact. The
production migration owner's FORCE-RLS compatibility remains an explicit check,
not an assumed property of local superuser databases.

### Combined repair publication record

The R/V merge is locally resolved, not discarded. Main's 184 migrations remain
byte-identical; six unmerged R SQL files move after V's 0181 without SQL changes.
New 0188 adds validated source/version composite foreign keys and explicitly
reports historical mismatches instead of silently repairing evidence. Head and
supplier canary agree on all 191 migrations. R3 upgrade/replay admits the explicit
forward successor. The stored approved S5 request is dispatched without rebuilding
resource order; exact quantity/version bindings and current-authority gates stay.

Confirmed review repairs also preserve terminal contact facts, select the exact
member's intent before primary fallback, deny invalid standing dates/UUID actors,
require a closing initiator, defer compute capacity/deadline errors to the queue,
acquire compute capacity before the original native charge, and record missing
objective-verifier identity as unsatisfied rather than substitute a principal.

Both semantic typechecks pass under Node 22.22.3. Local cloud-placeholder files
required SRI-verified, lock-matching steel-sdk/redis-parser/undici overlays in /tmp;
shared dependencies were not changed. Four missing TS workspace aliases otherwise
resolved planning/projections and peers to the older Desktop checkout; explicit
candidate aliases fix source custody without modifying those owners' contracts.
Generated client/manifest/forms/workspace/deployment checks and all nine actionlint
checks pass. Process E2E 6/6 and real relocated worker/source custody pass. Release
fixtures pass 80/80, zero skips. The subsequent mutation inventory first rejected
the new disposable verification driver; classifying it READ_ONLY/PRODUCTION_BLOCKED
restored the inventory, with no new production writer or bypass.

The 191-migration benchmark reached all six original p95 thresholds successfully,
but its new FK harness failed on unrelated absent owner parents, then search-path
rendering, then PostgreSQL's prohibition on temporary-to-permanent FKs. Those FAIL
receipts are retained. A narrowed fresh-database probe now uses the exact validated
installed FK definition on an isolated regular scratch table: matching source and
version accepted, cross-source version rejected with 23503 for both owners. It
does not claim V owner-write or production acceptance. The driver now explicitly
exits from its recorded outcome after teardown rather than trust dependency cleanup
exit-code changes. A second review identified the temporary-FK issue and requested
historical mismatch preflight; both are addressed before publication.

The earlier positive R1 authenticated API -> actual queue/worker/checker -> S4/S5
owner proof passes on 14e71d59/190 migrations; two unselected cases remain NOT_RUN.
It is not mounted Work or the final Linux-image proof. Hash-bound receipts and
rerun commands are in evidence/ci-process-repair-2026-10-16/combined-r-v-repair.json.

Remaining review dispositions: closing compiler/checker/broker use the same current
locale canonicalizer; do not unilaterally change historical signed bytes. API and
voice approval callers forward the reviewed effect hash; absent voice hashes remain
fail-closed/manual-review, not optional authority. Closing signed observations use
the closing owner, not a grant to raw V1/V2 private data; broader private custody is
not authorized by an independent-reader role. The tenant material lock and V4
disposable egress lock findings remain open performance/concurrency risks, not
silently marked fixed: removing those authority fences without a decisive race proof
would weaken revocation. Production migration-owner FORCE-RLS behavior requires
live verification. Live role inspection confirms PAID/ACTIVE project us-east-1,
production-only immutable repository OIDC, three inline policies, no attached
managed policies, and a CloudFormation-managed deployment role. No IAM mutation
or production deployment has occurred at this publication point.

### Hosted batch 166 and final generation boundary

Batch 166 on ba0835ce passed workflow validation, release governance, Gitleaks,
OSV, both semantic typechecks, shard inventory, authz/OpenAPI, frontend generated
inventories, PE boundary, retirement checks, lint (six non-blocking warnings),
and source drift. The backend aggregate failed because the final one-line closing
initiator guard shifted private-equity registry/schema source-line references in
the action manifest. Local verification had omitted that separate backend action
manifest after the final edit; that omission was an engineering error. The full
batch is complete, expensive jobs were skipped, and no failing job was rerun.

Regenerate both action-manifest files from actual source. Add all generated-source
contracts, including this manifest, to the ordinary release:preflight entry point
before its expensive release fixtures. This closes the local prepublication
omission without weakening the hosted independent source aggregate. No owner code
or acceptance criterion changed in this correction.

The previously authorized live deployment-role narrowing is now applied. The role
has exactly one inline policy: the deduplicated union of the current workflow's
four session policies. Two obsolete bootstrap inline policies were removed. Full
preimages and applied API/readback receipts are retained in the task artifact
directory (ci-release-iam-preimage-20261016.json and
ci-release-iam-applied-20261016.json), allowing administrator recovery. No runtime
resource was deleted or deployed. ValidatePolicy returned zero findings; thirteen
explicit positive/negative permission cases passed. IAM policy edits (including
self/worker escalation), unrelated ECR/ECS/CloudFormation targets, network writes
and passing an administrator role are no longer granted. The production repository
OIDC trust remains unchanged. The candidate template is byte-identical to deployed
template; its eight-resource-only finalized ECS rollout forbids IAM changes.
This intentionally restricts the live role beyond its historical provisioning
template: a future IAM/infrastructure change requires separately reviewed admin
authority and cannot restore broad permissions through the deployment role itself.

### Hosted batch 167: installed R3 restart harness boundary

All applicable checks except worker-image passed on e3914d33. Image digest
6de3a32894fa4dce36010355d1c1acdab9bbee5267b8d5efdfe570e7ba886eb8 built.
All four health/shutdown classes, authenticated R1 installed owner flow, R3 native
interpreter/solver/independent checker/worker inventory, and R3's full migration,
replay and physical PostgreSQL restart passed. The R3 queued-owner restart case
failed at run-owner-e2e.mts:423: the harness fell through to Git in a Git-less
installed image and dereferenced missing stdout. The image caller omitted the
existing FINNOR_R3_INSTALLED_SOURCE_COMMIT input, although it provided the general
release commit. R3 positive/restart completion and R4 were not reached, not passed.
Original artifact 12028355743 is retained with independently verified ZIP SHA256
7d8507a4ca18bcb3c3d499e871ad41453588867e3b3484b3f7ab5814ce85b751.

Before repair, verify the real shared smoke command wires its already validated
exact image commit to the harness's installed-source input. Failure cases: absent
input invokes nonexistent Git; wrong/invalid commit is rejected; image metadata
must still bind to actual labels and the source tree; no Git assumption may be
introduced into packaged execution; restart/worker/auth/owner criteria remain.
Extend the existing relocated-worker E2E to check this installed-call boundary,
retain its initial failing receipt, then rerun after wiring. No runtime Git binary,
checkout, swallowed error, case removal or protected-qualification change is needed.

Before correcting compute permissions, retain the published CloudFormation ECS
handler action lists and exercise both the base and session policy. Failure modes:
task replacement cannot clean up old revisions; service stabilization cannot read
or stop a deployment; role lookup or tag reconciliation is missing; session JSON
exceeds STS's 2048-character limit; direct deregistration, unrelated resources,
self-policy edits or arbitrary role passing accidentally gain authority. The
normal eight-resource rollout must remain the only writable CloudFormation scope.
No provisioning, role-trust or template mutation is part of this correction.

Local relocated-worker proof failed before the R3 call wiring and passes after it.
The existing CI-process E2E likewise rejected the missing replacement-handler
permissions before correction; all seven scenarios now pass. Pinned actionlint
1.7.12 and Bash syntax pass. The final compute session is 2006 characters, retaining
the stack, ECR and cluster restrictions. Its role lookup is scoped and intersects
the base policy's five exact task roles. AWS ValidatePolicy reports no findings;
twenty base/initial-session simulations and ten final-session simulations pass.
The role now also contains the verified handler closure, with matching readback.
Deregistration cannot be resource-scoped by ECS, so both base and session require
CloudFormation as first and last caller; direct deregistration remains denied.
Self-policy edits, unrelated service writes and arbitrary administrator role
passing remain denied. No production stack, task, database or application changed.
The old generic read-only-wildcard fixture was updated for this one constrained
cleanup action and read-only GetRole; all its other restrictions remain in force.
Retained before/after receipts and exact failed hosted results are in
evidence/ci-process-repair-2026-10-16/hosted-batch-167.json. Full image R3 restart
and R4 execution on the corrected source still require the hosted Linux gate.

After the final policy refinement, all 80 release fixtures pass, as do mutation
inventory (19 mechanisms, seven governed writers, no break-glass), all generated
contracts, seven process E2E scenarios and the relocated actual-worker proof.
This is local repair evidence, not deployed-owner or Linux scientific execution.
