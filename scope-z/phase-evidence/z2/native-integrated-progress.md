# Z2 native integrated replay: progress note (resume point for a successor)

Branch `w/z2-native` (local worktree `/home/factory-user/repos/finnor-z-w-z2`, remote `/home/factory-user/repos/fzv-w-z2`). Run names carry the tag `w2-`.
Evidence stays on the remote under `/home/factory-user/repos/fzv-int-out/`. Packs live under `/home/factory-user/repos/fzv-z2-pack-w2/`.

## Done
- Read the contract, driver, schema, installer, prepare step. Failure model committed first.
- Node toolchain bootstrap: registry `npm@10.9.4` (distribution npm) beside the host pinned node 22.23.4 under `fzv-z2-pack-w2/toolchain` (see report DECISIONS).

## Running
- nothing

## Next
1. prepare-replay `--git-commit` mode, install-owner external-root/node pin/headers seed/public env.
2. `native/z2-stack.mjs` (+ `native/z2-auth.mjs` variant) and driver HTTPS trust field.
3. `native/z2-session.mjs` scenario; dev-iteration; final pack; run.

## Update 2: installer/prepare external-root modes

- prepare-replay.py: added `--git-commit` mode (reads only `git archive` objects, blob-sha verified) with `--external-root`; delimited `z2-native` block.
- install-owner.py: added `--external-root`, `--node-version-pin`, `--node-headers-seed`, `--public-env` (delimited `z2-native` blocks). Existing refusal guards unchanged. Not yet exercised.
- Next: toolchain assembly, TLS/anon-key decision, Z2 stack launcher, scenario, pack build.

## Update 3: declared SPKI pin for the loopback https issuer

- native-replay.mjs/schema: optional `authIssuerSpkiSha256Base64` adds Chromium `--ignore-certificate-errors-spki-list` for the declared self-signed issuer; certificate verification is never disabled.
- Decisions: Node 22.23.4 (host-pinned, headers cached) with recorded deviation from repo pin 22.22.3; `NEXT_PUBLIC_SUPABASE_URL` and a non-validated anon placeholder are fixed at install time via `--public-env`; GoTrue `GOTRUE_JWT_ISSUER` is set to the https front so JWT `iss` equals the declared issuer (Z2-owned auth starter copy, shared starter untouched).

## Update 4: install-01 FAILED (public-env gate), harness written

- install-01 (commit 7aa6238): all 48 steps passed; engineeringStatus FAILED only because my public-env inlining gate also required NEXT_PUBLIC_OS_API_URL in client chunks, but that variable is server-only (proxy prefers FINNOR_OS_API_URL). SUPABASE_URL/ANON_KEY were inlined correctly. Fix: drop the server-only variable from --public-env; no installer code change. Evidence retained at fzv-z2-pack-w2/install-01.
- Added finnor-os/scripts/project-z/native/: z2-auth.mjs (https issuer via GOTRUE_JWT_ISSUER), z2-app.mjs (next start + NODE_ENV=test + receipt build ids), z2-stack.mjs (pack-root runner, TLS front, scenario-owned worker), z2-fixtures.mjs, z2-expected.py (independent hand profile via original-oracle game reader), z2-session.mjs (users, fixtures, drain, owned replay worker, target, driver).

## Update 5: successor session (HEAD 3c0180d)

- Installs: w2-install-03 and w2-install-04 each passed all 48 steps (engineeringStatus PASSED). install-04 was built from 3e72da5; its pack predates the mixture qualificationRef fix (3c0180d), so w2-install-05 is built from 3c0180d for the final run. Pack for install-03 was removed after install-04 passed (evidence and PACK_REMOVED.txt kept).
- Stack runs: dev runs w2-dev-01..04 failed on harness defects (G4, G5, scenario directory, plpgsql ambiguity fixed by merging the integrated tip). w2-native-01 (install-04 pack, no overlay) reached negative-fixtures: all four case fixtures (claim/checkpoint/artifact/partial) were created through the real API; `negative-fixtures` failed with 422 `Y3_QUALIFIED_SUPPLIED_MODEL_BINDING` (G6).
- Driver stages (browser login, kill/restart per boundary, allowance exhaustion, six negatives, mounted Work, oracle comparison) have not run yet.
- Next: w2-install-05 then w2-native-02 on the unmodified install-05 pack.
