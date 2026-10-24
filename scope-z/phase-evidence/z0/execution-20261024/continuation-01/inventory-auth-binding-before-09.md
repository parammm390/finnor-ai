# Z0 inventory authentication and bounded packaging failure map

Recorded before these next source edits in this same phase session. This is a
current source inspection, not a historical pre-code read receipt or an
authenticated execution result.

## Actual preimages and failure

Current HEAD: `a1c393ff7464972af04d67ad1c993815111e5cdc`.
Coordinator: `9f3edfd3b4c6758832c53139da0773218062191e`.

- `native-observation-child.mjs`:
  `7503a1fa367185725c9bea17ffb2312ed4af7112333e79554f8c8f4414b67512`.
- `run-native-e2e.mjs`:
  `0b6e24b973865477620fc3f245106f66215801c679e464baec92934b10d107c1`.

The driver sends the real session bearer and expected existing actor for both
QUERY and INVENTORY. The child calls canonical `requireContext` and compares
tenant, principal and owner role only inside QUERY. INVENTORY returns the real
registry without using that bearer. The parent nevertheless labels both as
`REAL_AUTH_NATIVE_QUERY_OWNER` and does not require an authenticated actor in a
successful child result. A prior login does not establish authentication inside
this child. This is a statically observed verification gap, not a newly executed
unauthenticated request.

The actual canonical `apps/api/lib/auth.ts` requires a bearer with bypass off.
Its context contains `tenantId`, `userId` and `role`. Use that existing owner;
do not create an Auth implementation, a new route, a tenant or an identity.

## Closed change and expected values

1. Validate a nonempty bearer and the existing QUERY intent restriction before
   either native operation. Use canonical `requireContext` for both operations.
2. Before inventory or operational owner invocation, require its real context
   to match the expected tenant and principal, with role exactly `owner`.
3. Both successful child results contain only the three relevant authenticated
   actor fields alongside their existing payload. No token, email or full
   context is written to evidence.
4. Parent exit 0 requires a non-refusal result and the matching authenticated
   actor. Parent exit 2 requires a typed refusal. Mismatched/missing identity,
   null/malformed results and success/refusal exit contradictions fail closed.
5. Retain a sanitized per-step actor witness and an observation, rather than
   query-only, label. Keep the 54-case plan, all original Work/budget/recovery
   predicates, canonical registry and scientific scope unchanged.
6. Native Auth positive, invalid bearer and foreign-actor runs still require
   actual disposable authority. Do not simulate them or promote syntax/doctor
   checks into those runs. Source and installed 108-case coverage remains
   NOT_RUN until the guarded actual flow executes.

## Failure classes to preserve

- Missing/empty bearer; unknown QUERY intent; real Auth failure.
- Real context from a different tenant or principal; a non-owner real role.
- A successful child without its real actor, with a forged actor, with
  `refused: true`, or with null/non-object JSON.
- A refusal exit without a typed predicate, or a success exit mislabeled as a
  refusal. Existing typed business refusal inside an authenticated QUERY
  response is distinct from child-level refusal.
- Native module/root escape, target loader/code drift and stdout/timeout bounds
  remain governed by the existing driver. No mock, alternate owner or new
  authority switch is permitted.

## Current resource boundary and source delivery

The previous reconstruction launch was canceled without an exposed cause or
exit. Do not repeat it. The last disk observation was 44,784 KiB available at
100% use, less than the 47,206,840-byte source staging population alone.
Full install/build needs substantially more and remains NOT_RUN.

Safe independent packaging may stream a complete, deterministic source tar
directly from the same live coordinator plus these owned leaves, without an
extra uncompressed staging copy. Its failure map, before that packaging code:

- Pin installation-12 snapshot SHA
  `a4f0b08ebcd271847848900ba714277682a1ce404a0a6bb5f1e405eadcd89de0`,
  original population
  `63bca8ad8ffff6787230683716f4127beda13a60a923584c964512e1c794bb30`,
  and base archive SHA
  `f900d214b0f114918d5f5f7490c9c9a19e7007a89a07354538ccf616ab98cc47`.
- Accept only the same 3,040 declared regular source paths and the exact two
  named owned changes above. Rehash every unchanged live file, mode, current
  Git cut and unchanged shared CSP preimage before/after capture. Refuse
  undeclared owned files, symlinks, dirty source or coordinator drift.
- No dependency tree, private fixture, environment file, Git object or service
  belongs in the archive. Preserve the original member order and modes,
  deterministic tar/Gzip metadata and the snapshot population algorithm.
- Output a fresh installation-14 archive, snapshot, archive descriptor and
  capture receipt. Its `runtime` is a declared future reconstruction path,
  explicitly not an existing staged or installed runtime. Never overwrite
  installation-12 or claim its old build applies to changed source.
- Use the shared heavy lock nonblocking. Require headroom for the capped new
  archive, an additional Git copy, and 16 MiB untouched margin. Cap compressed
  output at the original archive size plus 1 MiB. Refuse before source archive
  creation on inadequate space or a busy lock. Do not loop either refusal.
- Validate every actual tar member, exact bytes/modes/population and live input
  cut. An archive passing this check is source packaging, not a reconstructed
  executable or a native positive. Preserve any failed capture receipt.
- If source capture cannot proceed, preserve an exact owned preimage-bound
  patch and current source identities. Do not delete retained/user files,
  authorize a rebuild, bypass CSP or create services to make progress.

Allowed checks: actual Node 22 syntax for the two changed files, existing
side-effect-free driver doctor, existing missing-authority refusal and assembly
lock check, then actual bounded source-archive capture/custody if resources
permit. No new post-code unit tests. Full backend/frontend/reconstruction/native
checks must retain NOT_RUN for current source if resources/authority block them.

Pending shared CSP application, the independent precommitted full native oracle,
existing two-target DB/Auth/process authority, mounted production-build Auth
input and protected/financial custody remain separate, unchanged dependencies.
