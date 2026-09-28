# Release CI recovery boundaries

Before changing the runtime, the observed failures and required boundaries are:

- An unreserved worker must not start after its Objective has exhausted the global query or action budget.
- A step that already reserved its last permitted operation must still be allowed to claim that operation.
- A stale caller snapshot must not override current persisted Objective counters.
- Exhaustion must preserve an existing assignment as reassignment history and must not silently execute it.
- Specialist usage must count only that specialist's assignments; another specialist's work must not consume its allowance.
- A PE waiver or close must supply the exact approved authority decision to the canonical SQL owner. An allowed execution decision alone does not satisfy its unconditional human approval floor.
- Execution authority, approved request, BusinessEffect hash, receipt, current authority revision and canonical target must still match.
- A failed Work must be claimed through its reviewed retry control before continuing its Objective. A browser test must not wait for a Continue button that current canonical state correctly hides.

Verification uses the existing real PostgreSQL integration journeys, the real Atlas browser journey, and the pinned release secret scanner. No authority floor or canonical state transition is relaxed.
