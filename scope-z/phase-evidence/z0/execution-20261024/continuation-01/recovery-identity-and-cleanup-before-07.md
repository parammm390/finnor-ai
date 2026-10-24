# Recovery identity, mounted build and cleanup failures, before repairs

This is a source-grounded failure map written before the next source edit.
The actual starting source is own commit
`1404c893553a838cee2e131c7ee40d9a2474fedf`, coordinator commit
`9f3edfd3b4c6758832c53139da0773218062191e`. Installation 10 freezes those
bytes; installation 11 passed all 11 engineering reconstruction subprocesses.
Neither installation is native-qualified. Preserve both and every earlier
failure unchanged. Coordinator driver review 06 item 3 is not fully fixed in
that starting commit.

## Confirmed failure and independent expected result

| Failure in the starting driver | Required observation / fail-closed result |
| --- | --- |
| `atBoundary(CLAIM)` accepts any running job for the Work; a separate search selects any live job owned by the worker | Independently precommit an exact native job selector: type, owner ID, generation and native enqueue stage. Derive its canonical idempotency key, require exactly one real job and the same scoped original Work/input owner, protocol 1, current token/fence and unfinished delivery by the owned worker. Capture the actual job UUID, entire payload digest and delivery identity at the cut. A different Work job cannot satisfy any part. |
| ARTIFACT accepts any session's model/check refs, not the selected job's artifact | Bind the cut to the exact selected X2 session/generation and its checked model/check refs. Hash and verify both persisted artifact preimages and retain their exact identities. Require no original-owner consumption of that model. The same identities must remain after physical exit and recovery. Do not manufacture a producer pause or queue row to make this boundary observable. |
| AMBIGUITY accepts any unknown obligation under the reservation | Precommit the original X2 request node selector, correlate the selected job/session to the real request, S6 obligation, S5 consumption, effect and canonical action. Require possible egress and an actually unknown/reconciliation-required state. Retain exact request/wire, obligation, consumption, effect and action identities; an unrelated unknown cannot establish the cut or recovery. |
| A higher fence is checked only against whichever job was selected, without preserving type/generation/payload | Recovery requires a new unfinished-or-completed delivery of that same captured job UUID, unchanged type, protocol, payload digest and canonical idempotency key, with a higher fence/token and the replacement worker identity, plus the existing independent terminal outcome. A fence alone still cannot pass. |
| No durable cut receipt exists if the driver fails after SIGKILL but before the final case report | Save a sanitized exact-boundary witness before SIGKILL, then actual exit and replacement receipts as each occurs. Keep them on later failure. Raw claim tokens and private wire preimages never enter these receipts. |
| Case login switching occurs before `try/finally`; a failed alternate login can skip restoration | Enter cleanup before starting logout/switch. Mark restoration as required before the first login change. Attempt source and login restoration independently and fail the whole run on either failure. |
| `runCase` records restore errors but `main` unconditionally sets `completed=true`; a case report is already labelled PASSED | Do not write or count a PASSED case until its restoration succeeds. Propagate a typed restoration failure and retain a sanitized diagnostic. Final qualification must additionally require no retained restore failures and exactly all 108 completed case reports. |
| RIGHTS isolation is optional and accepts a different principal in the same tenant, despite tenant-wide authority revisions | Before Auth/DB/signals, require each of the four RIGHTS cases to use an existing real case owner in its own distinct tenant and principal, separate from the primary and alternate owners and every other case tenant. Reject missing credentials, duplicate tenants or shared principals. Create no users or tenants. |
| An owned listening process can still execute an arbitrary entry; installed mounted build metadata is not tied to the serving process | Bind worker/API entries to the canonical SOURCE entries or installation manifest entries and hash their actual files. Bind the actual dedicated frontend listener to the standalone `server.js`, its exact built assets and current source population/build ID. Seal the standalone closure immediately after the actual Next build; validate that receipt and actual files before any Auth/DB connection, signal or business call. Public Auth must still have been explicitly supplied at build time. |

Native selectors are finite verification inputs, not new product job types or
execution authority. Only X2 can establish the ARTIFACT and AMBIGUITY cuts.
CLAIM may select the actual X1 compiler, X1 institutional continuation or X2
producer. All selectors must resolve through real canonical DB rows. A missed,
expired, ambiguous or already-advanced boundary fails rather than selecting
another job. No new fixture, DB writer, fake native positive, new listener,
Auth bypass or post-code unit test is authorized.

The installed Next output guide and actual installation-11 directories were
read before edits. The actual standalone tree lacks `public` and `static`;
the guide explicitly says Next does not copy those. The new build-sealing
step must stage both from this same build/source target, then seal the complete
self-contained standalone closure. This is an additional confirmed mounted
delivery defect, not evidence that the old native flow ran.

Next can replace `/proc/<pid>/cmdline` with its versioned server title. A
canonical Next title is accepted only together with the exact package
version, Node executable, dedicated listener, actual expected app/standalone
cwd and (for the frontend) a live unauthenticated static asset whose bytes
match the sealed build. It is not a wildcard for arbitrary process entries.
The SOURCE worker entry is the real `apps/worker/src/index.ts`; the SOURCE
API is the actual backend Next binary rooted in `apps/api`. Installed entries
remain the manifest's emitted API/worker. No new launcher is run.

## Additional confirmed CSP boundary, before its repair/request

The actual coordinator `next.config.mjs` includes loopback HTTP Auth in
`connect-src` only when `NODE_ENV=development`. A real `next build` seals
production headers, and the current public-Auth build input deliberately
permits only loopback HTTP. Therefore even a separately delivered correct
public input would produce a browser build whose CSP blocks that Auth origin.
Runtime environment changes cannot repair these baked headers.

Do not edit this coordinator-owned file. Prepare an exact-current-preimage
one-condition request that also permits the already-explicit disposable
`FINNOR_X1_FRONTEND_INSTALL=1` build profile to include the same strictly
validated loopback Auth origin. Normal production remains unchanged. The
native mounted-build validator must inspect the actual compiled
`routes-manifest.json` CSP and refuse before Auth if the explicit build input
is not allowed. Missing public input is still NOT_DELIVERED, not fake Auth.
Retain this shared integration request as pending until the coordinator
actually applies and records it. Do not silently overlay it in a supposedly
actual-coordinator source capsule.

## Disk and reconstruction plan

Actual filesystem observation before repairs: 2,828,800 KiB available.
Installation 11 uses 2,326,377 KiB for runtime and 457,044 KiB for build-home.
A new full reconstruction with another retained npm download cache would leave
too little headroom once its source capsule and delivery objects are included.
The new reconstruction may designate **only its own newly created npm cache**
as temporary, record a bounded cleanup receipt after dependency/native install,
and remove that disposable cache before the frontend build. It must not delete
installation 11, any older runtime/cache, original logs or other user files.
Recheck actual free space under the shared heavy lock before starting.

## Validation specified before code

1. Existing Node 22 syntax checks for every affected/new native script, and
   scoped `git diff --check`; no after-the-fact isolated unit tests.
2. Existing executable driver `--doctor` and missing-authority `--run` guard:
   expected exits 0 and 2 respectively, zero Auth/DB/browser/native cases.
3. Freeze a new committed coordinator-plus-owned source capsule and rebuild it
   into a new independent installation using the exact locks and shared heavy
   lock, 4096 MiB cap. Run the existing full backend typecheck, actual mounted
   Next standalone build, complete emission and offline installed doctor.
   Check the real emitted inventory and all source-custody URL mappings.
4. The new mounted-build receipt must be produced by the actual Next output,
   with source population, deterministic build ID, public Auth build-input
   receipt digest, standalone server, assets and symlink containment. Offline
   validation is file engineering, not an authenticated mounted-flow pass.
5. Actual SOURCE/INSTALLED native, original-owner, currentness, UI, accounting
   and physical cuts remain NOT_RUN until the separately delivered expiring
   native authority, existing canonical fixtures and isolated targets exist.

These repairs grant no DB/Auth, fixture creation, provisioning, protected
custody, financial effects, external publication or slot release. Z0–Z3
currently occupy four slots; Z4/Z5 remain queued. Only the coordinator may
accept a current-source-bound handoff and release this slot.
