# SharedWorkProgram development kernel

`produce(originalRequest)` executes one structurally shared exact DAG across
distinct original Works. `applyChanges(checkpoint, changes)` atomically applies
signed bag insertions/retractions, programme/objective edits and withdrawal.
It reuses exact unchanged nodes and recomputes dirty dependents. There are no
implicit algebraic rewrites or claims of differential-join asymptotic behavior.
Two explicit, source/parameter/partition-bound terminal equality laws permit
reuse: a pure filter distributes over the same bag union, and a grouped sum
pulls through an equijoin only with unique dimension keys and exactly retained
group/value fields. The Python checker reconstructs the side conditions and
executes every original programme independently. Original DAG coverage,
discovery, storage and the source computation remain charged. Only the
certified destination terminal's initial execution floor can be waived.
Intermediate operators are not eliminated by this narrow implementation.
`DIRECT` mode uses the same indexed operators and per-Work caches without
cross-Work nodes. It is diagnostic baseline equipment, not qualified full X/Y.

The original per-Work Python/Fraction checker executes original programmes,
checks schema/units/multiplicity/order, reconstructs graph coverage and lawful
partitions, and checks conserved exact tick allocations. Producer results stay
`UNKNOWN` until checked. Exact declared computation does not establish source
truth, S8 admission, effect authority or accepted material business work.

## Contract and limits

The strict request/IR schemas are in `contracts.ts`. No float, arbitrary code,
network operator, unbounded recursion or effect is executable. See the frozen
`scope-z/phase-evidence/z1/engineering-contract.md` for the semantics and failure
model. Numerical components are bounded to 512 reduced bits. The batch bounds
are 2–1,000 original Works, 4,096 original nodes, 100,000 total source rows and
1,000,000 newly materialized derived rows. Additional 128 MiB encoded data,
128 columns, 64-level input structure, operation and original-deadline bounds
are explicit. Out-of-profile or exhausted runs have no usable partial result.

Canonical JSON keys, text comparisons, shared-consumer lists and full-row
selection ties use UTF-16 code-unit order, without locale collation or Unicode
normalization. Boolean `and`/`or` short-circuit left-to-right after full static
type checking. The independent interpreter implements those rules explicitly.
It derives the complete envelope from original inputs, retains partial source
evidence and UNKNOWN costs, and checks mandatory discovery/storage charges
and initial execution lower bounds. It does not attest historical physical
charges or a native lifetime budget from an isolated candidate.

`resources.remainingTicks` is the original ceiling available to this Z1
continuation at submission, not a replenished allowance on every update.
Checkpoints carry cumulative exact charges against that ceiling. Native S5
must independently check its actual present remaining reservation/capacity.
The native port may lower the ceiling, never renew it. Failed/retried/directed
fallback computation carries the same charge history, parent and deadline.

`checkpoint.cache` and complete candidates are private to the authenticated
principal. Only `projectForWork` is a per-Work projection helper; its identity
argument is **not authentication**. Native callers must resolve real authority
and current canonical sources before invoking it. Cache keys include the full
lawful partition, source bytes/revision/rights/types, each operator's referenced
typed parameters and build. Child keys carry upstream parameter dependencies;
unrelated original parameters do not partition a shared source or prefix.
The full original parameter map remains in the currentness/admission binding.
Different tenants/principals cannot be combined in one authenticated batch.
Public source classification does not grant cross-principal access.

Withdrawal preserves original programme, provenance, charge history and S6
references. It releases no native liability. Revocation suppresses affected
results while independent unaffected projections remain current.

## Ordinary native integration, execution gated

`private-equity/.../z1-shared-work/owner.ts` implements claim orchestration,
separate owned producer/checker processes, checked-publication binding and
per-Work consumption inside the **existing** S5 portfolio transaction.
The orchestration leaf supplies a strict canonical `JobHandler` factory.

`native.ts`, `native-store.ts`, `resources.ts`, `admission.ts` and `owners.ts`
provide the concrete ordinary ports for canonical intake/persistence/claim
fencing, original-parent debits, separate S8 checks and typed S3/S4 consumption.
`api.ts` and `work-panel.tsx` integrate with the existing authenticated route
and original Work mount through coordinator-owned shared changes.
The coordinator adopted the prior base/portfolio migrations and shared source
integration. Its empty existing-database catalog upgrade is not a populated
reservation, owner flow or authenticated installed-execution receipt. The new
occupation-stream/receipt-state forward proposal remains unassigned and
unapplied, separately requiring coordinator review.
Native entry points require `FINNOR_Z1_PROFILE=ordinary_disposable` and
`FINNOR_ENVIRONMENT=staging` for the converged runtime, or the legacy standalone
`FINNOR_ENVIRONMENT=ordinary_disposable`. Both require nonproduction mode or
the explicit `FINNOR_Z1_INSTALLED_DEVELOPMENT=1` compiled-development setting.
`VERCEL_ENV=production` is always refused. The native driver checks the chosen
global profile matches the existing frontend/API and its owned worker.
These settings neither create disposable authority nor replace real authentication.

`portfolio-stream.ts` folds the complete canonical S5 occupation projection
through strict bounded MANIFEST/DATA/SEAL frames. The concrete native adapter
holds the same transaction and S5 serializer across fixed-size cursor fetches.
It checks independent original/other/envelope counts, canonical membership
order/digests, scope fences, selected current heads and exact prefix/occupancy
capacity before returning a receipt. All retained statuses, including UNKNOWN,
contribute their upper envelopes. Unselected quantities stay opaque witnesses;
this grants no S6 settlement. The legacy full-snapshot limit remains 8 MiB.

This new data path and persisted-delivery refinements are implemented but
unverified. The new narrow type, SQL-grammar and public stream-process attempts
all stopped before check children at the unchanged 4 GiB disk guard. Their
source inventories precede further review edits. Existing earlier producer/
checker passes do not validate the stream, SQL cursor or receipt transitions.
See `scope-z/phase-evidence/z1/implementation-20261026-17/` and the scripts README
for the bound argument, proposed migration and separate qualification states.

Child processes receive no inherited credential environment. Memory/input/
output/time bounds and actual PID/exit/process receipts are retained. This
is not an OS filesystem/network sandbox or an attested runtime. USD,
aggregate memory, loader-parent overhead, native storage, S7 and field costs
remain separate meter gaps. Tick accounting is not a complete financial cost.

## Replay

From an absolute checkout with Node 22 and its locked dependencies:

```sh
cd /absolute/checkout/finnor-os
npm ci --ignore-scripts --no-audit --no-fund
export FINNOR_Z1_SOURCE_COMMIT="$(git -C /absolute/checkout rev-parse HEAD)"
export FINNOR_Z1_SOURCE_TREE="$(git -C /absolute/checkout rev-parse 'HEAD^{tree}')"
node --import ./node_modules/tsx/dist/loader.mjs \
  scripts/project-z/z1/verify.mjs /absolute/new/evidence
node --import ./node_modules/tsx/dist/loader.mjs \
  scripts/project-z/z1/edge-cases.mjs /absolute/new/edge-evidence
node --import ./node_modules/tsx/dist/loader.mjs \
  scripts/project-z/z1/physical-recovery.mjs /absolute/new/recovery-evidence
```

These two fixture-only variables bind the public replay to the declared
checkout. Without them, fixtures explicitly use the historical starting base,
not an assertion about an installed final commit. The fresh reconstruction
sets and records both automatically and hashes installed native loader assets.

The recovery runner kills an owned **local file-fixture worker** at three
durable boundaries. It does not prove canonical queue/S3/S4/S5/S6 recovery.
Public 32-family names and 256 local case slots are not protected or native
32×8 qualification, independently accepted assignments or a novelty claim.

`scripts/project-z/z1/reconstruct.py /absolute/new/evidence` creates a fresh
source target, performs its own locked install with a private npm cache,
checks kernel types and repeats all three runners without borrowed modules
or runtime Git objects, then removes the temporary target. It proves only
this installed development kernel, not authenticated FINNOR installation.
On the shared host, put installs/typechecks/heavy runs under
`flock /home/factory-user/repos/finnor-z-shared-heavy.lock`, and keep
`NODE_OPTIONS=--max-old-space-size=1536` for these bounded kernel runners.
On the existing `zphasefinnor` Computer, use
`/home/factory-user/repos/finnor-z-remote-heavy.lock` instead. Never use two
different heavy locks for concurrent work on the same host. Full graph
checks/builds have a separate maximum of 4096 MiB. Preserve the existing
4/6/8 GiB entry guards. Do not start another person's stack.
