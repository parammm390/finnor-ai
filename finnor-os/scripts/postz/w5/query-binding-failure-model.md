# W5 original query binding

The existing organization reader requires the authenticated owner, original Work,
and immutable Work input. A typed observation must not append steering input or
change the selected plan, Work state, resource reservation, or possible effects.

Failure cases frozen before changing the adapters

- Missing, malformed, extra or forged identity fields reach a permissive validator
  and are rejected only after generic intake has already changed the Work.
- The public envelope removes the semantic Work ID from the native request.
- Generic typed intake creates a new Work input and invalidates the original cut.
- A different Work is substituted for the request's recorded Work.
- A participant or foreign tenant receives owner-only query metadata.
- Objective execution omits the active plan's immutable input.
- Objective verification substitutes the latest input for the exact active plan
  and original loop, allowing a superseded basis to satisfy the goal.

The existing authenticated native journey owns the public read proof. Before a
worker is started, capture the original Work/input/plan and S5/S6 records, execute
the real POST /api/queries twice, and compare those exact records. Malformed,
unrelated-principal and wrong-Work requests must fail without changing them.
Retain the HTTP traffic, original selectors and before/after snapshots through
the journey's existing artifact writer and its unchanged time and byte limits.

The Objective adapters must forward the selected input and derive verification
identity from a matching active plan and loop. The current owner still checks
request/input identity, authorization and currentness. A type check alone does
not establish this native journey or final phase acceptance.

The full-context scoped check additionally exposed two reserved generic-arrow
forms in .mts verification files and a missing explicit NODE_ENV in the isolated
S6 ledger child's allowlisted environment. Preserve the generic functions' behavior
with trailing commas, and set the child's NODE_ENV to production without inheriting
any other ambient variable. These compiler repairs do not qualify live dispatch.

## Original S6 continuation evidence

Hosted case 016 passed the original S6 recovery and over-budget refusal, then
W5 continuation returned HTTP 500. Its verified signed handoff exceeded the
262144-byte S1 evidence-version limit while meeting the existing handoff bound.
Keep the full signed preimage in ordered, bounded S1 records under the original
Work. Commit the records, manifest and continuation event together. The native
driver must independently reconstruct the handoff from PostgreSQL, verify its
size, digest, original owner checkpoint and signature, then run the existing
evaluation and terminal storage refusal.
