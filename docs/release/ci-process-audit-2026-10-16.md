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
