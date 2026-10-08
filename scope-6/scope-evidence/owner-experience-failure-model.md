# Native experience delivery: authoring gate

The observable contract is delivery of original prepared events from the actual
S1–S5 semantic owners through the existing authenticated outbox. Signed transport
and protected append receipts establish bytes, owner, references and order only.
They do not change the original admission, scientific, settlement or H2 fields.
This integration is S6-owned work; missing native producer wiring is not external.

Credible failures to challenge before implementation:

1. A configured native S5 writer commits a revision/invalidation in its ordinary
   experience table but creates no durable signed event-delivery origin.
2. A crash or outage loses the prepared event, changes its identity, creates an
   alternative action/effect ledger, or releases held allocation exposure.
3. S5 forges BUSINESS_OWNER mandate/utility preimages or registers another
   owner's references using S5 credentials. Missing authentic references must
   retain pending delivery and fail protected append.
4. A receipt authenticates changed content, another tenant/principal, an unknown
   parent, or an altered rights scope. Repeated delivery must retrieve the same
   immutable event/receipt and cannot rewrite the ordinary prepared record.
5. S1/S2 readback incorrectly assumes that their content digest is a detail hash;
   their existing typed view/protocol digest contracts must be preserved.
6. A downstream consumer mistakes H0 mechanical settlement or a supplied H1
   proposal for admitted causal attribution, economic value or method promotion.

Selection: extend the existing native-owner/outbox/separate-process ledger E2E,
using its real authenticated S5 resource writer and invalidation readback. Retain
original reference-only challenges. Add an event challenge that first observes
missing authentic dependencies, supplies their exact original preimages through
separate disposable BUSINESS_OWNER authority, then independently reads and
verifies the protected event and receipt. Do not mock owner issuance, rewrite
history, relax reference checks, or add a production fault seam. Missing event
delivery is a capability baseline, not a claimed exploit.

Registered domain: actual ordinary-role PostgreSQL/native handlers and separate
local ledger process; disposable external signers; 64 append and 64 recovery-read
budgets; 256 unresolved deliveries per authenticated workload. Monetary cost and
production OS/key/release admission remain unestablished. Rerun and exact source,
inputs, faults, signed origins, append responses and readbacks are retained by
the authoritative runner. No relevant source/test edits during its execution.

Retained capability baseline: the existing six owner/reference cases pass in
`owner-experience-baseline-scoped`. Its new case initially queried a nonexistent
timestamp column; that harness error remains retained and is not a demonstrated
implementation failure. After using the actual event identity column,
`owner-experience-missing-event-baseline` runs the explicitly selected event
challenge and fails because the real native S5 revision/invalidation records
have no authenticated event origins, with source freeze and terminal exit 1.
The earlier initial harness also counted genuine S5 reference rows in an S6-only
assertion; its failure remains retained. Workload-scoped assertions preserve the
original logical counts and do not hide the separate S5 reference checks.

The retained `native-owner-experience-separated` run passes its five native
cases and the first six transport cases. Its event oracle incorrectly required
signatures for older ordinary events created before the signing route existed.
The two events produced by the configured writers have valid native origins.
The corrected oracle snapshots all historical events before route configuration,
requires both newly produced revision and invalidation events to be signed,
and verifies that every historical prepared record remains unchanged. It does
not re-sign historical events or erase their missing delivery qualification.

The subsequent retained run `native-owner-experience-qualified` reaches genuine
signed event delivery and passes all 18 separate-process ledger cases. The new
event case refuses a fixture utility reference whose digest is raw SHA-256 of
an opaque label, rather than the canonical hash of a supplied content preimage.
The fixture will bind its BUSINESS_OWNER utility reference to its actual declared
utility object, using the same canonical contract as other native references.
The delivery test will independently check that object against the issued digest
and register it under separate BUSINESS_OWNER authority. This repairs the input
fixture; it does not authorize S5 to invent a utility preimage or relax protected
reference validation. The prior mismatch and all failure artifacts remain retained.
