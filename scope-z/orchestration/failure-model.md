# Coordination failure model, before controller implementation

This is the engineering delivery coordinator, not FINNOR's S4/S5/S6/S8 runtime, an authority ledger, or an acceptance oracle.

## Observable contract

Exactly six phase identities exist, Z0–Z5. After a common PRD/contract lock, the initial launch group is exactly Z0, Z1, Z2. At most three phase implementation slots may be active. A lightweight immutable handoff check frees a slot and requests Z3, then Z4, then Z5 immediately. Independent scrutiny, protected qualification, production admission, and mature financial evaluation never hold that scheduling gate. They also cannot be inferred from it.

Every dedicated execution requires its own actually provisioned Computer and actual session receipt. A staged creation card, launch intent, research session, local fallback session, silent/default model, or unobserved process is not a dedicated execution receipt. All execution and checking model roles must use `gpt-6.1-sol`, reasoning `max`.

## Credible failures and required rejection

1. Premature launch: PRD/contracts are drafts, missing, or hash-mismatched. Reject every phase launch.
2. False source lock: a file changes after sealing or an attached source copy is substituted. Reject that snapshot; retain its failed verification. Never silently reseal at launch.
3. Wrong group/order: Z3 starts before the initial group or Z5 skips Z4. Reject the requested transition.
4. Overbooking: concurrent handoffs race, one slot is reused twice, or a fourth implementation lane starts. Make state changes atomic and idempotent; never infer capacity from deep certification completion.
5. Fake Computer/session: UI staging, a null ID, repeated Computer IDs, a shared research Computer, or a local worktree is substituted for six dedicated provisioned Computers. Keep launch blocked or explicitly local-only; do not count it as mandatory dedicated execution.
6. Wrong model: a missing/default/alternate orchestrator, worker, validator, or subagent model/reasoning field. Refuse launch/receipt and do not silently fall back.
7. Lost launch acknowledgement: a remote request may have succeeded without a response. Retain LAUNCH_UNKNOWN and reconcile the SAME request/session identity; do not issue a blind new creation.
8. Stale/duplicate completion: a prior head, wrong phase, wrong contract digest, replayed event, or later untested product cut arrives. Reject the mismatch or return the prior idempotent result.
9. Ownership collision: a phase modifies a peer prefix, shared migration, global client/manifest/lock, enforcement, or checker outside its locked ownership. Preserve work and route an exact integration request; do not overwrite or merge it to free a slot.
10. Missing handoff: source/base/tree, changed-file manifest, interface version, verification dispositions, original failures, costs/gaps, obligations, or reconstruction inputs are absent. Do not accept scheduling handoff.
11. Certification confusion: scheduling readiness is presented as code completion, protected qualification, S8 admission, activation, or 100×. Maintain separate statuses and exact evidence classes.
12. Dead lane: an exited/interrupted process is called active, or a blocked implementation is called complete. Record the real state, report any underfilled slots, retain incomplete engineering and repair ownership.
13. Parent reset: retries, new chats, fallback, or certification reset the original reservation/deadline/effect identity. Reject the reset; carry forward remaining budget and unresolved S6 references.
14. Unreceived peer context: one chat is claimed to have read another's changes merely because a file exists here. Bind each delivery to artifact hashes and an actual receiver acknowledgement or leave NOT_DELIVERED.
15. Non-reconstructible handoff: unpublished local Git objects, hidden alternates, donor dependencies, or a missing source bundle are required. Keep installed/reconstruction proof incomplete.
16. Secret or protected truth leakage: context bundles include credentials, private inputs, future hidden cases, or unrequested customer material. Exclude the material and block its transfer; retain safe gap references.
17. External write overreach: automation provisions Computers, pushes, opens PRs, merges, deploys, changes grants/signers, contacts people, or creates financial effects without exact current authorization. No such default adapter is permitted.
18. Corrupt control state: malformed JSON, symlink/out-of-workspace path, interrupted write, or simultaneous updates corrupt state. Fail closed, preserve prior records, use atomic replacement and exclusive locking for task-owned control files.

## Finite pre-implementation verification contract

A subprocess-driven controller E2E must retain inputs, invocation, exit status, structured output, state before/after, and reproducible rerun instructions for:
- draft/hash-mismatch rejection;
- exact initial group and three-slot cap;
- ordered immediate refill without waiting for certification;
- duplicate-event idempotence;
- missing/wrong model and duplicate Computer rejection;
- wrong-cut/ownership/handoff rejection;
- staged/not-received versus actually running separation;
- interruption/UNKNOWN without false completion;
- independent certification status not changing scheduling order;
- atomic conflicting updates.

The E2E uses disposable task-owned control fixtures, not fake FINNOR business evidence or fake remote execution. Success qualifies only the controller's local transition behavior. Live remote launch remains NOT_RUN until real Computer/API/session receipts exist. No post-code unit tests are to be added.
