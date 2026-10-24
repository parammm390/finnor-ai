# Native worker custody, before final driver edits

Actual canonical queue source selects `FINNOR_WORKER_INSTANCE_ID`, otherwise
`worker:<hostname>:<pid>`, and defaults to a 300-second lease. The earlier
driver's `FINNOR_WORKER_ID` is not that flag, and its finite 120-second recovery
wait cannot reclaim a default 300-second lease. This is an internal driver
configuration gap, not native success or an excuse to renew business deadlines.

Before native execution, require the separately authorized target to already
have a declared 30-to-60-second `worker.leaseSeconds`, verify that exact actual
worker environment value, and restart with that same queue lease. Verify the
actual Node binary, canonical entry operand, non-bypass environment and exact
native DB configuration without recording credential values. Use the canonical
worker-instance flag, not an invented alias.

An actual physical cut must bind the owned process to the original running
job's `lease_owner`/token/fence. Persistent `job_delivery_attempts` must witness
the same job's higher-fence delivery by the actual replacement worker, even if
the job finishes before a later read. A matching unrelated claim or killing an
idle unrelated process cannot pass. Inspect only that owned worker's actual
descendants; refuse detached producer groups rather than leave an un-killed
physical producer and claim complete termination. Retain process identities
and the actual killed claim. The provided noncascading independent worker
remains a prerequisite.

This changes only the guarded replay driver. It does not configure, start,
stop, migrate, seed, grant or authenticate any target now. No new business
deadline, allocation, authority or allowance is created. Real native execution
and all three physical cuts remain NOT_RUN.
