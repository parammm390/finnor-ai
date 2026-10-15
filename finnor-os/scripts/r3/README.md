# Native R3 environment

Use Python 3.11 and `requirements.lock` in a separate virtual environment.
`uv pip sync --require-hashes --python <venv>/bin/python requirements.lock`
installs the pinned numerical proposer dependencies. Do not upgrade shared
scientific environments. The separately launched checker uses only Python's
standard library.

The observed PySCIPOpt 6.0.0 wheel exposes SCIP 10.0.0 in **FLOAT64** mode.
It does not expose the documented exact-mode option. No exact SCIP/VIPR
certificate is claimed. Candidate transfers are reconstructed as rationals,
repaired on the exact fixed allocation where necessary, and checked against
every original inequality in a separate process. Numerical optimum/bound/
infeasibility statuses never establish an accepted original-problem proof.

Run `run-native.py --python <venv>/bin/python --output <new-evidence-dir>`.
Original inputs, trace, separate checks, mutations, references, process
identity, observed meters and failures are retained in that directory.
