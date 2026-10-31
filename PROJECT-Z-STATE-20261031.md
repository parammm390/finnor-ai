# Project Z: where things stand

As of 2026-10-31, about 01:45 UTC. Written by the coordinating Droid session while the owner's usage was running out.

**Read this first: nothing is accepted.** 0 of 6 phases (Z0 to Z5) pass an independent, authenticated end-to-end check on the final code. Do not treat any branch below as finished.

## Where everything is

All branches are in GitHub repo `parammm390/finnor-ai`, prefixed `codex/zbackup-20261031-`. They were pushed as new branches only. `main` was not touched. No pull requests were opened or changed.

| Suffix | Local branch it came from | Head | What it holds |
|---|---|---|---|
| `START-HERE` | integrated branch + this note + `ops/` | new | Open this one first |
| `integrated` | `codex/project-z-integrated-20261030` | `6a18051` | Z0 to Z5 and R12 merged as of Oct 30 about 20:55 UTC. Older than the phase branches. |
| `w-z0-parent` | `w/z0-parent` | `305454a` | Z0 original-parent native scenarios, recovery boundaries, artifact builder |
| `w-z0-mounted` | `w/z0-mounted` | `8cc599e` | Z0 mounted-browser scenario |
| `w-z0-r12` | `w/z0-r12` | `7b90513` | R12 primary-diligence reader and native scenarios |
| `w-z1-native` | `w/z1-native` | `3106ad3` | Z1 native session and failure snapshot |
| `w-z2-native` | `w/z2-native` | `8f9ab05` | Z2 native session |
| `w-z3-s4` | `w/z3-s4` | `25b3e00` | Z3 S4 session |
| `w-z4-native` | `w/z4-native` | `85f2b6a` | Z4 native session |
| `w-z5-native` | `w/z5-native` | `a3f4a18` | Z5 native session |
| `w-matrix` | `w/matrix` | `f21e780` | Requirement-to-case matrix (JSON) and renderer |
| `factory-project-z0`, `-z1`, `-z3-viability`, `-z4-execution-proof` | `factory/...` | `1450833`, `d14e18a`, `8c1bd82`, `932ba42` | Earlier worker lines with commits that are not in the branches above |
| `coordinator-snapshot` | uncommitted coordinator folder | new | 63 edited files plus small new code files, saved as found. Not reviewed or tested. |

The phase branches (`w-*`) are newer than `integrated`. Re-merging them was the next planned step (`ops/project-z/local-helpers/coordinator/merge-real.sh`, then `regen-int.sh`).
Draft PRs #158 to #163 on GitHub are older and conflicting. They were not touched.

Helper scripts are under `ops/project-z/`. They assume the original machine layout (`/home/factory-user/repos/...`) and a remote test computer called `fzv`.

## What is proven

The requirement-to-case matrix is `scope-z/orchestration/integrated-20261030/requirement-case-matrix.json`.
It has 354 phase cases: 80 PASS (mostly unit-level, on older code), 253 NOT_RUN, 18 EXTERNAL, 1 FAIL, 2 INCOMPLETE.

| Phase | PASS / cases |
|---|---|
| Z0 | 2 / 65 |
| Z1 | 10 / 59 |
| Z2 | 18 / 55 |
| Z3 | 23 / 60 |
| Z4 | 4 / 58 |
| Z5 | 23 / 57 |

## Why the native runs fail

Every phase's end-to-end setup was built on assumptions about how existing X/Y components behave. Nobody checked those assumptions against the real code first. Each assumption broke at a different step, so runs fail in setup before the new Z code is fully exercised.

Latest run per phase (outputs on the test computer in `fzv-int-out/native/<name>/`):

| Phase | Run | What happened | Cause |
|---|---|---|---|
| Z0 | `w0n-native-01` | P0-01 timed out | The worker re-queues `run_x1_institution_continuation_v1` about every 60 s, so the fixture never sees "no live job". Not yet decided whether the fixture check or the owner is wrong. |
| Z0 | `w0n-native-02` | 9 PASS, 6 FAIL, 2 not creatable | 5 fail mainly with 400 `NATIVE_ORIGINAL_WORK_OWNER_REQUIRED` from `apps/api/app/api/queries/route.ts`. Not checked whether the integrated branch already carries the repair. |
| Z0-M | `w0m-native-01` | Failed before any scenario | The folder `.centropy-certification` did not exist in `fzv-w-z0m`. Create it (mode 700) and rerun under a new name. |
| Z1 | `w1-native-09` | Failed at step 13 | Private diagnostic was not exported. `w1-native-10` (with the failure snapshot) was queued. |
| Z2 | `w2-native-02` | Assertion at `z2-session.mjs:240`, case n3 | Expected `UNSUPPORTED`, got `CHECKED`. Not yet known whether the test or the product is wrong. |
| Z3 | `w3-z3s-02` | Z01 to Z03 PASS, Z04 FAIL | 422 `VIABILITY_TRANSITION_NOT_CONFIRMED`: the API hides the real error behind this generic code. `w3-z3s-03` was running. |
| Z4 | `w4-full-02` | Got past app start, scenario failed | Reason not yet read: see `scenario-01/session.json`. The earlier failure was stale `.next` build folders. |
| Z5 | `w5-native-10` | Z5N-09 and Z5N-10 PASS, Z5N-11/12/14 FAIL | The setup puts an X1 parent and the Z5 S3 to S4 to S5 chain in one tenant. S5 requires every registry resource to share one rights reference and horizon (`allocation-contracts.ts` about line 127, `enterprise-allocation.ts` about lines 119 and 177), so this cannot work. Needs a plain original Work without the X1 parent. |
| R12 | `wr12-native-01` | R12-20 timed out | The objective ran 4 rounds and never completed. |

## Next steps, nearest to passing first

1. Z0-M: create the folder above, rerun.
2. Z2: find why n3 returns CHECKED.
3. Z4: read `session.json`, fix, rerun.
4. Z3: read the `w3-z3s-03` result, make the viability API log the real error.
5. Z0: settle the continuation re-queue question and the `queries/route.ts` repair.
6. Z5: redesign the scenario setup as above.
7. R12 and Z1: find why R12-20 never completes, read the Z1 diagnostic.
8. Re-merge heads, run each phase once on the integrated candidate, rebuild on a clean machine, write the final handoff with the seven labels and external packets EP-01 to EP-10 (`externalRequestPackets` in the matrix JSON).

Each retry gets a new run name and failed runs are kept.

## Rules that still bind

- Prefer end-to-end tests. Do not write unit tests after the code. Write the failure model before a fix.
- One native stack at a time on the test computer. Runs take 2 to 25 minutes.
- No push, merge or deploy of the candidate without the owner's say-so.
- Never invent S5 renewals, grants or receipts. Z4 grants were signed only by the coordinating session (`dfd67166...`) using `ops/project-z/local-helpers/coordinator/z4-sign-grant.mjs`. Do not sign from another session.

## Not backed up

About 3.4 GB of run evidence and delivery packs. They are not code and were too large to push. They stay in `finnor-z-coordinator/scope-z/orchestration/` (`evidence/`, `delivery-20261026/`, `continuity/`) and `scope-z/phase-evidence/z0/capability-discovery/` on this computer, and in `fzv:/home/factory-user/repos/fzv-int-out/native/` on the test computer. If those computers are reset, this evidence is gone.
