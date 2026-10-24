# Runtime and native replay addendum 03

This supersedes the current source, driver and native-oracle sections of
`runtime-and-native-replay-02.md`. Current frozen source is installation 12.
The attempted installation-13 launch was canceled by the tool before target
creation, with no PID or exit code. It was not retried unchanged. See
`reconstruction-13-launch-cancelled.json`; the reason was not exposed.
Installation 11 passed an earlier source population and remains historical,
not a current-source reconstruction. This document grants no native execution,
DB, Auth, process or effect authority. All 108 native obligations remain NOT_RUN.

## Frozen source for this round

- Own implementation commit `8a2d82bac98944db528667f868f4671f63bca2ba`,
  tree `53fadcceccac84b90970e3cc1df0d1d9a7650f8c`,
  coordinator `9f3edfd3b4c6758832c53139da0773218062191e`, both tracked diffs
  empty at freeze. `owner-use-integration-08/manifest.json` rechecked every
  shared target and owned leaf byte against the live coordinator and found no
  new owner-use shared delta. The separate CSP request below remains pending.
- `installation-12/source-snapshot.json`: 3,040 files, 47,206,840 source bytes,
  population `63bca8ad8ffff6787230683716f4127beda13a60a923584c964512e1c794bb30`.
- `installation-12/converged-source.tar.gz` SHA-256
  `f900d214b0f114918d5f5f7490c9c9a19e7007a89a07354538ccf616ab98cc47`,
  11,070,952 bytes. No dependency tree, Git objects, private fixtures or
  credentials are archive inputs.

Historical installation 10 froze own `1404c893553a838cee2e131c7ee40d9a2474fedf`,
population `60d02fdfea7df750e3502cbb5e5d03bd34d3ff138d27c1978fee539087134b0c`.
Installation 11 rebuilt that exact archive and passed its 11 expected terminal
results (Git exit 128, ten other exits 0). Its full manifest is
`dae273a3117ded61afc32ef536563911039be204c3038423ab3eef9d1caa1588`.
It does not include the later mounted-build seal or copied standalone assets.

## Exact replay entrypoints

The network-free entrypoints are the current owned
`finnor-os/scripts/project-z/z0/run-native-e2e.mjs --doctor` and `--plan`, run
with the recorded Node 22 executable. Their 54 planned cases are not 54 passes.

After disposition of the canceled launch and a reviewed disk/headroom check,
the following is the concrete **engineering-only** replay of frozen source 12.
It is documentation, not an invocation performed by this handoff. The output
must not exist. Keep the recorded Node/npm/Python/native compiler and OS-library
prerequisites; no sibling dependency tree is an input.

```sh
R=/home/factory-user/repos/finnor-z0
C="$R/scope-z/phase-evidence/z0/execution-20261024/continuation-01"
N=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin/node
/usr/bin/df -Pk "$R"
/usr/bin/flock /home/factory-user/repos/finnor-z-shared-heavy.lock \
  /usr/bin/env NODE_OPTIONS=--max-old-space-size=4096 \
  "$N" "$R/finnor-os/scripts/project-z/z0/reconstruct-converged.mjs" \
  --installation="$C/installation-12" \
  --output="$C/installation-replay-03"
```

This recipe intentionally supplies no public Auth input and starts no listener.
It cannot qualify native Auth. Applying the pending shared CSP change requires
a new source freeze and its own corresponding build, not relabeling source 12.
The separately delivered source-bound public build input must name that actual
new population. Do not patch a previously sealed build or retry the canceled
large command unchanged.

Native invocation remains `--run`, absolute `--authority`, `--oracle`,
`--oracle-sha256`, `--output`, and
`--ack=ALLOW_Z0_DISPOSABLE_NATIVE_FLOW_ONLY`. There are deliberately no invented
authority/oracle files or credential values here. Read the earlier full schema
and this addendum's eight-file, mounted-process, rights-isolation and exact-cut
requirements together. Only actually delivered existing records and authority
can fill those inputs. No stack initializer is part of this recipe.

## Independent original-owner oracle (replaces trusted expected rows)

`native-original-oracle.mjs` imports no producer, decoder, lowering, checker
or product observer. Every owner-expecting fixture must carry
`owner.originalInputs`, exactly these 13 pinned fields
(`finnor.project-z.z0.original-owner-inputs.v1`): `schema`,
`compilerRequestId`, `programId`, `sourceGrantId`, `sourceId`,
`sourceRevision`, `rawSourceSha256`, `mandateSha256`, `canonicalSha256`,
`nativeLinksSha256`, `ruleId`, `recordId`, `subjectRef`
(`pe_deal:<uuid>@v<n>`).

At execution the driver re-reads the real retained compiler publication, the
standing mandate row, the pinned source grant and the immutable Core bytes
through the restricted read-only observer, plus the live scoped Deal,
workstream and party links. `nativeLinksSha256` is the oracle's canonical
SHA-256 (localeCompare key order) over `{deal, workstreams, parties}` exactly
as read. The Core grammar is a finite explicit reader: a JSON array of flat
records with explicit `id`, string/boolean/null values only; duplicate or
normalized-colliding keys, `__proto__`/`prototype`/`constructor`, numbers,
nested values, trailing commas or trailing bytes refuse with typed codes.
Unsupported formats, chronology or rule meanings refuse; this restriction is
a verification boundary, not a product policy change.

The oracle independently derives the stable responsibility identity, the
deterministic expected entity UUID, the closed three-operation payload
(standing-rule inputs override raw record values), the registered completion
contract refs, the action digest and the full expected business row. Supplied
`owner.operation/entityId/stableIdentity/originalDeadlineAt/frozenPayload/
expectedFullRow` values are compared against the derivation and are never
inputs to it. The frozen P1 node must independently match the same action,
deadline and contract refs.

Owner-row observation requires the exact derived business-field projection,
creation at or before the original deadline, and timely visibility: the
independent observer's read at or before the deadline, or the actual commit
timestamp at or before it. A retained timely witness is reused across polls
only for the byte-identical native row. Reports carry a sanitized input
witness (pin/byte digests and counts), never raw original bytes.

## Currentness cases: real stages, fenced cut, relevant dependency

The 28 CURRENT_* cases no longer accept caller-labelled stages or
whole-snapshot digest changes. For each case the driver freezes only the
independently supervised worker process group, re-reads the scoped DB and
independently recognizes the declared stage from actual state:

- INTAKE: original compiler WAITING/PARTIAL with no institutional session.
- CLAIM: the exact `run_application_semantics_v1` job running with the
  session's live claim token/fence and a matching persisted delivery attempt
  by the owned worker identity.
- USE: institutional session MODEL_READY with model/check refs, no original
  action or materialization.
- DISPATCH: the original model-derived canonical draft exists (exact program,
  stable identity, model input digest and materialization binding), with its
  live fenced job and no business row.

A missed or unobservable boundary fails the case; no queue hook, forged job,
DB write or simulated exception substitutes. The dependency witness compares
only the relevant projection: authority revision (RIGHTS), original source
grant revisions and pins (SOURCE), governed profile restriction/authority
hashes (TERMS), S5 parent reservation/charge state (PARENT). For
CODE/CHECKER/CONSUMER the only admitted fault is appending a fixed harmless
comment to the one closed file named by the fixture, inside an explicitly
authorized disposable target whose byte preimages and postimage are pinned by
the oracle; the original bytes are verified before and after, restored in
`finally`, and any unexpected concurrent change refuses restoration rather
than overwriting. The refusal baseline is the actual pre-fault cut, so a
DISPATCH cut after lawful consumption must preserve its draft and must not
dispatch or replace it. All four tenant-wide RIGHTS cases require an existing
real `caseOwner` with both a distinct tenant and principal, unique to that case
and separate from primary and alternate owners. The preflight rejects missing
or shared identities before Auth/DB/signals. No owner or tenant is created.

## Physical recovery: exact original job and boundary

Each recovery fixture independently precommits `recoveryJob`, exactly `type`,
`ownerId`, `generation`, `stage`. The driver derives the real canonical enqueue
key (`x1-compiler:…`, `x1:…` or `x2:…`) and recognizes one real protocol-1 job
with that type/owner/generation, original Work/input, current live token/fence,
and an unfinished delivery owned by the supervised worker. It captures the
actual job UUID, entire payload digest and delivery UUID at the cut.

ARTIFACT and AMBIGUITY must select X2 and carry the independent 13-pin owner
inputs. The selected root's real institutional origin must match the computed
original compiler, programme and stable responsibility. ARTIFACT verifies that
session's exact model/check refs and both canonical persisted preimages before
owner consumption. AMBIGUITY additionally precommits `recoveryNodeId` and binds
that request node to its actual wire digest, S5 consumption, S6 obligation,
effect and canonical action, with actual possible egress and UNKNOWN or
reconciliation-required state. A different Work job or exposure cannot count.

Sanitized write-ahead boundary, physical-exit and replacement receipts survive
a later failure. Raw claim tokens and private wire bodies are not recorded.
The same job UUID/type/protocol/payload/generation must then receive a new
higher-fence, different-token delivery by the actual replacement worker.
The exact original artifact/effect identity and independent terminal outcome
must also survive. A fence alone never passes. A missed cut fails; no queue
hook, fake persistence or simulated kill substitutes. None of these cuts ran.

## Mounted controls: real form, real bearer, real switches

Browser identity is established only through the mounted login. The driver
observes the actual `/api/centropy/me` response and its request authorization
header, verifies that bearer against the real Auth `user` endpoint, and then
uses the same verified bearer for independent reads. Cookies alone, an
unobserved password grant, an injected context and test-key headers are not
accepted. The useful LEARNING positive is driven through the existing
semantic form (`Existing discovery-profile UUIDs…`, `Authorized discovery
targets…`, `Original resource demand…`, `Original deadline…`, the
`Learn for an unfinished original X1 responsibility` details and a keyboard
submission of `Request learning under original reservation`). The real
request body (minus the UI-generated idempotency key) and the reservation
response are compared to the independent expectation; no route interception,
mocking or fulfillment is used. The MOUNT case additionally drives
`Refresh current scope`, reload, the maintained Investigations drawer to a
distinct pre-existing root/Work and back, and a real Sign out followed by
login as a separately delivered existing alternate owner, proving `/me`,
denial of the old Work and absence of the old private panel markers, then
restores the original login. No tenant, principal, grant or fixture is
created by the driver. Case switching enters `try/finally` before logout.
Source and login restoration are attempted independently; any failure stops
the run. A PASSED case is written only after its restoration succeeds, and
qualification requires all 108 cases plus no retained restoration failure.

## Mounted build custody and pending shared CSP repair

The new builder is implemented to copy this same target's `public` and built
`static` assets into Next's actual standalone directory, then seal the complete
standalone files and contained links. The receipt binds the source snapshot
and population, deterministic build ID, serialized standalone configuration,
compiled routes/CSP and public Auth build-input receipt. This new step is not
executed yet because installation 13 never launched.

Native preflight additionally requires `apiProcess` and `frontendProcess`
identities in the owned process set. It binds actual Node/cwd/entry bytes to the
canonical SOURCE worker/backend Next or INSTALLED manifest entries, and the
dedicated frontend to that sealed standalone server. An exact versioned Next
process title is admitted only with the expected executable/cwd/listener and
a bounded live static-asset read matching the sealed bytes. Undeclared
preloads are refused. These guards do not start a listener or grant authority.

The actual historical compiled CSP omits loopback HTTP Auth because it was
built with production headers. `shared-mounted-csp-request-01/request.json`
requests the one-condition repair to coordinator-owned `next.config.mjs`:
preimage `68e4c3caebd0d3b31667e7d11af79796c8427347b723d7e4d434b9275f816726`,
postimage `bd9af375c76421070883eac073bac8e2c9eec982783ae2320ed513a6dc4056fd`,
patch `337a022e811f1879d8557b3fbc30834db111b4995ad7e6c5583f57fde64dca11`.
Read-only applicability exited 0. The request is pending and was not silently
overlaid in installation 12. Normal production remains unchanged by the
proposed disposable-build exception. The new validator refuses explicit public
Auth inputs that the actual compiled CSP would block. After coordinator
application, freeze and rebuild the corresponding new source population.

## Binding, guards and qualification

All eight verification files (`run-native-e2e.mjs`, `native-e2e-plan.mjs`,
`native-original-oracle.mjs`, `native-currentness.mjs`,
`native-mounted-work.mjs`, `native-observation-child.mjs`,
`native-recovery.mjs`, `native-mounted-build.mjs`) must match the frozen source
snapshot before any Auth or DB session opens. The updated offline doctor is
implemented to validate mounted custody and all four driver contracts inside
the next emitted runtime; that current-source run remains NOT_RUN.
`native-driver-doctor-11.log` (exit 0, 54 planned cases, zero native cases) and
`native-driver-authority-refusal-09.log` (exit 2, zero cases) bind current driver
`0b6e24b973865477620fc3f245106f66215801c679e464baec92934b10d107c1`.
No post-code unit tests were added. The previous guard receipts remain intact.

The reconstruction recipe in version 02 still uses the exact lock installs,
fresh native addon/browser assets, full backend types, actual Next build,
complete emission and offline doctor. Current code adds the standalone seal
step and removes only its newly created, explicitly temporary npm cache after
dependency/native installation, recording the bounded cleanup. A future
authorized reconstruction must use a new target and the shared heavy lock,
4096 MiB cap and actual disk guard. The canceled launch is not automatically
retried by this delivery. No old runtime, cache or failure evidence is deleted.

SOURCE/INSTALLED native runs, useful original-owner business effects, mounted
flow, currentness, accounting and physical recovery remain NOT_RUN. Current
engineering reconstruction is also unfinished for the separate canceled-launch
reason. Missing DB/Auth does not excuse that engineering gap. Protected custody,
production, whole-code correspondence and financial/operational 100× are not
granted or established.
