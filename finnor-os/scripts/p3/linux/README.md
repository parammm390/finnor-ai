# P3 Linux verification bundle

This bundle is executable, but **has not run on this Darwin host**. A build or a
signed development profile is not confinement, S8 admission, or deployment.
No script provisions AWS, installs system packages, grants privilege, or changes
the production release contract.

## Before running

Use an explicitly authorized Linux host with the selected architecture, cgroup
v2 (`cpu`, `memory`, `pids`), a delegated empty cgroup subtree, and a private work
directory. The launcher needs the host permissions required by raw runsc. Do not
run this inside standard Fargate or grant generated code a task/instance role.
The cell receives no database, broker, cloud, browser, or evaluator credentials.

Install the repository's exact backend lock in its own checkout. Independently
obtain and verify gVisor `release-20260928.0`, including its source commit,
release provenance, binary SHA256, Apache-2.0 license and current security status.
The scripts require an explicit binary hash; they never download or execute an
unverified binary. The operator supplies an Ed25519 development origin key in a
private file. It is never copied into the image or emitted in evidence.

```sh
cd /absolute/isolated/FINNOR/finnor-os
node scripts/p3/linux/build.mjs --output /absolute/new/p3-bundle
node --import=tsx scripts/p3/linux/profile.mts \
  /absolute/new/p3-bundle /absolute/verified/runsc \
  EXPECTED_RUNSC_SHA256 /absolute/delegated/cgroup \
  /absolute/private/work /absolute/private/ed25519.pem \
  /absolute/new/signed-profile.json /absolute/new/public-origin.pem
FINNOR_P3_LINUX_PROFILE=/absolute/new/signed-profile.json \
FINNOR_P3_LINUX_ORIGIN_KEY="$(< /absolute/new/public-origin.pem)" \
node --import=tsx scripts/p3/linux/certify.mts
```

`build.mjs` builds fixed candidate, checker, hostile-probe and checkpoint
entrypoints. On Linux it also materializes a link-free rootfs from the executing
Node binary and its actual ELF dependency closure. Node must support
`node:sqlite`. On Darwin it emits source/bundle/SBOM/license manifests only and
reports `ROOTFS_BUILD_UNPASSED`, rather than pretending to supply Linux binaries.
Outputs must be new directories. No peer installation or host source mount is
used by a cell. The build manifest records all bundled source/package identities.

## Frozen observable challenges

The existing A–T failure inventory applies. This concrete bundle additionally
freezes these observer predicates before its first execution:

1. Signed profile, exact runsc/rootfs/source identities, kernel/architecture,
   cgroup delegation and empty work-root checks precede every launch.
2. A host tripwire positively records each financing stage, then sees zero
   guest autosave/background/navigation/submit, DNS/direct-IP/IPv6/redirect or
   WebSocket effects. A random host sentinel remains unreadable to the guest.
3. Registered pure and three real SQLite/file fixture branches run under
   network-none. Complete candidate outputs are checked outside the cell.
   Clones retain independent identities and the public baseline stays unchanged.
4. Finite host-file/socket/metadata/symlink, storage/inode, output, descendant,
   memory and wall probes fail or terminate within the fixed envelope. Actual
   cgroup CPU/peak-memory/events and post-teardown process membership are saved.
5. A raw runsc checkpoint stops a quiescent process. A new container restores its
   private tmpfs/file state, with a fresh security identity, and an independent
   exec observer verifies it. The full checkpoint file manifest is checked.
   Mutated bytes and incompatible lineage refuse. Logical SQL checkpoints are
   tested separately; neither protocol is described as CoW.
6. Failed/denied cells, unknown meters and cleanup liabilities remain in evidence.
   No cell enters the accepted-isolation denominator until every required
   observer passes. Money stays unknown, not zero.

Each run writes a pre-run source/profile manifest, per-case inputs, independently
captured tripwire and cgroup observations, outcomes, usage and a SHA256 evidence
manifest. A non-Linux invocation writes a blocked record and exits nonzero.
Runtime failures do not fall back to trusted-native execution.

## Threat and support limits

gVisor limits kernel-system-API exposure; it does not eliminate host/firmware
compromise or hardware side channels. Network-none and host cgroups are separate
enforcement predicates. Raw checkpoint compatibility and restored networking
must be observed on the exact binary/kernel/CPU cut. Protected authority,
financial funding, independently sealed comparison and production live reads
remain separate gates.

Primary references: <https://gvisor.dev/docs/architecture_guide/security/> and
<https://gvisor.dev/docs/user_guide/checkpoint_restore/>.
