# Selected PE analysis: implementation and qualification

Status: **controlled integration qualification passed; live-model product acceptance incomplete**.
Observed 2026-11-03. This document does not accept the full product, all 675 catalogue entries, or Project W/Z phases.

## User outcome and concrete change

A selected PE record must be usable context for an analytical question. Previously the exact closing-risk prompt entered a durable Objective and failed without a completed canonical read or answer. A registered backend query alone did not deliver the requested analysis.

The new path uses the accepted business root and the existing permissioned `pe_world_state` owner read. It sends the resulting BeliefView to the configured answer model, checks assessment citations against that exact view, obtains a separate critic review, and rechecks the native source/rights pin before publication. Ordinary supported typed reads retain their existing route. Mutation requests retain the execution path.

The answer distinguishes registered records from inference, assumptions and evidence gaps. It preserves record provenance and timestamps, states that confidence is uncalibrated, and does not establish approvals, completed actions, closing eligibility or realized profit. A second model review is a support check, not independent verification of financial truth.

The analysis and review share a finite deadline. Explicit shorter caller deadlines remain binding; voice retains a short default budget. Physical provider calls honor an explicit bounded timeout rather than always applying the ordinary eight-second text-call ceiling.

## Reproduced publication bug

Cancelling through the authenticated instruction-cancel API during analysis review left the Work cancelled but still emitted an answer-completed event. The failing E2E observed one completed event after cancellation.

Completion now checks the cancellation fence and commits the existing Work/input transition before emitting the response-completed event. The transition rejects a superseded input or terminal cancelled Work. The cancellation-during-review regression now observes cancelled Work and no answer-completed event. This finite case is not an exhaustive concurrency proof.

## Executed checks

| Check | Result | Scope |
| --- | --- | --- |
| `pe-objective-world-scope.test.ts` and `private-equity-p1-world-truth.test.ts` | 30 passed, zero failed/skipped | Disposable real PostgreSQL, ordinary SQL role, signed local authentication, actual HTTP routes, native owners, authority, query receipts and persisted answers; deterministic model transport |
| Selected risk analysis and polite wording | Passed | Actual selected root and owner risk reach answer/review; answer persists in Thread; Work completes; no DomainAction is created |
| Foreign/unknown citation | Passed | Exact citation error; no accepted answer |
| Critic rejects support | Passed | Exact support error; no accepted answer |
| Rights revoked during review | Passed | Native deny grant invalidates publication; exact source/rights error |
| Cancellation during review | Passed | Actual cancel API; cancelled Work; zero completed response events |
| Existing model-routing/observability/fault regressions | 14 passed, zero failed/skipped | Existing tests, not new unit tests |
| Backend TypeScript and generated build-input checks | Passed | Source consistency; not live usefulness |
| Live application-provider transport control | Failed | Local AWS credential chain reports an expired session; no successful new answer/review qualification |

Run the two integration files from `finnor-os` against a migrated, explicitly disposable database with `track_commit_timestamp=on`. Set `FINNOR_PE_OBJECTIVE_EVIDENCE_DIR` to retain each run's input identities, HTTP responses, owner/query results and observations. `FINNOR_GROUNDED_ANALYSIS_LIVE=1` enables the bounded real-provider control and selected positive case; it requires actual authorized AWS credentials and the selected Region. The deterministic results must not be presented as live-model results.

## Remaining acceptance limits

- Real-model latency, response support and answer/review completion remain unaccepted. Earlier attempts also produced request-abort and connection-reset errors; expired credentials do not retrospectively explain every transport error.
- This path inspects bounded registered canonical evidence. It does not ingest missing QoE/IC-document bodies, connect providers, expand source grants, or certify enterprise-wide completeness.
- At most 64 claims/70 KB are supplied. Dependency closure for omitted financial-series/source claims is not yet qualified. Missing financial context must remain a gap; exact EBITDA or profit must not be invented.
- The six analysis cases do not accept the remaining semantic prompts, full autonomous drafting, closing approval, closing-readiness proof, every channel, or every catalogue operation.
- The capability manifest is a declaration of operations. It is not proof of current provider configuration, execution rights, working integration or end-to-end outcome.
- No production deployment or broad feature-completion percentage follows from these results.

## Product standard

Further work should be accepted on a complete user outcome: correct selected context; real authorized evidence; sound financial reasoning; usable deliverable; bounded execution where requested; independent owner/provider readback; and understandable recovery when it cannot finish. Record actual time, model usage, corrections and failures, not only a passing test count.

The requested 100× superiority remains an untested target. A defensible comparison needs matched tasks, source data, permissions and resources; strong equipped alternatives; independent correctness/usefulness judgments; and measured time/cost. No such comparison is established here.
