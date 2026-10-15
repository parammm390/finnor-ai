# Unpublished R3 handoff

The branch is a reviewable implementation on main
`517003a4396bc8101a90be4b425ee01de9446740`, tree
`07ba69b8e96f05944c2f9f14a74b2c400eb89e42`. No peer code was adopted.
Functional completion is **INCOMPLETE** because the final Linux API/worker
image has not been built and executed. Protected and combined gates are separate.

`release.json` names the two actual commits, final tree and SHA256/size of
`r3-standalone.bundle`, `01-r3-owned.patch` and `02-shared-integration.patch`.
It is generated only from a clean branch after both commit groups. Its
standalone bare clone and independent ordered-patch replay must produce the
same exact final tree. No commit identifier is self-embedded in its own source.

## Reconstruct

From a new directory, using absolute paths to the supplied handoff:

```sh
git clone /absolute/handoff/r3-standalone.bundle /absolute/new-r3-checkout
git -C /absolute/new-r3-checkout rev-parse HEAD HEAD^{tree}
```

Alternatively check out the named base in an isolated clean repository and
apply `01-r3-owned.patch` then `02-shared-integration.patch` with `git am`.
Do not apply shared patches over dirty peer edits. `shared-patch-contracts.json`
records exact selected-base preimages and proposed postimages, affected
readers/writers/jobs, contract versions, owner boundaries and compatibility
evidence. The first commit is deliberately not a separately runnable release.

`source-seal.json` binds product, locks, schemas, jobs, runtime/licences and
generated outputs. `private-evidence-index.json` binds raw evidence by hash.
Raw preferences, reports, browser state, native origins, installed environments
and credentials are not in the patches or bundle's R3 delta.

## Private evidence access

The evidence owner can inspect
`/Users/paramdave/.codex/worktrees/r3-incentive-rule-synthesis/FINNOR/scope-r/r3-incentive-rule-synthesis/evidence/`.
Resolve each index entry relative to that directory and check its SHA256 before
using it. Access is local, not a published URL or permission to upload it.
Credentials and private-key material are excluded from the index and handoff.
Keep any authorized transfer private and preserve original hashes.

`evidence-summary.json` names decisive PASS cuts, every retained failure or
interruption, unresolved meters and skipped gates. Older source cuts remain
older source cuts. There is no consolidated final-image or combined-R receipt.

## Reproduce verification

Install root and `finnor-os` npm dependencies from their existing lockfiles.
Use isolated Python 3.11.15 and 3.12.13 environments, never a shared upgrade:

```sh
uv venv --python 3.11.15 /absolute/new-r3-checkout/.r3-runtime
uv pip sync --require-hashes --python /absolute/new-r3-checkout/.r3-runtime/bin/python /absolute/new-r3-checkout/finnor-os/scripts/r3/requirements.lock
uv venv --python 3.12.13 /absolute/new-r3-checkout/.r3-upstream-runtime
uv pip sync --require-hashes --python /absolute/new-r3-checkout/.r3-upstream-runtime/bin/python /absolute/new-r3-checkout/finnor-os/scripts/r3/upstream-requirements.lock
/absolute/new-r3-checkout/.r3-runtime/bin/python -I /absolute/new-r3-checkout/finnor-os/scripts/r3/seal-runtime.py --output /absolute/new-r3-checkout/.r3-runtime/manifest.json --scip-license /absolute/new-r3-checkout/finnor-os/scripts/r3/licenses/scip-Apache-2.0.txt
```

Run `run-native.py --python <absolute-runtime-python> --output <new-absolute-dir>`.
For real owner/worker stories, from that checkout run
`python3 finnor-os/scripts/r3/run-local.py`. The final selective command was
`python3 finnor-os/scripts/r3/run-local.py queued-original-and-r3-physical-restart,mounted-work-reload-switch`.
It uses disposable auth/SQL/owners, not production credentials or auth bypass.
The browser uses Factory's assigned pane when available and never closes it.

The remaining image gate is internal engineering. With a functioning local
container engine, build both explicit `api` and `worker` targets from the
repository root using `finnor-os/Dockerfile.worker`, record immutable image
digests, and execute `scripts/r3/check-runtime.mts` inside each installed image.
Then run real queued-job/owner/migration proofs on those bytes. This recipe is
NOT RUN and is not permission to deploy, provision or activate anything.

## Serial integration order

1. Start with the exact selected committed main.
2. Integrate any independently sealed peer interface in actual dependency
   order, never copy dirty R2 bytes or inherit its old grammar certificate.
3. Apply the R3-owned group, then merge the minimum shared group from its
   exact preimages. S3/S4/S5 leaf versions preserve original numeric routes.
4. One serial integrator assigns unique ordered migration numbers, regenerates
   bundle/head and preserves 0171 runtime-role isolation. R3's base-local
   0172 collides with observed R1/R2 proposals and is not a joined reservation.
5. Seal installed runtimes, all original/peer/R3 job schemas, exact S5 readers,
   typed P7 closures, native signed transport and all Capital mounts together.
   Regenerate OpenAPI, clients and capabilities from that integrated source.
6. Run affected owner, fault, Work, fresh/upgrade/restart and old/new job
   proofs on the same joined build. Only then record COMBINED_R_CUT_CHECKED.

`owner-request-packets.json` names concrete S3/S8/operation/comparator/S7 and
peer dependencies. It grants none of their authorities.
