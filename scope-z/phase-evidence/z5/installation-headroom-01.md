# Point-of-use installation headroom engineering receipt

This is a real read-only driver guard, not an archive, installation or
accepted handoff. Checkpoint 08 freezes current source; checkpoint 07 and
all original failures remain immutable.

Only `finnor-os/scripts/project-z/z5/reconstruct.mjs` changes since 07.
Driver SHA-256:
`217ed024652cce50b1a4163036a64efe5e2cd8deddc10cc353162bcb293298cb`.
Current 36-file code digest:
`017c02c2f1074abfaeb62134602391422d7401bb30071947605159e46d7f1b71`.
Request 07 and native/TypeScript/kernel/checker/helper bytes are unchanged.
`installation-headroom-failure-model-01.md` precedes the edit.

The early 8-GiB guard remains. The same predicate is now checked inside the
already-held heavy lock immediately before EACH root/backend `npm ci`.
That lock remains held through guard and npm. Guard/spawn/npm failures
propagate; the original owned-process-group timeout bounds remain.

## Actual commands and exits

Executed in a credential-free environment, with exclusive retained logs:

```sh
/usr/bin/env -i \
  PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin:/usr/bin:/bin \
  LANG=C.UTF-8 \
  /usr/bin/flock -w 600 -x /home/factory-user/repos/finnor-z-shared-heavy.lock \
  /home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin/node \
  /home/factory-user/repos/finnor-z5/finnor-os/scripts/project-z/z5/reconstruct.mjs \
  --installation-headroom /home/factory-user/repos/finnor-z5
```

Actual exit **2**, `BLOCKED_INSUFFICIENT_DISK`:
2,917,261,312 available / 8,589,934,592 required bytes.
`installation-headroom-01.log` SHA-256:
`2c930e365c567464adcc13dabfe4771323239f4044272e0370278e064f7dad67`.
It binds the driver SHA above and reports zero installs, DB actions and
listeners. Script elapsed 161.4 seconds includes lock wait; isolated guard/
lock time, CPU and RSS were not measured. Execution:
`call_UIB1ESl6mNmFB1p4hdSXxyxf`.

The diagnostic never reads a delivery receipt/archive, extracts source,
invokes npm or starts native work, even when free space would be sufficient.
Its successful exit would mean HEADROOM ONLY, never installed proof.

| Affected check | Actual exit | Evidence |
|---|---:|---|
| Driver MJS syntax | 0 | `reconstruction-syntax-08.log` |
| Embedded install-wrapper syntax / Python extractor parse+compile | 0 | `reconstruction-embedded-syntax-08.log`; wrapper not executed, extractor matches preserved index |
| Relative diagnostic target | 1, expected | `installation-headroom-invalid-path-01.log`; rejected before receipt/npm IO |
| Independent source/artifact verification | 0 | `installation-headroom-verification-01.log` |

Source/verification calls:
`call_jvyLRDmnaFicE2sjU3t4IXZW`,
`call_IMckyWV8hj799KyP4SQbFTxy`.
No new unit or public-population campaign was added. Full backend/frontend,
SQL, native guard, public sweep and process evidence are reused only for
their unchanged source and original scopes, not called newly executed.

## Remaining blockers

Shield still denies the source commit; no retry, flagged-content inspection,
exclusion or alternate package occurred. No archive, extraction, cold replay,
dependency installation or application build exists. The actual npm branch
and native DB/Auth/custody flows remain NOT_RUN. The disk floor is not a
reservation against uncoordinated writers and is never lowered.

Coordinator request-07 application/rebase, migration naming/head/bundle and
generated outputs remain unapplied. Qualification and release gates remain
independent; no coordinator acceptance or slot release is asserted.
