# Current default public process flow

Actual default-run exit: **0**, 256/256 original registered outcomes.
Independent artifact verification: **0**, all 256 producer and 256 checker
exit records checked, including original expected replacement dispositions.

This is one diagnosed affected rerun of the original frozen population,
closing the current runner's previously unexecuted default CLI path.
`../default-runner-validation-contract-01.md` records that scope correction
before invocation. No implementation, original input, expected value or
positive denominator changes. Original contracts, checkpoint 05 and runs
01–03 are preserved rather than retroactively changing their execution state.

| Original disposition | Registered slots |
|---|---:|
| CHECKED_CANDIDATE | 188 |
| CHECKED_INFEASIBLE | 50 |
| UNSUPPORTED | 16 |
| INCOMPLETE | 2 |

The mandatory population audit is attached to the default receipt. The slots
still contain only 84 different complete inputs, including 50 different
positive inputs, 172 repeated slots and nine cross-label duplicate groups.
Structural-family qualification and independent freshness remain
`NOT_ESTABLISHED`. The audit artifact's zero semantic-execution counter
describes only its static prelude, not the subsequent 256 producer/checker
pairs in the full flow.

## Exact identities

Current 36-file source digest:
`d65ccefad807b1690e2d4ad2b9dcec72c76f894af771fddbeae71110e6e564f2`.
Runner SHA-256:
`978a8b5b92b1fa68f3493827ac512b2f81c63793312a6d36623cd4a7a76c31ec`.
Original registration SHA-256:
`74c0d1b3f02e53e3c011f4cf5f976dd62378e04d2fd56b389973078cf6b2f42e`.
Report SHA-256:
`3edf444934d18c206bd21e6d8555daa061e125d5a41120402f8b1b54bd70c7b7`.
Attached audit SHA-256:
`30ffa624467ba08d54e6a1deac2054532857c4a4c7455520a1adb34674511e69`.
Timing SHA-256:
`66caf02de0a7dec1e24e56a629df04bb0fb7c4f27ad1d7afca80f490498635cc`.

The report also pins the unchanged kernel/checker. Raw process record-set
SHA-256, in registration order with producer before checker, hashing compact
sorted-key JSON rows of `{path,sha256,bytes}`:
`700d675c5d18737c87058bf20cd549a49d29e1f2508290c583c4fda7169c51a8`.
The 512 process records occupy 996,684 bytes.

## Actual observations and retained failure

- `../public-sweep-04-preflight.log`: source/registration/headroom exit 0.
- `../public-sweep-04.log` and `../public-sweep-04-launch-01.json`:
  first launch exit 127 at missing `/usr/bin/time`; no cases or lock started.
- `../public-sweep-04-run-02.log`: corrected default flow exit 0.
- `../public-sweep-04-timing-02.json`: Python 3.12.3 standard-library timing,
  without an external timing executable or dependency installation.
- `../public-sweep-04-verification.log`: independent verification exit 0.

Driver elapsed is 62,882.001 ms. Complete command elapsed is 300,782.536 ms,
including heavy-lock wait and startup; isolated lock wait is not measured.
Child user/system CPU are 75.586182/12.969399 seconds. Linux child rusage
reports maximum single-child RSS of 91,918,336 bytes, not simultaneous
process-tree peak. Node is 22.23.4 with the existing 512-MiB heap cap.
Command wait bound is 600 seconds and overall timeout 1200 seconds.
These are source engineering costs, not a comparative speedup result.

The new invocation performs no DB/Auth operation, listener, native owner
action, installed rebuild, archive extraction, protected admission or financial
effect. It does not bypass or retry the independent Shield commit denial.

## Repeat the inner flow

The actual outer measurement used Python `time/resource/subprocess`; its
exact inner argv is retained in the timing artifact. This replay example
uses a new output directory and does not require `/usr/bin/time`:

```sh
env -i \
  PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin:/usr/bin:/bin \
  LANG=C.UTF-8 \
  /usr/bin/flock -w 600 -x /home/factory-user/repos/finnor-z-shared-heavy.lock \
  /home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin/node \
  --max-old-space-size=512 \
  /home/factory-user/repos/finnor-z5/finnor-os/scripts/project-z/z5/offline-e2e.mjs \
  /home/factory-user/repos/finnor-z5/scope-z/phase-evidence/z5/public-sweep-review-04
```

Retain the fresh result and any failure. Do not overwrite this directory or
regenerate frozen cases. This example is a replay recipe, not another run
already performed. Native and reconstructed/installed qualification remain
separate and unpassed.
