# FRONTIER5.X4 development handoff

This is a bounded, consent-only system-identification implementation, not a
protected admission or production activation. The frozen profile, owner seams
and limits are in `architecture.md`; the preregistered failure model is in
`acceptance/specification.md`. Actual per-requirement results belong in
`verification-ledger.json`, not in this overview.

## Reconstruct from the sealed source bundle

Use a fresh directory and a supported Node 22 installation. Do not copy an old
`node_modules`, `.next`, private binding file, scientific database or receipt.
The bundle includes the supplied base history and does not need the donor
repository. That supplied history is genuinely shallow at
`ed32d200a9459269509f1e40d4e13a3e2a1a4d6a`; its earlier parent is unavailable.
An ordinary bundle clone fails on that boundary. Reuse X5's explicit
boundary-aware source bootstrap, not another object database or invented history:

```sh
DELIVERY=/absolute/path/to/x4-delivery
FRESH=/absolute/path/to/fresh-x4
NODE=/absolute/path/to/node22
REV=$("$NODE" -p \
  "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).sourceCommit" \
  "$DELIVERY/delivery-manifest.json")
test ! -e "$FRESH" || exit 1
git init "$FRESH"
git -C "$FRESH" bundle unbundle "$DELIVERY/x4-source.bundle"
install -m 644 "$DELIVERY/x4-shallow-boundaries.txt" "$FRESH/.git/shallow"
git -C "$FRESH" checkout -b codex/frontier5-x4-autonomous-system-identification "$REV"
cd "$FRESH"
"$NODE" scope-x4/reconstruct.mjs \
  --evidence-dir /absolute/path/to/new-reconstruction-evidence
```

The reconstruction driver rejects a dirty starting checkout or preexisting
module/build directories and checks that
installed workspace aliases resolve inside the fresh checkout. It performs both
ordinary `npm ci` installs, source/child regeneration checks, backend/campaign/
frontend type checks, affected UI lint, generated/security release preflight,
the actual Next API and frontend builds, complete trace/native-ABI audit, and a
fresh authenticated physical campaign with security/DB/S8 and repeat replication.
It retains each command, exit, elapsed time, log, source identity and result.
An existing evidence directory is not overwritten.

Ordinary package download/build prerequisites are required. This is a fresh
checkout of the supplied shallow source and ordinary dependency installation
on the same host, not a complete ancestral clone or clean-OS image proof.
X4's scientific child executes fixed emitted JavaScript on Node 22; it
does not require a new numerical supplier or run generated source.

## Run the scientific boundaries

From `finnor-os`, with Node 22 first on `PATH` and a freshly built API:

```sh
FINNOR_X4_BUILT_API=1 \
FINNOR_X4_EVIDENCE_DIR=/absolute/path/to/new-matrix \
node --import=tsx scripts/x4/run-matrix.mts
```

The matrix registers cases and freezes scientific source and verification-file
digests before execution. Each case gets a new disposable PostgreSQL database,
signed identities, actual built authenticated API, native durable JobQueue
worker and independent private-state physical providers. It does not insert a
terminal scientific model or a successful effect. Providers retain the original
30-second whole-process lifetime. Crash recovery waits real native lease/backoff
and compute expiry, never edited timestamps.

Native queue execution uses the production scientific handler and JobQueue from
the installed source tree. It is not evidence that the full worker image or its
arm64 native suppliers were executed. The Docker packaging change is separately
source-audited; image execution requires a working local image toolchain.

## Drive the maintained Work

First start the real scientific fixture:

```sh
FINNOR_X4_BUILT_API=1 FINNOR_X4_PHASE=browser \
FINNOR_X4_EVIDENCE_DIR=/absolute/path/to/new-mounted-evidence \
node --import=tsx scripts/x4/run-installed.mts
```

Wait for `X4_MOUNTED_FIXTURE_READY`, then in another terminal, from `finnor-os`:

```sh
FINNOR_X4_EVIDENCE_DIR=/absolute/path/to/new-mounted-evidence \
node --import=tsx scripts/x4/browser-checks.mts
```

Use the task-assigned browser session when supplied. Otherwise the browser
driver derives a worktree-scoped X4 session. It signs in normally, uses the
emitted Work, checks a real axe result, and tests keyboard/pointer intake, slow
reads, signed token refresh, exact uncertain invocation replay, delayed old-Work
success/error, logout/foreign principal, real offline/reconnect, reload and
visible rights revocation. It closes only its own browser and fixture.

Extra browser mutation acknowledgments stay QUEUED. They are transport/privacy
proof, not additional scientific completions. The original four-use limit and
actual pre-mount scientific effect count remain unchanged.

## Evidence and limits

The delivery evidence keeps original failed and interrupted attempts, not just
successful reruns. A pass is scoped to its recorded source cut and exact probe.
Generated contracts must reproduce exactly; source trace membership is checked
against the emitted route, not inferred from files present on the builder.

Logical scientific and canonical Evidence bytes are charged to the original
parent. This is not physical disk or monetary metering. Provider money, human
work and aggregate process-tree peak memory remain UNKNOWN without a complete
independent measurement.

Observation-only is a diagnostic ablation, not the strongest incumbent.
Existing native S2 requires supplied calibrated finite-IID laws/priors; native
S3 fits supplied temporal equations and correctly projects UNKNOWN S2 laws.
An unequipped native input or absent qualified `B_ref` cannot be scored as a
baseline failure or converted into a gain, amortization, financial result or
100× claim.

Builder-controlled identities, signers, providers and host remain development
custody. Native Mission execution, matching full governing sources, independent
original thirty-six-system qualification, protected admission, production/live
authority, qualified matched comparison and mature financial results remain
separate gates. No remote write, cloud provisioning or production change is
part of these commands.
