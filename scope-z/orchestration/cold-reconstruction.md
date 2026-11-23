# Exact cold context reconstruction

The sealed product/283-member execution locks are unchanged. The complete
handoff is the pinned source checkout **plus both archives and receipts**:

1. `evidence/project-z-execution-pack-1.0.0.tar.gz`
2. `evidence/reconstruction-bootstrap-1.0.0.tar.gz`
3. `evidence/execution-pack-seal-receipt.json`
4. `evidence/reconstruction-bootstrap-receipt.json`
5. `evidence/context-transport-manifest.json`

The first archive is 3,570,581 bytes, SHA-256
`c6c5868a077346e61f50dea1d4fe77682a8c6e70a658a8e863752fb59cd52703`.
The bootstrap is 17,256 bytes, SHA-256
`659a086b3ec81192d777941b51861ebac029c71f0e654c5e74929f789b3a8ff3`.

The bootstrap supplies only the unchanged 43,440-byte historical draft.
Its exact SHA-256 is already bound by the sealed prompt index at
`historicalDraftExcluded`. It is not an active prompt or silently recovered
R1 blueprint. It remains excluded from active inline payloads.

## Actual first failure and correction

A completely fresh independently copied Git target at base
`7bfdd2d3ab611c90f1355637858824ff1ba67f98`, with no node_modules, first failed
the real assembler CLI because that inactive draft was absent. Original:
`evidence/cold-reconstruction-97a0feffbcd84d2baad9b6e6e63d5224/report.json`.
The complete failed target is retained, including the new failure receipt
that its checker wrote. Do not “repair” that indexed failed target in place.

A **new** fresh target with the separately pinned bootstrap passed:
`evidence/cold-reconstruction-2c252b89821a4b3788528832b44eb89b/report.json`.
All five real steps passed: independent source copy, pinned checkout,
assembler check, execution-builder check, non-fixture controller verify.
No dependency installation, borrowed modules, Git alternates, model/session
invocation, remote delivery or FINNOR product-runtime test occurred.

## Repeat the full finite E2E

```sh
python3 /home/factory-user/repos/finnor-z-coordinator/scope-z/orchestration/e2e_cold_reconstruction.py \
  --bootstrap-archive /home/factory-user/repos/finnor-z-coordinator/scope-z/orchestration/evidence/reconstruction-bootstrap-1.0.0.tar.gz
```

The driver creates a new task-owned target every time, uses `git clone
--no-local`, verifies no alternates/dependency borrowing, rejects unsafe or
differing existing archive entries, and records actual CLI inputs/outputs/
statuses. It never deletes previous targets. Its first deliberate run without
the bootstrap is a real failed reconstruction, not a PASS or product defect.

For a remote receiver, obtain the original pinned source objects first,
verify the separately supplied transport/lock digests, then extract both
archives with path-safe **no-clobber** handling into a fresh checkout. Run
the same three check commands with the destination's actual absolute cwd.
Actual Computer/model/delivery/full-read receipts and a current-source launch
snapshot remain required. This successful cold context replay is not the
separate final installed FINNOR owner/mount proof.
