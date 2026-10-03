# S6-11R preregistration and test-audit decision

This implements only frozen S6-11R. Actual production nonrollbackable custody and
deployment remain X1. A separate disposable local process is a protocol oracle,
not evidence that a same-UID machine supplies independent protection.

Observable contract: every dependent ledger read, append and dispatch verifies
the exact authenticated local history against a release-pinned witness. A witness
ahead of, or conflicting with, local history refuses operation. Outage or an
invalid/replayed response also refuses operation. A durable local suffix from a
crash before witness acknowledgment may extend only the witness's matching prefix;
it cannot replace history or reset sequence. A lost witness reply permits retrieval
of the same acknowledged commitment, without changing the original ledger receipt.

Failure modes: rollback of both journal and signed head; fork at equal sequence;
unavailable witness; redirect/endpoint substitution; wrong witness key/ledger ID;
nonce replay; malformed/outsize response; valid witness prefix with local durable
unacknowledged suffix; duplicate commit; receipt reset during recovery. All witness
messages bind the ledger ID, signer, nonce, sequence and checkpoint. One operation
has a 5-second witness deadline, at most 256 commitment steps per request and
bounded messages. Production endpoints require HTTPS; only disposable loopback
fixtures may use HTTP. No business payload is sent to the witness.

Test authoring gate: extend the existing protected-journal/truncation and storage
failure/SIGKILL cases in `run-ledger-e2e.mts`; do not create another challenge
family. The pre-repair implementation accepts whole-state rollback because both
local files are valid together. Preserve that failing baseline before changing
production. The independent fixture owns a separate persisted monotonic head and
verifies signed ledger commitments; test inputs never pre-supply acceptance or
protected receipts. No production interface exists solely for tests: the pinned
witness interface is the actual missing deployment contract.

Evidence records exact fixture/source/runtime inputs, signed requests/replies,
local before/after histories, observed refusal codes, retained recovery receipt
identity, terminal processes, source freeze and repeatable command. Existing
writer-exclusion, content tampering, typed owner, IR and concurrency checks remain.
