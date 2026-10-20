# Remaining S8 live-gate cost, preregistered 20 October 2026

The fourth native run still fails the original seven-second suite after twelve
completed negative cases. Its retained command trace shows ordinary canonical
READs taking approximately 105–149 ms, with each refusal requiring both before
and after READs. The S8 journal at that cut contains twelve entries, 273,587
bytes. Batched lifecycle source hashing alone did not fix the gate.

The S6 canonical reference read performs a full storage-integrity pass before
every read, including both checkpoint lookups made by an S8 command. Its content
loop currently opens, stats, reads, hashes and closes every committed file
serially. This is a specific remaining source of repeated file-handle latency.

## Diagnostic and failure model

Use the retained closed attempt only for read-only timing of its actual
`verifiedContentBytes` method across the same exact receipt set. Do not open the
old service, acquire its writer lock, replay business operations, alter its
history, resign authority or grade this diagnostic as a native result.
Record receipt/source hashes, count, serial and at-most-eight-handle timings,
observed results and replay inputs in a new evidence directory. Do not print
configuration, credentials, content or private keys.

If timing supports the diagnosis, batch the existing integrity content checks
with at most eight handles and `Promise.allSettled`. Each check must retain
the exact content filename derivation, same-descriptor no-follow regular-file
and size checks, complete-byte SHA256 comparison and unconditional close.
Await the entire batch before propagating its first error in original order.
Keep the ledger's request queue, release checks, complete journal/anchor checks,
every committed file on every request, witness and all current authorization
unchanged. No cross-request file cache or deferred verification is allowed.

Failure cases include changed/missing/nonregular content, symlinks, oversized
files, any read/hash/close failure, incomplete batches and accepting a command
before all integrity checks finish. Never accept a partial integrity pass.
Validate the repair through a fresh native S8 campaign with the original
deadlines, state comparisons, grants and ordinary physical worker. Retain every
earlier failure. Timing alone does not establish security or native gate success.

## Fifth native outcome

The fresh fifth attempt preserves source custody and still fails the unchanged
seven-second negative suite. Eighteen cases and two controls complete, compared
with twelve in attempts three/four; case nineteen lacks its ending-state read
and is not credited. Typical early READs drop to approximately 75–99 ms, with
later post-refusal READs around 166–194 ms. CURRENT takes 183 ms and RECHECK
408 ms. The bounded S6 content scan is independently accepted in source, but
this timing improvement is not a passing gate or security qualification.
Retain all five attempts. Further repair needs a new diagnosis of remaining
cost; do not rerun unchanged, increase seven seconds, cache integrity checks,
remove state comparisons or call incomplete cases successful.
