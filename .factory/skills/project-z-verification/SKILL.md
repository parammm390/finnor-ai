---
name: project-z-verification
description: Verify a Project Z phase through an isolated real native owner flow, independent original-semantics checks, mounted Work, physical recovery and a separately installed rebuild. Use for Z0-Z5 implementation or handoff verification, not as evidence that this source-grounded procedure has already run.
---

# Project Z verification

## Authority and honest current state

The full locked Project Z PRD and common contracts govern. All LLM work uses
gpt-6.1-sol/max, no fallback. This skill does not authorize provisioning,
subagents, external sends, production access, grants, signers, paid effects,
commits, pushes or deployments. Current phase authority and coordinator
ownership decide writes. Protected admission belongs to independent custody.

This is a **new source-grounded skill**, not the unavailable historical
boundary-verification skill. At authoring, product-runtime verification and
separately installed reconstruction are NOT_RUN. Do not claim this skill
already drove a real Work, authenticated a user or verified a Z mechanism.

## Doctor: establish an owned target before mutations

1. Read AGENTS.md, the complete seed, its lock/receipt and mandatory companion
   read map. Run `python3 scope-z/prompts/assemble.py check` from the actual
   destination repository. Check all original lock members, source commit/tree,
   delivery inventory and active own phase. Missing bytes are NOT_DELIVERED.
2. Record actual `git rev-parse HEAD`, `git rev-parse HEAD^{tree}`,
   `git status --short`, Node/npm/Python/native compiler versions, package/
   dependency lock hashes and installed build identity. Run commands with
   an explicit absolute repository cwd. Root requires Node 22.x. A source
   hash or requested model flag is not an installed-runtime receipt.
3. Before product code, write feature/failure/expected-value maps. Read real
   callers and installed Next documentation for relevant edits. Inventory
   environment **names only**, never print credentials or .env contents.
   Require an explicitly authorized disposable tenant/database, real local
   test-owner credentials, same frontend/API Supabase Auth project and owned
   process/port identities. Disable live providers/effects; loopback alone
   does not make inherited auth/provider connections disposable.
4. Source-grounded launcher:
   `node scripts/centropy/start-certification-stack.mjs --name=project-z-proof`.
   It writes .centropy-certification/project-z-proof/stack.json, migrates and
   seeds a persistent disposable DB and starts frontend/API/worker. Its ports
   are fixed 3001/3101/55441 even for different names. Run one such stack at a
   time; do not borrow or kill another person's listener. It deletes
   AUTH_DEV_BYPASS and requires configured real Auth. If auth or isolation is
   unavailable, record the blocker; a fake owner or bypass is not a substitute.
   `--production-build` exists but requires both actual .next/BUILD_ID files.
5. Root check commands actually present: `npm run workspace:check`,
   `npm run centropy:manifest:check`, `npm run centropy:coverage:check`,
   `npm run centropy:client:check`, `npm run centropy:forms:check`.
   Workspace typecheck: `npm --prefix finnor-os run typecheck`.
   Root `npm run lint` and `npm run build` exist. Run only affected checks
   with bounded resources and an actual exit/status receipt. The release
   generated-preflight chain includes writers, so do not call it a doctor.

Do not run a launcher, migration, seed or fault injection in a prompt-only
task. Do not print URLs containing credentials or export them into evidence.

## Drive: actual actions and durable identity

Existing basic browser check, after the owned stack is ready:

```sh
cd /absolute/path/to/the/owned/repository &&
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3001 \
PLAYWRIGHT_OUTPUT_DIR=test-results/project-z-scratch \
node scripts/centropy/run-local-e2e.mjs \
e2e/centropy-owner-login.spec.ts --project=desktop-chromium --workers=1
```

The path above is documented syntax, not an active unresolved phase field.
Select the actual absolute checkout before executing it. The launcher loads
test-owner credentials locally and enforces loopback. It does not provision
the stack. The test checks /api/centropy/me and reload, not Project Z semantics.
All skipped tests mean NOT_RUN for the skipped behavior, never PASSED.

For phase proof, use the existing mounted /centropy login, root/Work controls
and real authenticated actions/query interfaces. Existing selectors include
Email, Password, Sign in, Message CENTROPY, Send instruction, and the CENTROPY
conversation region. Recheck actual installed selectors instead of assuming
the snapshot is current. Record sanitized inputs and actual returned original
Work/thread/input IDs. Do not invent a new /api/project-z endpoint or claim
a phase-specific runner exists before implementing it.

Trace the same original ID through actual job claim/fence, bounded producer,
independent checker process, persisted artifact and native owner consumer.
Bind current rights/source/terms/code/checker/consumer and parent
reservation/deadline/budget. Exercise shared S5 and S6 only within explicit
disposable authority. Preserve independently observed effects or UNKNOWN.
Include negative tenant/private-use, stale/revoked, unsupported, incomplete
and resource cases, plus a real useful supported positive.

Phase-specific independent expected values:

| Phase | Required independent semantic oracle |
|---|---|
| Z0 | Real authenticated HTTP/DB query identity, canonical inventory denominator, original-parent reachability |
| Z1 | Original per-Work direct exact initial/update/edit/retraction computation, not the shared DAG |
| Z2 | Full native Y3 sequential/common-tremble floor and complete lawful correlated coalition plans/LP witnesses |
| Z3 | Original arena and all reachable strategy-memory branches, every fair bad cyclic SCC, separate nonvacuity |
| Z4 | Original integer interpreter/compiler correspondence and the actual pinned relation-bound proof verifier |
| Z5 | Original coupled finite composition, nonempty actual assumption discharge, preorder and live-state bridge |

## Observe: actions plus persisted and user-visible state

For every feature, retain action, expected-value provenance, authenticated
response, durable original-ID evidence and reloaded mounted Work. Screenshots
alone do not prove DB state; SQL alone does not prove owner consumption.
Observe computation disposition, source/currentness, checker result, owner
use, S5 capacity, S6 obligations/UNKNOWN/reconciliation, S7 costs, exact
conditionality, security limits and separate qualification states.

Use actual Work reads such as /api/centropy/works/{actualWorkId} under the
authenticated proxy; braces here document URL syntax, not a fabricated ID.
An original counterexample, rejected falsifier or unsupported result remains
visible. Completion means the independent expected state, not disappearance
of an error. Reload, switch session/root and use keyboard/semantic controls
where relevant. Cover all mapped user-visible features, not just login.

## Physical recovery and remaining-budget fallback

Kill only an owned producer/worker at declared durable boundaries, then
restart the actual worker from the same owned stack/source build. Prove claim
fencing, duplicate handling, preserved original IDs, reservations, deadlines,
remaining resource receipts and no unauthorized effect replay. Record a real
physical exit and restart, not only an in-memory exception. Retain UNKNOWN
and outstanding S6 obligations through timeout/cancel/restart.

Existing e2e/centropy-controlled-recovery.spec.ts is a narrower example. It
requires CENTROPY_DISPOSABLE_E2E=1 and a guarded disposable admin DB at
127.0.0.1:55441/finnor, temporarily changes a read permission and restores it
in finally. It is a privileged mutation, not a harmless smoke test, and it
does not prove once-only external effects. Use it only with explicit local
DB authority; never infer that authority from this skill.

## Separate installed proof and replay artifact

Rebuild/install the phase's final source on a separately isolated target with
no borrowed node_modules, undeclared local Git objects, hidden native assets,
source fallback or unrecorded dependency/toolchain. Record exact source/base/
head/tree, install/build commands, dependency and native asset hashes,
build IDs, runtime target, authenticated original Work IDs and repeated
owner consumption/UI proof. Source E2E and installed E2E have separate states.
No frozen final implementation means installed-development is not PASSED.

Each finite run retains an immutable artifact outside Playwright's output
directory, which Playwright clears on a later run. Include sanitized inputs,
steps, independent expected values, actual observations, exit codes, skips,
source/build/toolchain, seed/pack/lock digests, evidence hashes, replay command,
environment variable names, complete costs/meter gaps, failed attempts,
remaining budget/obligations and coverage/gate dispositions.

Existing browser proofs include actorEmail. Restrict originals locally and
make redacted derivatives before any explicitly authorized delivery; never
send tokens, credentialed URLs, PII, private observations or live data.
Keep failure proofs and their digests when rerunning. A later pass does not
erase a previous failure or justify changing its expected value.

## Cleanup and final coverage

Stop only owned recorded stack/process IDs, preferably signal the launcher so
it stops its children/embedded database. Do not broad-match processes or
delete another fixture. Restore explicitly injected local permissions, retain
the persistent disposable database/evidence as required for replay, close
owned browser contexts and record remaining reservations/UNKNOWN. Do not
delete exposure or call cancellation compensation.

Report each feature's doctor/drive/observe/recovery/installed coverage.
Separate doc drift from product defects and separate internal incompleteness
from real external custody/authority blockers. Apply the current common
qualification states to each gate. Final phase handoff uses IMPLEMENTED,
CHANGED, EVIDENCE, COMPLETION GATE, REMAINING LIMITATIONS, FRONTIER DELTA,
NEXT DEPENDENCIES. No assembly check, login smoke, checker microbenchmark or
this skill's existence establishes protected admission, operational/financial
100×, whole-code correspondence or production activation.
