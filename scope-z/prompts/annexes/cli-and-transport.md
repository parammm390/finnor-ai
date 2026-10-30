# Real CLI and context-delivery boundary

This document supplies reconstruction constraints, not runnable phase-launch
commands. The authoring chat must not start a session or create a Computer.
The installed observed CLI is Droid 0.249.0. Read its actual `droid exec --help`
again on the destination if the version changes.

## Supported and prohibited combinations

Ordinary `droid exec` and native `--mission` orchestration are different
execution modes. Native mission worker/validator flags exist in the observed
help. Do not describe an ordinary invocation as a managed multi-worker mission.
The CLI supports file input, cwd, settings, model and reasoning flags.
It requires --auto high for mission execution; never substitute a permissions
bypass or assume the current task grants it.

A continuation with --session-id requires an actual known session and a
nonempty prompt. **--session-id cannot combine with --spec-model or --use-spec.**
Do not invent session IDs, send empty continuations, rely on inherited model
routing or combine incompatible flags. Continuation still explicitly pins
the main model gpt-6.1-sol, reasoning max and sealed settings. Spec-mode
arguments are absent from continuation.

If a future authorized controller uses native missions, it explicitly pins
main/orchestrator, worker and validator models to gpt-6.1-sol/max and leaves
skipScrutiny=false and skipUserTesting=false. The sealed settings also pin
light/medium/heavy subagent tiers; that does not authorize launching one.
Actual runtime/model receipts, not just requested flags, are mandatory.
The prompt engineer does not implement, launch or change that controller.

## Deliverable bytes versus transport evidence

Each `delivery/zN.manifest.json` lists the selected seed and every companion
file, exact bytes/digests, mandatory read order, source identity and required
earlier seed dependencies. It starts at NOT_DELIVERED and NONE_OBSERVED.
No session, Computer or API message acknowledgement is invented.

On an actually provisioned dedicated Computer the coordinator transfers the
whole pack, verifies its externally sealed index/receipt hashes, selects its
own seed, checks the delivery inventory and obtains a real receiver read
receipt. Transfer all mandatory companions, not just README or a local link.
For a genuinely isolated destination the original product-lock files and
source checkout must also be present at their canonical repository paths.
Copying the pack alone cannot make a checkout or source identity exist.

The receiver reads the inline seed payloads fully and then every mandatory
companion in the declared order. Record file hashes, complete ranges and real
read acknowledgements; truncation or a pointer is not reading. The complete
Z0 seed embedded in Z1–Z5 is earlier context, not a scheduled Z0 execution.
No peer handoff is presumed. Later actual handoffs go into a new immutable
launch-context snapshot with receipt and admissibility, not into old seeds.

Delivery states are REQUESTED, DELIVERED_WITH_RECEIPT, ACKNOWLEDGED_READ,
NOT_DELIVERED and DELIVERY_UNKNOWN. Read-only source/session metadata cannot
prove message delivery. Historical failed message attempts remain
NOT_CONFIRMED. Six renderer-owned Computer proposals still require apply;
do not bypass them by APIs or shell provisioning.

## Sealing request

The prompt pack's authoring payload digest covers indexed source and generated
artifacts without a self-hash. The receipt separately hashes the index. The
coordinator must create its own execution-pack lock binding final receipt and
index digests together with controller/role/reconstruction instructions,
then a per-launch current source and actual-received-peer snapshot.
This authoring receipt is not that lock, a launch, or a qualification receipt.
