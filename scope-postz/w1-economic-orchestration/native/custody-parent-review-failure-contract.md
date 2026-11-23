# Custody integration: parent failure-first qualification

Registered before parent implementation. Status: all new owning executions
NOT_RUN. The original proposal and every failed artifact remain immutable.

## Inputs and authority

- Original proposal manifest:
  `integration-proposals/objective-read-custody-v1/manifest.json`,
  SHA-256 `3c9240d29ba3d04eced8b6f9fe8357713d9d4d95f34a7e093150f7058f29bb7b`.
- Independent Pass 2 decisions:
  `reviews/0002/pass2/decisions.json`,
  SHA-256 `7f7675e362113508dd141f07be766176bc49e11a27ec5d519cf651f5a02c7a6a`.
- Fifteen original findings are preserved. Fourteen distinct findings were
  accepted; RC0002-001 duplicates RC0002-002. Static validation is not runtime
  qualification or a claim that the proposal is complete.
- Local disposable SQL, source edits, checks and local commits only. No browser,
  external service, publication, protected grants, deployment or provisioning.
  No unit tests. The existing browser refusal and cold-capacity limit stand.

## Before epoch

Install only the original proposal's four E2E/verification script leaves and its
HTTP_V4 contract, with exact live preimages and no production changes. Run the
real signed HTTP/Core/native admission owner against the current production
source in a new `http-0010-custody-baseline` directory. The driver already
registers all 65 predicates before SQL setup. Record missing native private
schema/owner, narrow-grant admission failure, ancillary projection failure,
and any other actual outcome without calling missing or skipped cases PASS.

The baseline source freeze is expected to be incomplete because the new
production owner and migration are not installed. It is a falsification
attempt, never qualification. Preserve the mandatory verifier's result,
including the three independently established bad expectations in that
unrepaired proposed verifier. Do not alter the old price/source/deny fixtures
to make those expectations pass. No successful baseline outcome may establish
new Objective custody integration.

## Confirmed defects and owning falsifiers

1. **Persisted lease (RC0002-002):** fresh native frontier reservation clears
   the loop lease. Claiming a native node must restore its persisted loop lease
   atomically under the existing loop, generation, active-plan and step fences.
   Do not weaken the DB origin/current-claim fence. The primary actual queue
   case must create both private replies and complete with zero new activation.
2. **Final completion (RC0002-003):** after verification starts, let ordinary
   `receiveWork` commit a new input or let the original deadline elapse.
   Neither the original plan nor Work may become completed from that old proof.
   Revalidate original input, unchanged acceptance, selected plan, revision,
   step/loop claim and original deadline under the locked completion owner.
   Plan sealing, final step and Work completion must share that transaction.
3. **Completed-delivery recovery (RC0002-004):** one query and one already
   reserved unfinished check with `maxSteps=2`, then redeliver the completed
   query's original payload. Finish check step 2 without creating step 3,
   another query receipt, another grant, or any activation.
4. **Partial frontier (RC0002-005):** a compiler-admitted chain q1 -> q2 -> q3
   with checks depending on their own query must not fail the whole acceptance
   while q3 is still valid and ready. Run accepted query branches before final
   whole-goal verification, without reserving or spending a replacement budget.
5. **Repeated request (RC0002-006):** use two original accepted assertions,
   `status == "ok"` and `execution.status == "succeeded"`, for the same request,
   with distinct supporting native nodes. Bind verification to each accepted
   criterion/native node. Two lawful receipts are not an ambiguity failure.
6. **Independent old controls (RC0002-007..009):** preserve SOURCE_DELAYED
   price `100.1`, current price `100.125`, unrelated company/foreign tenant
   `201 UNAVAILABLE`, and unrelated team_roster deny positive revenue control.
   Repair only the new verifier's incorrect expectations.
7. **Conflict reachability (RC0002-010):** before each changed-request or
   changed-key probe, establish an unfinished, current original native claim
   and successful unchanged replay. Record that exact positive control,
   persisted lease/claim, receipt and immutable private bytes. Vary one field;
   require rejection at that field's binding, not a completed/stale-claim
   rejection. Preserve the original 65 IDs and strengthen their observations.
8. **Generated inventory (RC0002-011):** regenerate and check the canonical
   authorization matrix, OpenAPI and both generated clients. Never hand-edit
   generated outputs.
9. **Duplicate controls (RC0002-012..015):** remove the redundant scheduling
   option and caller-derived native execution key; derive intent membership
   from the canonical list and reuse one object-normalization helper without
   weakening complete private-query schema validation.

Additional completion/recovery/graph cases are sub-observations of the existing
registered Objective predicates, not replacements or retroactive passes.
Their explicit independent SQL/HTTP checks must be present in the verifier.
Preserve the original 47 predicates, all 18 new IDs, literal original source
rows, real ancillary INSERT fault, actual worker/signed auth, app-role RLS,
all eight per-predicate activation meters and immutable first private bytes.

## After epoch and stopping rules

Apply the coupled production/schema/migration/custody change and confirmed
repairs as the sole live writer, with fresh exact preimages. Generate the
migration bundle canonically, then API/client/authorization outputs. Strictly
typecheck all imported production owners and the explicit `.mts` closure.
Use a fresh disposable DB and new attempt directory, never overwrite baseline.

Keep the existing 1200-second qualification limit. A parent wrapper bounds the
combined driver, mandatory verifier and cleanup, with finite local operations.
Freeze source before runtime and do not edit it during runtime. Require actual
65/65 observations, verifier success, complete cleanup, original-byte custody,
and unchanged activation meters. Two identical failures require inspection,
not a wider deadline or weaker oracle.

Source/type/generation checks are not behavioral passes. Local custody proof is
not W001-W060, physical recovery, mounted user testing, cold reconstruction,
admission, activation, field validation, comparison, 100x/10x or economics.
All unexecuted or blocked gates remain NOT_RUN.
