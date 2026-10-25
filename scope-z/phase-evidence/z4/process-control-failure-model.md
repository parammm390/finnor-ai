# Process-control and lineage correction, before implementation

The native Python supervisor starts a separate process group. Killing only
the replay Node child's group can leave an active prover alive on timeout,
parent loss or an unexpected child exit. A reused PID must never let cleanup
kill another lane. Buffered logs must drain before an exit receipt is final.

Add a concrete, local IPC lifecycle binding. Before sending native input, the
producer reports the actual supervisor PID, parent PID and Linux start ticks.
The controller independently reads `/proc`, records that exact group and
acknowledges it. Only then may computation begin. Record closure separately.
Cleanup checks start ticks before signalling recorded native groups as well
as the owned Node group. IPC parent loss stops active native groups. A missing
or mismatched acknowledgement fails closed, without accepting a proof.

The offline executable E2E will use real owned processes and a public literal
integer request. It will wait for a real Rust child, physically kill the Node
and recorded native groups, retain actual exit and identity observations and
refuse an altered start-tick identity. This is process equipment only, not a
fake Work, permission grant, DB/Auth replay or native qualification.

Separately, refreshing owned files currently leaves the installed lineage's
owned digest stale. Rebinding must compare the complete owned path sets,
preserve the independently rebuilt native identity, verify its binary/source,
and update both actual source digests. It must not borrow a parent Git tree.

Native negative coverage must explicitly require tenant, private-use,
authority, currentness, budget, cancellation, unsupported and incomplete
cases. Cross-tenant and authority cases need genuinely distinct authenticated
actors, not a relabelled owner response. No fixture or grant is authored here.

The locked delivery interruption is before acknowledgement, not merely after
it. Persist the independently reread native result and both native guard acks
before an `OWNER_RESULT` barrier. Recovery may acknowledge only that same saved
result/use ID after fresh checks; an unresolved delivery without a known result
must stay UNKNOWN and must not silently start a replacement native use.
An owned replay child must also exit on parent-channel loss before work starts.

The ordinary queue worker must not depend on the replay controller for cleanup.
Extend the physical E2E first: start real proving without the IPC observer,
independently record the supervisor/Rust identities, kill only the Node worker
and require both native processes to stop. On failure, the controller cleans
only those recorded groups and retains the original failure.

Bind both native generations to their actual Linux parents before execution.
A parent lost before guard installation must fail closed. Preserve the existing
supervisor, limits and meters; the lifecycle guard is part of the hashed Node
runtime source, not a different cryptographic relation or a new Rust build.
Also reject any newly observed delivery in the initial delivery transaction.
A concurrent ACK or UNKNOWN must never be replaced after an earlier empty read.
