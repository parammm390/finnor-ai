# Z5 native integrated progress

Updated every commit. Base a5209ab (integrated candidate with request 07, e481133).

## Done
- Read governing docs, driver, worker, owner package, runner/launcher.
- Failure model committed first: `native-integrated-failure-model.md` (F1-F21, D1-D6).
- D4 fixed: `registerFixedProfile` no longer requires an impossible sourceRef hash fixed point.
- Launcher `z5` profile block (private roots, owner-transport/consumer config paths, S3 python flag) and runner pass-through.

## Running
- `native/z5-session.mjs` staged Z5N-01..14 (ledger/transport, second tenant, X1 parents, S3/S4/S5 chain, S6 obligation, S8 lifecycle, profile register); Z5N-12/13 (S7 assignment, delayed callback) NOT_RUN pending. About to run `w5-native-01`.

## Next
- `native/z5-session.mjs`; driver fixes (D1-D3); first run name `w5-native-01`.
