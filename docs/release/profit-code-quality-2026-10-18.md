# Profit decision code: domain and accounting repair

Baseline: `a7117d4d6b5283ae0ce734036d4eb5d1413ce276`. Work occurs in an isolated checkout; the existing operating-profit checkout is untouched. The baseline PR passed every required CI gate. Green CI is not evidence that invalid internal states or incomplete financial reconciliation are absent.

## Failure model registered before implementation

1. Shared types admit net-profit objectives without financing/tax accounting, profit targets on other objective modes, programme problems without a programme definition, mixed legacy/programme fields, and exact problems without exact source. Runtime rejects several of these, but the compiler permits production callers to construct them.
2. A final synchronous model transition crosses the original monotonic deadline. No later search iteration checks the clock, so the current controller can report POLICY_AVAILABLE after exhausting its grant. Test the public dynamics boundary with a controlled monotonic clock; do not introduce a production clock hook or renew the grant.
3. S4/S5 certificate validation checks several arithmetic identities but does not reconstruct common plus selected-action terminal liabilities. Removing the same common debt from both courses preserves incremental utility and can understate S5 funding.
4. Working-capital funding can be reduced while retaining a positive net working-capital movement, unchanged P&L/FCF, and a valid content digest. S5 then consumes a smaller gross cash requirement. Gross positive stock movements must cover positive net stock movement.
5. Subtracting two large aggregate working-capital balances loses a small movement. Retain the three actual stock movements once and use their net/positive sums. Do not add an epsilon to the revenue-profit hurdle.
6. Consistently removing a mandate-declared constant debt payment or financing expense can preserve the current certificate's self-contained arithmetic. Check constant ledger components against the original charter; state-driven values remain conditional S3 inputs.
7. Aggregate revenue, nonoperating cash and comparator closing cash can drift from their retained period ledger. Reconcile the available identities without claiming missing comparator driver detail is verified.

## Test ownership and repair shape

Compile-only public-contract checks protect the domain variants. New runtime regressions are authored and run red before any runtime repair. Their primary owner is the existing S4 certificate/S5 cash-adapter interface or S4 search entry point. Isolation is needed to present a consistently rehashed but invalid certificate and deterministic clock expiry without bypassing the actual immutable store or depending on CI scheduling. No test-only production export, clock injection or storage bypass is added.

After reproduction, separate financial-certificate reconciliation from generic control-contract parsing; preserve the existing wire schemas, checked STOP incumbent, hard cash/resource/risk limits, source identity, exact-model boundary and no-authority qualifications. Update S4/S5 source manifests and retained native proof for the actual verifier dependency. Re-run existing profit, exact-control and owner integration paths.

No customer profit, universal profit guarantee, or whole-codebase line-by-line review is claimed. The backend inventory also exposes much larger orchestration/repository owners; this coherent repair addresses the decision and money boundary first.

## Implemented and verified

- Objective types now require financing/tax accounting for net profit and exclude it and revenue targets from other modes. Control problems distinguish legacy, exact-source and full-horizon programme inputs. Schema parsing returns the corresponding type without an unchecked generic result cast; the programme compiler requires its actual variant.
- Search checks the original monotonic grant after each actual and paired model calculation, and before publishing an available policy after serialization. Already checked exhausted incumbents remain advisory; a late available result is withheld and its discarded output reference removed. No deadline or expansion grant is increased.
- Working capital uses the three stock movements once, retaining small changes beside large unrelated balances. Gross funding uses their positive parts; the independent Python implementation uses the same accounting convention without importing production code.
- Financial reconciliation now has a dedicated pure owner, separate from generic request/policy parsing. It reconstructs mandate, outstanding and SETTLED debt plus selected-action liabilities; checks constant cash/P&L drivers against the charter; rejects missing gross stock funding; and reconciles retained revenue and nonoperating totals. Existing path, P&L, utility, cash-floor, target and programme-domain checks remain.
- The new verifier is pinned in S4, S5, R1 and native-proof source identities. The actual native owner case additionally retains a rehashed, internally balanced omission of a mandatory 300-unit payment and the S5 adapter's specific refusal. This does not claim that forged policies can enter the immutable owner store.

Before runtime edits, all 11 new numerical/financial regressions failed against `a7117d4d`; the compiler rejected all seven intended rejection assertions on the permissive baseline. After repair, all **99** focused tests pass (the existing 88 plus 11 regressions), as do backend, root and S4-runner typechecks. Five valid type constructions and all seven rejection assertions compile. The CI inventory includes the new runtime test exactly once across three shards (227 files total); inventory discovery is not reported as a test execution.

Rerun from `finnor-os` with Node 22.22.3:

```sh
node node_modules/vitest/vitest.mjs run tests/unit/control-accounting-boundaries.test.ts tests/unit/operating-profit-policy.test.ts tests/unit/revenue-profit-target.test.ts tests/unit/operating-profit-allocation.test.ts tests/unit/operating-programme-search.test.ts
node --max-old-space-size=6144 node_modules/typescript/bin/tsc -p tsconfig.json
node --max-old-space-size=6144 node_modules/typescript/bin/tsc -p scripts/s4/tsconfig.json
```

From the repository root, run `node --max-old-space-size=6144 node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` and `node scripts/release/verify-test-shards.mjs`. The compiler's development heap flag is needed in this container; it does not alter any production decision grant. The initial compiler invocation exhausted its default 2 GB heap and is not counted as a passing check.

Retained native baseline: run [39076906758](https://github.com/parammm390/finnor-ai/actions/runs/39076906758), artifact [12117885982](https://github.com/parammm390/finnor-ai/actions/runs/39076906758/artifacts/12117885982), ZIP SHA256 `8ba9fc5e6a8eece0c59a28d0f1561db3110c06e43d995c93af7d162c5629df40`. Its 39 native cases passed on the baseline. With the changed production code, replay of that artifact's retained S3 model/kernel reproduces the original certificate, nodes and demand exactly. All eight programme candidates also agree with the independent Python reference within its registered `1e-6` comparison: worst value `219.4999436442165` versus `219.49994364421673`. Current S4 source identity passes with 13 source leaves. The new charter-payment omission countercase also passes on that retained owner policy.

Local log SHA256s (baseline failures are reproducible by running the new regression files on the baseline checkout): runtime red `3123bbf5cb0c9f00dc3c87e49d75c51af9b07a42bd80b4329789274ecde00b27`; type red `81632eaa7d31d721c7c909e3dedb0337857a501b46dfb68ba5b8d4c72c43167e`; final 99-test run `e2ef9dc84be0d92fd1dbf02839fa031c069e4e7954c6c0011c0ef59ee59425c6`; retained-kernel replay `45392a7755122f24e1ef4add7fac6b43e0be606ea877deb5cee6280d6ce09cd0`.

Fresh full owner/DB CI must run on this change; the baseline's 39 passes are not relabeled as new-head evidence. No production deployment or merge is performed. The previously attempted CodeRabbit authentication was unsupported; no automated CodeRabbit approval is claimed. Pstack/OpenClaw provenance and test discipline are retained in [the preceding test audit](profit-search-test-audit-2026-10-17.md).

## Remaining product boundary

The v1 certificate does not retain comparator nonoperating amounts per period. Exact comparator closing-cash reconstruction is possible when both original nonoperating drivers are constant, or the horizon has one period. For state-driven multi-period comparator cash, aggregate FLOAT64 totals cannot be reassociated as an exact period ledger; this repair does not claim that unavailable detail is checked. Likewise, the funding inequality is a necessary accounting check, not a reconstruction of unretained individual stock observations.

The revenue hurdle still concerns the registered finite conditional model. Source validity, calibrated causal response, implementable actions and measured additional customer profit remain separate acceptance requirements. This week's next product gate should be a source-backed customer intervention with a preregistered comparator and realized net-profit reconciliation, not a universal guarantee inferred from synthetic tests.
