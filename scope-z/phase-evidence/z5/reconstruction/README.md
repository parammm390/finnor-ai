# Reconstructible Z5 engineering delivery

## Current continuation, memory guards and checkpoint 11

`../reconstruction-memory-01.md` and checkpoint 11 bind current code digest
`4b897351ee60ecb0a8b2894730382f291e1c14715eb10f3da6fd859887299b0e`.
The driver now checks 4-GiB process / 6-GiB installed-engineering memory
headroom inside each held heavy lock before resource-intensive dispatch.
Both existing 8-GiB disk checks and the 4096-MiB graph heap cap remain.
The source replay sequence also includes `finite-boundary-e2e.mjs`.

Read-only `--memory-headroom process` or `--memory-headroom graph` reports
actual Linux memory and exact required bytes using Node 22.23.4. Exit 0
means HEADROOM ONLY, not permission or a successful reconstruction.
Below-floor/unknown memory refuses with exit 2; locked dispatch converts a
failed preflight to 1 so it cannot impersonate the native guard's expected 2.
The actual local wrapper replay and native zero-action refusal are retained;
they do not extract an archive, install modules or run a native target.

The ONE commit retry is still consumed and no committed transfer packet
exists. No recipe below grants another attempt or a staged-source workaround.
Earlier current/pending source-cut text is preserved history. Installation,
cold replay, native proof and coordinator acceptance remain unpassed.
Full cached-index whitespace is exit 2 on preserved patch/log evidence;
implementation whitespace and the current worktree check are clean. These
historical bytes and the consumed reviewed index are not rewritten.

## Current continuation, committed packet still NOT_DELIVERED

The one approved local commit retry was consumed by a further Shield refusal.
`../commit-retry-01/result.json` records that terminal outcome. No additional
commit, staged-source archive, journal exclusion or hook/identity change is
permitted. The recipes below do not grant authority to retry or package
uncommitted source.

The corrected current worktree has 37 implementation files, code digest
`f894c1b2299be223a907b22e77cd24ecf6e886f6de56c8f6bb2f02544f387f58`.
Its source-bound handoff and inventory are `../finite-boundary-01.md` and
`../source-current-checkpoint-10.json`; the preserved reviewed index is older.
`finite-boundary-e2e.mjs` supplies an additional diagnosed process replay with
retained inputs, expected values and before/after raw results. It needs a
fresh absolute directory under the extracted phase evidence prefix and the
same pinned Node/Python, original heavy lock and process-memory guard.
It is not a native or installed qualification flow.

Everything below is historical source-cut evidence or a conditional recipe.
No final commit/archive/receipt, extraction, own dependency install or build
has occurred. The 8-GiB installation floor stays unchanged. No native target
manifest has been supplied or verified; this lane does not operate another
Computer or release its own slot.

## Authority revision 02

ONE reviewed Shield-checked local commit retry is now explicitly approved.
`../commit-review-01/authority/` preserves the exact coordinator records.
The original journal remains included unchanged; no exclusion or bypass.
The source-cut state is RETRY_PENDING, not a successful commit/archive.
The later `../commit-retry-01/` transaction record must carry the actual result.
Historical blocked/no-retry statements below remain checkpoint-08 evidence.
If the retry passes, execute this committed-source recipe without weakening
any guard. Otherwise stop the retry. No native target is authorized here.
The old Z1 hold is superseded by current user direction, but this lane neither
performs Z1 replay nor operates another Computer.

Current status: **no archive or cold replay**. Droid Shield denied the local
commit for a potential secret in `../recovery-e2e-01/journal.json`. That action
was not retried or bypassed. See `../BLOCKED-CHECKPOINT.md`; the commands below
remain a recipe until user review resolves the block.

The future packager now selects exact integration request 07, manifest
SHA-256 `fb88fe4dc4b23d46927a92c716f8d64c2edfc2f33389f9282b4285fdd9a35f5c`,
patch SHA-256 `793cd28d935908cc50d3eebee513f0deda0e2f39e7f9e3e12d90a340a6794ef7`.
It adds bounded planning-refusal handling to one postimage; all eleven
preimages, ten other postimages and SQL metadata match 06. It passes a strict
read-only Git check. This source-only pin change does not execute packaging
or relax its clean committed-source or headroom guards.

The final delivery is generated **after the selected-path source commit**.
`delivery-01/receipt.json` pins that exact head/tree, every archive member,
the archive, manifest, standalone reconstructor and unapplied integration
patch. The archive contains every committed regular file, including baseline
sources, pinned dependency locks/native assets, public cases and retained
failures. It excludes Git objects, node_modules, user-untracked launch files,
credentials supplied through the environment and any peer dirty source.

Build the deterministic package from the actual clean committed worktree:

```sh
cd /home/factory-user/repos/finnor-z5 &&
python3 /home/factory-user/repos/finnor-z5/finnor-os/scripts/project-z/z5/freeze-delivery.py \
  /home/factory-user/repos/finnor-z5/scope-z/phase-evidence/z5/reconstruction/delivery-01
```

The final handoff gives the real receipt SHA-256. Pass that value as argument
two below. It is a required externally checked preimage, not a value the
reconstructor invents. The following command shape uses the shell variable
`RECEIPT_SHA256` for that exact recorded digest:

```sh
FINNOR_Z5_HEAVY_LOCK=/home/factory-user/repos/finnor-z-shared-heavy.lock \
/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin/node \
  /absolute/delivery/reconstruct.mjs /absolute/delivery/receipt.json \
  "$RECEIPT_SHA256" /absolute/fresh-owned-target --offline-replay
```

All CLI paths must be absolute and the target must not exist. Use Node
22.23.4 and `/usr/bin/python3` 3.12.3. The standalone driver authenticates its
own delivered bytes, receipt, manifest and archive, rejects duplicate/escaped/
special/link/missing members, enforces byte/headroom bounds and checks every
member. It places an explicitly declared manifest at the native source
identity seam. It never adopts parent Git, fetches source, resolves modules
from another checkout, initializes a database or starts a listener.

Offline replay repeats original producer/checker corruption/currentness
process checks and the three real **LOCAL FILE** worker interruptions on the
newly extracted source. The native driver must again exit 2 with zero actions.
These are source/package E2E results, not an installed FINNOR application,
authenticated native queue proof or protected qualification.

The public runner now also records exact frozen-input identity counts before
a full sweep. The existing 256 slots contain 84 different inputs and only
50 different positive inputs in the original 188-positive-slot denominator.
Those counts are diagnostic, not structural-family qualification. The actual
`--audit-only` invocation is retained in
`../public-population-audit-01/`; it does not extract source, replay semantics,
resolve the commit denial or substitute for this blocked cold reconstruction.

`../public-sweep-04/` now retains actual execution of the current default
runner, including that audit prelude and all 256 original producer/checker
pairs. Independent artifact verification exits 0. It ran on that source
worktree, not a newly extracted source or separately installed application.
It does not resolve the missing committed archive, source receipt or native
authority. Its first missing-`time` launch failure is retained; the successful
command uses existing Python standard-library timing, not a new dependency.

Current source identities are in `../source-current-checkpoint-08.json`.
Retained-request/head publication guards, the narrow planning transport fix
and common output containment have separate pre-change models and affected
engineering receipts. Process E2E 03 exercises current canonical output;
native guard 08 still refuses before all native actions. These worktree
checks do not create an archive, extract source or establish installed proof.

`--extract-only` performs only exact extraction. `--install-engineering` is a
separate recipe, requiring at least **8 GiB free** before any install. It
performs fresh root/backend `npm ci`, proposed full graph checks with locally
installed declarations, existing catalogue/lint checks and baseline app
builds. Every step is bounded and retained; failures do not become PASSED.
It never applies the coordinator-owned shared proposal. Accordingly even a
successful run is explicitly **baseline plus owned leaves with an unapplied
Z5 proposal**, not installed native Z5 qualification. The current machine
lacks that safe disk headroom; no dependency installation is attempted.
Timeout/output limits terminate only the subprocess group created by this
driver, including its `flock`/npm descendants, not just the wrapper. The
process-group change has syntax coverage only; cold execution is NOT_RUN.

The current driver preserves that early check and now rechecks actual
headroom inside the same held heavy lock immediately before EACH root/backend
`npm ci`, with no lock release between check and install. This closes the stale
pre-extraction/lock-wait measurement gap. The floor is not a disk reservation
against an uncoordinated writer and has not been lowered.

Read-only diagnostic command, safe without a delivery receipt:

```sh
/usr/bin/flock -w 600 -x /home/factory-user/repos/finnor-z-shared-heavy.lock \
  /home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin/node \
  /home/factory-user/repos/finnor-z5/finnor-os/scripts/project-z/z5/reconstruct.mjs \
  --installation-headroom /home/factory-user/repos/finnor-z5
```

It returns 2 below the floor, or 0 for HEADROOM ONLY, with zero installs,
DB actions and listeners. It cannot read a receipt/archive, extract or invoke
npm. It is not cold reconstruction or a bypass of the commit denial.
`../installation-headroom-failure-model-01.md` precedes the change.

Actual current diagnostic: exit 2, 2,917,261,312 available bytes versus the
unchanged 8,589,934,592-byte requirement. Driver and embedded-wrapper syntax
exit 0; the relative-path negative exits 1; independent verification exits 0.
`../installation-headroom-01.md` pins the actual command and source/log hashes.
The npm branch remains unexecuted. This is not a cold archive receipt.

On a no-Git target the original coverage auditor's display-only
`git rev-parse HEAD` metadata is supplied only from fully verified declared
archive membership by `source-metadata.mjs`. The receipt labels this as a
manifest declaration, not an observed Git repository. No audit predicate,
expected output, source graph or failure condition changes.
Application builds remain baseline-plus-leaves, not the integrated proposal;
mandatory shared signatures/registrations can block those builds until the
coordinator integrates the exact proposal. Such a failure is retained, not
converted to an installed pass.

The coordinator must independently integrate/rebase the frozen shared
request, assign the real migration/head/bundle, regenerate canonical outputs
and reconstruct that **integrated** source before native qualification.
This lane neither fabricates its acceptance nor treats a missing DB/Auth
permission as proof of completed integration. No Z1 archive replay is run.

Reconstruction outputs are generated derivatives, not hidden source inputs.
Keep reports and exact failure receipts; a temporary extracted source tree
can be removed after its replay report and input identities are retained.
