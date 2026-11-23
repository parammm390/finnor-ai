# Actual frozen-population identity audit

Actual audit-only CLI exit: **0**, `AUDIT_COMPLETED`.
This is a post-code static diagnosis, not another semantic campaign or
structural-family qualification.

| Observation | Count |
|---|---:|
| Original registered slots / labels | 256 / 32 |
| Different complete original inputs | 84 |
| Repeated input slots | 172 |
| Exact duplicate groups / cross-label groups | 49 / 9 |
| Registered positive slots / different positive inputs | 188 / 50 |
| Labels with eight different inputs | 2, F11/F12 |
| New producer/checker/DB/listener actions | 0 |

Every original member SHA-256 matches the unchanged registration. Canonical
comparison preserves every input field and array order and only sorts object
keys. Different hashes do not establish semantic or structural diversity.
The original 188-slot denominator and all expected outcomes remain unchanged.
The same-input groups include F01/F02, F13/F14, F17/F21/F22, F23/F25 and
F30/F31/F32. F09, F14 and F29 each contain one different input across eight
slots.

Report SHA-256:
`0bffb1bea4da3f016651c34445261254f6ab2ac9be5ea09c75392e6184361ef2`.
Runner SHA-256:
`978a8b5b92b1fa68f3493827ac512b2f81c63793312a6d36623cd4a7a76c31ec`.
Original registration SHA-256:
`74c0d1b3f02e53e3c011f4cf5f976dd62378e04d2fd56b389973078cf6b2f42e`.
The report also pins the unchanged kernel/checker and locked family catalogue.
Node: 22.23.4, heap cap 256 MiB; complete elapsed time 240.748 ms.
Peak RSS/CPU were not measured. Fixture bytes read: 1,021,465.

## Exact observed checks

- `../public-population-audit-01.log`: audit-only exit 0.
- `../public-population-audit-verification-01.log`: independent Python 3.12.3
  recomputation of all member and input hashes, exit 0.
- `../public-population-output-guard-01.log`: noncanonical output escape
  refused before destination creation, exit 1 as expected.
- `../public-population-overwrite-guard-01.log`: existing directory refused,
  exit 1 as expected.
- `../public-population-guard-verification-01.log`: escaping destination
  absent and original report SHA-256 unchanged, exit 0.
- Changed-runner `node --check`: exit 0, retained tool call
  `call_15bGBCXPpVtraDKUTum5YhEl`.

The failure contract was written before changing the runner:
`../public-population-audit-contract-01.md`.
The original sweep and original failures are untouched. This mode creates
no archive and does not retry or circumvent the Shield denial.

## Repeat the actual mode

Use a new owned output directory. The example below is a replay command, not
another execution already performed:

```sh
env -i \
  PATH=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin:/usr/bin:/bin \
  LANG=C.UTF-8 \
  /home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin/node \
  --max-old-space-size=256 \
  /home/factory-user/repos/finnor-z5/finnor-os/scripts/project-z/z5/offline-e2e.mjs \
  --audit-only \
  /home/factory-user/repos/finnor-z5/scope-z/phase-evidence/z5/public-population-audit-review-01
```

Exit 0 means the identity audit completed, not that the population qualified.
The default full semantic mode was not rerun after this receipt-only change.
Future full runs perform this same audit first and attach its unestablished
structural/freshness qualification states.
