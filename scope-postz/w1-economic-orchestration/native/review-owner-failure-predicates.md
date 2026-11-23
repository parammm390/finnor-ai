# Verified review defects, recorded before repairs

## Lock order

The actual current economic reader and physical pre-claim path acquire the P2
search row before `currentEconomicCutTx` re-enters the S5 portfolio mutex. Actual
publication acquires the portfolio mutex before that same search row. Two real
connections can therefore deadlock with a current projection and publication.
Preserve a single portfolio-before-domain-row lock order at all transactions
which can reach W1 currentness, learning, invalidation or replanning, not only at
the reported reader line. Do not fix this by reducing currentness, weakening
fences, changing lock scope or treating a deadlock as successful publication.

Exercise actual concurrent reads against physical native publication and retain
database waits/aborts and original attempts. A failure must not erase a completed
physical computation's debit or invent a successful checked incumbent.

## Public context bounds

The public orchestration schema currently accepts purpose/population values up
to2048 characters, but the actual conditional observation context accepts1024.
A1025-character public value can be accepted then fail after actual admission
while learning parses the continuation context outside its fit-error handler.
Reject incompatible values at the authenticated original submission boundary.
Exercise the exact1024/1025 boundary before any original search/attempt/effect.

## Resource currentness

The RESOURCE facet currently hashes the original cached physical-capacity digest
instead of the current physical owner policy. An actual post-publication policy
change is invisible to P7 invalidation until a later worker fails currentSearch.
Read the existing physical policy owner under the same current cut; do not add a
second capacity ledger or reinterpret S5 capacity as funding. Exercise actual
owner-policy changes and require an actual immutable invalidation/no stale use.

## Recovery

The independently reported plan-qualified recovery-key defect is also the
concrete failure predicate registered in physical-recovery-contract.md. First
reach it through an actual claimed and killed restricted worker. Do not replace
that physical proof with synthetic failed queue rows or silently repair its
oracle.
