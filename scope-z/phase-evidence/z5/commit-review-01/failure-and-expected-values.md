# One reviewed local commit retry, pre-execution contract

Authority: actual coordinator
`coordinator-integration-04/user-authority-revision-20261025-02.md`,
SHA-256 `537ed0c0e6723d604c2a9b2181aa529775e4edf38bc12a96668734bda95fbaf0`.
The exact local inspection is
`z5-shield-local-inspection-01.json`, SHA-256
`5915d943b79264e8258c098362a6f2613b99bba43b9bb0fab166f3b26ce158f6`.
Copies under `authority/` retain those original bytes.

This is existing Z5 attempt 005, not a new execution slot or implementation.
The current 36 implementation files must remain at digest
`017c02c2f1074abfaeb62134602391422d7401bb30071947605159e46d7f1b71`.
Checkpoint 08 and every earlier failed run remain immutable.

## Failure and expected-value map

| Failure | Required behavior |
|---|---|
| Existing retry intent or result | Reconcile it; never launch another commit |
| Stale source or superseded denied index | Stop; review current exact owned selection and stage its current bytes |
| Unrelated staged/user launch paths | Stop; never unstage, overwrite or commit user work |
| Journal changed or omitted | Stop; require unchanged pinned hash and included staged blob |
| Missing configured author/committer | Stop; never set or override identity |
| Shield refusal | Consume the one retry; preserve actual refusal, no unchanged retry/workaround |
| Hook or other commit failure | Preserve actual result and source; no second commit attempt inferred |
| Successful local commit | Verify exact tree, parent, source, journal and required coauthor before packaging |
| Inadequate disk | Preserve original archive/extraction/install guards; never lower them or delete existing targets |
| Missing native authority | No DB/Auth/SQLite, initialization, migration, seed, grant, signer, listener or launcher |
| Duplicate/escaped/changed delivered member | Refuse reconstruction, retain actual failure |

Journal SHA-256 remains
`35b1edeff9cb49f95e2994f28f55866f3bd9422b865b9dbc458b8276f534ae0f`.
Review it only through pinned metadata and streaming hashes; never render
values. It remains included in both staging and any committed delivery.

The exact selected paths are frozen before staging. After reviewing the
staged tree, create the exclusive
`scope-z/phase-evidence/z5/commit-retry-01/intent.json` transaction record.
That record pins the exact selected paths/tree, approval and source digest.
It is created after staging, outside the source cut, to avoid a self-hash
cycle. The later result/log and package outputs are likewise derivatives,
not omitted implementation or a journal exclusion.

Only one ordinary Shield-checked `git commit` is permitted, with configured
identity and enabled hooks. No push, PR, merge, deployment or external send.
Commit success is not coordinator acceptance or release.

## Reconstruction and qualification

Source archive and source-only verification retain their original finite
headroom limits. Dependency installation/full installed engineering retains
the unchanged 8-GiB floor, including point-of-use checks under the shared
heavy lock. Full graph heap remains at most 4096 MiB. No borrowed modules.
If this Computer cannot safely install, provide the complete exact committed
transfer packet for the existing zphasefinnor Computer, without creating or
operating a native target.

The frozen 256 slots remain 84 distinct complete inputs and 50 distinct
positive inputs in 188 positive slots. They are public builder-controlled
development evidence, not 32 independently qualified fresh families.
No population, expectation, denominator or qualification gate is rewritten.
Original Work/parent/deadline/resources, S6 liabilities/UNKNOWN, S7 attribution
and independent S8 admission remain authoritative.
