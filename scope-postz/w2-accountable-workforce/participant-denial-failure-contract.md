# Participant denial across existing controls

Registered before changing the authority implementation, 2026-10-31.

The W2 role ceiling must deny generic approvals to participants without granting
legacy roles, inventing a user, or failing while recording that denial. Existing
Linux integration failures return 500 instead of 403 at DLQ listing, run pause,
and action revert (run 41252848596, jobs 124690644375 and 124690644581).

Failure modes: a retired role reaches an owner operation; a participant gets an
owner approval; a dev identity absent from canonical users is inserted into the
authority decision foreign key; a valid participant's denial loses its canonical
identity; an unsuccessful revert changes action state; an owner positive or
tenant isolation check regresses.

Extend the existing database-backed route journeys first to try both retired
`analyst` and current `participant` contexts. Keep all owner, action-state, and
cross-tenant assertions. Resolve a denial's employee foreign key from canonical
identity, preserving the participant ceiling and durable denial evidence.
Actual signed participant routes remain a separate owning journey.

The separate existing route-boundary inventory also needs to recognize the
already implemented `requireCapabilityOwner` wrapper, as the canonical authz
generator does. This maintains an existing convention check; it is not security
qualification. The signed participant journey must still exercise all seven
owner capability methods and verify the before/after write counts.

Fresh PostgreSQL route baseline 001 reproduced all three original 500 failures
with 14/17 passing. Treatment 002 passed 17/17, including current participant and
retired-role denials, owner positives, unchanged rejected actions, and tenant
isolation. The later corrections-route failure shares the same denial path and
must be included in the consolidated verification.
