# X5 local reproduction

`verification-ledger.json` is the completion authority. These instructions are a
recipe, not a claim that every gate passed. Failed attempts remain in the local
delivery evidence directory. The independent pre-code oracle is unchanged.

## Runtime and source

- Parent: `c421182fc4f322824d49cd444bc8f89d95e39736`.
- Ordinary verified runtime target: Node 22.23.3, Linux x64, both repository
  lockfiles. X5's actual trainer/inference child uses only the locked Node/tsx
  graph. Its numerical reference is standard-library Python.
- The disposable driver uses the locked `embedded-postgres` native PostgreSQL
  server, real commit timestamps, ordinary non-superuser/non-bypass-RLS roles,
  signed disposable identity and actual emitted API. Managed extensions are
  explicitly omitted in that lower environment. This is not hosted qualification.
- The existing worker image retains its separately pinned Node version and
  ARM64/native scientific prerequisites. A source change or different exact
  runtime invalidates an old capsule. No Docker/ARM64 image proof is implied by
  a local Node run.

Install both lockfiles with Node 22 active:

```sh
REPO=/home/factory-user/repos/finnor-x5
NODE=/home/factory-user/x3-tools/node_modules/node/bin/node
export PATH=/home/factory-user/x3-tools/node_modules/node/bin:$PATH
export FINNOR_S3_PYTHON=/home/factory-user/x3-tools/python/bin/python
export FINNOR_S4_PYTHON=/home/factory-user/x3-tools/python/bin/python
npm ci --prefix "$REPO" --no-audit --no-fund
npm ci --prefix "$REPO/finnor-os" --no-audit --no-fund
cd "$REPO/finnor-os"
NODE_OPTIONS=--max-old-space-size=4096 npm run build --workspace=@finnor/api
```

Prebuild seals native X3, then X5. Do not edit sealed product files while a
campaign runs. Each run needs a fresh absolute output directory. Never reuse a
failed run's terminal rows as proof of a later source cut.

The Python paths are explicit native S3/S4 prerequisites for the real N06
handoff, not an X5 trainer. Provision the scientific owner's locked
`packages/epistemic-runtime/src/intervention-requirements.txt` and
`requirements-s5.txt` in that Python environment. X5 training itself remains
the locked Node entrypoint. The full/pending driver fails before fixture
creation when either absolute Python setting is absent.

## Installed checks

From `finnor-os`, with the variables above:

```sh
FINNOR_X5_BUILT_API=1 FINNOR_X5_PHASE=probes \
  FINNOR_X5_EVIDENCE_DIR=/home/factory-user/x5-delivery/evidence/new-probes \
  "$NODE" --import=tsx scripts/x5/run-installed.mts
FINNOR_X5_BUILT_API=1 FINNOR_X5_PHASE=review-probes \
  FINNOR_X5_EVIDENCE_DIR=/home/factory-user/x5-delivery/evidence/new-review \
  "$NODE" --import=tsx scripts/x5/run-installed.mts
WORKER_JOB_LEASE_SECONDS=30 FINNOR_X5_BUILT_API=1 FINNOR_X5_PHASE=faults \
  FINNOR_X5_EVIDENCE_DIR=/home/factory-user/x5-delivery/evidence/new-faults \
  "$NODE" --import=tsx scripts/x5/run-installed.mts
WORKER_JOB_LEASE_SECONDS=30 FINNOR_X5_BUILT_API=1 FINNOR_X5_PHASE=resources \
  FINNOR_X5_EVIDENCE_DIR=/home/factory-user/x5-delivery/evidence/new-resources \
  "$NODE" --import=tsx scripts/x5/run-installed.mts
FINNOR_X5_BUILT_API=1 FINNOR_X5_PHASE=caller-expiry \
  FINNOR_X5_EVIDENCE_DIR=/home/factory-user/x5-delivery/evidence/new-caller-expiry \
  "$NODE" --import=tsx scripts/x5/run-installed.mts
FINNOR_X5_BUILT_API=1 FINNOR_X5_PHASE=full \
  FINNOR_X5_EVIDENCE_DIR=/home/factory-user/x5-delivery/evidence/new-full \
  "$NODE" --import=tsx scripts/x5/run-installed.mts
```

Run serially, each under a 900-second command limit. The full run keeps the
ordinary default queue lease. Only the separate registered failure diagnostics
use 30 seconds. Work remains 3,600 seconds, child 30 seconds, heap 256 MiB,
IPC 4 MiB, logs 64 KiB, sampled RSS kill 384 MiB, attempts eight, uses 256 and
retained X5 payload 16 MiB. Smaller original allocations are explicit negative
cases, not renewed budgets.

The full run must produce 32 independently registered four-replica assignments,
128 observed outcomes, the complete physical-use census, actual native
independent approvals, signed typed S8 checks, cold revocation and final summary.
A native evaluator result alone is not the full gate.

Reproduce the actual retained parameters without importing the trainer:

```sh
python3 "$REPO/finnor-os/scripts/x5/reference.py" \
  /home/factory-user/x5-delivery/evidence/new-full
```

## Mounted maintained Work

Start `FINNOR_X5_PHASE=browser` with an emitted API and fresh evidence directory.
It builds/starts the actual Next frontend and waits. Once
`browser-fixture.json` exists, run in a second terminal:

```sh
FINNOR_X5_EVIDENCE_DIR=/home/factory-user/x5-delivery/evidence/new-browser \
  "$NODE" --import=tsx scripts/x5/browser-checks.mts
```

The browser runner uses its own named session, real forms, real signed login
and automatic refresh, actual owner-response delays, ordinary workers and SQL.
It does not seed browser storage/tokens or replace owner success bodies. It
closes its session and stops its own fixture. No customer or hosted credential
is needed or permitted.

## Interpretation

Local signers, data, actors and public/dependent partitions are builder
controlled. Original parameters are an ablation, not the equipped comparator.
The native exact and neural-disabled procedure arms remain the strong
comparators. Noncompletion within a decision budget is not an elapsed
3,600-second harm proof. Money, human work, reasoning reduction and aggregate
memory remain UNKNOWN. See `external-continuation.md` for unavailable gates.
