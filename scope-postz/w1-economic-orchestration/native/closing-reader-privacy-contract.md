# Independent closing reader compatibility

Registered before the forward repair. Actual W2 Linux run 41230609882 records
SQLSTATE 42501 in the independent checker's material-cut query. Its source calls
`pe_closing_cut`; existing S5 and S6 restrictive policies invoke Y4 boolean
visibility functions whose EXECUTE privileges were revoked from PUBLIC and
granted only to the application and worker roles. The isolated closing checker
and broker were omitted from that policy dependency closure.

Permit these existing reader roles to evaluate only the three S5/S6 visibility
predicates used by their existing table privileges. Add no table access, write,
role membership, superuser, BYPASSRLS, private-source, source-handle or financial-
effect authority. Preserve tenant filtering and the private-recipient boundary.
A closing reader is never a confidential recipient, including when it sets an
application principal GUC to an owner.

The unchanged actual closing-owner positive must get beyond the prior checker
refusal and complete before the remaining compensation controls run. The
adapter-off baseline must still reach its intended missing join: the financial
owner CLOSED and compensation OPEN. All four repaired controls remain required.
No permission error, unavailable checker or skipped assertion is a settlement.

Supplement the actual owner journey with ordinary-role SQL checks: record the
checker/broker identities and privileges, allow ordinary same-tenant visibility,
deny a foreign tenant and keep a confidential S5 proposal hidden even with a
spoofed owner principal setting. Confirm the actual application recipient still
sees its own private proposal. Create only explicitly synthetic privacy rows in
one rolled-back transaction; they must confer no budget, effect or receipt.
Missing roles, extra privileges, changed tenant visibility, failed rollback and
principal impersonation all fail the check. These focused checks supplement the
full owner E2E and do not establish Y4 protected or field qualification.
