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
