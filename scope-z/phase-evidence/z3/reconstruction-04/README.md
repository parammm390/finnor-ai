# Frozen source-only distribution

Source cut: `c6b1df57b4602521c1b5369143f44289afd48beb`.
Tree: `c7fa1e3abe61cf25dcc5bc49f8f53f16ea42fcbc`.
3154 regular files, 1740 canonical production sources, sixteen exact patches.

Keep `manifest.json`, `source-inventory.json`, `source-modes.json` and
`source.tar.gz` together. To reconstruct without this worktree, copy those
four files into a fresh directory and extract `source.tar.gz` into its fresh
`source/` subdirectory. The packaged stdlib-only verifier runs with:

```sh
node /absolute/reconstruction/source/finnor-os/scripts/project-z/z3/verify-reconstruction-source.mjs \
  --reconstruction=/absolute/reconstruction \
  --output=/absolute/fresh-source-check
```

Use pinned Node 22.23.4. No dependencies, Git objects, DB/Auth or listener
are needed for this source-only check. The separate original-cut receipt
also checked canonical membership against the exact committed tree.
No installed/native success is claimed. Do not run installs/full builds
without safe headroom and renewed permission. See the current handoff and
`reconstruction-correction.md` for exact hashes, failures and all gates.
