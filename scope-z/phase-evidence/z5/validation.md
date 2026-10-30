# Actual validation index

There is no source/package commit or delivery receipt: Droid Shield denied
the commit. `blocked-source-checkpoint.json` preserves the denied old cut.
Current source identities are in `source-current-checkpoint-08.json`, an exact
metadata delta over its pinned immutable checkpoint 02. Current proposal is 07,
SHA-256
`793cd28d935908cc50d3eebee513f0deda0e2f39e7f9e3e12d90a340a6794ef7`.
It remains unapplied. All original failed runs stay in this directory.

| Check | Actual exit | Observed result / scope |
|---|---:|---|
| pack-check-02 | 0 | All 20 original locked members; historical authoring receipt unchanged |
| public-sweep-03 | 0 | 256/256; 188/188 useful positives |
| public-sweep-04 preflight | 0 | All 36 current source identities and original registration; safe source-replay headroom |
| public-sweep-04 launch 01 | 127 | Retained missing `/usr/bin/time`; no producer/checker or heavy-lock acquisition |
| public-sweep-04 default flow, launch 02 | 0 | Current runner: 256/256 original outcomes; 188/188 positive slots; attached identity audit |
| public-sweep-04 artifact verification | 0 | All 256 producer and 256 checker records, original expectations and source hashes independently checked |
| public-population-audit-01 | 0 | Post-code identity audit only: 84 different inputs / 256 slots; structural qualification NOT_ESTABLISHED |
| public-population-audit-verification-01 | 0 | Independent Python recomputation of all 256 original input digests |
| public-population-output-guard-01 | 1, expected | Noncanonical path escaping owned evidence rejected before creating any destination |
| public-population-overwrite-guard-01 | 1, expected | Existing evidence directory refused |
| public-population-guard-verification-01 | 0 | Escaping destination absent; original audit report hash preserved |
| integration-request-06 assembly | 0 | Corrected new-file Git header; eleven exact proposed files |
| integration-request-06 Git check | 0 | Strict read-only `git apply --check --whitespace=error`; no shared application |
| integration-request-06 verification | 0 | All eleven source pre/postimages and migration metadata byte-identical to 05 |
| integration-request-07 assembly / Git check / verification | 0 / 0 / 0 | Only policies-route postimage changes from 06; eleven preimages, other ten postimages and SQL metadata match |
| Changed Python syntax 06 | 0 | Assembler/freezer parse and compile without executing the packager |
| Original integration patch checks 01–05 | 1 each | Retained `dev/null` creation-header failures |
| Preserved-index whitespace 01 | 2 | Retained forty blank context lines in nested historical patch data |
| process-e2e-02 | 0 | 41/41 original-process corruption/scope/fence cases |
| process-e2e-03 | 0 | Current common helper; 41/41 original outcomes, 2 producer / 18 checker exits verified |
| recovery-e2e-01 | 0 | 7/7; three real LOCAL FILE kills; no native queue/DB |
| diagnostics-01 | 0 | Five alternating role pairs; not equivalent-work speedup |
| backend-types-11 | 0 | Request 05 source postimages, byte-identical to 06; 1459 roots / 4471 sources, zero diagnostics |
| backend-types-12 | 0 | Current backend and actual request 07; 1459 roots / 4471 sources, zero diagnostics |
| frontend-types-05 | 0 | Request 05 source postimages, byte-identical to 06; 257 roots / 1837 sources, zero diagnostics |
| lint-check-03 | 0 | Full root baseline plus then-proposed sources; 300 entries, 0 errors / 18 warnings |
| lint-check-05 | 0 | Current exact proposal's affected lintable sources; 3 entries, 0 errors / 2 warnings |
| workspace-check-01 | 0 | Existing unchanged package layout check |
| manifest-check-03 | 0 | Existing unchanged 580 HTTP / 77 planner inventory |
| coverage-check-04 | 0 | Original auditor/predicates unchanged; 657 classified, zero unresolved |
| client-check-01 | 0 | Existing unchanged generated-client check |
| forms-check-01 | 0 | Existing unchanged generated-forms check |
| sql-parse-02 | 0 | Current SQL; 28 statements / 7 bodies / 6 matching function identities; no SQL execution |
| Syntax 05 / changed Python 06 / changed runner | 0 / 0 / 0 | Unchanged files and embedded extractor retain 05; two changed Python files and current public MJS separately checked |
| native-guard-06 | 2, expected | NOT_RUN, empty actions, zero DB/Auth/listener/effect operations |
| native-guard-07 / 08 | 2 / 2, expected | 08 binds final helper; no native actions, all nine counters zero |
| Changed Python / native MJS / common-helper syntax | 0 / 0 / 0 | Syntax 07, native syntax 07, helper syntax 08; packager not executed |
| native-output-noncanonical-guard-01 | 1, expected | Normalized owned target absent; rejection precedes authority imports/creation |
| consumer-publication-verification-01 | 0 | All current process/guard records, seven changed source identities and request 07 binding; no native concurrency claim |
| reconstruction-syntax-08 / embedded syntax 08 | 0 / 0 | Driver/wrapper parse; unchanged Python extractor compiles without execution |
| installation-headroom-01 | 2, expected | Real locked read-only diagnostic; 2,917,261,312 available / 8,589,934,592 required bytes, zero installs |
| installation-headroom-invalid-path-01 | 1, expected | Relative diagnostic target refused before receipt/archive/npm IO |
| installation-headroom-verification-01 | 0 | Current driver/report/source binding; all other implementation and prior failure evidence unchanged |
| Exact archive / cold source replay | NOT_RUN | Commit denied; no final source archive or receipt |
| Historical packaging source guard 01 | 1, expected | `EXACT_COMMITTED_SOURCE_REQUIRED`; not retried or bypassed |
| Installed engineering | NOT_RUN | No source receipt; pre-checkpoint observation 875,044,864 bytes free vs required 8,589,934,592 |

Full graphs use compiler 5.9.3, SHA-256
`3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675`,
explicit third-party declarations and exact virtual postimages, no peer
project source or shared writes. Current backend source digest
`b12d01736f45a408e08a397f672a65320f6d0ced918966d112823a10f9ee2a21`;
frontend source digest
`833a12b67272eae1f1e0e29bf4b5fa1f13ec20eafb9f962df0179fa62c7ace56`.
Backend 12 wall 102,276.100 ms / peak RSS 3,413,782,528 bytes; frontend
23,796.592 ms / 1,215,332,352 bytes. Each held the shared heavy lock and
used the permitted 4096 MiB heap cap.

Current source corrections affect only owned backend/scripts/SQL; frontend
postimages are identical to request 03. Full root lint 03 plus affected
request-05 lint 05 passed. Warnings remain visible, including one new
scope-dependency warning in the proposed panel. No lint hook was disabled.
The earlier backend-09/lint-05 command batch elapsed 1142.9 seconds including
shared lock waits. Historical backend 11 completed in 63.8 seconds; current
backend 12 completed in 103.4 seconds;
compiler wall above excludes scheduling/driver overhead.

The final source fixes prepaid terminal fences/audit separation, non-mutating
reads, real tenant-scoped native observations, the producer/S8 heartbeat
handoff race and reconstruction-owned subprocess-group bounds. No new
post-code unit campaign was added. Exact unchanged kernel/checker hashes bind
the reused public process evidence; it does not test these native fixes.
The latest worker-only correction extends prepaid terminalization to the exact
episode storage/event failure before local claim registration. Its original
pre-correction failure model is `preclaim-exhaustion-failure-model-01.md`.
Backend 10 retains that historical correction pass. The final lifecycle fix
closes settled handler callbacks before final lease release and directly
checks the current fence before producer dispatch. Its pre-correction model
is `worker-lifecycle-failure-model-01.md`. Backend 11 and the whitespace check
exit 0. The authority guard was rerun as 06 in a credential-free environment
and exited 2 before DB/Auth/network imports. Other unchanged source-bound
checks are reused. Actual quota/transaction/timing behavior remains NOT_RUN.

The population-audit portion of this continuation changes only
`offline-e2e.mjs` and evidence.
`public-population-audit-contract-01.md` precedes that receipt/output-guard
change. The actual credential-free audit-only CLI exits 0, reads 1,021,465
fixture bytes and records 240.748 ms complete elapsed time. Its report SHA-256
is `0bffb1bea4da3f016651c34445261254f6ab2ac9be5ea09c75392e6184361ef2`.
The runner SHA-256 is
`978a8b5b92b1fa68f3493827ac512b2f81c63793312a6d36623cd4a7a76c31ec`.
The original registration remains
`74c0d1b3f02e53e3c011f4cf5f976dd62378e04d2fd56b389973078cf6b2f42e`.
Independent Python recomputation verifies all members and canonical input
digests. There are 84 different inputs, 172 repeated slots, 49 duplicate
groups, nine cross-label groups and 50 different positive inputs in the
unchanged 188-positive-slot denominator. Only F11/F12 contain eight different
inputs. Input inequality does not establish distinct structures.

The audit-only invocation was not a semantic campaign. Original public sweep
03 remains bound to its original runner bytes. Checkpoint 05 explicitly
recorded that the current default full semantic path was not executed.
`default-runner-validation-contract-01.md` corrects that validation-scope
judgment before one diagnosed affected rerun, preserving the original
population, expected values, denominator and earlier contract.

Current default sweep 04 exits 0 on 256/256 original outcomes: 188 candidates,
50 checked infeasible, 16 unsupported and two incomplete. Independent Python
verification checks all 512 raw process records, source hashes, original
expectations and the attached population audit, exit 0. Report SHA-256:
`3edf444934d18c206bd21e6d8555daa061e125d5a41120402f8b1b54bd70c7b7`.
Attached audit SHA-256:
`30ffa624467ba08d54e6a1deac2054532857c4a4c7455520a1adb34674511e69`.
It still reports only 84 different inputs, 50 different positive inputs and
unestablished structural-family qualification. Audit-prelude execution
counters refer only to that static prelude; the full flow has 256 producer
and 256 checker exit records.

The first launch exits 127 because `/usr/bin/time` is unavailable, before
the lock or cases start. `public-sweep-04-launch-01.json` and the original
`public-sweep-04.log` retain that failure. The corrected launch uses existing
Python 3.12.3 standard-library timing, credential-free, under the shared heavy
lock. Driver elapsed is 62,882.001 ms; command elapsed is 300,782.536 ms
including wait/startup. Lock wait is not separately isolated. Child user/
system CPU are 75.586182/12.969399 seconds. Maximum single-child RSS is
91,918,336 bytes, not combined process-tree peak. This is not a benchmark
comparison or installed/native evidence.

No implementation bytes changed in the checkpoint-06 continuation. Existing type graphs,
SQL, native guard, process/recovery E2E and syntax checks are reused for
unchanged source. Exact commands and interpretation are in
`public-sweep-04/README.md` and `public-population-audit-01/README.md`.

The subsequent read-only Git-parser checks exposed an independent delivery
defect. All five original requests fail with `dev/null: No such file or
directory`. They lack the new-file mode header in their Git extended diff.
`integration-patch-failure-model-01.md` precedes the assembler correction.
The historical request 06 adds exactly one `new file mode 100644` line. Actual
generation, strict Git check and independent byte verification each exit 0.
Manifest SHA-256:
`c2ba6bcbeee7c8f5ccb5c2fbb3f356b8a05170ecb0e130b582852e157572a18b`.
All eleven source pre/postimages and migration metadata match 05 byte for
byte. Thus the already completed type/lint graphs remain source-bound;
their logs are not relabeled as newly executed request-06 checks.
At that checkpoint the packager selected 06; syntax 06 checks it without execution.

`staged-whitespace-01.log` retains the separately observed cached-index
check's exit 2 and forty blank-context findings in old patch artifacts.
This outer diff-as-data check is not silently converted to a pass. No old
patch, index entry or whitespace policy was changed. The corrected active
patch passes Git's strict added-source whitespace check without applying it.

Coverage 04 supplies explicit third-party declarations to the original
TypeScript import/finite-expression program. Its 158 roots / 762 source files
include 160 own files, digest
`d81a8aa48628e805af40f7267b86dec0fd0f02c616e1e91541d440a38917fcc7`.
No unresolved call is suppressed or reclassified. Manifest/client/forms/
coverage passes are for **unchanged baseline generated outputs**, not
regenerated combined Z5 outputs or authenticated mounted operations.

## Checkpoint-07 retained-request, transport and output correction

Seven implementation files change since checkpoint 06; that checkpoint's 36-file
digest is `7f714420d589fd2e28e6bbe52d81b2f3bfb15c9e3b8eac98b205f5acada5d9b4`.
The three pre-change models are `consumer-publication-failure-model-01.md`,
`composition-plan-transport-failure-model-01.md` and
`native-output-containment-failure-model-01.md`.

Final S4/S8 transactions consistently check the retained request under its
lock. Final composition consumption also checks the locked actual head/use,
current admission and original owner cut after external work. Already
committed original S5 debits remain charged on refusal. The native flow adds
post-cancellation admission/use/planning negatives and durable-state comparison;
those actions and the in-flight cancellation schedule remain NOT_RUN.

Request 07 changes only the policies-route postimage from 06, preserving all
eleven preimages, other ten postimages and migration metadata. Its bounded
Z5 catch prevents expected planning refusals from falling through to HTTP 500
without changing non-Z5 handlers. Assembly, strict read-only Git checking and
independent byte verification exit 0. Manifest SHA-256:
`fb88fe4dc4b23d46927a92c716f8d64c2edfc2f33389f9282b4285fdd9a35f5c`.
The packager selects 07 but is not executed.

Backend 12 checks the current TypeScript graph and actual request 07, exit 0.
The later common-helper change is MJS, not a backend TypeScript input. Its
syntax passes; process E2E 03 exits 0 on all 41 original cases and pins that
helper's bytes. Independent verification checks both producer and all 18
checker exits, including 16 corruption rejections. Process report SHA-256:
`83ea04049f3c4d40f68d55212d75d40ea991a8a663e3ecadd78e963279c43ae3`.
The process Script elapsed 215.9 seconds including shared-lock wait and other
parallel guard checks; isolated process/lock time is not measured.

The native noncanonical-output CLI exits 1 before creation; its normalized
target remains absent. Canonical native guard 08 exits 2 before DB/Auth/network
imports, all nine counters zero. Report SHA-256:
`9f543a385c83c0671e047d403dd323cfad1b9c37f01f2b5d10b898623239e4a1`.
Independent artifact/source verification exits 0. Root lint explicitly ignores
`finnor-os/**`; the backend has no configured lint command. No ignored source
is reported as linted. Frontend/lint/SQL/generated-output checks are reused only
for their unchanged bytes. No new unit or public-population campaign ran.

## Current point-of-use installation headroom correction

Only `reconstruct.mjs` changes since checkpoint 07. Current code digest:
`017c02c2f1074abfaeb62134602391422d7401bb30071947605159e46d7f1b71`.
Driver SHA-256:
`217ed024652cce50b1a4163036a64efe5e2cd8deddc10cc353162bcb293298cb`.
`installation-headroom-failure-model-01.md` precedes the change.

The original early guard remains. The same predicate is also checked under
the already-held heavy lock immediately before each root/backend `npm ci`,
without releasing that lock. Guard/npm failures propagate, and existing
owned-process-group timeout handling remains. A diagnostic CLI checks actual
space read-only; it is not an install, receipt, extraction or source/build proof.

Changed driver and embedded install-wrapper syntax checks exit 0. The embedded
Python extractor parses/compiles and matches the preserved index, without
execution or bytecode. The relative diagnostic-path negative exits 1 before
file/receipt/npm work. Current TypeScript, native/process, SQL, proposal and
public population bytes are unchanged; their source-bound checks are reused,
not relabeled as new runs. No new unit suite or fake archive is used.

The actual credential-free diagnostic under the shared lock exits 2:
2,917,261,312 available bytes against 8,589,934,592 required. The report binds
the driver SHA above and reports zero installs, DB actions and listeners.
Report/log SHA-256:
`2c930e365c567464adcc13dabfe4771323239f4044272e0370278e064f7dad67`.
Independent artifact/source verification exits 0. Script elapsed is 161.4
seconds including lock wait; isolated guard/lock CPU/time are not measured.
The embedded install wrapper is syntax-checked but NOT_EXECUTED. No receipt/
archive is read and no extraction/npm/native action starts. See
`installation-headroom-01.md`. This does not resolve Shield or installed proof.

## Retained actual failures

- Original doctor/runner wrong-root and missing co-located npm, exit 127;
  first sweep's Node strip/parameter-property failure.
- Process E2E 01, exit 1: the older checker accepted
  `fabricated-whole-code-correspondence` and `false-counterexample-class`.
  The corrected independent checker and full sweep/process reruns pass.
- Backend types 01, exit 1: 20 diagnostics. Backend types 03, exit 1:
  wrong orchestration alias and source changed during that check.
- Manifest, coverage and lint 01/02, exit 1: explicit-tooling bootstrap
  failures. Coverage 03, exit 1: five unresolved existing dynamic routes
  caused by absent declarations in this uninstalled worktree.
- Original patch format checks 01–05, exit 1 each; exact failing identities
  and stderr are in `integration-patch-check-01.json`.
- Preserved-index whitespace check, exit 2; original literal context-line
  findings are retained in `staged-whitespace-01.log`.
- Default-flow launch 01, exit 127; missing external timing executable,
  retained in `public-sweep-04-launch-01.json` and `public-sweep-04.log`.

Read the unchanged original logs and retained failure notes; later passes
do not rewrite those facts. No native authenticated run, live SQL/RLS
validation, actual S8 custody, mounted browser, native physical recovery,
separately installed integrated app build, protected/equipped campaign,
operational/financial 100× or activation is established.
