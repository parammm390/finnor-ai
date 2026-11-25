# Birch PE acceptance — T0 diagnostic

From `finnor-os`, with the repository's Node.js version and dependencies installed:

```sh
npm run benchmark:pe:birch -- "$HOME/birch-evidence/participant" participant
npm run benchmark:pe:birch -- "$HOME/birch-evidence/owner" owner-control
npm run benchmark:pe:birch -- "$HOME/birch-evidence/owner-draft" owner-draft
npm run benchmark:pe:birch -- "$HOME/birch-evidence/denied" owner-denied-control
npm run benchmark:pe:birch:grade -- <path-to-one-observation-json>
```

Each invocation creates a new embedded Postgres instance and fixture tenant, ingests and binds four versioned exhibits, submits the same signed objective to the real route, and snapshots the outcome in a private JSON file. On acceptance, it drains the registered objective and workforce job handlers under the worker database role, re-reads Work through the signed route, and records durable steps, events, planner outcomes, jobs, actions and effects before stopping Postgres. The runner clears inherited service environment variables. Its only configured model is a local diagnostic observer, which cannot produce a business memo; the final runs invoked it zero times. The oracle is imported only by the offline grader, never by the fixture.

The observation JSON separates the participant safety control (`control`), the unmet associate requirement (`associateDealMemo`), and the owner outcome (`ownerControl`). Grade each observation independently. The draft cohort retains the frozen grader's `owner-control` mode and carries its own versioned `cohort` field. The grader's numeric checks alone cannot establish source lineage, reviewer acceptance or authority.

The original owner control uses the unchanged query/check profile and zero-action objective budget. `owner-draft` uses the preregistered `draft-owner-cohort.v1.json` authority and budgets in a separate fixture. Only the manifest's named actions are granted to the submitting owner and workforce profiles; an isolated database trigger also refuses other domain action types and records refusals. The fixture sets up the case, committee configuration and model definition, not a run, recommendation or verification result. It does not grant approval or waive existing confirmation gates.

| Acceptance pack gate | Observed outcome |
| --- | --- |
| Participant deal-objective denial — negative control | **PASS.** Signed participant intake returned the expected scope denial (HTTP 403); no objective loop, objective jobs, actions or effects were recorded. This does not score underwriting or financing. |
| Associate deal-memo capability | **UNMET.** Only owners may submit a deal memo objective under current policy. A participant can write a standalone draft, which is not a deal memo. |
| Owner control T0 — underwrite and finance | **FAIL.** The owner control was admitted and executed a Deal grounding query, but the completion check failed for IC preparation and decision evidence; no qualifying memo or calculation sheet was produced. Owner intake is not an associate submission. |
| Draft-enabled owner T0 — underwrite and finance | **FAIL.** The Work selected and persisted a cited underwriting action, then paused at the existing approval gate (`policy_requires_approval`). No run, review-ready IC Case, memo or calculation sheet was observed. |
| Negative B2/B7 | **FAIL** for the tested B2 scope: the B2-denied owner request returned a generic 403, not a scoped evidence request. B7 denial and absence of out-of-scope retrieval were not established. |
| T1–T4 — event release, operation, amendment and exit | **UNPROVEN.** These events were not released after failed T0. |
| Recovery and authority | **UNPROVEN** for replay, restart, supersession and business authority across the journey. The draft run recorded a pending action, not an executed effect. |

The original owner run stops with `IC_PREPARATION_VERIFICATION_UNMET` before any model proposal. The draft run stops at a different boundary: the underlying underwriting action requires confirmation. The Postgres underwriting integration suite exercises cited inputs and XLSX persistence/readback independently of that gate. No memo or investment recommendation has been verified end to end; the next proof needs authorized progression through the existing workflow, not a weaker verifier or a different participant policy. These runs provide no production release verdict or 95% acceptance claim.
