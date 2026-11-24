---
name: verify-work-recovery
description: Model-check the Work recovery claim (POST /api/works/:id/retry) with TLA+. Use when a change touches claimWorkRecovery, beginWorkPlannerAttemptTx, transitionWork, handoffWork, WORK_RECOVERY_CLAIM_TTL_MS or the retry route, or when a retry, lease or ownership bug is reported.
---

# Verify the Work recovery claim

`finnor-os/verification/work-recovery/WorkRecovery.tla` models one failed Work, three retry requests from two employees, ownership handoffs and the recovery lease expiring while a request is still busy. TLC checks every interleaving of those steps.

## What it proves

- **SinglePlanner.** At most one request plans a Work at a time. Two planners plan the same instruction twice and can propose or run the same business actions twice.
- **OwnerOnly.** A recovery starts only for the employee who owns the Work at the moment the claim commits.

Both hold for the current code with up to two handoffs and any lease expiry. The model does not cover objectives (`controlObjective`), economic replays in the retry route, worker jobs or more than one Work. A request whose lease was taken over can still write the "understanding" status before the planner fence refuses it. That write is outside the model and is an open gap.

## Run it

From `finnor-os`:

```sh
node verification/work-recovery/check.mjs
npx vitest run tests/integration/work-kernel.test.ts -t "recovery"
```

The first command needs Java 11 or later. It downloads tla2tools 1.7.4 once and checks its SHA-256. Set `JAVA` or `TLA2TOOLS_JAR` to use local copies. CI runs the same command in "Correctness - Financial and authorization regressions". The second command checks the same two properties against the real code on PostgreSQL.

`check.mjs` expects `current` to pass and four variants to fail: `before_planner_fence`, `pre_082260a2` and `pre_17034c60` replay real past bugs, and `unlocked_owner_check` moves the owner check out of the locked claim. An `ok` line for a variant means it still fails the way the old code did.

## Read a result

Read every counterexample and every passing state graph with the `/statechart` skill. A counterexample is a sequence of the steps below, and each step is one transaction or one unlocked read in the code.

| Model step | Code |
|---|---|
| `Precheck` | the unlocked `workAggregate` owner read in `apps/api/app/api/works/[id]/retry/route.ts` |
| `Claim` | `claimWorkRecovery` in `packages/db/index.ts`, under `FOR NO KEY UPDATE` |
| `ReadStatus`, `WriteRecovery` | the pre-082260a2 route, which read the status and then called `transitionWork` |
| `Understand` | `transitionWork(..., "understanding")` in `handleInstructionResult`, `packages/orchestration/src/index.ts` |
| `BeginPlanner` | `beginWorkPlannerAttemptTx` in `packages/db/index.ts`, including the `retry:` lease fence |
| `Finish` | the planner's end, when the Work leaves planning |
| `Handoff` | `handoffWork` |
| `LeaseExpires` | `WORK_RECOVERY_CLAIM_TTL_MS` passing while the request is still in `assembleOperatingContext` |

If `current` fails, compare its counterexample with the code. A trace the code can take is a real bug: report it with the trace in these step names and keep the property. A trace the code cannot take means the model is wrong: fix the step that does not match the code.

## Keep it in step with the code

The model last matched the code at main `2070ded091` plus the planner fence added with this skill. When a change touches a file in the table, update the matching step in the same change, run both commands, and move this commit forward only after you have read the code at the new commit and confirmed that every step still describes it.
