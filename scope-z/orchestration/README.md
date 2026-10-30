# Project Z execution coordination

This directory coordinates engineering delivery. It is **not** FINNOR's planner,
admission service, effect broker, allocation store or financial oracle.

## Locks and actual roles

- Requirements: `scope-z/FINNOR-Z-PRD.md`, 973 lines.
- Product lock: `scope-z/locks/product-lock.json`, SHA-256
  `61d9881ca8059d24d057d1e00d5436ef2059de7889ccd1fd2f92a630075bcebf`.
- Prompt author: existing distinct session
  `ec89fb12-9c02-40b9-b383-8952b27b8ed1`, continued by the supported CLI with
  `prompt-engineering.authoring.seed.md`. That research/authoring session is not a
  Z execution phase or a dedicated phase Computer.
- Final prompt/seed identities belong to the separately sealed execution pack.
  An execution-pack digest cannot be embedded in one of its own members.
- Six named Computer creation proposals are staged, not provisioning receipts.

Only `gpt-6.1-sol` / `max` is allowed in every model role. See
`gpt61-max-settings.json`; actual model/session/Computer observations remain
required. API documentation and requested flags are not runtime attestations.

## Controller

`control.py` is a Python-standard-library, POSIX local receipt controller. It
does not call a network API, provision, launch a session, deliver a prompt, send
messages, push, merge, activate a capability or produce an effect.

It implements:

- immutable product/complete-execution-pack member verification;
- one Z0/Z1/Z2 initial **launch-intent group**, not three invented running phases;
- at most three reserved implementation slots;
- real-start receipt validation, including distinct dedicated ready Computers,
  session bindings, every model role and acknowledged full-seed identity;
- strictly ordered immediate refill intents Z3, Z4, Z5 on a complete lightweight
  engineering handoff, independent of deep certification;
- interruption, same-parent continuation and lost-launch-acknowledgement states;
- idempotent event IDs, ownership/source-cut checks and original-parent budgets;
- revalidation of accepted evidence bytes, including idempotent calls;
- exclusive update locking, bounded atomic state and retained immutable snapshots;
- fail-closed interruption and exact pending-snapshot recovery.

The controller checks **custody and consistency of supplied observations**, not
their truth. It cannot authenticate Factory's service or an arbitrary producer's
assertion. The coordinator must obtain actual observed service/runtime receipts.
Do not fabricate one to satisfy the schema. Independent source/runtime scrutiny
and native protected authority remain separate.

Live start observations must be timezone-qualified and at most five minutes
old. Status output counts only fresh last-observed running lanes, explicitly
not a live platform probe; stale lanes keep their reservations and require
reconciliation. An absent or interrupted lane never becomes complete to fill a
slot.

## Commands

Every command takes absolute `--root` and `--state` paths. The selected state
directory must be task-owned inside that root. The controller pins the product
trust anchor above. First non-fixture initialization also requires
`--execution-pack-digest` with the actual independently reviewed manifest digest.
Subsequent state binds that same immutable digest.

Available commands:

| Command | Effect |
|---|---|
| `verify` | Check sealed product/execution-pack bytes only |
| `init` | Create a local PLANNED state, no remote request or launch |
| `request-initial --event-id` | Record one initial launch-intent group |
| `start --event-id --receipt` | Record an actually observed running requested lane |
| `launch-unknown --event-id --phase --reason` | Keep the same reserved intent after lost acknowledgement |
| `interrupt --event-id --phase --reason` | Record non-running unfinished work, without freeing completion capacity |
| `resume --event-id --receipt` | Reconcile the same Computer/continuation/original parent |
| `handoff --event-id --receipt` | Check lightweight complete engineering handoff and request the next ordered refill |
| `certify --event-id --receipt` | Record separate independent gate observations, never release a slot |
| `status` | Report last-observed scheduling state and explicit shortfall |
| `recover` | Adopt only the exact single immutable pending successor after an interrupted pointer write |

Receipt fields are defined by `contracts/common-contracts.json` and checked by
the command implementation. Every receipt includes product/execution digests,
explicit `synthetic: false` for live facts, original identity and referenced
evidence bytes/classes. Start receipts include actual source/Computer/session/
model/delivery observations and original-parent resources. Handoffs include
the full required manifest, seven passed internal-software check families,
retained failures, reconstruction, costs/gaps and outstanding obligations.

No live example contains a made-up Computer/session ID or invented PASS.
Simulation fixtures are permanently marked and cannot initialize a live run.
Missing actual source transport or remote session capability is NOT_DELIVERED/
BLOCKED, not an excuse to call local fallback a dedicated execution.

Do not blindly retry a session-creation request after a lost acknowledgement.
Reconcile the original intent/session; the controller itself never performs
that external request.

## Repeatable controller E2E

From any directory:

```sh
python3 /home/factory-user/repos/finnor-z-coordinator/scope-z/orchestration/e2e_controller.py
```

The failure model and subprocess driver were written before controller code.
The initial run failed because the implementation did not exist; that report
is retained. Later checks cover 37 complete subprocess scenarios, including
concurrent handoffs, byte substitution, explicit fixture/live separation and a
real process exit between immutable-snapshot and current-pointer writes.

Every run creates a new task-owned evidence directory with exact inputs,
invocations, exit codes, observed state hashes, source/driver hashes and rerun
instructions. Nothing is deleted to hide a failure.

These are **local deterministic engineering-control tests using SIMULATED
platform facts**. They do not show provisioned Computers, real remote sessions,
FINNOR owner flow, protected admission or business throughput.

## Source delivery and phase refill

1. Verify product and complete execution-pack bytes.
2. Observe the actually provisioned dedicated Computers. Renderer-owned creation
   cards must be applied; no shell/API provisioning bypass.
3. Deliver the full source/seed pack and an immutable launch snapshot. Confirm
   actual receipt/read acknowledgement; source existing only here is not delivery.
4. Submit the Z0/Z1/Z2 session requests concurrently through a supported
   authorized platform surface. Record partial failure/UNKNOWN honestly.
5. Record actual start facts. If three do not run, report the precise underfill.
6. On a complete lightweight handoff, request the next queued phase immediately;
   do not wait for protected or programme-wide certification.
7. Keep independent scrutiny, user testing, admission, 100× and S7 qualification
   in separate receipt streams. Their statuses never imply scheduling or effects.

The CLI accepts `--file` and `--session-id`; continuation **cannot** combine
`--session-id` with `--spec-model`/`--use-spec`. Native mission mode requires
`--auto high` and explicit main/worker/validator model/max flags, whereas an
ordinary session is not a native mission. Do not use unsafe permission bypass.

The two historical message POST attempts returned HTTP 400. Their delivery is
NOT_CONFIRMED. A CLI continuation is a different actual delivery path and must
have its own receipt.

## Complete cold-role context and execution seal

`roles/coordinator.role.md` and `roles/prompt-engineer.role.md` are complete
own-role directives. Their assembled `.seed.md` counterparts retain the whole
Z0 reference seed, all six concrete bodies, controller instructions and the
native-query source clarification. They are not delivered chats or phase starts.
The prompt pack separately retains full X/Y/Y2/Y3 and selected actual sources.

The coordinator's `build_execution_pack.py` deterministically constructs those
two role seeds and `scope-z/locks/execution-pack.json`, after verifying the exact
reviewed prompt index/receipt and every member. It never modifies recognized
or unrecognized differing files, calls a service, or initializes live state.
`--check` verifies the same complete bytes without writes. The manifest
does not hash itself; the external seal receipt records its final digest.
Run the actual controller `verify` against that digest before any live init.

This first local seal retains the dated platform absence observation, Node 22
development preflight, original controller failure and complete replay archive.
Actual readiness and source changes still require new immutable per-launch
snapshots. Do not edit old seeds or promote historical absence to current health.
