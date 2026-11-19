# Shared admission correction, before its edit

The current W1 wrapper acquires slot-1.lock / slot-2.lock, while the shared
coordinator and actual W3 owner use mediumslot-1.lock / mediumslot-2.lock.
Those separate names cannot enforce the shared two-medium-job limit. A heavy
lock does not substitute for counting independent medium-only jobs.

Use the exact existing shared mediumslot names. Never remove another lane's
directory, owner record or processes. Keep mkdir exclusive, the two-slot limit,
three-GiB disk floor, heavy lock, load gate and finite waits unchanged. This
correction changes resource admission only, not any child deadline or result.
The historical W1 resource receipts remain historical; do not relabel their
slot accounting as conformant. Check the actual newly acquired names in the
next owned run and retain its before/after receipt.

Failure modes: wrong shared directory; name mismatch; treating a peer's slot as
available; removing peer ownership; leaking an owned slot on termination;
starting below the floor; returning PASS without a terminal successful child.
The existing descendant cleanup issue M2 remains separate and unrepaired here.
