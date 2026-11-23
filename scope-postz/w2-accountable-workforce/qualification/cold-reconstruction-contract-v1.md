# W2 cold reconstruction contract, before implementation

This is a new qualification flow, not a claim that cold execution has occurred.
The existing development installer copies installed dependencies and cannot
itself establish a cold install.

## Required owning chain

1. Seal the exact working source file population, locks and all committed vendor
   assets. Retain a bounded source-object pack for the actual source HEAD and the
   retained migration source commit required by the existing owner installer.
   No donor `.git`, application `node_modules`, virtual environment, build
   output, user configuration or private fixture enters the source archive.
   The sole project-configuration class is `TRACKED_PUBLIC_NPM_BOOLEAN_FLAGS_V1`:
   exact tracked paths `.npmrc` and `finnor-os/.npmrc`, Git blob
   `51df798a520d03f9313c458c9c67008676b094d0`, SHA-256
   `5602bb233ec1478ef60941257e98dfa8a86c9aeb22a4705aeb4beb15605e8a40`,
   23 bytes and regular mode 0644. Both HEAD and index must retain that blob.
   The producer, packet intake and reconstructed-source checks enforce the
   exact class/bytes binding; declaration alone is insufficient. No other
   `.npmrc`, untracked/private configuration, HOME configuration or symlink is
   admitted, including a symlinked source root. A HOME source root cannot claim
   this project class even if its bytes match. Do not omit these tracked files
   to satisfy privacy filtering.
   The public producer checks the raw `--source` root and every lexical parent
   before resolving it, including an ancestral symbolic component followed by
   a real final directory. Canonicalization must not erase this refusal.
   The public root/backend install stages apply the same raw lexical check to
   `--prepared` immediately after parsing, before output creation, packet
   inspection or prepared-root resolution. Other actions keep their existing
   argument requirements.
   Independent helper checks remain required after that public boundary check.
2. Reconstruct source in one fresh, exclusively owned directory. Restore only
   the sealed Git source objects and index so the real build interfaces observe
   the same source identity, including any declared uncommitted source overlay.
   Do not create a replacement commit or override an author/committer identity.
3. Verify the declared Node/Python executables and the complete declared npm
   distribution. Use isolated HOME/TMPDIR and a new package cache populated only
   from declared, content-addressed cache assets. Run both real lock-based
   `npm ci --offline` installs. Never copy or link donor application modules.
4. Call the existing owner build-development/build-frontend interfaces. Do not
   modify kernel C, protected ABI, manifest generation or business admission.
5. Run the original installed native, bound and recovery drivers with their
   original 1200/1200/900-second walls, resource floors and original scenarios.
   Run the actual supported assigned-desktop mounted participant flow and all
   six original withdrawal/completion predicates against the fresh frontend.
6. Compare actual retained old and fresh native programme artifacts through both
   independently installed checker entrypoints. Check exact schema/graph/digest
   compatibility in both directions and reject a version-tampered artifact.
   Historical artifact compatibility is not fresh current-use authority.

## Failure population fixed before code

- Existing output, replaced ownership claim, unsafe archive path, duplicate
  archive entry, undeclared file, symbolic/hard link or byte/mode mismatch:
  refuse before extraction or any native process.
- Missing/changed source, lock, vendor asset, Git source object or declared
  runtime distribution: fail, never use a donor worktree to fill the gap.
- Missing/inadequate package cache: retain the actual offline install failure;
  no network-mode fallback or copied installed modules.
- Insufficient canonical available memory, half-CPU capacity, retained global
  disk floor, lane allocation or time: refuse/stop the owned stage without
  changing its original limits.
- Hung child/import/startup/closer, nonzero exit, missing original receipt or
  failed cleanup: fail even if another field says PASS.
- Old artifact not bound to its real installation/native receipt, missing fresh
  source-custody tamper/restoration proof, incompatible programme, or mutated
  installation: fail compatibility, no fabricated interchange fixture.
- Missing actual supported browser provenance, participant consent/readback, or
  any original mounted predicate: fail mounted/cold qualification. Never replace
  the desktop pane with Playwright or fabricate headed/external ownership flags.
- Source/locks/assets change during a stage: retain the first actual failure.
  Next-generated inputs may change only through the existing frontend finalizer's
  exact observed deltas.
- A tracked public-config path/blob/hash/mode changes or its declaration is
  absent/forged: refuse. Test these through actual source metadata and
  independently restored fixture HEAD/index/file checks, not an npm install.
  A sparse/missing tracked source file still refuses; materialize a separate
  own candidate from its immutable commit rather than repairing Integration's
  intentional sparse absence or silently dropping the file.
- A raw CLI source/prepared root or any lexical parent is symbolic: refuse
  before canonicalization. Exercise direct-root and ancestral symbolic
  spellings in the actual producer and both root/backend install-stage
  subprocesses, not only their helpers. The ancestral case must have a real,
  non-symbolic final directory. Use each CLI's ordinary relative-output refusal
  as a pre-state-change sentinel: canonical directories keep that ordinary
  error, while symbolic spellings fail the earlier specific root guard. The
  stage sentinel must precede packet inspection and install. Do not create an
  archive/install or add a production test/bypass flag.
- Unknown Linux protected admission or genuine human/field/comparative/economic
  state stays separate and NOT_ESTABLISHED. Darwin is not protected-positive
  evidence.

## Fixed envelope and evidence

New preparatory source/cache stages: 300 seconds. Each clean npm install:
900 seconds. Historical artifact compatibility: 120 seconds. The complete cold
controller: 14400 seconds inside the overall 28800-second campaign maximum.
These new setup limits never replace or renew an original scenario deadline.

Use the canonical shared heavy lease and host sampler, at least 3 GiB retained
disk, canonical host load at no more than half CPU capacity, frozen memory and net-new disk
allocation, finite real owned cleanup, immutable intake hashes and explicit
artifact allowlists. A metadata inspection is not a cold run. Source/static
checks and OS supervision controls are not installed native/browser proof.

## Resume findings and controls, fixed before completing the draft

The unfinished producer selected the parent of npm rather than npm, omitted
the HEAD and migration root-tree objects, buffered its object pack, and kept
baseline receipts at external paths without validating installed custody.
These are source-diagnosed gaps, not observed cold failures.

- The packet must carry its cache and copied baseline receipts by canonical
  relative paths. Retained checker installation and declared toolchain remain
  separately pinned explicit inputs, never donor application dependencies.
- Include the actual HEAD root tree and the retained migration commit's root
  and ancestor trees. Restore the original commit without author configuration,
  a new commit, alternates, grafts or another worktree's Git directory.
- Stream the object pack and deterministic gzip archive; seal verification
  must not silently buffer a source-sized object population.
- Refuse an uninstalled baseline, mismatched manifest/native-freeze hashes,
  unsuccessful native/cleanup receipts, or changed retained installation.
- Restore into an exclusive empty directory and copy only declared package
  content assets into a fresh cache. Both actual offline installs must finish
  without modifying sealed source or linking to the donor.
- Each setup/install/build/native stage takes the same shared heavy lease.
  The coordinator waits between stages without owning that lease. Stage waits
  count against the fixed 14400-second total; no stage or original predicate
  deadline is renewed.
- Artifact interchange uses real native CLOSED programmes through both
  independently installed reader/schema/digest/graph exports. It does not
  manufacture a current compiler input or claim historical compatibility is a
  fresh authority check.
- Missing actual browser metadata fields stay UNKNOWN. In particular, a CLI
  `--headed` flag, an endpoint, and a hand-authored boolean are not proof of a
  headed or externally launched browser.
- A normal npm shell-to-Node `exec` keeps process identity; it must not be
  confused with PID reuse. Ownership follows sampled PID, group and actual
  process start time, never stale descendant PID membership alone. A reused or
  unfamiliar process must survive rather than be killed as an old campaign.
- The original 64 MiB evidence-output bound excludes the explicitly private
  owned PostgreSQL/runtime population. The global disk floor and net-new disk
  budget still cover all bytes, including that private population.
- Public owner packaging requires a real clean committed candidate, except
  `AGENTS.md`. Never manufacture a commit or relax that admission. Full/cold runs
  use a new own worktree at Integration's authorized immutable checkpoint.
  In all mode, build the backend and obtain its actual native baseline, seal the
  clean candidate, then build the frontend. This keeps exact finalizer-observed
  Next deltas out of the source that the next backend build must admit.
- Source, tool and policy pins are made before launch by `freeze-harness.py`,
  outside product source, and their manifest SHA is passed explicitly to the
  coordinator and every runner. Checks of the original active controller
  continue while cold children use the reconstructed source. A pin change is
  a failure, never a reason to refresh the expected hash during a run.
