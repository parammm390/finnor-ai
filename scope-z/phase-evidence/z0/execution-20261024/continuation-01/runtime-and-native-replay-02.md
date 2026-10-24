# Final reconstruction and native replay addendum

This supersedes the operational details in `runtime-and-native-replay.md`.
It does not grant native execution, DB, Auth, process or effect authority.
Native source, native installed, mounted business flow and all three physical
recovery cuts remain NOT_RUN. The coordinator alone owns the Z0 slot.

## Archive-only engineering replay

Use the source archive, `source-archive.json` and `source-snapshot.json` in
`installation-08`. No donor dependency tree, private fixture, credentials or Git
objects belong to this input. The recorded Node 22, npm, Python, C++ compiler,
make and OS shared libraries remain explicit platform prerequisites.

Run `finnor-os/scripts/project-z/z0/reconstruct-converged.mjs` with the recorded
Node executable, `--installation` set to that absolute input directory and
`--output` set to a new absolute directory under this worktree's
`scope-z/phase-evidence/z0/`. Hold
`/home/factory-user/repos/finnor-z-shared-heavy.lock`; use a clean environment,
the recorded Node-first PATH and 4096 MiB Node heap limit. Do not reuse an old
runtime or overwrite a failed attempt.

The recipe verifies every archive member and extracted source byte, proves
parent Git discovery actually fails with exit 128, installs the two locks
independently, explicitly rebuilds fs-ext, downloads the pinned browser, checks
the full backend, and records every actual type input inside the new target.
It builds the actual Next standalone frontend and emits the API, worker, bridge,
independent checker, route graph, loader, full dependencies and native assets.
The offline doctor also invokes the original canonical checker URL through the
fixed installed loader. No TypeScript runtime fallback is accepted.

`GIT_CEILING_DIRECTORIES` names the **parent** of the target root. Naming the
current root failed in installation-05 and is not a valid isolation proof.
The exact source population is the Sentry release, avoiding opportunistic
ancestor-Git version discovery.

The immutable emitted runtime is root-bound. Reconstruct at another absolute
root rather than moving an already sealed runtime with fixed custody paths.
The full installation manifest is retained outside the generated runtime, not
just its counts. It is also available inside the runtime for actual custody
validation. Platform libraries are declared and hashed, not secretly borrowed.

## Public browser Auth is a build input, not native permission

The real browser reads two literal `NEXT_PUBLIC_SUPABASE_*` values. Next freezes
them during `next build`; setting them only when starting the server is too
late. With no public build input the recipe records `NOT_DELIVERED`. Such an
engineering build is not an authenticated-ready installation.

An eventual explicitly delivered `--public-auth-input=/absolute/file.json`
must have exactly these fields:

- `schema`: `finnor.project-z.z0.frontend-public-auth-build-input.v1`
- `phase`: `Z0`
- `sessionId`: `66647028-fac4-4793-bec3-22b564d12b90`
- `sourcePopulationSha256`: the actual frozen source population
- `expiresAt`: a future expiration at build intake
- `authOrigin`: the exact authorized loopback HTTP origin, without a path
- `publicUrlEnv`, `publicAnonKeyEnv`: explicit environment **names**

No values or example token are supplied here. Only a public publishable key or
anonymous-role provider key is admitted; service-role, secret and user keys
are refused. Public inputs reach only the actual Next build subprocess.
Receipts retain source/input/key digests and environment names, not values.
No Auth request occurs during this engineering recipe. New public inputs
require a fresh reconstruction and new immutable runtime manifest.

Installed native preflight requires that build receipt to match the separately
authorized real Auth origin and public key. A matching receipt still is not a
real login, an independent DB observation or owner-use proof.

## Native authority and independent expectations

The authority and oracle schemas and all 54 cases per SOURCE / INSTALLED target
remain as documented in the earlier replay document. Both targets must supply
`sourceSnapshotSha256`, the actual hash of their adjacent `source-snapshot.json`,
in addition to the common source population. The driver checks all actual source
bytes, only the declared installation transforms and the real full asset
validator before opening an Auth session or DB observer.

Each worker additionally declares `leaseSeconds`, an integer from 30 through
60. The already-running worker must actually use that preauthorized queue lease.
The driver does not change an original business deadline or resource envelope.
The canonical optional instance flag is `FINNOR_WORKER_INSTANCE_ID`, not
`FINNOR_WORKER_ID`; absent an override the queue uses `worker:hostname:pid`.
Actual executable, entry, environment, process group and claim ownership are
checked before a physical cut. Persistent delivery-attempt rows must prove the
same killed job was reclaimed at a higher fence by the actual replacement.

Each recovery fixture must supply a nonempty independently expected durable
state and exactly one `recoveryOutcome`: `ORIGINAL_OWNER_OBSERVED`,
`TYPED_REMAINING_BUDGET_REFUSAL` or `UNKNOWN_RETAINED`. The ambiguity cut requires
`UNKNOWN_RETAINED`. A fence increase alone does not pass. Original owner state
must be independently observed, typed remaining-budget refusal must not add a
new action/use, and UNKNOWN must preserve every original obligation without
forward use or duplicate/replacement responsibility.

No fake positive, tenant, role, grant, seed, queue substitute or Auth bypass is
provided. Current missing authority means zero executed native cases, not a
skip converted to PASSED. The eventual native invocation still requires the
explicit `ALLOW_Z0_DISPOSABLE_NATIVE_FLOW_ONLY` acknowledgment and complete
separately delivered authority/oracle files. Do not run the existing cascading,
fixed-port certification launcher on the basis of this document.
