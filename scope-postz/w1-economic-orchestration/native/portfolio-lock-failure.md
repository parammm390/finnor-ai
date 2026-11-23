# Failure-first current-owner transaction repair

Retained attempt `evidence/native-bootstrap-0007` accepted the signed W1 request
and scheduled the original native continuation. Its first compute unit was
quarantined with `DatabaseExecutionDeadlineError`; no P2 attempt was admitted.
The stack enters `readNumericEnterpriseAllocation` through `recheckSearchOwners`.

P2 admission holds the canonical `s5-portfolio:<tenant>` transaction advisory
lock. W1's current snapshot calls the complete S5 validator without the existing
client. The validator starts another transaction and waits for the lock held by
its own caller. Longer deadlines cannot repair this ownership cycle.

Make the canonical S5 store/validator accept an existing transaction, retaining
the same authorization, portfolio mutex, immutable certificate verification,
consumptions, complete current portfolio, source/rights, capability, policy and
resource checks, and invalidation experience. Forward that client only from the
actual W1 snapshot boundary. Existing nontransactional callers retain their
current API behavior; R3 is not silently treated as a numeric allocation.

Failure conditions include dropping currentness, validating a cached projection,
using a foreign tenant/principal client, opening another portfolio transaction
for invalidation, losing owner events, or extending the original deadline/grant.
Reentrant acquisition must occur on the same PostgreSQL client. The caller owns
rollback/retry of a supplied transaction.

Expected owning proof: the unchanged native warm/scored bootstrap reaches actual
admission, submission and original P1 SQL acceptance, with independent capsule
oracle PASS, actual separate restricted worker and zero external network calls.
Attempt 0007 and all previous failures remain in evidence. This is not a unit
test, protected-admission receipt, cold-install proof or economics claim.
