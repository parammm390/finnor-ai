# Z4 engineering reconstruction

These commands do not authorize DB/Auth setup, grants, listeners, a native
target replay, protected cases or financial effects. `NATIVE-REPLAY.md` covers
the separate existing-target authority guard.

## Declared inputs

Use this same phase checkout and branch. The shared-request manifest pins the
baseline commit. The delivery report pins the owned-source commit/tree, overlay
digest, native identities and all archives. A declared baseline Git archive is
an input, not an undeclared parent checkout fallback. Never reset a dirty
checkout or replace another lane's work to reconstruct this phase.

`toolchain-pins.json`, Cargo.lock and both npm locks are authoritative. Public
dependency fetches must match their recorded hashes. The source inventory
uses Node 22.23.4 with its exact bundled npm 10.9.9. The retained npm 11.19.1
attempt failed normal lock/peer validation; neither lock nor peer policy was
changed to conceal it. A corrective `toolchains --npm-only` attempt requires
the exact previous terminal receipt SHA and retains the old prefix/receipt.
The source inventory
accepts an explicit producer Node and optional Rust prefix. The isolated target
installs its own Node/npm and Rust from verified archives, never by copying
those producer executables or node_modules. Native output bytes need not match
across distinct build paths; source, locks, parameters and the newly installed
binary hash remain separate observed identities.

Use a fresh evidence directory for every attempted command. Retain each
failure. Install/build/check commands serialize on
`/home/factory-user/repos/finnor-z-shared-heavy.lock`; graph checks use at most
4096 MiB and two CPUs/jobs. The native rebuild keeps its two-GiB free-space
guard. A temporary-cleanup receipt may retire only positively identified own
generated intermediates or duplicate dependency payloads. Keep their source,
official archives, manifests, installed proof binaries and original logs.
Retired generated compiler/cache prefixes are not claimed to remain installed.

## Executable sequence

Set absolute `SOURCE`, `RUN`, `TARGET`, `REQUESTS` and `PRODUCER_NODE` paths.
`RUN` and `TARGET` must remain below this checkout's
`scope-z/phase-evidence/z4/`. `REQUESTS` is an immutable generated proposal set.
The producer Rust prefix must already be declared and available for inventory
and Cargo vendoring. `install-rust.py` supplies the explicit official producer
toolchain bootstrap; no DB or application stack is needed.
For a fresh source prefix its command is
`python3 install-rust.py --prefix "$SOURCE/finnor-os/packages/epistemic-runtime/native/z4-execution-proof/.toolchain"`.
An already retained archive prefix is not overwritten. A newly installed
producer prefix can instead be declared with `--rust-prefix /absolute/prefix/installed`
on both `inventory` and `vendor`.

From `SOURCE/finnor-os/scripts/project-z/z4/`:

```sh
python3 reconstruct.py inventory --repository "$SOURCE" --node "$PRODUCER_NODE" --evidence "$RUN/inventory"
flock /home/factory-user/repos/finnor-z-shared-heavy.lock python3 reconstruct.py vendor --repository "$SOURCE" --evidence "$RUN/vendor" --fetch-missing-pinned
python3 reconstruct.py stage --repository "$SOURCE" --vendor "$RUN/vendor" --target "$TARGET" --evidence "$RUN/core-stage"
python3 engineering.py toolchains --repository "$SOURCE" --target "$TARGET" --evidence "$RUN/toolchains"
flock /home/factory-user/repos/finnor-z-shared-heavy.lock python3 reconstruct.py build --repository "$SOURCE" --vendor "$RUN/vendor" --target "$TARGET" --evidence "$RUN/native-build"
flock /home/factory-user/repos/finnor-z-shared-heavy.lock python3 reconstruct.py verify --repository "$SOURCE" --target "$TARGET" --evidence "$RUN/core-verify"
flock /home/factory-user/repos/finnor-z-shared-heavy.lock python3 engineering.py stage --repository "$SOURCE" --target "$TARGET" --requests "$REQUESTS" --expand-core --evidence "$RUN/product-stage"
python3 engineering.py install --repository "$SOURCE" --target "$TARGET" --fetch-missing-pinned --evidence "$RUN/product-install"
python3 engineering.py checks --repository "$SOURCE" --target "$TARGET" --evidence "$RUN/product-checks"
python3 engineering.py builds --repository "$SOURCE" --target "$TARGET" --evidence "$RUN/product-builds"
python3 engineering.py generated-requests --repository "$SOURCE" --target "$TARGET" --evidence "$RUN/generated-requests"
python3 deliver.py --repository "$SOURCE" --target "$TARGET" --requests "$REQUESTS" --checks "$RUN/product-checks" --builds "$RUN/product-builds" --evidence "$RUN/delivery"
```

No command above starts the certification stack or executes migration SQL.
Native toolchains may be installed in separate `--rust-only` and
`--runtime-only` attempts. If owned source changes before source freeze,
`refresh-owned` requires an actually observed old staged inventory and retains
the rebuilt native identity. `rebind` verifies the matching owned tree before
rebinding lineage to a reviewed local commit. Neither turns old checks into
current checks.
`update-requests` requires the exact previous proposal set and validates every
old staged postimage and every unchanged live preimage before composing a new
proposal set. It never writes shared live files.

The checks run actual generators, selected-profile Next typegen, source
stamps and installed provenance before the source inventory. They then run
the existing workspace, auth matrix, action, domain, capability/client/forms/
coverage, type, lint and compute-policy checks. The scoped lint configuration
removes the root's global finnor-os ignore for the explicit owned file list.
The Node module loader refuses module resolution outside the target. It is
an import boundary, not an OS sandbox.
Keep `NODE_OPTIONS=--import=/absolute/extracted/root/finnor-os/scripts/project-z/z4/isolation-loader.mjs`
when an authorized operator starts an extracted API or replay process. The
preload declares that exact extracted root, so bundled source URLs cannot
silently select the build checkout. The replay launcher preserves this guard
for its concrete children. These are startup requirements, not permission to
start a listener here.

Both builds must leave the complete source population unchanged, emit the
declared build IDs and trace the actual native/source assets without compiler
intermediates. The installed archive includes actual builds, native binaries,
runtime traces, source identity assets, pinned Node/npm and concrete replay
dependencies. Its readback verifies every declared member. The owned-source
archive is an overlay against the declared baseline, not a claim to contain
that baseline or an independently authenticated installed runtime.

## Qualification

Offline proofs, source checks, builds, archive integrity and missing-authority
refusals are engineering evidence only. Source-native, installed-native,
protected and financial qualification remain separate. A local package is not
permission to publish it. Coordinator acceptance alone releases the slot.

The checked verifier currently retains a full independent original-integer
replay and input-commitment read. Do not call its whole lifecycle sublinear or
infer a compact-cost speedup from fixed proof size or a warm verifier timer.
The complete bounded scaling sweep retains failing 64/256-step observations;
operational 100× is NOT_PASSED and financial qualification is NOT_RUN.
Credential-free frontend builds also do not configure a real Auth project:
the existing browser Auth module inlines its public project configuration at
build time. An authorized native target needs matching configured builds and
fresh exact build/authority receipts, not an invented login bypass.
