# Birch PE acceptance — T0 diagnostic

From `finnor-os`, with the repository's Node.js version and dependencies installed:

```sh
npm run benchmark:pe:birch -- "$HOME/birch-evidence/participant" participant
npm run benchmark:pe:birch -- "$HOME/birch-evidence/owner" owner-control
npm run benchmark:pe:birch -- "$HOME/birch-evidence/denied" owner-denied-control
npm run benchmark:pe:birch:grade -- <path-to-one-observation-json>
```

Each invocation creates a new embedded Postgres instance and fixture tenant, ingests and binds four versioned exhibits, submits the same signed objective to the real route, and snapshots the outcome in a private JSON file. On acceptance, it drains the registered objective and workforce job handlers under the worker database role, re-reads Work through the signed route, and records durable steps, events, planner outcomes, jobs, actions and effects before stopping Postgres. The runner clears inherited service environment variables. Its only configured model is a local diagnostic observer, which cannot produce a business memo; the final runs invoked it zero times. The oracle is imported only by the offline grader, never by the fixture.

The current runner and grader deliberately exit nonzero: no release-qualified T0 deliverable exists. The grader's numeric checks alone cannot establish source lineage, reviewer acceptance or authority.

| Acceptance pack gate | Observed outcome |
| --- | --- |
| T0 — underwrite and finance | **FAIL.** Participant intake was denied with HTTP 403. The authorized owner control was admitted and executed a Deal grounding query, but the verified completion check failed for IC preparation and decision evidence; no qualifying memo or calculation sheet was produced. The owner control is not a substitute for participant acceptance. |
| Negative B2/B7 | **FAIL** for the tested B2 scope: the B2-denied owner request returned a generic 403, not a scoped evidence request. B7 denial and absence of out-of-scope retrieval were not established. |
| T1–T4 — event release, operation, amendment and exit | **UNPROVEN.** These events were not released after failed T0. |
| Recovery and authority | **UNPROVEN** for replay, restart, supersession and business authority across the journey. The observed T0 runs recorded no domain actions or business effects. |

The parser regression test proves the Birch mandate's “may not contact anyone” no longer becomes a recipient; it also distinguishes prohibited contact from a separate positive request. The post-fix authorized run reaches the deterministic IC planner. It queries the Deal graph and checks completion, then stops with `IC_PREPARATION_VERIFICATION_UNMET` before any model proposal. Do not relax that check or use the owner control to count participant intake. The next proof needs an exact participant read/draft authority path and a source-backed draft outcome that the independent grader can verify. These runs provide no production release verdict or 95% acceptance claim.

## Participant authorization boundary

The 403 is expected under the [participant identity contract](../../../scope-postz/w2-accountable-workforce/participant-identity-contract.md): institutional authority is owner-only. The associate already has a fixture role assignment and query grant; neither admits them to the ordinary authority snapshot. The world reader also requires a tenant-wide candidate cut, not just a deal grant. The permitted draft below is a standalone artifact, not a deal-room or IC draft and not a T0 acceptance result.

From `finnor-os`, using the repository's Node.js version and installed dependencies:

```sh
FINNOR_BIRCH_EVIDENCE_DIR="$HOME/birch-evidence" npx vitest run tests/integration/birch-participant-boundary.test.ts
```

The test reuses this runner's isolated signed identities, Birch deal, and T0 exhibits. The associate submits the deal objective, reads their own Work, and compares the response for a custodian's Work with a missing Work. The custodian runs a real deal-world query as a positive control for the B2 document reference. The associate is denied both deal-world authorization and access to the custodian's evidence-bearing Work. The associate then creates a blank DOCX, edits their own draft version, and reads the edited text without advancing the current head. The JSON receipt in the printed directory records the fixture hash, inputs, signed route methods and statuses, and readbacks; the custodian's evidence contents are not copied into the receipt. The test requires no model calls.
