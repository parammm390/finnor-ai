# Bind the actual physical bootstrap parent

Actual worker-image job 124630909755 passes all five S6 isolation cases, but
both successful P1/R2 programme cases fail ISOLATION_BOOTSTRAP_RECEIPT_INVALID.
The retained real receipts identify guardian 27, guest 29 and parent 26 for
the arithmetic case. R2's physical receipt binds guardian 27 and separately
observes its Python supervisor 26. The shared validator instead assumes that
every launcher's parent is its own current Node process. That is true for
direct S6 launch and false for the existing supervised R2 launch.

Make the expected guardian, actual launching parent and filter digest explicit
at both maintained call sites. For S6 use the spawned child and current Node
parent; for R2 use its physical child receipt and observed supervisor PID.
Keep strict receipt schema/custody, original identity bounds, process-group
and guest-parent relationships, UID, privilege and filter checks unchanged.
Missing identities and forged/wrong parents still fail; do not accept whatever
parent the receipt supplies. Retain R2's independent parent-binding assertion.

Re-run the unchanged actual worker-image arithmetic, readonly hostile, deadline
and cancellation cases, along with S6 isolation. Existing real failed receipts
are the baseline. A typecheck or kernel-only pass does not qualify this repair.
