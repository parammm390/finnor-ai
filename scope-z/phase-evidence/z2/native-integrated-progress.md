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
