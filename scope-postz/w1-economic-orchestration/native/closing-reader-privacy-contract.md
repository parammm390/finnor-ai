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

The three isolated predicate calls pass in real Linux PostgreSQL, but run
41233570873 still fails SQLSTATE 42501 in the complete material-cut query.
The predicate-only check therefore does not establish the complete dependency
closure. Execute the actual pe_closing_cut query under each role, retaining a
missing-programme NULL as a query/permission preflight only. Its permissions
must fail before the positive financial journey if a dependency is absent.
Diagnostic output may name only a PostgreSQL permission object's identifier
and kind from the exact permission-denied syntax; never emit arbitrary SQL
error messages, statements, parameters, request data or database credentials.

The full query preflight now reproduces the exact remaining refusal: job
124637078371 reports permission denied for table capability_nango_bindings.
Y5's PUBLIC restrictive evidence-source policy embeds a direct bindings-table
subquery; PostgreSQL checks its table privileges even for ordinary non-Nango
records. Do not grant closing readers access to bindings, connection identities
or source scopes. Put the same currentness test behind a SECURITY INVOKER
PL/pgSQL predicate: ordinary source types return true without preparing a
private-table query, closing reader roles always reject Nango records, and
existing other callers retain their own original table privileges and RLS.
Preserve public ordinary sources and all other source privacy policies.

Actual rolled-back evidence-source rows must prove ordinary visibility, Nango
refusal, no binding-table SELECT privilege and foreign-context refusal. Re-run
the complete material-cut permission preflight and unchanged full closing
positive. No empty-cut or privacy result is a financial closure claim.

The local full-cut probe additionally reproduces missing EXECUTE on
s5_institution_visible. The existing institution reservation/state/history
policies explicitly return true for every role except finnor_app, yet their
function references still require planning permissions. Scope those three
unchanged predicates TO finnor_app: other roles retain exactly their prior
policy truth without acquiring an institution function or private read right.
Audit every existing checker/broker-readable table with real EXPLAIN under
that role, collecting all permission failures in savepoints before failing.
The inventory grants nothing and executes no selected rows. Retain catalog
relation identifiers, exact bounded permission identifiers and SQLSTATE only.
This planning audit supplements populated privacy and the actual closing query.
