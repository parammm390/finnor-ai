# Z0 exact reviewed-membership recipe

This is an engineering recipe, not authorization to build or run native cases.
The only executed new flow is metadata normalization and verification.
No product files or installed dependencies were copied.

## Frozen input and existing interface

- Coordinator HEAD: `9f3edfd3b4c6758832c53139da0773218062191e`
- Coordinator tree: `2dc4d5bc13d22853cf4dc9feb5f6ac7fbf6bb9c9`
- SHA-256 of UTF-8 `git diff --binary`, with trailing whitespace removed by
  JavaScript `trimEnd()`:
  `45557d982b550ac355e945d4ddf80434cc4d8f107f01646f1919dae1a06d6b05`
- Named reviewed receipt SHA-256:
  `aa97d0ff34a38d818fde1d79298e767d4639a993875678c133a37de7f3b57911`
- Its compact JSON file-row membership SHA-256:
  `cefb4d5aeec7250a9bf5e30bb0e3641d0bdcc3cb14d3b108be72bfc67775c737`
- Normalized `additional-coordinator-source-index.v1` SHA-256:
  `dd2c5a8a4f2069ab569dfec8877ba6412e43c0b6825ceb5d4837b76474a62354`
- Metadata-only prospective collector population:
  `33d82ae209cd103c6419ed9b72094928e94fd1ec3dfef629112122d9ddc57efe`,
  3,156 files, 48,829,074 bytes.

The 170 explicitly supplied paths include 143 untracked paths. All 22 Z3
owned and four composed shared postimages, all 17 new Z3 leaves, and their
file modes match. No untracked-file search supplies membership. The normalizer
adds byte lengths and source-cut anchors to the existing input format. It
does not replace the canonical capability inventory or coordinator authority.

`prepare-converged-source.mjs` already accepts this exact interface, bounded
to 4,096 rows, 16 MiB per member, 64 MiB total and a 1 MiB index. Its SHA-256
is `67f93374367af4d0c87a1df3ac9c5517cf8e1e45287f1fc6402413548a7bc15c`.
The evidence adapter pins that implementation and checks its allowlist.
Actual collector materialization of this new cut was NOT_RUN because the
user forbids new copies/builds below the guard.

All 36 Z0-owned files equal both product commit
`5ad4e8d75c61b9cc1ee273cc14f8d8068d5ebd41` and adopted coordinator bytes.
`current-adopted-proposal/` is an honest empty delta, with an empty patch.
Do not substitute the obsolete 99-member index or older owner-use proposal.

## Read-only verification, executed successfully

```sh
flock /home/factory-user/repos/finnor-z-shared-heavy.lock \
  /home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin/node \
  /home/factory-user/repos/finnor-z0/scope-z/phase-evidence/z0/execution-20261025/attempt-06/normalize-reviewed-membership.mjs \
  --verify
```

This verifies frozen bytes without refreshing the cut. A changed receipt,
driver, source, mode, membership or Git cut refuses. `--emit` is one-shot:
the delivered outputs already exist and must not be overwritten.

## Future fresh capture/reconstruction, BLOCKED, NOT EXECUTED

The coordinator's combined-build guard remains 4 GiB. The fresh-reconstruction
recipe additionally keeps the earlier 6 GiB fresh-target guard, rather than
reusing the prepared-target exception or lowering a guard. Current available
space is below even 4 GiB. No cleanup or independent Z1 replay is authorized.

The coordinator now typegens before its source cut. If typegen or another
authorized edit changes this frozen cut, obtain its reviewed receipt and
make a new owned, hash-bound input first. Never silently refresh this input.
Only after coordinator-authorized capacity and a matching cut:

```sh
(
  set -eu
  flock -x 9
  /usr/bin/python3 - <<'PY'
import os
p = "/home/factory-user/repos/finnor-z0"
s = os.statvfs(p)
assert s.f_bavail * s.f_frsize >= 6 * 1024**3, "FRESH_TARGET_STORAGE_GUARD"
PY
  N=/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin/node
  R=/home/factory-user/repos/finnor-z0
  E="$R/scope-z/phase-evidence/z0/execution-20261025/attempt-06"
  S="$E/future-current-source"
  T="$E/future-current-installed"
  test ! -e "$S"
  test ! -e "$T"
  "$N" "$E/normalize-reviewed-membership.mjs" --verify
  "$N" "$R/finnor-os/scripts/project-z/z0/prepare-converged-source.mjs" \
    --coordinator=/home/factory-user/repos/finnor-z-coordinator \
    --proposal="$E/current-adopted-proposal" \
    --coordinator-source-index="$E/additional-coordinator-source-index.json" \
    --output="$S"
  /usr/bin/python3 - "$E/current-combined-source-reference.json" "$S/source-snapshot.json" <<'PY'
import json, sys
reference, captured = [json.load(open(p)) for p in sys.argv[1:]]
assert captured["sourcePopulationSha256"] == reference["sourcePopulationSha256"]
assert captured["files"] == reference["files"]
assert captured["ownedDeltas"] == []
PY
  /usr/bin/python3 "$R/finnor-os/scripts/project-z/z0/freeze-source-archive.py" \
    --installation="$S"
  "$N" --max-old-space-size=4096 \
    "$R/finnor-os/scripts/project-z/z0/reconstruct-converged.mjs" \
    --installation="$S" --output="$T"
) 9>/home/factory-user/repos/finnor-z-shared-heavy.lock
```

These commands use actual accepted CLI names. The default reconstruction
requires a new, absent output and installs both dependency locks, builds
native assets and the real frontend, seals it, emits the closure and runs the
offline doctor. The archive contains no modules or Git objects; archive
reconstruction does not require donor Git history. Source acquisition uses
the coordinator's tracked list plus the 170 named paths.

This default engineering command does not supply public Auth build authority.
A future authenticated build additionally requires the separately delivered,
expiring source-bound `--public-auth-input=/absolute/delivered-input.json`
and its explicitly named public environment inputs. Do not invent them.

## Historical reconstruction and native repeat

Run 21's actual `--prepared-target-*` command is a historical command receipt,
not a reusable replay command. `installation-18-proposal` is now built and
correctly refuses the source-generation-only prepared profile. Never erase
its markers or reuse it as an unbuilt target.

The retained historical capsule is
`/home/factory-user/repos/finnor-z0/scope-z/phase-evidence/z0/execution-20261024/continuation-01/installation-21`.
Its archive SHA-256 is
`6666aeaed71c53a407fafdfc05b2008fe42e2e2d67ba5d2f119168b6308347ae`.
A later authorized repeat must use default `--installation=<that absolute
capsule> --output=<new absent owned target>` under the same lock and guards.
It would repeat historical population `ded45547...`, not current population
`33d82ae2...`.

The implemented native driver has 54 cases per SOURCE/INSTALLED target.
Neither its doctor nor missing-authority refusal runs those cases. After
actual source-bound DB/Auth/process authority, complete independent oracle
and public build input arrive, its exact invocation is:

```text
<pinned Node 22> <target>/runtime/finnor-os/scripts/project-z/z0/run-native-e2e.mjs
  --run
  --authority=/absolute/actually-delivered-authority.json
  --oracle=/absolute/actually-delivered-original-semantics-oracle.json
  --oracle-sha256=<actual independently committed SHA-256>
  --output=/absolute/new-owned-evidence-directory
  --ack=ALLOW_Z0_DISPOSABLE_NATIVE_FLOW_ONLY
```

The angle-bracket values above are documented inputs, not delivered authority.
No native invocation is authorized now. Real mounted Auth, original parent,
physical recovery and installed native repetition remain separate NOT_RUN
obligations.
