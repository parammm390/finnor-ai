# Temporal fixture construction

This is an authored historical fixture for Golden Flow 7. It is not production history.
The original certification database and its earlier proofs must remain unchanged.

Before implementing the isolated fixture, the failure cases are:

- Targeting the original database or a remote database. Verify both the localhost URL and PostgreSQL's actual data directory against the named clone and its source marker before writing.
- Copying a running database. Stop PostgreSQL cleanly before copying the persisted fixture.
- Inconsistent input or result hashes after changing the fixture's clock. Reseal each affected immutable snapshot/result with the canonical hashing functions; never change financial inputs or outputs.
- Invalid history hashes. Recompute each authored snapshot hash with the database's exact JSONB representation.
- Accidentally moving forecast periods, credential expiration, or business deadlines. Move only recorded/observed/created timestamps and the explicit underwriting world cutoff.
- Claiming a historical baseline from missing ledger coverage. Verify the coverage start is before the requested baseline and assert complete coverage in the E2E proof.
- Fabricating evidence-to-model causality. Create current changes through canonical APIs, compare selected bases, and retain the explicit missing causal edge.
- Leaving trigger bypass active. Scope fixture construction to one transaction, restore replication mode, and close the admin connection before starting the product processes.

The test must record baseline/current recommendation identities, exact Run hashes and deltas, declared source links, Thread reload, and a repeatable fixture construction command.
