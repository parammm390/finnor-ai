# Preregistered production-registration development proof

This extends local proof coverage, not product authority or protected admission.
It does not replace or weaken the original X3/X4/X5 campaigns.

## Real gap and selected approach

Existing X3/X5/X4 proof workers register selected native handlers themselves.
`apps/worker/src/index.ts:createWorker()` is the actual production registration
factory. Its executable-main secret/scheduler/heartbeat/image path is distinct
and remains outside this local proof.

Use an explicitly opt-in proof-harness mode in the existing X5 and X4 IPC
workers. In that mode, dynamically import and call `createWorker()`; do not
register replacement handlers or select a restricted handler subset. Preserve
the old paths as defaults for the already registered fault/recovery proofs.
This is a test-harness choice, not a production-only testing seam.

Use ordinary constructor defaults: an unconfigured 300-second lease and the
same ordinary disposable worker database role. Record the effective factory,
lease, class, worker identity, PID and actual tick results in retained worker
receipts. Actual durable business deliveries establish the exercised types.
Do not expose private queue state or add a production accessor solely for this.

The environment contains a genuine old global `release_probe`. Account for it
through a normal factory tick before queuing the scientific assignment. Never
delete, retime, mark complete, or filter it out. X5 application installation
already polls up to eight ordinary ticks, so it naturally accounts for earlier
registered jobs. No extra retry count, startup deadline or tick deadline is
introduced.

## Failure model

- Missing factory registration leaves a genuinely queued business job unfinished.
- A wrong database role, tenant fence, Work input or lease must fail the real
  owner path, not be repaired by direct business-state writes.
- Slow factory startup or a lost IPC request must fail the existing startup/
  45-second tick deadline. Do not widen it for the new imports.
- Other registered jobs may be claimed. Retain their effects/receipts and
  investigate unexpected mutations; do not restrict the factory to make the
  oracle pass.
- A reported worker error must not become a successful tick.
- A crash must retain the original physical lease/recovery behavior. Run the
  original fault/resource cases in their default proof mode with their original
  explicit lease settings.
- X5's evaluator still forbids dispatched effects and external operations in
  its non-effectful domain. Do not weaken that oracle to combine X4 into it.
- A small native smoke proof is not the full X5 evaluation or S8 admission.

## Actual proof and original floors

Run the existing full X5 census through the factory mode: eight independently
accepted native source records, physical parameter training, poisoned-experience
rejection, fresh X3 reconciliation and separate-principal approval, 32 scenarios,
four arms, 128 outcomes, 152 physical uses, original delayed-observation controls,
retention and signed learned-policy lifecycle. Preserve the original independent
numerical reproduction.

Run full X4 separately through factory mode: actual experiments, original
instrument/checker, fresh-instance replication, immutable model, physical
decision use, invalidation and original signed S8 checks. This remains scoped
test reconciliation, not financial/business completion.

Both modes keep original limits, oracles, timeouts, identifiers and counters.
Keep separate fresh attempt directories. A mode may be reported only if its
actual worker receipts and durable deliveries establish it.

## Discovered retained-job accounting boundary

The first factory run completed X4's business checks and also correctly rejected
the retained migration `release_probe`: its original payload is `{}`, so it
cannot bind any release commit. The local worker also has no traceable deployed
release identity. Preserve that original run and its logged refusal.

Before adding accounting code, require a read-only observation of the exact
original job after factory consumption. Its identity/type/payload/protocol must
remain unchanged, it must have one failed attempt, and its error must come from
the real release-identity/probe check, not an unrelated failure. Retain this as
an expected refusal with `releaseQualified:false`. Do not fabricate a release
identity, edit the old payload or call this full service-bootstrap validation.
This additional observer follows a disclosed development finding; it is not
retroactively preregistered protected evidence or a changed business oracle.

The second attempt exposed an observer error: the native queue's terminal state
at its original one-attempt ceiling is `dead_letter`, not `failed`. Its retained
error is a stack, not only a message. Correct the new observer to the existing
queue contract (including `max_attempts=1` and the exact release-check first
line), preserve that failed attempt, and leave the native queue and all original
business/evaluation oracles unchanged.

## Discovered X5 claim-order boundary

The current-cut3 X5 native attempt failed before training because the original
global probe was still queued. Its real factory ticks completed the interactive
application BUILD and INSTALL jobs first. Installation then stopped polling
because its original installed-status oracle had passed. The earlier expectation
that up to eight installation ticks necessarily consumed the old batch probe
was wrong. The failed run and stopped-database receipt are retained.

Before changing the harness, require the same explicit pre-intake ordinary tick
already used by X4: call the actual factory once while only the retained probe
is queued, then run the unchanged read-only refusal observer, then submit the
native X3 application. Do not inspect the queue to select a job, change native
priority/lane/order, alter timestamps/payloads/identities, add retries, or widen
the original tick/campaign deadlines. Keep the original installation loop and
all four-arm, cost, acceptance and numerical oracles unchanged. This is a
disclosed development-harness correction, not protected preregistration.
