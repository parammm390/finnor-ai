# Complete reconstruction and guarded native replay

Native execution, SQL execution, Auth, mounted business flow and physical recovery
are NOT_RUN. Neither reconstruction nor these commands grant that authority.
The coordinator still owns shared application and the Z0 slot.

## Engineering reconstruction

`prepare-converged-source.mjs` reads actual coordinator bytes, the exact-current
three-file proposal and owned implementation. `freeze-source-archive.py` freezes
every declared source before npm, Next or the custody adapter can alter it.
The archive contains no dependency tree, credentials, private fixture or Git
objects. The source manifest names every byte and its provenance. A later commit
containing receipts does not change the bound implementation source.

`reconstruct-converged.mjs --installation=/absolute/frozen-installation
--output=/absolute/new-owned-evidence-target` verifies the archive and starts
from an empty target. Run it with Node 22 and the shared heavy lock, 4096 MiB.
It performs independent root/backend lock installs with lifecycle scripts
disabled, an explicit fs-ext source rebuild, a version-bound browser download,
full backend types, the actual mounted Next standalone build, complete ESM
emission and offline native/closure doctors. Every subprocess has its own
immutable command, exit and log hash. It does not initialize/migrate a database,
load Auth credentials, start an API listener or execute a business owner.

The emitted source map closes computed original TS URLs to emitted JS. The
declared installation-only AST transform replaces import-meta source custody
and actual subprocess TS-loader operands. The fixed loader refuses TS execution.
Original source remains hashable evidence. All fresh dependencies, native files,
internal links, API routes and checker pins are inventoried. System shared
library versions remain explicit platform prerequisites, not copied donor assets.

## Native plan, safety doctor and missing authority

`run-native-e2e.mjs --plan` lists the closed case population.
`run-native-e2e.mjs --doctor` imports no DB/browser/native owner and records NOT_RUN.
`run-native-e2e.mjs --run` without the separate authority refuses before effects.
No fabricated successful fixture is supplied.

An eventual explicitly authorized invocation also requires absolute `--authority`,
`--oracle`, `--oracle-sha256`, `--output` and
`--ack=ALLOW_Z0_DISPOSABLE_NATIVE_FLOW_ONLY`. The oracle digest must match a
separate expiring Z0 authority. The driver never accepts SQL or shell recipes.

The authority schema is `finnor.project-z.z0.native-authority.v1`. It binds this
session, Z0, expiry, synthetic-only existing canonical native owner records,
disposable internal effects, no provisioning, no Auth bypass, source population,
oracle digest, physical-recovery permission, and exactly SOURCE / INSTALLED
targets with different disposable databases. Each target supplies exact
root/source/build/loader identities, real owner/tenant IDs, real Auth origin,
API/frontend/application origins, owned PID/start-time/executable/argv hashes,
an independent worker process group, exact allowed authenticated HTTP operations,
and environment **names**, not credential values. The driver checks listener
socket ownership. Cascading launchers cannot satisfy physical-recovery custody.

Target environment-name fields are `observerDatabaseEnv`, `ownerEmailEnv`,
`ownerPasswordEnv`, `authAnonKeyEnv` and `nativeEnvironment`'s explicit name map.
The latter only admits canonical DB/Auth/worker flags; providers, AWS, payments,
Auth bypass and arbitrary NODE_OPTIONS are refused. The observer role must be
non-superuser/non-BYPASSRLS and default read-only. No role creation/grant occurs.

The independent oracle schema is
`finnor.project-z.z0.original-semantics-oracle.v1`. It declares not candidate
derived, committed before acquisition, the full literal 77-entry inventory,
and complete case fixtures for both targets. Case fixtures bind actual original
Work/input/reservation/thread IDs, original standing-input provenance, exact
resource limits, authenticated native HTTP steps and independently expected
responses/durable states. A useful G1 case includes every original observer
business field, creation deadline, the actual frozen owner payload, typed
checker result, native model-use materialization and canonical owner row.
Negative/currentness cases require real changed-dependency observations and a
typed refusal, not a forged response. Missing cases cannot silently skip.

Harness and confidential D1 intentionally have no public query admission. The
native observation child uses the actual API `requireContext` with a real bearer,
then the existing original orchestrator owner. It never accepts a supplied ctx.
Mounted real login, `/me`, original Work HTTP/DB identity and reload are separate
checks. No new product route is introduced.

Recovery pauses only the exact owned independent worker group, observes the
actual claim/artifact/ambiguity boundary, physically kills it, proves exit and
restarts the same source/build entry. Same-job fence increase, original IDs,
reservations, deadlines, exact resource limits, outstanding S6 and duplicate
action constraints must survive. A missed/advanced boundary fails. Native
attempts retain immutable case/failure artifacts; synthetic mounted screenshots
mask the test-owner email. New restarted workers, browser and observer are closed
at the end. No cancellation, compensation or financial conclusion is inferred.
