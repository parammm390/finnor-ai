# W2 runtime qualification failure contract, before repair

Requirements: `FINNOR-POSTZ-W-PRD-1.0.0`, especially W2, W052/W053, sections 9.3-9.5 and 11.5-11.7. This packet is engineering infrastructure, not evidence of genuine human participation, protected admission, field completion, comparative capacity, or economics.

## Frozen source failures

Base commit: `cecec15d64fe8f8fb63a5a29b98979f978ba6138`, full-source checkout. Committed vendor source and archive are present. The donor participant transfer SHA-256 is `27e2b457f60e70a79722cc456b5e7b30cca88dcb7bc408b4cef461909096df0e`.

1. `run-native-bound-e2e.mts:62-63` and `run-native-recovery-e2e.mts:62-63` only set an expiry flag and signal a worker. Awaited database/API startup or a stuck query need not return to a flag check. No external parent terminates the entire awaited body.
2. Bound lines 397/400 and recovery lines 634/637 swallow owned closer failures, then derive final status only from business failure. A failed API/pool/admin/database closer can therefore coexist with a reported PASS.
3. `current-cut-contract.md` requires `run-job.py --heavy`, but that runner is not committed on this exact base. This is a tracked-source observation, not a claim that sparse checkout omitted the vendor archive.
4. Supported `scripts/postz-w2/browser.mjs` excludes the participant identity, has no participant workspace/expiry interactions, and provides no actual browser provenance. It cannot satisfy `mounted-fixture.mts:265-280`.
5. Existing generic X1 reconstruction is institution-specific. A copied-package W2 development build does not establish a clean source/lock/assets installation.

These five are source-diagnosed failures. No full native, mounted, or cold baseline is reported as executed. Their first actual owning run and any intended failure must be retained when the heavy slot is available.

## Repair and control boundary

Reuse the proven participant supervisor's exclusive output mkdir, nonce/parent/body/inode claim, loser noninterference, owned child process-group supervision, exact PostgreSQL data-directory identity, and finite final verdict. Generalize one seam rather than clone per-campaign supervisors. Preserve original business assertions, 1200-second bound and 900-second recovery walls, 3 GiB start floors, original resources, and original output limits.

Before implementation, the process/filesystem control population is fixed as follows:

| Control | Independent expected observation |
|---|---|
| Startup never settles | The external parent terminates the actual child group within the registered control wall; final status FAIL, timeout true. |
| Closer throws or never settles | Every later closer is attempted; the named failed closer makes the final report FAIL. |
| Same-output collision | Exclusive directory creation selects one winner. The loser never spawns, reads/writes evidence, or cleans any winner resource; winner PID and evidence remain intact. |
| Nonzero exit or absent receipt | Final status FAIL even if another body field asserts success. |
| Child-group leak after success | Exact owned group is stopped and the unexpected leak prevents PASS; a separately owned neighbor survives. |
| Direct body or changed output claim | Refuse before writes, database startup, process spawn, or cleanup. |
| SIGTERM interruption | Finite termination of only the owned child group, retained interrupted FAIL verdict. |
| PostgreSQL identity mismatch | Refuse cleanup of a nonmatching PID/data directory. Real PostgreSQL validation is NOT_RUN until the heavy slot is granted. |

These are real OS process/filesystem controls, not simulated W2 actor/business outcomes. Short control walls are separately registered and cannot override production campaign limits. Child heaps are at most 64 MiB and observed child memory must stay below 256 MiB. No real database, model, browser, network service, native compiler, or build belongs in this light control population.

## Authoring gate

- Observable contract: finite execution, exclusive evidence ownership, exact cleanup, truthful terminal status, and preserved unrelated processes.
- Credible regressions: awaited startup hangs, swallowed closer errors, collision cleanup killing the winner, direct body writes without a claim, and nonzero/missing receipts reported as success.
- Existing coverage: donor participant controls establish one fixed 180-second driver, not both full campaign launchers or the supported mounted/cold routes.
- Production seam: the reusable runner is consumed by actual bound/recovery campaign launchers. No test-only production override may shorten those campaigns or fake browser metadata.

## Validation discipline

Keep source and tests unchanged during each run. Record exact input/code hashes, command, actual host, process IDs, deadlines, first failure and terminal cleanup. A source or syntax check is not native runtime proof. Do not label borrowed dependency links as cold installation. Do not stop the user-owned desktop browser.

## Outer runner and independent-freeze control population

The changed outer observer is verified through the same real twelve OS controls,
inside `run-job.py`, not by rerunning W2 business fixtures or starting a database.
An externally generated and explicitly SHA-pinned manifest freezes the source of
the runner, still-active coordinator, all declared setup/browser/native helpers,
canonical sampler, Node/Python/Git/ps and any selected npm/browser binary and
resource policy. The active coordinator checks its original source even while a
child executes in the cold source copy. Finalization checks those pins again.

Additional pre-spawn failure oracles are: wrong manifest SHA, missing source pin,
wrong tool hash, changed policy hash, and a changed active harness source pin. An
active external-pinset change and a live outer-output collision are also frozen
OS-boundary controls. Each integrity violation
must refuse or terminate its own launch, retain FAIL, and leave a separately
owned neighbor untouched. Do not change live product/controller files to create
these controls; a disposable copy or changed external pinset is required.
No such control establishes installed, browser, host-performance or protected
admission. The light controls use no browser metadata command, npm install,
PostgreSQL, paid model or native compiler.

## Disappearing-group continuation control

The 001 outer cleanup had a broad `ProcessLookupError` catch around primary
signaling, the remaining-group sweep and the final live check. A real OS
interleaving reproduced cleanup PASS with an already observed detached group
still alive. The scheduling controller pauses unchanged runner lines only;
actual ownership sampling, `poll`, `killpg`, kernel ESRCH and receipt writing
are not replaced. Its own final cleanup stops the controlled residual and
leaves an independently launched neighbor alive.

The repaired runner catches disappearance at each signaling operation, visits
every known group after a disappearing primary/earlier group, rechecks group
identity after CONT, and always reaches a separate final live-group check.
Replay the real interleaving with `run-review-regression-controls.py`. The fixed
control must witness the sweep/final check and no surviving owned group; a
receipt field alone is insufficient. Failure to observe the actual race is
NOT_REPRODUCED, never a fabricated failure-first receipt. This is bounded
process/source qualification only, not archive, installation or full cold proof.
