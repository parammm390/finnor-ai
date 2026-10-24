# Original-parent adapter lock-order review

Evidence class: partial, source inspection only. No DB statement was executed.

## Independent failure model, declared before the repair

The canonical S5 adapter takes the tenant portfolio mutex before tenant source
mutex 5510. The proposed origin validator and original-P1 consumer previously
took 5510 first. Their same-transaction descendants can read or charge the
original S5 portfolio. A concurrent owner operation that holds the portfolio
mutex and waits for 5510 can therefore form a two-lock wait cycle.

Expected contract: every new original-parent entry acquires the existing
portfolio mutex, then existing mutex 5510, before original owner/Work/resource
rows. Reentrant acquisition of those same transaction locks does not allocate
capacity, create a grant, or change an authority decision.

## Finite verification

Inspect all three new entry seams: origin validation, retained allocation
frame reads (including recovery), and original-P1 model consumption. Verify
their common lock helper precedes owner/resource row locks. Run scoped compiler
diagnostics after the change. A concurrent real-native DB falsifier remains
NOT_RUN until an explicitly authorized disposable DB is delivered.

This review does not establish deadlock freedom across existing native owners.
