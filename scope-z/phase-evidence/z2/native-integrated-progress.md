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
