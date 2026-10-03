# Frozen item S6-07: original-member crash recovery

Authoring gate, before changing the owning test or implementation:

1. Observable contract: a two-member original native S1/S3/S4/S5 obligation must
   retain both responsibilities after the first accepted conditional JSON PATCH
   and actual broker/worker SIGKILL. Read-only reconciliation cannot dispatch the
   other member. A compatible subsequent real queue delivery may dispatch only
   that never-attempted member under fresh current authority and physical fences.
   No possibly attempted member is replayed; every member independently settles
   before the workflow and joined S5 consumption complete.
2. Credible breaking behavior: the existing broker gates dispatch on zero total
   ATTEMPTs, while waiting native delivery invokes only read-only reconciliation.
   The second original member is therefore stranded indefinitely. Relaxing this
   to replay all members would duplicate a consequence; ignoring cancellation,
   lease expiry or immutable request/method bindings would permit unauthorized work.
3. Missing existing coverage: the existing native crash case has one original
   member, so GET-only recovery is sufficient and cannot expose this defect.
   Extend that same authoritative `native-durable-workflow-crash` case to two
   actual upstream-issued channels of the same preregistered method. Keep the
   other existing authority/cancellation/readback challenges unchanged.
4. Test-only production seam: none. Native owners create the original references,
   effect and obligation. The local TLS fixture owns the external records; it
   SIGKILLs the actual candidate broker and queue worker only after receiving
   the first real PATCH. Ordinary test support may prepare independent generated
   measurements for the second channel, but cannot supply protected receipts,
   settlement or native admission results.

Failure cases under the existing crash/ambiguity, resource-conservation and
version/fence families: partial dispatch, a stale/cancelled physical claim, lost
response, wrong-record/null readback, duplicated recovery and history reset.
Independent oracle: exactly one PATCH per original record, concrete field value
0.15 for each, actual process signals/reaping, original immutable effect/request
and held resource envelope, all-member protected observations/verification,
fresh signed authority and actual job-lease validity before the second PATCH.
The original first member's ATTEMPT and receipt cannot be replaced on restart.

Bounds stay unchanged: at most 64 original members/attempts, 64 durable protected
observations, 30-second broker operation, 5-second maximum authority witness,
existing real queue retry due time and original S5 liabilities. This case uses
two records of the same conditional JSON method, not a new provider/operation.
No economic, production isolation, live-provider or human-release claim follows.

Run the existing native owner runner before the implementation repair, retain
the intended failure, then rerun after the repair with identical external oracles.
Do not edit relevant source/tests while either runner is active. Every run retains
exact source/runtime versions, original inputs, provider transcript/readback,
native claims/deliveries, signals, protected history, liabilities and rerun command.

Retained baseline `member-recovery-baseline`: 11/12 pass, terminal exit 1 and
source freeze. The actual two-member crash retains one PATCH and refuses to
dispatch the untouched member on later queue delivery (independent oracle 1 vs 2).
Eight relevant original source/support files are retained with matching hashes.

Retained first repair `member-recovery-repaired`: 10/12 pass, terminal exit 1,
source freeze. Ordinary native recovery refuses `jobClaimFence` because the
PostgreSQL bigint arrives as a string while the strict public schema requires a
safe positive number. Normalize this actual queue value at the trusted worker
boundary; keep the public schema strict. The later crash case also fails the
sweeper idle assertion (`worked:true`), so that run does not qualify member crash
recovery. A fresh full rerun is required after repairing the concrete fence type.
The termination census found the driver already terminal; no process was killed
or reported as interrupted.

Retained fence-normalized run `member-recovery-fence-qualified`: 11/12 pass,
terminal exit 1, source freeze. The real current recovery job reaches the owner
assessment but is refused for `S5_CURRENT_RESERVATION_CONSUMPTION_FENCE_CHANGED`.
The exact S5 UNKNOWN notification increments the original reservation revision;
the native checker currently rejects this required accounting transition. Repair
must preserve S5 ownership: authenticate this obligation's protected attempt and
the S5-recorded before/after reservation position/envelopes, require exactly that
single retained-liability revision, and reject any other revision/revocation,
changed envelope, settled consumption or foreign proof. Older history without
the new explicit revision evidence cannot silently qualify continuation.
