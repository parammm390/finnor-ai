# Canonical transaction order acceptance

The mounted role-change campaign retained an actual PostgreSQL deadlock:
`completion-cut-1/browser-2/fixture-authority-writes.json`.
The assignment writer held the existing V3 material-cut advisory fence while
waiting for `authority_states`; X3 had already read-locked current authority
and then waited for that same material-cut fence during canonical auditing.
The rolled-back attempt committed no grant.

Before the corresponding change, select the existing `closingTx` transaction
boundary for X3's existing `tx` export. It takes the canonical V3 material-cut
fence before the transaction body and therefore before current-authority locks.
Do not create a new lock, ledger, migration, retrying business engine, or bypass.
Do not merely hide the inversion with fixture retries.

Retain current tenant/role/record/source checks, statement/lock deadlines,
original application allocations, idempotency and atomic effects. The source
manifest must be restamped and the API rebuilt because runtime behavior changes.
Rerun complete installed/concurrency/lifecycle checks, signed owner-effect and
mounted identity/effect checks on this new cut.

Credible failures are remaining inverse lock order, authority checked outside
the serialized transaction, excessive lock duration, bypassed currentness,
changed cancellation/deadline behavior, and a stale compiled API.

Logout acceptance remains the actual canonical signed-out gate: no private
application forms, then use its real Sign in link for a fresh login. The product
deliberately preserves the bookmarked Work URL; an automatic redirect was an
incorrect driver assumption, not the required product contract.
