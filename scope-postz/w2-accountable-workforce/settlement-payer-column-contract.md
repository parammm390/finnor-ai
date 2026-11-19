# Canonical financial payer binding

The original after-exact Linux episode at77e6f4e8f16ba6549d0f012851fc8aafbcb98d53
closed the financial transaction, then failed the unchanged OPEN-versus-SETTLED
assertion. The join checks `row.consumption.principalId`, but the canonical
`AllocationConsumption` body has no principalId field. An actual earlier local
owner snapshot confirms its keys match that contract. S5 stores the authenticated
payer in `s5_consumptions.principal_id` and `s5_reservation_origins.principal_id`.

Read those existing owner columns in the same tenant-scoped join and require both
to equal the immutable accepted payer. Do not infer identity from a projection or
add a payer field to historical consumption bytes. Preserve both reference hash
checks, exact amount/currency, payee, accepted terms, independent receiving
observation/checker/currentness, reservation, business effect and one-payment
constraints. Neither enrollment nor this repair grants payment authority.

The existing five-case actual-owner comparison is decisive: exact payment must
settle once; the original adapter-off baseline must reproduce the missing join;
wrong amount, payee and receipt must stay OPEN. The exact case also retains the
UNKNOWN interval, worker restart, unchanged original acceptance, single physical
payment, single S5 debit and adverse-receipt reopening without refund. Retain
each original input and the observed owner rows even when an assertion fails.
