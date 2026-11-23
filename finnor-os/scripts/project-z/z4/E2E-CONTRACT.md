# Pre-code executable E2E contract

The public runner consumes the frozen registration. Its primary boundary is
the installed process protocol, not private helpers. Native `prove` returns an
actual compressed proof and relation/compiler/parameter identity; a new
`verify` process receives the original request and claimed output, never a
producer boolean. An independently implemented exact interpreter and
constraint correspondence pass before ordinary owner use.

For every positive, compare all final registers with the registered literal
family-formula output. Wrong-result cases change a final register while keeping
the proof. Unsupported cases change opcode to `div`. Authority/currentness/
budget/interruption rows exercise the owner protocol as separate diagnostics,
not fake authenticated native flows. Report each actual obligation separately;
an offline-only row is not a protected/native pass.

Critical falsifiers: proof bit flip/truncation/trailing bytes, program constant/
opcode/type/unit/rounding changes, initial/final/input/length/parameter/compiler/
binary changes, malformed/range/floating/overflow/Boolean/select values,
and a genuine valid field-only relation paired with an invalid signed claim.
Guarded native command without an authority manifest exits 78 before DB/Auth
or network calls. Offline fixture manifests cannot unlock it.

Physical offline recovery uses an actual owned child stopped at claim,
checkpoint/artifact and delivery boundary. Native replay requires explicit
existing-target authority; absent authority is NOT_RUN, never a fake Work.
Artifacts retain inputs, formulas, commands, statuses, meters, source/build
identities and errors. Full graph/build checks run under the shared heavy lock.

## No-replay v2 correction

The b169136 checker failed the added process-level interpreter trap because
it replayed the programme on every audit. `no-replay-e2e.mts` and
`no-replay-fault-loader.mjs` now protect the locked no-full-replay boundary.
The loader first proves its throwing interpreter replacement is active.
The checker must then accept the retained real proof and reject seven
substitutions without another interpreter call. The original reference
interpreter remains part of production diagnostics, not consumer verification.

From the selected repository's `finnor-os` directory, invoke pinned Node with
`--import tsx --import ./scripts/project-z/z4/no-replay-fault-loader.mjs`
followed by `./scripts/project-z/z4/no-replay-e2e.mts --input` and an absolute
public candidate/oracle file, plus `--evidence` and a fresh absolute directory.
Use the ordinary isolation preload and a 1 GiB Node ceiling. The current
public input is `scope-z/phase-evidence/z4/no-replay-inputs-01.json`.
The proof, not the fault loader, supplies the verified output. Input commitment
checks still scan original inputs; no whole-path sublinear claim follows.
