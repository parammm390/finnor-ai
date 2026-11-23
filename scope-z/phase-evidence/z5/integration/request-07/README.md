# Exact shared request 07, not applied

Base/head: `9f3edfd3b4c6758832c53139da0773218062191e`.
Manifest SHA-256:
`fb88fe4dc4b23d46927a92c716f8d64c2edfc2f33389f9282b4285fdd9a35f5c`.
Patch SHA-256:
`793cd28d935908cc50d3eebee513f0deda0e2f39e7f9e3e12d90a340a6794ef7`.

All eleven preimages, ten other postimages and migration metadata match 06.
The sole changed postimage is the original policies route. Its new
composition-plan case catches only bounded Z5 errors as expected 403/409
refusals, leaving all original non-Z5 handling intact. No owner, control,
effect, protected-admission or production authority is granted.

Actual assembly, strict read-only Git checking and independent verification
each exit 0:
`../../integration-request-07-assembly.log`,
`../../integration-request-07-git-check.log`,
`../../integration-request-07-verification.log`.
Backend 12 checks these actual virtual source bytes, exit 0. Unchanged
frontend/lint source retains its earlier receipts; those are not new runs.

Actual strict check:

```sh
git -C /home/factory-user/repos/finnor-z5 apply --check --whitespace=error \
  /home/factory-user/repos/finnor-z5/scope-z/phase-evidence/z5/integration/request-07/shared.patch
```

The SQL body remains
`b461945e729aeee02c90eec947c9b45db1fc5b7fdebb2d808587dcfd151fd71c`,
unexecuted and without an invented migration name. Coordinator application/
rebase, real migration/head/bundle, generated outputs and integrated builds
remain separate work requiring their own authority. Requests 01–06 are
immutable history, not alternate permissions. No coordinator gate is written.
