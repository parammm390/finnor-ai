# Y2 local delivery and reconstruction

This is a finite **disposable development** response-model family. It is not a
field-qualified financing recommendation, execution permission, protected
admission, production installation, or financial-benefit claim.

## Runtime

Use Node 22 and `/usr/bin/python3`. The runtime pins the interpreter bytes and
embeds 19 semantic source pins in the actual API and worker builds. Changed
assets cannot attest to unchanged compiled code. Keep the canonical source tree
with its two unchanged lockfiles and install its workspace dependencies.

Required owner configuration is explicit: authenticated private-equity tenant
and principal, canonical source/Work/root, migration
`0196_postx_y2_strategic_response.sql`, physical queue/native leases, and the
existing private S4 proposal-store directory. The development port requires
`FINNOR_ENVIRONMENT=ordinary_disposable`, `FINNOR_Y2_PROFILE=ordinary_disposable`
and a non-production runtime. It refuses production. Do not use production
credentials or hosted databases for the following verification commands.

The fixture commands create their own restrictive local database roles, signed
disposable auth, loopback listeners, temporary proposal stores, actual owner
routes, worker and checker. They never contact a business provider.

```sh
cd /absolute/checkout/finnor-os
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild --offline fs-ext embedded-postgres @embedded-postgres/linux-x64
npm run db:bundle
npm run build --workspace @finnor/api
node --import=tsx scripts/y2/build-runtime.mts
FINNOR_Y2_BUILT_API=1 FINNOR_Y2_EVIDENCE_DIR=/absolute/new/application-evidence \
  node --import=tsx scripts/y2/run-installed.mts
```

Root frontend dependencies also require their own `npm ci`. The mounted
orchestrator builds and exercises the real frontend, owns fixture readiness,
runs the browser driver and orders cleanup:

```sh
FINNOR_Y2_EVIDENCE_DIR=/absolute/new/mounted-evidence \
  node scripts/y2/run-mounted-campaign.mjs
```

For manual diagnosis, start `scripts/y2/run-mounted.mts` with a new absolute
`FINNOR_Y2_EVIDENCE_DIR`. Once it reports `Y2_MOUNTED_FIXTURE_READY`, run
`scripts/y2/browser-checks.mts` with that same directory. Both paths derive a
task-owned named browser session, preserve an assigned session name and close
only that session.

## Packet-only reconstruction

Commit and review all intended source first. The existing Y1 source-preimage
codec is reused unchanged as a generic exact-commit/complete-tree transport:

```sh
node finnor-os/scripts/y1/package-source.mjs /absolute/new/source-packet
node finnor-os/scripts/y1/reconstruct-source.mjs \
  /absolute/new/source-packet /absolute/new/checkout /absolute/new/source-receipt.json
cd /absolute/new/checkout/finnor-os
FINNOR_Y2_SOURCE_PACKET=/absolute/new/source-packet \
FINNOR_Y2_RECONSTRUCTION_EVIDENCE=/absolute/new/reconstruction-evidence \
FINNOR_Y2_TMPDIR=/absolute/new/task-temp \
  node scripts/y2/run-reconstruction.mjs
```

The runner performs **two fresh lockfile installations**, rebuilds native
dependencies and both applications, checks generated/owner boundaries, reruns
the full emitted application and browser campaigns, and requires a clean
reconstructed Git tree. No dependency or compiler output is borrowed for builds.
Its frozen budget is 30 minutes, 3.5 GiB owned storage and 128 MiB free storage.
Optional `FINNOR_Y2_RECYCLE_TASK_DEPENDENCIES` may name only this task's owned
disposable dependency directories. It moves storage before the two `npm ci`
replacements, never reuses their contents for a build. Do not point it at user
or peer work.

## Interpretation

The public incumbent fixture retains six supported parameter/behavior models:
three interference signs with two integer-domain-equivalent bias/tie pairs.
The executed synthetic intervention identifies the complementary **family**
while retaining both bias/tie pairs. It does not identify a unique parameter
model. Independent checking preserves these alternatives.

Under the original robust S4 mandate, the one-period public oracle retains STOP
at value 0 while crowd-out remains, then permits coordination at conditional
value 18 after that family is disambiguated. The two-period programme has value
38 and STOP preserves the already selected public schedule. These are finite
model-relative values, not returns, cash flows, field calibration or equipped-X
comparison results.

All required obligations are in `verification-manifest.json`. A failed or
missing required case keeps the finite development completion gate false.
Preserve failures in `failure-ledger.json` and the evidence index. The handoff
receipt must distinguish the tested source cut, source-only transport, emitted
application transport, mounted browser replay and fresh reconstruction.

Original PRD/S-lock/R1 source parity, a qualified equipped-X comparator,
protected/S2 field qualification, protected admission, activation, operational
100× and S7 realized financial efficacy remain separate, unpassed gates.
