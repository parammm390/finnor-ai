# Z3 reconstruction protocol

Everything below reproduces from the lane branch `factory/project-z3-viability` alone
(base commit `9f3edfd3b4c6758832c53139da0773218062191e`, tree
`2dc4d5bc13d22853cf4dc9feb5f6ac7fbf6bb9c9`). Runtime artifacts — `cli.mts`,
`checker.py`, and the four native leaves under
`finnor-os/packages/{epistemic-runtime,private-equity}/src/project-z/z3-viability/` —
were frozen at commit `11a90a32f1453a4930ef32f0edf2de7d1a4c4fee`; later lane commits add
verification drivers and evidence only.

## Toolchain pins

- Node v22.23.4 (this Computer: `/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin`).
- python3 (stdlib only; no third-party packages anywhere in the checker or probes).
- No dependency is installed outside the two locked lockfiles; installs used
  `npm ci --ignore-scripts --no-audit --no-fund` (582 frontend / 437 backend packages,
  logs: `install-frontend.log`, `install-backend.log`).

## Steps and expected results

1. Producer bundle (from `finnor-os/`):
   `node_modules/.bin/esbuild scripts/project-z/z3/cli.mts --bundle --platform=node --format=esm --outfile=<out>/cli.mjs`
   → sha256 must equal `43a3d180cf01602ccacfc01147d934a5f3a5a437f5767eccb1a1ce933bdaa4d7`.
   (Source `cli.mts` sha256 `9d4acd16ced00ebfb4240d119d7785e008aa568eb7eb18fb54354886974251db`;
   esbuild is lockfile-pinned at 0.25.12.)
2. Frozen population integrity: `python3 finnor-os/scripts/project-z/z3/finite-e2e.py --freeze`
   prints the sha256 of `frozen-public-cases-v2.json`
   (`0f1cc6af5de3a006a8880c7550f65c1c0d56e00fdaf34bf8b388c7cbc1e726c6`) and refuses to
   revise it. Any drift raises `Frozen public population cannot be silently revised`.
3. Full finite sweep: `python3 finnor-os/scripts/project-z/z3/finite-e2e.py --cli <out>/cli.mjs --output scope-z/phase-evidence/z3/runs/<new-name>`
   → `status: PASS`, `requests: 3892` (256 frozen cases + 3636 grid), report
   `frozenDigest: 75434db94e19e24098d199b8c9eb0e7ec5ea102792ad2845f401ad07229a122b`;
   output directories are immutable (a rerun into an existing directory refuses).
   Retained reference: `runs/02-checker-hardening/report.json` sha256
   `61adc8485558490f3c4d3306ae1bee1894dae164e6592353fe902390783bb69c`.
4. Independence/digest-stage probes:
   `python3 finnor-os/scripts/project-z/z3/probe-independence.py --cli <out>/cli.mjs --output scope-z/phase-evidence/z3/runs/<new-name>`
   → `status: PASS`; recomputes all 3892 retained digests from `runs/02` and requires
   three-way agreement; asserts the pinned artifact digests (cli.mjs above, checker.py
   `b71c0bec3be5eb1e6218e4b04a26bf07918a3f781e5712800a8ff061497e837e`).
   Retained reference: `runs/03-independence-digest/report.json` sha256
   `a1d1313717ef6d26374138f33c3d8e30372064802f7eeca641f821d9fb88eb85`.
5. Typechecks (heap 4096 under `flock /home/factory-user/repos/finnor-z-shared-heavy.lock`):
   - `cd finnor-os && npm run typecheck` → exit 0 (`post-code-backend-typecheck-4.log`).
   - `node_modules/.bin/tsc -p ../scope-z/phase-evidence/z3/build/ui-check/tsconfig.json`
     → exit 0 (staged panel at its future import path).
   - `node_modules/.bin/tsc -p ../scope-z/phase-evidence/z3/build/entry-check/tsconfig.json`
     → exit 0 (staged proof worker entry).
6. Coordinator patch set: `node scope-z/phase-evidence/z3/build/generate-integration-patches.mjs`
   regenerates all nine patches and `integration-patches/manifest.json` byte-identically,
   re-verifying preimage blobs, scratch application, postimage blobs, bundle-generator
   determinism, and patched-tree coherence. Apply order and identities:
   `integration-patches/README.md` + `manifest.json`.

## Evidence index (all retained, none overwritten)

| artifact | content | result |
|---|---|---|
| `runs/00-implementation-absent/` + `implementation-absent.log` | pre-code failure-first assertion that no Z3 implementation existed | recorded |
| `runs/01-source/` + `source-sweep-01.log` | first full sweep (pre-hardening) | FAIL evidence retained |
| `runs/02-checker-hardening/` + `source-sweep-02.log` + `probe-checker-hardening.log` | hardened sweep, 3892 requests, 8 semantic mutations, per-obligation falsifiers | PASS |
| `runs/03-independence-digest/` | structural-independence audit, digest-stage forgeries, metrics irrelevance, 3892-record three-way digest agreement | PASS |
| `baseline-{frontend,backend}-typecheck.log` | pre-change typecheck baselines | exit 0 |
| `post-code-backend-typecheck{,-2,-3,-4}.log` | post-code iterations; `-1`/`-2` FAILs retained, `-3`/`-4` exit 0 | final exit 0 |
| `build/ui-check/`, `build/entry-check/` | staged typechecks of the panel and proof entry | exit 0 |
| `build/rebuild-02.log`, `build/cli.mjs` | producer bundle build + pinned artifact | digest above |
| `native-backend-typecheck.log`, `native-leaves-baseline.sha256` | native-leaf baselines | recorded |
| `engineering-plan.md`, `mathematical-contract.md`, `reading-receipt.md`, `pre-code-freeze-correction.md` | pre-code artifacts (immutable) | frozen |
| `integration-patches/` | nine preimage-bound coordinator patches + payloads + README + manifest | dual-verified |
| `runs/04-migration-ddl/` + `migration-ddl-validation*.log` | disposable PostgreSQL 18 DDL application + guard/RLS/grant matrix (attempts 1-2 retained) | 26/26 PASS |
| `runs/03-independent-reverification/`, `independent-verify-*.log`, `build/validate-migration-0199.mjs`, `build/run-verify-batch-*.sh` | supervisor-run independent reverifications (sweep PASS, probe PASS at be2c775, post-apply worktree typechecks) | preserved as-run |
| `build/mount-check.mjs` + `build/mount-check.log` | post-apply frontend typecheck of patches 0005+0005b in a /tmp mirror of the whole `src/` tree with root-tsconfig include surface (needs `node_modules` + `finnor-os` sibling symlinks and `next-env.d.ts` in the program) | tsc exit 0 |

## Not reconstructible from this lane (external authority)

Native runtime proofs (migration application, patched staging tree, real disposable
owner, three SIGKILL recovery proofs, mounted reload) require the coordinator's
`finnor.z3.existing-disposable-authorization.v1` delivery; see
`integration-patches/README.md` §Authorization contract. Protected admission (S6) and
financial qualification are not part of this engineering lane.
