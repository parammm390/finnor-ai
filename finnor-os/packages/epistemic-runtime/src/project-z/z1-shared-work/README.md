# SharedWorkProgram development kernel

`produce(originalRequest)` executes one structurally shared exact DAG across
distinct original Works. `applyChanges(checkpoint, changes)` atomically applies
signed bag insertions/retractions, programme/objective edits and withdrawal.
It reuses exact unchanged nodes and recomputes dirty dependents. There are no
implicit algebraic rewrites or claims of differential-join asymptotic behavior.
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
lawful partition, source bytes/revision/rights/types, parameters and build.
Different tenants/principals cannot be combined in one authenticated batch.
Public source classification does not grant cross-principal access.

Withdrawal preserves original programme, provenance, charge history and S6
references. It releases no native liability. Revocation suppresses affected
results while independent unaffected projections remain current.

## Native seam, not a completed installed feature

`private-equity/.../z1-shared-work/owner.ts` implements claim orchestration,
separate owned producer/checker processes, checked-publication binding and
per-Work consumption inside the **existing** S5 portfolio transaction.
The orchestration leaf supplies a strict canonical `JobHandler` factory.

Its required `Z1NativePorts` have **no concrete/default implementation here**.
The coordinator must implement canonical intake/persistence/claim fencing,
original-parent debits, S8 checks, actual S3/S4 typed consumption, outbox/S7
delivery and mounted Work. Registration alone is not a positive owner flow.
Native entry points require `FINNOR_Z1_PROFILE=ordinary_disposable`,
`FINNOR_ENVIRONMENT=ordinary_disposable` and nonproduction mode. Those settings
neither create disposable authority nor replace real authentication.

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
`NODE_OPTIONS=--max-old-space-size=1536`. Do not start another person's stack.
