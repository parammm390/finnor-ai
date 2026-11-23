# Exact request 06, serialization repair only

Manifest SHA-256:
`c2ba6bcbeee7c8f5ccb5c2fbb3f356b8a05170ecb0e130b582852e157572a18b`.
Patch SHA-256:
`11ec9cb7d2a000d617f5fa8c42786832105da34a13cdc19ee1d9118228a4a354`.
Unapplied SQL SHA-256:
`b461945e729aeee02c90eec947c9b45db1fc5b7fdebb2d808587dcfd151fd71c`.

The only patch change from 05 is the added `new file mode 100644` header
for the absent `InstitutionCompositionPanel.tsx` preimage. All eleven source
pre/postimages, modes, symbols and migration metadata are unchanged.
The actual shared file remains absent. No source, SQL, index or gate is applied.

Actual generation, strict read-only Git checking and independent byte
verification each exit **0**. Changed Python syntax exits **0**, without
executing the blocked packager.

Evidence:

- `../../integration-request-06-assembly.log`
- `../../integration-request-06-git-check.log`
- `../../integration-request-06-verification.log`
- `../../syntax-check-06.log`
- `../../integration-patch-failure-model-01.md`, written before the fix
- `../../integration-patch-check-01.json`, original five failures

Repeat only the read-only patch check:

```sh
git -C /home/factory-user/repos/finnor-z5 apply --check --whitespace=error \
  /home/factory-user/repos/finnor-z5/scope-z/phase-evidence/z5/integration/request-06/shared.patch
```

This does not authorize applying shared files. The coordinator must accept
or exactly rebase every preimage, assign the real migration/head/bundle and
regenerate canonical outputs. Missing DB/Auth/custody and the independent
Shield commit denial remain unchanged. Original requests 01–05 are retained.
