# Canonical participant identity without a retired product persona

Actual Linux source check 124632633505 rejects W2 admission of retired field
role labels in active authority and browser authentication. Preserve the P8
scanner and retirement predicates; do not add an exception or hide those labels.

Represent the existing recipient-only workspace with a canonical participant
role. Retain existing database identities and business role/grant ownership,
but do not migrate existing people, create grants or restore old field roles.
The institutional workspace and general authority ports remain owner-only.
Only the existing W2 authority ports admit an active participant, with their
same three-capability ceiling, exact resource scope and recipient checks.

Failure modes are incomplete forward schema migration, canonical identity/type
disagreement, global owner fallback, a role conferring authority by itself,
retired-role login, cross-principal disclosure, lost recipient consent, or an
unbounded participant port. Extend the existing signed-bearer owning journey
to reject both retired identities and then read the actual participant role.
Re-run unchanged P8 static/runtime guards, actual W2 owning cases and types.
This is a software identity profile, not genuine human or protected qualification.

# Capability HTTP owner boundary

Fresh whole-backend CI at commit 77e6f4e8f16ba6549d0f012851fc8aafbcb98d53
found seven calls across five capability route files passing the expanded
`owner | participant` identity into an owner-only capability API. The existing
proof-specific type check did not load these routes. Whole-backend type checking
must remain a required gate.

Parse the signed identity once at the capability HTTP boundary and require its
actual role to be owner before reading a capability body or entering its owner.
Return the narrowed identity without a cast. Do not promote a participant, widen
`CapabilityActor`, change the capability owner's authority policy, or re-enable a
retired role. Reuse the same boundary for all five route files.

Before changing the route implementation, extend the existing signed HTTP native
episode to exercise all seven methods as the actual nonowner participant. Every
one must return 403, with no capability run or Nango binding created. Keep the
existing native owner/workforce positive paths and exact authority checks.
Retain inputs, methods, statuses and before/after counts as a rerunnable artifact.
