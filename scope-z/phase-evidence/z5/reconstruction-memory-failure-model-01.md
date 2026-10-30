# Reconstruction memory-guard failure and expected-value model

Written before the diagnostic replay and reconstruction implementation change.
Checkpoint 10 and its evidence remain immutable:
`eb17e93d4c2e1ab21698f9e24702f9439b5e615a44f55df92b8e9f3d64dbe563`.
Its 37-file code digest is
`f894c1b2299be223a907b22e77cd24ecf6e886f6de56c8f6bb2f02544f387f58`.
The reconstruction driver preimage is 13,831 bytes, SHA-256
`217ed024652cce50b1a4163036a64efe5e2cd8deddc10cc353162bcb293298cb`.

## Concrete remaining gap

The standalone reconstructor takes the shared heavy lock for process replays,
installation and full graphs. It preserves the 8-GiB disk checks, including
inside each install lock, and the 4096-MiB graph heap maximum. However, it does
not check the original 4-GiB process / 6-GiB graph available-memory floors
before those reconstructed steps. A held lock or a heap limit is not that
headroom check. The new diagnosed finite-boundary replay also is not yet in
the reconstructor's replay sequence.

This is an authored packaging-path gap, not native authority and not an
observed installation or extraction failure. The actual memory diagnostic
does not yet exist; preserve the original driver's real refusal separately.

## Required behavior

- Read Linux `MemAvailable` with no credential, DB, network, npm or source
  archive access. Missing, malformed, negative, unsafe or unrepresentable
  measurements must refuse. Keep the original byte floors: 4 GiB for source
  processes and 6 GiB for installed engineering steps/full graphs.
- Provide a read-only `--memory-headroom process|graph` diagnostic, restricted
  to the pinned Node 22.23.4 and exact argument count. It reports measured and
  required bytes, source SHA, and zero native/install actions. Exit 0 means
  MEMORY HEADROOM ONLY; below-floor or unknown is exit 2.
- Use the same diagnostic inside the already-held original heavy lock,
  immediately before dispatch. Hold that lock through the actual child.
  All offline process replays, both installs, type graphs, catalogue/lint
  checks and baseline builds must use that guarded dispatch path.
- Preserve both existing 8-GiB disk checks and the original owned-process-group
  timeout/output cleanup. The memory observation is not an OS reservation
  against uncoordinated writers and is not protected execution custody.
- A memory guard failure must not be mistaken for the native authority
  guard's expected exit 2. The dispatch wrapper must stop with exit 1 and
  report the guard's real exit/signal before starting any payload.
- Include the existing seven-case finite-boundary replay in the future
  source reconstruction sequence. Do not regenerate any case or expectation.

## Bounded actual-process verification

Before the implementation edit, invoke both proposed memory diagnostics once
on the existing driver, in a credential-free bounded process under the
original heavy lock. They currently refuse the unsupported CLI with exit 1.
Retain their original stdout/stderr, source identity and actual exit.

After the edit:

| Action | Expected value / observation |
|---|---|
| Actual process-memory diagnostic | Exact 4-GiB floor; exit 0 iff measured headroom suffices, otherwise 2 |
| Actual graph-memory diagnostic | Exact 6-GiB floor; same fail-closed rule |
| Invalid profile through actual embedded dispatch wrapper | Exit 1, payload marker absent |
| Graph-profile dispatch of a read-only child | Only after the real guard passes; child observes the heavy lock still held via a nonblocking acquisition refusal |
| Seven-case finite-boundary replay through process-profile dispatch | Same input/expectation contract, 7/7 if actual headroom permits |
| Existing native E2E authority refusal through process-profile dispatch | Actual child exit 2 with zero DB/Auth/listener/effect actions, not a memory-refusal substitute |

Run the actual embedded wrapper directly using its exact extracted source
string and the actual production driver. Do not fake a receipt, archive,
memory file, guard, owner or native target. Use fresh exclusive owned outputs.
Do not manufacture a low-memory condition. If the real memory floor refuses,
stop that path and report it; do not retry unchanged or weaken the threshold.
An unobserved insufficient-memory/read-error branch remains source/syntax
coverage only. No new unit-test campaign or exhaustive semantic sweep.

Only the reconstruction MJS and evidence/docs need change. Backend/frontend
typed sources and their actual compiler inputs remain unchanged, so do not
repeat their full graphs without a new concern. Syntax-check the driver and
both embedded JavaScript wrappers; compile the embedded Python extractor's
AST without executing extraction. Verify current code/evidence and whitespace.

## Authority, original resources and blocked delivery

The one approved commit retry is consumed. Preserve the reviewed index,
retry intent/result and byte-identical included journal; no restaging,
commit, archive workaround, hook/identity change or escalation. No final
committed transfer packet can be produced under the current stop.

No native manifest path has been provided or verified. No DB/Auth/SQLite,
launcher, listener, migration, seed, grant, signer, fake owner, borrowed
runtime/target or external effect is authorized. Shared request 07 remains
unchanged and unapplied. Original identities, Work/parent/deadline/budgets,
S6 liabilities/UNKNOWN, S7 attribution and independent S8 admission remain.
Only the coordinator accepts a current-source handoff or releases this slot.
