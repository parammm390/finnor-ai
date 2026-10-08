# Exact serial integration packet

Base C: commit `a72b4f402cfa1bbf51e518891db2d893b9a71aca`, tree
`ca56b7b91d5a449bbe3a3dd7317c73da712fd5a3`. This is restricted ordinary
development, **not BASE10**. C's receipt/reconstruction are retained in
`evidence/base/`. No moving peer branch is an input.

## Ordered application

1. Reconstruct the final owned P6 commit/tree from the delivery manifest and
   owned exact-C patch/bundle. Owned files are the P6 ordinary producer,
   consumer adapters, new UI component, runners and phase records only.
2. Examine the actual applied migration histories and allocate a new forward
   migration for `schema.proposed.sql`. The current published registry head is
   `0164_completion_c_m2_control_continuation.sql`; its 166 published files and
   bytes must remain unchanged. Do **not** publish this proposal under an
   invented number or add it to a second registry.
3. Apply `shared-native.exact-c.patch` against its exact preimages. It proposes
   P1 use/currentness/execution hooks, P7 historical-to-fresh intake, existing
   authenticated route and durable worker/job policy, ordinary package export,
   existing analytical-panel mounting, OpenAPI and capability generators.
4. Apply `shared-generated.exact-c.patch` for the matching OpenAPI, canonical
   CENTROPY types and capability manifest. Regenerate and compare those outputs
   on the actual successor; preserve all old allocation/P5 behavior.
5. Review the separate `s8-procedure-port-v1.md` with the actual S1/S4/S5/S6/S7/S8
   owners. Supply independent custody, evaluator/signature, registered image,
   full resource enforcement, admission/use lease, fallback and billing.
   **None is activated or synthesized by these patches.**
6. Publish the immutable serial successor and exact migration/runtime/module
   identities to P6. P6 must reconstruct it independently and rerun the native,
   affected owner and mounted stories on that cut. Overlay proof is not owner
   adoption or successor proof.

All shared edits are confined to a labelled, owned disposable validation
overlay. No completion/evolution/M5 peer checkout was modified. No push, PR,
merge, deployment, provisioning, protected activation or live commitment is
included.

## Required reruns

Run `npm ci --no-audit --no-fund` at root and backend with pinned Node 22.22.3
Darwin arm64/ABI127 for this local profile. Never load live `.env` files.
The provided runners scrub credentials/provider variables and use fresh
loopback disposable databases. Every output directory must be fresh and
absolute. Commands below assume `R` is the reconstructed **integrated** checkout
and `E` a fresh absolute evidence parent outside it.

- `cd "$R/finnor-os" && node scripts/p6/run-local.mjs native "$E/native"`
- `cd "$R/finnor-os" && node scripts/p6/run-local.mjs transfer "$E/transfer"`
- `cd "$R/finnor-os" && node --import=tsx scripts/p1/run-regressions.mts "$E/regressions"`
- `cd "$R/finnor-os" && FINNOR_TEST_PYTHON="$PYTHON312" python3 scripts/p1/run-native.py p1 "$E/p1" "native-unseen-liability-composition,false-IC-liability-omission,bounded-invalid-graph,semantic-TypeScript-and-real-S6-execution,registered-canonical-program-query,actual-canonical-ObjectiveLoop,idempotency-and-native-Work-projection,tenant-principal-refusal"`
- `cd "$R/finnor-os" && FINNOR_TEST_PYTHON="$PYTHON312" python3 scripts/p1/run-native.py p1 "$E/capital" "visible-capital-owner-bound-three-input-recompile"`
- `cd "$R/finnor-os" && node scripts/p5/run-local.mjs programme "$E/p5"`
- `cd "$R/finnor-os" && FINNOR_P7_EVIDENCE_DIR="$E/p7" node --import=tsx scripts/p7/run-native-e2e.mts`
- `cd "$R/finnor-os" && node --import=tsx scripts/p6/run-mounted-local.mjs "$E/mounted"`

During repair only, `node scripts/p6/run-local.mjs native "$E/focused"
induction-crash` selects the baseline and three physical induction stories.
Its required denominator is four PASS plus twelve NOT_RUN, never a full-suite
claim. The default invocation requires all sixteen stories PASS. Physical
publication/ack tests record real warm-worker readiness and preparation before
ordinary intake; they do not renew any original grant or establish cold transfer.
Read `validation-method-audit.md` and retain every final-cut failure.

The mounted runner requires the task's assigned blank/owned browser pane and
session. It refuses unrelated tabs and checks the local frame before input.
Its temporary credentials live outside source/evidence and are removed.
CDP automation is not trusted OS/native input or protected-host qualification.

`PYTHON312` must point to a verified isolated Python 3.12 interpreter installed
with the exact `intervention-requirements.txt` pins. The S5 solver additionally
checks NumPy2.3.3, SciPy1.16.2 and the bundled HiGHS1.8.0. Python3.11 is refused;
do not remove that guard. Preflight all numerical imports before the original
bounded run. The actual local interpreter/library pins are in the capital
driver receipt and source-bound ModelCompute invocation, not an image attestation.

The unnumbered SQL is consumed only by the disposable P6 runner until serial
allocation. A published successor must adapt its migration setup explicitly,
without running the same CREATE statements a second time.

## Acceptance and blockers

Attach exact version/domain, PASS/FAIL/UNRUN/UNQUALIFIED and evidence-strength
classifications. Preserve every failed run. GateP6 remains UNQUALIFIED until the
independently controlled original comparison and full-cost horizon pass.
`independent-gate-p6.request.json` is runnable preparation, not a signed protocol.
No numeric gain threshold or fictional independent sample count was introduced.

Read `owner-regression-exceptions.md` before claiming a complete owner suite.
The retained unchanged C P1 `future-port-refusal` assertion is inconsistent with
C's already joined pure P5 dependency port. Selected green controls do not
erase that failure. All old allocation/S8 behavior and published tests remain
unchanged by the P6 proposal.
