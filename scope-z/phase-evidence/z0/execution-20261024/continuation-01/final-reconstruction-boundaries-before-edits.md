# Final reconstruction boundary map, before the next edits

Installation 03 passed its nine recorded engineering steps. It is not native
qualification. The following finite gaps were identified before changing the
reconstruction recipe, emitter, or offline doctor.

| Boundary | Independent expected result | Before-edit observation | Planned check |
| --- | --- | --- | --- |
| Canonical checker command URL | The original checker command resolves to declared emitted JS and rejects incorrect pins with `X1_CHECKER_CODE_PIN_MISMATCH` | `canonical-checker-path-before-01.log`, actual exit 1, instead reports `Z0_SOURCE_EXECUTION_WITHOUT_EMISSION_REFUSED`; direct manifest checker entry already works | Add the actual explicit checker source to the emitted-source map; execute the same original command and incorrect-pin request with the installed loader |
| Parent Git discovery | Build children cannot discover this checkout's ancestor `.git` | The archive has no Git members, but Sentry's installed `buildTime.js` line 54 opportunistically invokes `git rev-parse HEAD`; the prior recipe did not force a discovery ceiling | Set a target-root Git ceiling, use the source-population release identity, and retain an actual `git rev-parse --show-toplevel` exit-128 receipt before installation |
| Type-resolution custody | Every source actually selected by the full backend compiler has its real path inside the newly installed target | Full actual backend compilation passed; its resolved source paths were not independently inventoried | Run the same real compiler with `--listFilesOnly`, reject every outside-target real path, and retain exact input hashes; keep the full actual compilation as a separate check |
| Coordinator integration race | A new source cut reflects current coordinator bytes, never overwrites concurrent work, and either requests exact known missing deltas or records that the requested target already exists | The coordinator has independently adopted the three shared owner changes and three owned leaves while reconstruction ran; old proposal preimages are now stale | Reconcile only the fixed proposal-03 target hashes, refuse unknown bytes, recheck head/diff and all observed bytes, write proposals/evidence only in the owned evidence directory |

No DB, Auth, tenant, stack, listener, native business flow, physical recovery,
migration, grant, seed, or external effect is authorized by this map. No new
unit tests are planned. These are actual archive/build/loader boundary checks.
Retain installation 03 and the canonical-checker failure unchanged. Freeze and
archive the new recipe before a completely fresh reconstruction; do not patch
the already sealed installed tree. Native source and installed proofs stay
NOT_RUN without separately delivered authority and an independent oracle.
