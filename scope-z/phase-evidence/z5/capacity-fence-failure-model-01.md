# Capacity-exhausted control fences: pre-correction contract

Written on the continuation before this correction, not before the original
Z5 implementation. Original denied index and recovery journal remain intact.
The real native E2E remains forbidden without separate DB/Auth authority.

## Observed source failure

The old worker catch, original-episode exhaustion, cancel, revoke and read
invalidation transactions update a request/profile and then insert an event
in the same transaction. `z5_storage` charges every event against the original
512-event/64-MiB episode cap. A quota violation rolls back the earlier fence.
The worker catch suppresses that failure as if every failed write were a
lost physical fence. A stale read can itself fail while trying to mutate.

This is a source finding, not a claim to have exhausted a real database.

## Required behavior

1. Keep the original caps, original episode, deadline, reservation, physical
   delivery and all old S6 liabilities. Do not create funding or reset a cap.
2. Use the 512 bytes already reserved on original request insertion for
   bounded terminal control metadata. Only status/generation/cancel changes
   to INCOMPLETE/UNKNOWN/STALE/REVOKED/CANCELLED qualify, with maximum growth
   512 bytes. Artifact/admission/claim changes still pay normal positive
   growth. This is prepaid occupancy, not a zero-cost computation claim.
3. Commit the authenticated, locked control fence first. Attempt its ordinary
   audit/cost record in a separate transaction. A failed audit cannot undo the
   fence or erase earlier claim/debit/cost evidence. Report an explicit audit
   gap, not a fabricated event.
4. Original delivery exhaustion commits INCOMPLETE before an optional event.
   Do not dispatch another producer for an already INCOMPLETE request.
5. Recognize only the exact original episode byte/event/use CHECK-constraint
   failures as resource exhaustion. Other dependency failures remain UNKNOWN.
6. READ does not mutate request/profile/episode/events/costs. A stale response
   declares its computed status separately from the retained stored status.
   Every actual consumer still rechecks the original profile, cut and fence.
7. Add a real guarded native read-idempotence observation to the existing
   E2E flow, comparing actual durable Z5 state before/after repeated reads.
   Do not fabricate a near-full DB, raise a quota, create an owner, or execute
   native SQL now. Capacity-fence behavior remains native NOT_RUN.
8. Native durable-state observations must enter the existing read-only tenant
   transaction using the genuinely authenticated, exact-checked owner.
   Bare pool queries lack the request's RLS settings and can incorrectly see
   no rows. Do not disable RLS or manufacture an observer identity.
9. Before the producer hands its permit to the independent original S8
   process, detach the completed permit from queue heartbeats. A renewal
   already in flight may observe that deliberate release; do not mistake it
   for a lost active producer fence. Unexpected loss of the still-active
   permit must continue to abort, and publication still locks a real permit.
10. Reconstruction timeout/output limits must terminate the entire
    subprocess group created by that driver. Killing only a `flock`/npm
    wrapper can leave its actual worker alive and its output pipes open.
    Never signal the supervisor's group or match unrelated processes.

## Finite allowed validation

Read actual callers/triggers first; preserve old source/failed receipts.
Run affected complete source graphs under the shared 4096-MiB heavy lock,
parse the changed SQL plus procedural bodies and statement/function
identities, check scripts including embedded extractor syntax, and execute
the native authority guard only. Reuse unchanged kernel/checker public
process evidence by exact source hashes rather than a new post-code unit
campaign. Keep denied commit, missing source archive/cold replay, unavailable
installed headroom and all higher qualification blockers explicit.
