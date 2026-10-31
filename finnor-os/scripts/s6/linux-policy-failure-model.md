# Ordinary Linux policy repair: failure model and E2E contract

Written before production changes. Preimage:
`df9111da8c7a1170f1f074e43fdf5984eaa55b8b`.
Scope: the two independent P1 findings, not W4/W5, installed owning proof,
protected execution, resource qualification, or permission to install anything.

## Authoring gate

- **Observable contract:** an ordinary guest cannot signal, change limits or
  scheduling of another same-UID process, redirect asynchronous I/O signals to
  it, or access System V IPC owned outside that guest. Node startup, private
  read/write, computation and worker threads must still work.
- **Credible regression:** the default-allow filter omits queued signals,
  `prlimit64` and System V IPC. A native guest reaches these syscalls even with
  the initial `--no-addons` flag: `process.execve` can restart the fixed Node.
- **Existing coverage:** `run-executor-e2e.mts` owns installed filesystem,
  network, child-creation, parent-death, wall-time and output proof. It does not
  exercise these native syscall families. Its assertions and deadlines stay
  unchanged. The absent root jail prohibits running it here.
- **Real boundary:** move policy construction, without changing its bytes,
  into a deep production module consumed by the ordinary executor and this
  runner. Emit its real filters. A native disposable child installs that exact
  cBPF through the kernel, not a mock or a static decision function.

## Named failure model

1. **PROCESS_QUEUED_SIGNAL_ESCAPE:** `rt_sigqueueinfo` or
   `rt_tgsigqueueinfo` delivers a signal to a controlled sibling. The target
   records actual SIGUSR1 delivery; it is not a real supervisor or host service.
2. **PROCESS_LIMIT_ESCAPE:** `prlimit64` lowers that sibling's
   `RLIMIT_NOFILE`. The unfiltered controller observes the actual limit.
   PID zero must retain legitimate self get/set behavior; other PIDs must not.
3. **PROCESS_CONTROL_ALIASES:** kill/tkill/tgkill/pidfd, scheduler/priority/I/O
   priority controls, process-memory controls and asynchronous signal ownership
   must not provide an alternate target-control path. Keep self-only operations
   only when the argument has an unambiguous kernel self meaning. In particular,
   do not bind a generated filter to the supervisor PID.
4. **ASYNC_SIGNAL_OWNER_ESCAPE:** fcntl F_SETOWN/F_SETOWN_EX and socket
   ownership ioctls redirect real readiness notifications to the controlled
   sibling. F_SETSIG, leases/dnotify and O_ASYNC must not reopen that path.
5. **SYSV_SHARED_MEMORY_ESCAPE:** a child obtains the ID of the controller's
   private test segment and attaches/writes a fixed sentinel. The controller
   independently reads that test-owned segment. Never enumerate, attach, read,
   change or remove unrelated host IPC.
6. **SYSV_QUEUE_OR_SEMAPHORE_ESCAPE:** message get/send/receive/control and
   semaphore get/control/op/timed-op reach only controller-created objects.
   Inspect queue count and semaphore value outside the filtered child.
7. **ABI_OR_ARGUMENT_BYPASS:** both x64 and arm64 policies compile in the
   kernel; the wrong audit ABI and x32 entry cannot reach an allowed syscall.
   Check full PID arguments, prctl parent-death protection, and existing
   clone/open restrictions. Independent architecture vectors supplement, never
   replace, the native kernel proof.
8. **POSITIVE_NODE_REGRESSION:** Node 22.22.3 starts under the real policy,
   computes 42, reads/writes private scratch, uses async crypto and worker
   threads, and exits normally. No launcher, chroot, capabilities or Landlock
   setup is invoked by the component runner.
9. **FALSE_DENIAL_OR_LEAK:** a setup failure, unrelated DAC/LSM/ENOSYS refusal,
   stale source, child timeout, wrong target or failed cleanup must never count
   as a successful regression. Keep those outcomes and the original receipts.

## Execution and evidence contract

### Threaded re-exec lifetime finding, before implementation

The original launcher sets `PR_SET_PDEATHSIG` only in the task that later
executes Node. Linux clears the setting in a newly created thread. A permitted
thread can then `execve`; replacing the thread-group leader does not restore
the original task's parent-death setting. Denying `PR_SET_PDEATHSIG` resets
does not close this path. This is an actual kernel lifetime boundary, not a
JavaScript flag or an admission claim.

The selected repair is a trusted, nonexecuting, capability-free guardian in the
already detached launch process group. It forks the guest before installing
the guest filter, remains the direct child of the original supervisor, and
kills only its verified own process group on original supervisor death. It
never loads guest code. The guest cannot change its process group or signal
the guardian under the mandatory filter. Preserve chroot, Landlock, zero
capabilities, no-new-privileges, consumed bootstrap FDs, exact stdout/stderr,
exit status and time/output cleanup. Explicitly report guardian and guest
identities in a new bootstrap schema rather than claiming they are one PID.

Extend the same native component fixture before changing the launcher. Its
unfiltered controller owns a disposable non-PID-1 supervisor and exact detached
group. A real filtered nonleader pthread execs the native fixture; retain the
actual pre-exec TID, post-exec PID and kernel parent-death signal of zero. Kill
only the original owned supervisor. Compare the original single-task guard
mechanism with the actual production guardian function, and independently
observe whether the re-executed guest survives before the unchanged three-
second safety alarm. The controller is a subreaper for only this owned family;
retain exact cleanup and verify all its children are reaped. This is a kernel
component comparison. It does not establish full installed jail proof.

Required additional owning gate: rebuild the actual root-owned launcher and
run the existing full executor campaign against bootstrap v2, followed by the
real W owners. No privileged installation is authorized by this contract.
Those gates remain NOT_RUN on this Mac. A component pass or a source inspection
must not be relabelled as installed or Linux owning completion.

### Additional POSIX queue finding, before the follow-up repair

Linux POSIX message queues resolve names through the IPC namespace. A fixed
filesystem root and filesystem Landlock do not isolate this namespace. The
original repaired filter still permits all six native `mq_*` calls, including
unlink of another same-UID queue. This is a separate gap from System V IPC.

Extend this existing owning kernel campaign with one exclusively created,
test-owned POSIX queue. Invoke actual open, unlink, timed send/receive, notify
and attribute calls in filtered disposable children. The unfiltered controller
observes the queue's original name, message count and flags. Require exact
policy EPERM and unchanged owned state; unrelated ENOSYS, EINVAL or host setup
failure is a failed proof. Never enumerate or access other queues. Verify
cleanup against the exact queue inode before unlinking its registered name.
The original 37 cases, Node positive and all time limits remain unchanged.

Pinned UAPI references: Linux v6.12 `arch/x86/entry/syscalls/syscall_64.tbl`
(240–245) and `include/uapi/asm-generic/unistd.h` (180–185), and the namespace
resolution in `ipc/mqueue.c`. Both architecture vectors are supplemental; a
Mac run cannot qualify these kernel operations. Follow-up baseline and repaired
Linux execution are NOT_RUN locally until an actual Linux kernel is available.

Primary owner: `scripts/s6/run-linux-policy-e2e.mts` with one native support
fixture. Write this E2E and its behavioral assertions before the policy repair.
Do not duplicate the policy's deny list in the native fixture: use Linux UAPI
syscall names and actual protected operations against registered test objects.

1. Fresh worktree dependencies use the mission `run-job.py --heavy` supervisor.
2. First extract the existing generator byte-for-byte into the real deep module.
   Record the preimage source and both old emitted filters, with hashes.
3. Run the new E2E against that unchanged old policy. Required security
   assertions must fail because signals/limit changes/IPC access actually
   succeed, while positive Node behavior passes. Keep the nonzero receipt.
4. Repair only the production policy/its real caller. Reuse the same E2E,
   trigger values and role-relative inputs; fresh registered PIDs/IPC IDs are
   necessary per episode and are recorded explicitly.
5. Run the unchanged E2E again. Require EPERM and independently unchanged target
   state. Required pre/post pairs are queued signal, sibling limit change and
   shared-memory mutation, plus message/semaphore coverage. New policy refusal
   of an operation already blocked by the host is supplementary coverage, not
   a reproduced old exploit.
6. Emit both architecture programs and have the kernel verify/install each in
   a sacrificial child. This x64 host cannot establish native arm64 behavioral
   qualification. Foreign-ABI kill and independent vectors are labelled as
   such; do not imply an arm64 native run.
7. Native children have a fixed three-second alarm; controlled targets have a
   fixed five-second alarm. The component runner has a fixed 120-second bound;
   positive Node retains the existing S6 10,000 ms computation allowance.
   No baseline-to-post deadline or assertion increases.
8. Every episode retains source text and SHA256 before/after, emitted filters,
   exact Node/compiler identities, logical and resolved inputs, commands,
   expected/observed results, timings, process exits, cleanup and rerun command.
   A changed source cut invalidates that episode.
9. Only the unfiltered controller creates IPC using exclusive test-owned keys.
   Children look up only those registered objects. Cleanup removes those exact
   IDs, verifies removal, and reaps only test-owned PIDs. No global kill or IPC
   census. Child/target parent-death guards and bounded controller cleanup cover
   interruption; any cleanup failure is a failed proof.

All real E2Es, compilation/builds and typechecks run through the shared heavy
supervisor, one at a time, with a new output directory. No source/test edits
while a job in this tree runs.

## Qualification and remaining owning proof

Evidence classification:
`KERNEL_POLICY_COMPONENT_PROOF_NOT_FULL_JAIL`.
The filter-only child does not prove root/library/manifest custody, device
metadata, capability-bearing exec, zero-capability handoff, Landlock, final
descriptor closure, full-jail parent death, installed owner execution or W1/W2.
Those remain separate parent-owned gates after separately resolved installation
authority. Ordinary output remains untrusted and unadmitted; hard aggregate
CPU/memory/PID/disk limits remain unavailable.
