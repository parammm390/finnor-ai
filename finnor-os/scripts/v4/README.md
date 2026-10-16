# Disposable capital-formation verification

This runner uses synthetic identities, independent test actors, installed API
routes, PostgreSQL and the physical worker. It does not establish live financial
authority, S8 admission, a cumulative V1–V5 pass or economic completion.
The restored plan files under `scope-v/v4-autonomous-capital-formation` are
historical preregistration assets required by source capture, not current
qualification receipts. Each new run's actual results remain authoritative.

## Clean prerequisites

Use Node 22 and Python 3.12 on a disposable machine with sufficient storage.
Retain the original limits in the verification plans. Do not clean peer data or
extend an existing programme to make a run succeed.

From the repository root:

```sh
npm ci
(cd finnor-os && npm ci && npm run build --workspace @finnor/api)
python3.12 -m venv .venv-v4
.venv-v4/bin/pip install \
  -r finnor-os/packages/epistemic-runtime/src/intervention-requirements.txt \
  -r finnor-os/packages/epistemic-runtime/src/requirements-s5.txt \
  -r finnor-os/scripts/v4/requirements-reference.txt
.venv-v4/bin/pip check
export FINNOR_S3_PYTHON="$PWD/.venv-v4/bin/python"
```

Both JavaScript lockfiles are required. The independent reference oracle also
requires `cryptography`; NumPy and SciPy alone are insufficient. The runner checks
imports and the declared exact Python package pins before database initialisation.

## Run

From `finnor-os`, run the full existing capital regression:

```sh
node --import=tsx scripts/v4/run-local.mts
```

Select the native original-Work continuation regression:

```sh
FINNOR_V4_ORIGINAL_WORK_PROOF=only node --import=tsx scripts/v4/run-local.mts
```

Select one registered boundary case for an affected-case rerun:

```sh
FINNOR_V4_BOUNDARY_CASE=D_SCOPED_SOURCES_AND_CYCLES \
  node --import=tsx scripts/v4/run-local.mts
```

Unknown boundary IDs fail. Selection is recorded in `results.json`; omitted
cases are not passes. Set `FINNOR_V4_EVIDENCE_DIR` to a new private directory for
each attempt. Retain the source snapshots, scientific versions, owner inputs,
observed results and failed attempts. Do not publish raw evidence with source.

The original-Work proof checks identity, input, goal, ceiling and counter
preservation, plus stale-input, cancellation and late-input refusals. Its explicit
whole-goal criterion remains unfulfilled. It does not execute a financing draw or
close a transaction.
