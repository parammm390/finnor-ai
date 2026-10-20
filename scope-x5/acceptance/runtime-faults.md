# Installed runtime fault registration

These are separate diagnostic Works, not extra independent business assignments.
Every Work keeps its original deadline, attempt, use and retained-storage limits.
Use ordinary authenticated APIs, native approvals, PostgreSQL and actual queue
claims. No status, checkpoint, counter, delivery, lease or outcome is seeded.

The `faults` diagnostic uses the ordinary supported
`WORKER_JOB_LEASE_SECONDS=30`, at the production minimum rather than a
one-second fixture lease. The scored campaign retains the ordinary default.
The 30-second child, 45-second tick and original Work bounds do not change.
Each driver invocation is bounded to 900 seconds.

1. Identify the real fixed core child only beneath the task-owned worker PID.
   SIGKILL during training must leave no published release/head and retain the
   consumed attempt/failure. Retry under the same Work must consume attempt two,
   with the exact original deadline.
2. SIGSTOP a real training child. The physical supervisor must enforce its
   original 30-second wall limit, kill it and publish no partial checkpoint.
3. Cancel a separate Work while its real child is alive. The child must exit or
   be fenced, no new release may survive, and cancellation does not reset meters.
4. Revoke a separate real training consent while training is physically alive.
   Publication must fail even if the bounded computation finishes.
5. Hold the actual post-child training-metrics transaction, kill only its
   owning worker, and observe rollback. Wait for the real queue/compute leases
   to expire, restart the ordinary worker and recover through its normal claim
   loop. The old delivery must be lease-lost and the successor must use a larger
   claim fence without resetting attempt/deadline.
6. Interrupt an actual evaluation-completion transaction the same way. No
   partial COMPLETE result survives; normal expired-lease recovery completes a
   new delivery and retains the earlier failure.
7. A durable WAIT pins its exact release/checkpoint across worker restart and
   a genuine retraining on one extra independently approved E09 lineage. Exact
   replay returns the old use/result, or explicitly refuses it, never swaps
   parameters. Compatible rollback selects the earlier immutable release.
   Correcting a source shared by both revisions makes both unusable.

The SQL triggers only wait at actual owner event insertion; they never create
events or change a result. Always unlock/drop them and stop only owned
processes, including on failure. Missing CPU, money or earlier interrupted
physical cost remains UNKNOWN. This registration does not assert that the
faults have executed or that an OS sandbox/aggregate memory limit exists.

## Separate `resources` diagnostic

Before its implementation, register these literal resource assertions:

- Two distinct original Works contend through two actual ordinary workers for
  the unchanged `native:x5-learning` capacity of one. Pause only the first
  Work's actual training child, outside every database transaction. The second must be durably
  `capacity_deferred`, have no child/training attempt, and retain its original
  deadline. Release, wait for its actual `run_at`, then both may complete
  sequentially under distinct lease fences.
- A separate Work starts with a 10,000 ms original allocation, two attempts and
  four uses. It must really train before expiry; after the actual clock crosses
  its original deadline, a fresh otherwise valid execute cannot mutate the
  native record. Retry, retrain or another handle for the same Work cannot
  renew it. Cancellation may stop it but never reset its counters.
- A separate 3,600,000 ms / eight-attempt / 256-use Work retains genuinely large
  native results: 128 exact one-minor entries and an 8,000-character memo, all
  through ordinary API/native reconciliation. Use two separately installed,
  budgeted compatible native destination applications in fixed round-robin
  order, while retaining one X5 compilation/Work/allocation. Repeat only up to the original
  256-use bound. The actual 16 MiB PostgreSQL storage constraint must eventually
  refuse a result; that native reconciliation and use completion must roll
  back atomically. Audit must retain the spent uses/attempt/deadline, a finite
  counter no larger than 16 MiB, and the failed physical delivery. A cancellation
  must withhold the capsule without reducing the existing meters.

These smaller diagnostic allocations and large inputs do not change the
scored original allocation, oracle amounts, observation schedule or decisions.

### Contention-fixture chronology

`resources-1` failed at its eight-second competing-process bound while a real
post-child SQL transaction was held. It did not establish capacity deferral.
`resources-2` is a mechanical pilot using SIGSTOP of the actual first child and
an IPC ordinary queue worker, without an open held SQL transaction. That
mechanical change was recorded here after its launch, so this pilot alone
cannot earn the final resource-proof gate. A subsequent fresh `resources-3`
run must repeat these registered assertions unchanged. The child still has
its original 30-second wall limit, the main tick remains 45 seconds, competing
tick eight seconds, and the driver 900 seconds. No capacity, time, event or
counter is seeded, extended or reset.

The `resources-2` pilot stopped at the upstream native application's own
`APPLICATION_STORAGE_BOUND` during record creation, after 42 completed uses and
9,519,872 X5 bytes. That is not X5 storage-exhaustion evidence. Before
`resources-3`, register two native destinations, installed before the storage
loop, in round-robin order so neither native owner quota masks the intended
X5 constraint. Record both native Works and costs as additional diagnostic
resources. They do not replace, extend or reset the single X5 original
allocation. The final failure must name the real
`x5_compilations_data_bytes_check`, not merely any upstream failure.
