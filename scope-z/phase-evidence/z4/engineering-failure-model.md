# Isolated engineering reconstruction, failure model before implementation

The existing native mechanism reconstruction does not establish an installed
product. The remaining reconstruction must cover the complete source graph,
all 23 requested shared files, original Work, worker, owner adapters, mounted
panel, generated contracts and both production builds. No listener or DB/Auth
mutation is authorized by these checks.

Failures and required observations:

* A patch silently applies to the live parent repository: use an explicit
  isolated target, ordinary `patch --fuzz=0`, and exact pre/postimage hashes.
  Recheck every live shared preimage. Never run repository-discovering apply
  from a nested checkout.
* Borrowed modules, a copied native binary or inherited toolchain supplies a
  false reconstruction: independently install pinned Node/npm and official
  Rust components from hash-verified archives. Build native binaries again,
  with locked offline Cargo. Install both npm locks independently. Retain
  resolved URL/integrity, selected platform, toolchain versions and exits.
* Dependency lifecycle code initializes DB/Auth or downloads hidden assets:
  npm installs ignore lifecycle scripts. Explicitly rebuild only the reviewed
  `fs-ext` binding with the independently installed Node headers and compiler.
  Builds receive no inherited credentials, provider, telemetry or DB settings.
* Missing tarballs, local patched dependencies, optional platform selection,
  native headers or licenses: retain the exact failure, do not substitute an
  installed package. Verify cache bytes by each lock's integrity; declare
  local tarball SHA and every license gap. Pinned public dependency fetching
  is distinct from runtime network or native qualification.
* Partial graph/generator success hides a missing seam: run existing OpenAPI,
  capability/client/form/coverage generation and checks, full backend/root
  types, explicit owned scripts/panel types, root lint and owned-source lint.
  Each command gets its own retained exit and log.
* Managed Next types or source stamps drift during the build: run the actual
  selected-profile typegen and source stamps before freezing the complete
  source population. Compare all members after both builds. Preserve any
  original failed receipt; do not ignore generated types or hand-edit them.
* Runtime falls back to the original checkout or omits native/source assets:
  independently installed paths must be target-local. Retain actual frontend
  and API BUILD_IDs, native identities and the emitted API trace inventory.
  Reject cache/toolchain/build-intermediate trace members.
* Disk, heap, jobs or lock contention invalidates checks: serialize installs,
  native builds and full checks under the shared heavy lock, heap at most
  4096 MiB, two CPUs/jobs. Preserve original failures and finite timeout exits.
  Remove only positively identified agent-created temporary installer trees
  and compiler intermediates, never source, installed native binaries or
  original failure logs.
* A copied report is treated as current evidence: bind each run to its actual
  source inventory and exact shared patch; retain previous versions. Changed
  source requires an affected rerun, not editing old outcomes.

Independent verification remains the pre-registered process-level original
integer/proof checks and the real pinned verifier. A separately installed
mechanism run, build, missing-authority refusal or zero command exit does not
establish authenticated source/installed native E2E, protected custody,
financial qualification or coordinator acceptance.

## Actual delivery-path failure, before its repair

`delivery-01` failed with `Z4_DELIVERY_UNSAFE_PATH`. Its bounded diagnostic
records eight actual API NFT references to the `@finnor/source-custody`
workspace symlink. All resolve inside the declared target, but the symlink
branch retained the trace's literal `../` components in the archive name.
An attempted complete diagnostic walk timed out at 90 seconds and supplied
no result; that timeout is not a successful inventory.

Canonicalize existing parent components before admitting a member, retain
the final symlink itself, and keep both lexical and resolved paths inside
the declared target. Deduplicate canonical directory traversal so repeated
trace aliases cannot bypass exact cache/native-intermediate exclusions.
Keep the independent archive unsafe-member and symlink-target guards.
Repeat actual full packaging/readback and relocation, not a post-code unit
test or a relaxed manifest check.
