# Installed worker CI follow-up, registered before repair

The published e2d91b5 run 39376870447 is FAIL. All other applicable jobs
pass; worker-image job 118477950461 and its required verdict fail. Preserve
that run and the downloaded image evidence. Image config identity is
sha256:42e463092de89f761ed0fca9a34996306f314eff8455dbf7de3d0258e58a5ab4.

## R3 heap failure

The real R3 installed interpreter/checker/registration slice passes.
The owner driver passes its baseline/full/replay/physical database restart,
then exhausts the inherited 384-MiB V8 old-space limit. Neither required
authenticated-positive nor queued-original/R3-restart case is credited.
The allocation origin is not established at this registration.

Before changing code, reproduce the driver's actual imports, migration
setup and HTTP fixture initialization under the same 384-MiB limit. A
private diagnostic may instrument import boundaries and stop before native
owner preparation. It must record source and diagnostic digests, commands,
memory, real HTTP refusals if reached, and owned process cleanup. This is
only a setup diagnostic, never installed native-owner proof. No production
credentials are inherited. An OOM remains FAIL, including any interrupted
cleanup; the observer must stop only its owned descendants.

Possible failures include source-loader/import graph growth, accidental
retention of setup data, unbounded observer allocations, and genuinely
insufficient runtime resources. Diagnose rather than assume the cause.
Do not raise Docker NODE_OPTIONS, worker heap, grants, invocation counts,
deadlines, or the existing aggregate observer bounds. Do not remove owner
cases, replace the real worker, bypass auth, suppress an OOM, or infer a
passing installed campaign from a narrower setup check. Register the
specific repair after evidence identifies it, then rerun relevant real
boundaries and the unchanged installed CI gate.

### Specific R3 repair, registered after reproduction and before code

Private diagnostic 2 reproduces SIGABRT/heap exhaustion at the original
384-MiB limit, after actual migration/restart PASS and while importing
the threads browser surface. It reaches every eager POST-owner import,
including company-brain. Its static import graph already consumes about
378 MiB of V8 heap. The interrupted cleanup is retained as failed; the
execution supervisor stops the remaining owned process. The first private
diagnostic generator failed on import-only package export resolution and
is not runtime evidence.

Keep all six eager POST-owner routes and every request/auth/body/timeout/
response check. Load the six additional Work/browser surface modules only
inside the existing request dispatch for their corresponding route. Do not
remove routes, alter responses, add a permissive fallback, extend a bound,
or omit the same modules when a browser actually requests them. Dynamic
import retains normal module caching. Cold-loading time remains inside
the original HTTP request bound, not free preparation. This fixture-only
change does not change production worker registration or its heap.

Repeat the exact private setup diagnostic after the repair, requiring
real unsigned owner HTTP 401 and successful cleanup under the same heap.
The selected backend owner cases must still run in installed CI; a passing
setup check alone is insufficient. Browser coverage and production worker
headroom remain separate, unproven by this narrower diagnostic.

Diagnostic 3 reaches the real unsigned 401 after lazy browser loading,
but then OOMs during cleanup under the same heap. It remains FAIL, not a
passing repair. Diagnose the large retained static import graph with a
private V8 snapshot before database startup. Snapshot creation is observer
work under the unchanged aggregate bound, not qualified owner execution.
Never publish its raw contents. The lazy-loading change alone is not
sufficient and may be removed if a smaller complete repair supersedes it.

### Static parser loading, registered before the next repair

The private snapshot identifies eagerly retained PDF.js parser source
alongside TypeScript and Playwright. Both X1 original-format readers
statically import pdf-parse even when no PDF source is read. Their PDF
branches are already async and validate original byte magic before parsing.

Move only each PDFParse import into its own existing PDF branch, after
the unchanged magic check. Keep the two readers independent, the exact
parser/package/bytes, all original rights/consent/coverage/size checks,
25-second parser calls, page bounds, blank-page refusal and destroy-finally.
No shared normalization, parser substitution or error fallback is allowed.
Cold import remains inside the caller's original outer bound. This is not
a claim that complete X1 PDF workloads fit the default worker heap.

Before code, prepare a private artifact E2E using actual generated PDF
bytes and both original readers: verify no parser loads for module import
or non-PDF reads, then require real PDF extraction in both, malformed magic
and blank-page refusal, and retained byte/source digests. Run the existing
12-protocol original-format corpus before and after. Repeat the original
384-MiB setup diagnostic; if deferred PDF loading alone suffices, remove
the speculative browser fixture change and prove the original eager route
setup instead. Installed positive/restart and five-case R4 gates still
require the real image, unavailable locally without Docker.

The unchanged existing 12-protocol corpus passes before repair. The first
private PDF E2E fails because its CommonJS cache probe cannot observe ESM
parser loading, even after successful real extraction. Preserve this
fixture failure; replace only that invalid observation with an in-process
inspector scriptParsed counter for the exact parser package URLs, enabled
before importing the readers. No external inspector port is opened and
raw script source is neither requested nor published.

## Local results

- The corrected pre-code ESM observer gives the expected eager-parser
  failure before repair. The repaired real-byte PDF E2E passes six case
  groups: no parser on reader import/non-PDF reads; actual producer and
  independent checker extraction; malformed magic and blank-page refusals
  in both readers. All 12 existing original-format protocols pass before
  and after. Source/byte/driver digests and rerun evidence are private.
- Deferred PDF loading alone passes diagnostic 5, including the original
  eager browser imports, actual migration/restart and unsigned HTTP 401,
  original 384-MiB heap, unchanged 900-second/6-GiB observer, successful
  cleanup and no surviving observed descendants. Sampled observer:
  14.615 seconds / 753,795,072 peak RSS bytes. The speculative browser
  fixture edit is fully removed. This setup proof does not run the two
  required native-owner cases.
- Actual PostgreSQL R4 baseline/candidate/cumulative/replay/physical-restart
  proof passes: all selected baseline names including original R2 and X1,
  all 217 current migrations/head 0194, empty replays, unchanged source
  and successful owned cleanup (4.933 seconds / 338,468,864 peak RSS).
  The installed five-case owner campaign remains pending.
- Complete backend strict types pass (53.623 seconds / 2,874,793,984
  sampled peak RSS bytes). Affected R4 driver strict types and the
  repository-declared lint also pass (existing warnings retained).
  The postrepair storage replay passes again with owned cleanup.
  No historical SQL, lockfile, Docker heap,
  native grant/deadline, production permissions or smoke case changes.

Local review covers the complete three-file code delta and this contract;
no actionable candidate is found. It is not another independent review of
the entire X phase. The earlier OOMs, interrupted cleanup and invalid
CommonJS observer remain failed. Local Node 22.23.3 is not CI 22.22.3
parity. A new exact-cut audit and real installed CI verdict are required
before claiming those gates pass.

## R4 migration fixture

The unchanged lexical baseline selects every migration below 0184. It now
ends in authentic 0183_x1_source_authority_role_isolation.sql, not the stale
0183_r2_robust_programme_search.sql assertion. Candidate-upgrade-restart
fails before subsequent owners, which are not credited.

Keep the complete selected baseline. Replace only the stale tail assertion
with equality of the entire installed baseline to the selected names and
an explicit assertion that the original R2 migration is included. Preserve
candidate install/replay, all cumulative successors, exact catalog equality,
and every owner case. Do not edit/renumber/drop historical SQL.

Before repair, prepare a repeatable actual PostgreSQL baseline/candidate/
cumulative/replay/physical-restart artifact check. Require the original R2
and authentic X1 migration, all 217 current migrations and head 0194, empty
replays, unchanged source and successful owned cleanup. This local storage
proof is not the installed five-case R4 owner campaign.

Review and audit the resulting source cut before publishing to existing
draft PR #143. Both PRs remain draft/unmerged. Clean-commit native X2 run 7
passes 14/14 (182.089 seconds, 3,252,002,816 sampled peak RSS bytes, actual
second-use pause 6,384 ms), without broader original bounds. That result
does not repair this failed worker CI or close the X1-to-X2 bridge,
remaining native matrix, full-chain reconstruction or qualification gates.
