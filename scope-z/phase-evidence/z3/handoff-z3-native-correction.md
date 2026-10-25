# Z3 current engineering handoff, 2026-10-25

Current-source installation is **NOT_RUN**, blocked by the retained 4 GiB
headroom requirement and user direction. Native and mounted authenticated
proofs are **NOT_RUN**, because existing DB/Auth/owner/worker authority was
not delivered. The permitted source-only packaging work is complete below.
This is a submission for coordinator review, **not acceptance or slot release**.
No coordinator gate was written. This supersedes `handoff-z3.md`.

## IMPLEMENTED

The ae8d1f6 native-owner correction remains unchanged. The coordinator adopted
all 22 owned deltas and four v3 owner requests, including the disjoint S5/Z1
composition. It has the actual mounted original-Work submit control, concrete
S4 finite readiness/reconciliation consumer, native P1/compiler/S5/S6 binding,
transactional physical-delivery fencing, pinned producer/checker/interpreters,
abort/close/deadline guards, durable cursor/revision bridge, lost-key aliases,
and bounded request history. These are source implementations, not executed
native qualification. The public GR(1) producer/checker is unchanged.

The executable v2 guarded native flow already exists at
`scripts/project-z/z3/native-correction-e2e.mjs`, with the native worker entry
and independent original-arena/cursor replay. It covers real process
kill/recovery boundaries, lease-expiry refusal without a successor, native
finite prefixes, original budget conservation, unchanged S6 UNKNOWN,
lost-key/history bounds, forged dependency assertions and real foreign-owner
HTTP denial. It does not provision its targets or grant authority.

The final bounded delivery supplies a real v4 standalone packet, complete
regular source archive/inventories/modes/replay assets, a stdlib-only
source/archive/patch verifier, corrected root-cwd producer recipe, guarded
install preflight, semantic comparator and actual current reconstruction guide.

## CHANGED

Same session `edc35487-a8a2-4ff6-ab70-66838205c078`, Computer `eea8d359`,
worktree `/home/factory-user/repos/finnor-z3`, branch
`factory/project-z3-viability`. No other model/session/subagent was launched;
the requested model setting is not an independent model attestation.

| Identity | Exact value |
| --- | --- |
| original lane base | `9f3edfd3b4c6758832c53139da0773218062191e` |
| base tree | `2dc4d5bc13d22853cf4dc9feb5f6ac7fbf6bb9c9` |
| adopted native correction | `ae8d1f68e201c23044be9cf7b7fec2c19a71750c` |
| adopted native tree | `1491eb6a21301d9e339b54673386dd4279ea204b` |
| final packaging/source cut | `c6b1df57b4602521c1b5369143f44289afd48beb` |
| source-cut tree | `c7fa1e3abe61cf25dcc5bc49f8f53f16ea42fcbc` |
| v4 manifest SHA-256 | `37e8432a28fc436f1e8d5b5dbf8e337aedf2f6738febaf84f6885349d94e3c89` |
| reconstruction-04 manifest SHA-256 | `1230d96252d3591a06bb4d9ce362767b45e0cc235bd79817037725e966d64410` |
| source inventory SHA-256 | `2b8bf789d8b6bcd1b81fb8d8bb80c2aaa77ed8a2ef06692def4affd8251c6406` |
| source modes SHA-256 | `106f2a911a5c72c70840bb3f00ba1837eca5d49b24bac6010dd57f05ad7c2047` |
| source archive SHA-256 | `226785ea2545a3cf580706979a3af1263fb246b9607c5ecd7358f2a174526036` |

After ae8d1f6: four owned tooling files changed (`build-native-corrections`,
`prepare-reconstruction`, `install-reconstruction`, `compare-reconstruction`,
all `.mjs`); `verify-reconstruction-source.mjs` was added. The v4 packet and
current docs/receipts were added. No native product source or shared global
source was edited. Subsequent delivery changes are evidence/documentation
only, not uncommitted replacement implementation bytes.

All exact leaf/receipt digests and file modes are in `native-freeze-v3.json`
and `native-freeze-v3.sha256`; the full 3,154-file reconstructed postimages
and modes are in `reconstruction-04/source-{inventory,modes}.json`.
Packet preimages/postimages, Git blobs, modes and patch digests are explicit
in v4's manifest. Its seven shared requests use mode 0644 (Git 100644).
The source archive is normalized to UID/GID/mtime zero and preserves file
modes; host Node/Python executables are separately observed, not archived.

**Do not reapply v4 to the coordinator.** Its first four patches are
byte-identical to adopted v3. Its complete three Z3 catalogue rows and
coverage rows match the actual combined coordinator source. The whole
generators/catalogues differ because other lanes are integrated. Preserve
the coordinator's S5/Z1 additions, generator and all other lane changes.

## EVIDENCE

New bounded checks (not new unit tests; N24–N31 failure maps precede fixes):

| Check | Actual outcome |
| --- | --- |
| sealed assembly check | exit 0, 20 lock members; assembly is not phase delivery/qualification |
| five owned tooling syntax checks | five exits 0 |
| real manifest generation/check and coverage generation/check | four exits 0; 583 HTTP + 77 planner = 660; zero unresolved dynamic calls |
| affected packaging ESLint | exit 0 |
| v4 emission | exit 0, seven exact requests |
| source preparation | exit 0; all 16 GNU-patch applications exit 0, zero fuzz |
| original-cut source/archive correspondence | exit 0; 3,154 regular files, exact archive/modes, 3,139 unpatched files and all 1,740 canonical production sources match the committed cut |
| packaged verifier without any original repository/dependencies | exit 0; archive/modes and all 16 forward/reverse patch checks pass |
| final-source root-cwd producer compilation | exit 0; byte-identical to approved producer, declared existing esbuild 0.25.12 |
| corrected asset/static-column audit | exit 0; four pinned assets, four declared tables, six INSERT column lists, checkpoint/s4_consumed/obligation_refs present; 3,892 retained records |
| current-source install preflight only | exit 2, `BLOCKED_DISK_HEADROOM`; no npm, build, replay, DB or listener |

Receipts: `runs/15-catalogue-final/`, `runs/16-source-reconstruction/`,
`runs/16-source-reconstruction-standalone/`, `runs/17-producer-correspondence/`
(retained combined-audit FAIL), `runs/18-source-assets-final/` (corrected
PASS), and `install-03-preflight/preflight.json`. Current protocol:
`reconstruction-correction.md`; package: `reconstruction-04/`.

Approved assets were observed unchanged:

- producer `43a3d180cf01602ccacfc01147d934a5f3a5a437f5767eccb1a1ce933bdaa4d7`;
- checker `b71c0bec3be5eb1e6218e4b04a26bf07918a3f781e5712800a8ff061497e837e`;
- Node 22.23.4 `94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90`;
- Python 3.12.3 `e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f`.

Retained source checks, verified against unchanged native leaf bytes:
`14-committed-boundary` PASS 17 cases; full backend overlay exit 0/inventory
`1ab0a4e193a851fd0a7d9ead32e2e1aa12211c2a80994a209cc56a9308cf6a79`;
entry exit 0/inventory
`c232fdf257256a9982f3ad22d3a12d57112ed8646a0d8faec146cba1fc81119c`;
frontend exit 0/inventory
`ab1f199065a3f53eef82c0ba88a7c6f02e24e60148415bac9a7a7f36da50690b`.
The retained 3,892-case public mathematical reference has frozen digest
`75434db94e19e24098d199b8c9eb0e7ec5ea102792ad2845f401ad07229a122b`;
its records SHA-256 is
`183e3fa3cf66d12f03b4efb660f4b437b29fb984de805fabf5b88d508758c37b`.
No giant replay was repeated in this attempt.

The actual coordinator validation-03 report was read: all 14 combined
checks exit 0, including full backend/frontend types and generated checks.
Affected lint has zero errors and the retained existing `scope` hook warning.
Its build inventory preflight includes all 22 owned/four shared postimages,
all 17 newly added Z3 leaves and modes; **it is not a build**. Receipt:
`/home/factory-user/repos/finnor-z-coordinator/scope-z/orchestration/evidence/coordinator-integration-04/build-inventory-preflight-01.json`.
Run 15 independently binds those receipts and the actual current postimages.

Failures remain, not relabelled:

- install-01 FAIL: stale manifest/coverage, missing Sentry configs and
  wrong-cwd producer `22dd0973…` refused by the boundary guard; other steps
  retain their original exits and backend build ID `WHID6M_s_4IE9wdbQ0rEI`.
  Those installed receipts cover reconstruction-02 only.
- install-02 exit 1: invalid flags, no installation. Reconstruction-03
  explicitly contained uncommitted tooling and is not the final package.
- catalogue attempts: missing tsx, missing TypeScript, then the omitted
  real `coverage/route.ts`. Originals retained; checks were not weakened.
- run 17 combined audit exit 1: audit identifier grammar excluded the
  digit in `s4_consumed`. All four assets were correct. Run 18 fixes only
  that audit, preserving source and the failed report.
- raw staged whitespace check exit 2 on a required blank-context prefix
  inside the byte-identical patch file. Its literal diagnostic copy also
  triggered exit 2; the retained derivative escapes it. Non-patch source
  check exit 0; exact patch checks still ran and passed.
- final retained-evidence whitespace check exit 2 on original install-01
  logs' carriage returns and blank endings. Those originals were not cleaned
  or rewritten. The check excluding only those historical logs exits 0;
  `runs/19-engineering-delivery/` retains the diagnostic and final index.
- older typecheck/OOM, checker/mount, migration and other failed logs remain.
  Historical DDL was not authorized by this continuation and was not rerun.
  It is not current native qualification. Runs 11/13 predating the final
  store bytes do not supersede source-bound run 14.

## COMPLETION GATE

**SUBMITTED_FOR_COORDINATOR_REVIEW, NOT_ACCEPTED. Lane remains occupied.**
No scheduling gate exists or was created here. The bounded source-only
package is validated; native, installed and financial gates are not promoted.
Protected corpus/custody and Z1's independently directed archive replay were
not accessed or run. Coordinator acceptance alone may release Z3's slot.

## REMAINING LIMITATIONS

1. Current-source own-lock installation/full application rebuild/comparator:
   NOT_RUN. Preflight measured 2,173,267,968 free bytes versus 4,294,967,296
   required, exit 2. The user forbids redundant installs, large replays and
   full application builds without original safe headroom. No targets were
   deleted to manufacture room. Post-preflight install branches remain
   unexecuted for final bytes, not claimed green.
2. Source native, installed native, mounted authenticated Work and physical
   owner recovery: NOT_RUN. Exact blocker:
   `EXPLICIT_EXISTING_DB_AUTH_OWNED_WORKER_AUTHORIZATION_NOT_DELIVERED`.
   `native-authorization-v2.md` is a contract, not authorization. No new
   DB/Auth/DDL/seed/grant/owner/listener action is permitted. The guard was
   not retried unchanged.
3. Protected/adversarial custody, equipped increment, operational/financial
   100x and activation: separate NOT_RUN/BLOCKED gates. No source/type/math
   or source-archive result establishes them.
4. Catalogue generation openly borrowed existing dependency symlinks.
   Producer correspondence used the declared existing compiler. Neither is
   a fresh install. The final regular source distribution borrows none.
5. Meter gaps remain: isolated child CPU/RSS and USD are unknown, not zero;
   worker process deltas are not isolated child measurements. No native
   remaining P1/S5 budget, reservation, deadline or S6 state was observed.
   Hashing host interpreters at guards has an unqualified performance cost.
   Small expiry/adoption charge windows and the shared S5 serializer's
   runtime behavior still need the authorized native flow.

## FRONTIER DELTA

Closed the actual internal delivery defects: the missing current handoff and
reconstruction guide now exist; v4 is emitted and frozen; production app
source/build configs/npm policies are retained; modes, normalized archive,
patch chains, committed-cut correspondence and replay assets are verified.
The cwd-sensitive approved bundle reproduces without changing its pin.
Install preflight refuses insufficient headroom before any install or build.
Already integrated coordinator semantics are documented and not overwritten.
Failures, incomplete targets and every qualification/meter gap remain visible.

This bounded delivery created no native jobs, reservations, grants or effects.
Existing remaining budgets/obligations are **unobserved/UNKNOWN**, not zero,
settled, released, renewed or reset. The guarded future flow requires three
pre-existing original Works, each with at least three attempts, eleven steps,
three original S5 compute requests and sufficient original deadline. These
are prerequisites, not newly supplied allowances.

## NEXT DEPENDENCIES

1. Coordinator reviews this current-source-bound freeze and selected packaging
   delta; do not reapply already adopted native/shared/catalogue changes.
2. Only after restored safe headroom and renewed permission, run the corrected
   own-lock reconstruction/full builds/public comparison for this exact cut.
   Existing installation receipts cannot stand in for it.
3. Only explicit user/coordinator existing-target v2 authority permits the
   already executable native, mounted and installed-native flows. No new
   provisioning, fake owner, budget renewal or protected custody is requested.
4. Independent protected/equipped/operational/financial gates and activation
   require their own authority/evidence. No push, PR, merge, deploy, external
   publication, customer contact or real financial action occurred.
