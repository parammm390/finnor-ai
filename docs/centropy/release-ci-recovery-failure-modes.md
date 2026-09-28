# Release CI recovery boundaries

Before changing the runtime, the observed failures and required boundaries are:

- An unreserved worker must not start after its Objective has exhausted the global query or action budget.
- A step that already reserved its last permitted operation must still be allowed to claim that operation.
- A stale caller snapshot must not override current persisted Objective counters.
- Exhaustion must preserve an existing assignment as reassignment history and must not silently execute it.
- Specialist usage must count only that specialist's assignments; another specialist's work must not consume its allowance.
- A PE waiver or close must supply the exact approved authority decision to the canonical SQL owner. An allowed execution decision alone does not satisfy its unconditional human approval floor.
- Execution authority, approved request, BusinessEffect hash, receipt, current authority revision and canonical target must still match.
- The IC opening owner has a different canonical contract: its opening reference must be the allowed execution decision. Passing the PE closing approval reference to that owner must fail. Both exact Core approval and execution proofs are required by the agent adapter.
- A failed Work must be claimed through its reviewed retry control before continuing its Objective. A browser test must not wait for a Continue button that current canonical state correctly hides.
- A non-key Work status transition must serialize competing status/event writes while allowing an Objective evidence append to hold its foreign-key key-share lock. The fresh browser run observed a cycle between late Work FOR UPDATE locking and ObjectiveStep updates. Work identifiers are immutable; the status owner can use FOR NO KEY UPDATE without permitting competing status writes. PostgreSQL's row-lock conflict table confirms this boundary: https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS.
- A completed specialist iteration awaiting approval must remain executable while its exact active Objective continues independent branches. The observed memo confirmation failed between the specialist's wait and the controller's subsequent global wait.
- That parallel wait must never authorize a finished ordinary step, a cancelled or failed step, a changed Objective revision, a superseded/terminal PlanRevision, a mismatched PlanNode/Work/tenant, or a terminal Work/Objective. Historical actions without PlanRevision generation pins retain the narrower legacy approval-wait contract.
- Repeated confirmation must reuse the same BusinessEffect and immutable approval episode; a rollback at the execution guard must leave the original pending action reviewable.

Verification uses the existing real PostgreSQL integration journeys, the real Atlas browser journey, and the pinned release secret scanner. No authority floor or canonical state transition is relaxed.
The final release audit must compare the actual current migration head and action registry with the production contract. A stale 0148 contract cannot release the 0149 parallel approval guard. The retired 41-action assertion must reflect the exact 45-entry hardening specification, including memo/deck preparation additions; the registry still must match every declared action. The sole allowed source adapter is the actual GmailSentMessageAdapter with only sent_message_readback scope. This does not authorize legacy provider-to-domain imports, mailbox sync, or receipt delivery claims.
