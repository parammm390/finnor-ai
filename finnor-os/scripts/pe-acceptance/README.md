# Birch PE acceptance — T0 diagnostic

From `finnor-os`, with the repository's Node.js version and dependencies installed:

```sh
npm run benchmark:pe:birch -- "$HOME/birch-evidence/participant" participant
npm run benchmark:pe:birch -- "$HOME/birch-evidence/owner" owner-control
npm run benchmark:pe:birch -- "$HOME/birch-evidence/denied" owner-denied-control
npm run benchmark:pe:birch:grade -- <path-to-one-observation-json>
```

Each invocation creates a new embedded Postgres instance and fixture tenant, ingests and binds four versioned exhibits, submits the same signed objective to the real route, and snapshots the outcome in a private JSON file. On acceptance, it drains the registered objective and workforce job handlers under the worker database role, re-reads Work through the signed route, and records durable steps, events, planner outcomes, jobs, actions and effects before stopping Postgres. The runner clears inherited service environment variables. Its only configured model is a local diagnostic observer, which cannot produce a business memo; the final runs invoked it zero times. The oracle is imported only by the offline grader, never by the fixture.

The participant run is a negative control: the policy intentionally denies deal objectives to that role. The runner and grader exit zero for this control only when the scope denial is observed without an objective loop, jobs, actions or effects. This is not a successful associate deal submission. The owner runs deliberately exit nonzero: no release-qualified T0 deliverable exists. The grader's numeric checks alone cannot establish source lineage, reviewer acceptance or authority.

| Acceptance pack gate | Observed outcome |
| --- | --- |
| Participant deal-objective denial — negative control | **PASS.** Signed participant intake returned the expected scope denial (HTTP 403); no objective loop, objective jobs, actions or effects were recorded. This does not score underwriting or financing. |
| Owner control T0 — underwrite and finance | **FAIL.** The owner control was admitted and executed a Deal grounding query, but the completion check failed for IC preparation and decision evidence; no qualifying memo or calculation sheet was produced. Owner intake is not an associate submission. |
| Negative B2/B7 | **FAIL** for the tested B2 scope: the B2-denied owner request returned a generic 403, not a scoped evidence request. B7 denial and absence of out-of-scope retrieval were not established. |
| T1–T4 — event release, operation, amendment and exit | **UNPROVEN.** These events were not released after failed T0. |
| Recovery and authority | **UNPROVEN** for replay, restart, supersession and business authority across the journey. The observed T0 runs recorded no domain actions or business effects. |

The parser regression test proves the Birch mandate's “may not contact anyone” no longer becomes a recipient; it also distinguishes prohibited contact from a separate positive request. The post-fix owner run reaches the deterministic IC planner. It queries the Deal graph and checks completion, then stops with `IC_PREPARATION_VERIFICATION_UNMET` before any model proposal. Do not relax that check or change participant policy. The next positive proof needs a source-backed memo and calculation sheet produced within the existing owner authority and verification contract; a standalone draft is not an authorized IC memo. These runs provide no production release verdict or 95% acceptance claim.
