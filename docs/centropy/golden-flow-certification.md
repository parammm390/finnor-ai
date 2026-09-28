# Golden Flow certification ledger

Current release candidate. Local fixtures and deployed production are separate certification states. This ledger supersedes the [historical ledger](historical-certification-ledger.md).

| Flow | Requirement | Current evidence status | Evidence | Observed scope |
|---|---|---|---|---|
| 1 | Blocker question | LOCAL_INTEGRATION_PASS | [Proof directory](evidence/release-candidate-blocker/) | Canonical answer, source links and reload; no Objective or effect. |
| 2 | One autonomous Atlas objective | LOCAL_INTEGRATION_PASS | [Fresh terminal proof](evidence/release-candidate-atlas-fresh-terminal/) | The original single Work has seven verified effects, a sourced financial memo, exact memo/run recommendation, and verified terminal success. The proof records its interrupted and resumed execution. |
| 3 | Growth −300bps + exit 9x | LOCAL_INTEGRATION_PASS | [Proof directory](evidence/release-candidate-growth-current/) | Exact two input deltas, new Scenario/Run, immutable base, dependent outputs and lineage. |
| 4 | Editable sourced IC deck | LOCAL_INTEGRATION_PASS; publication BLOCKED_EXTERNAL | [Proof directory](evidence/release-candidate-deck-mobile/) | Populated six-slide PPTX, 19 exact bindings, immutable edit and download hash; no real M365 destination. |
| 5 | Ask Sarah for the missing cohort file | LOCAL_INTEGRATION_PASS; real-mailbox certification open | [Proof directory](evidence/release-candidate-communication/) | Authored local party; explicit approval, actual SMTP acceptance, independent byte readback, receipt, no duplicate replay. |
| 6 | Parallel deal recheck | LOCAL_INTEGRATION_PASS | [Proof directory](evidence/release-candidate-workforce-final/) | Actual bounded specialist queries overlap; inspect and reassign proved separately. |
| 7 | Yesterday versus current | LOCAL_INTEGRATION_PASS | [Proof directory](evidence/release-candidate-temporal/) | Named temporal clone, actual historical basis and changed inputs/outputs; missing causal edges remain explicit. |
| 8 | Recovery | LOCAL_INTEGRATION_PASS | [Proof directory](evidence/release-candidate-workforce-final/) | Controlled read outage, preserved partial results, explicit continuation and verified terminal result. |
| 9 | Refresh active work | LOCAL_INTEGRATION_PASS | [Fresh proof](evidence/release-candidate-atlas-fresh-terminal/) | Same persisted IDs and user turn during pending approval. |
| 10 | Close whole browser and sign in again | LOCAL_INTEGRATION_PASS | [Fresh proof](evidence/release-candidate-atlas-fresh-terminal/) | Fresh Chromium process without saved cookies/session restores exact active Work, Objective, Thread and Canvas. |
| 11 | 390×844 phone | LOCAL_INTEGRATION_PASS | [Proof directory](evidence/release-candidate-deck-mobile/) | Thread default, Canvas sibling, exact approval, source inspection, readable controls and no horizontal overflow. |

## Release status

The release branch contains committed implementation and additional audited fixes awaiting the next exact-head CI run. The original Atlas objective and all eleven Golden Flows have local integration proof. The compiled four-viewport sweep and authored large-input renderer measurements have passed. The exact timed demo passes: first verified receipt at 55.145 seconds and full same-Objective terminal success at 143.302 seconds, six verified effects and six finalized receipts. Workflow/Outcome Pack and spreadsheet/source-record interactions pass. All three affected workforce reruns pass after the runtime correction. The final rebuilt four-viewport visual rerun passes. Canonical release gates, deployment, and live-host certification remain open. No LOCAL_INTEGRATION_PASS is a LIVE_CERTIFIED claim. Microsoft publication requires a real registered destination and independently verified provider write/readback.

## Repeatability

Each proof JSON records its inputs, actual IDs, observations, screenshot hash, limitations, and rerun command. Local owner credentials remain in ignored `.env.local`. `node scripts/centropy/run-local-e2e.mjs <spec> --project=desktop-chromium --workers=1` loads those credentials without writing them to evidence. Start the named stack recorded in that proof before rerunning.

## Additional certification

- [Capability classification](capability-coverage.json): 264 actual entries, each classified; classification coverage is distinct from individual execution coverage.
- [Human closing decisions](evidence/release-candidate-human-closing/): independent RLS readback, exact approval/effect/receipt, replay and rejected identity/payload boundaries.
- [Compiled viewport sweep](evidence/release-candidate-compiled-sweep/): desktop, tablet, 390×844 and 375×812; automated WCAG and keyboard results. The toolbar correction passes the final overlap assertion and rebuilt screenshot review.
- [Desktop renderer stress](evidence/release-candidate-renderer-performance-desktop/) and [mobile renderer stress](evidence/release-candidate-renderer-performance-mobile/): actual production components with explicitly authored UNKNOWN inputs. These measure UI rendering, not large production database load or a deployed Next.js bundle.

- [Exact original timed demo](evidence/release-candidate-real-demo/): real run video, checkpoint screenshots, six effects/receipts, full same-Objective completion, actual SSE resume and poll fallback.
