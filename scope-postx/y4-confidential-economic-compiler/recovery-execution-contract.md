# Retained native-abort recovery observation

The registered G1 entry was missing. This is a bounded implementation of its
participant-ledger reconciliation and refusal subcase, not a full queue-crash,
new economic-source authorization or effect-preservation qualification.

Failure model, fixed before implementation:

- Only read an explicitly retained synthetic adverse episode. Check current
  source identity and its actual native fault receipts, including the earlier
  immediate burned-session replay refusal.
- Reconcile all three SQLite ledgers in independent CLI processes, twice.
  Read state without treating a refused or expired result as a successful MPC.
- Retain the same original session, deadline, disclosure rows, conservative
  failed CPU reservations, ABORTED state and burned secret/nonces.
- Run the exact prior session through the real participant entry. It must
  refuse at the burned-session or original-expiry/currentness boundary.
- Never manufacture fresh authorization or renew the deadline to get past
  expiry. New owner-authorized work is distinct from replaying burned work.
- Compare every retained regular file byte before and after. Never publish
  private per-file hashes, inputs, keys or output values.
- Report fresh independently authorized native rerun and canonical worker
  crash/claim recovery as NOT_RUN when not actually observed.
