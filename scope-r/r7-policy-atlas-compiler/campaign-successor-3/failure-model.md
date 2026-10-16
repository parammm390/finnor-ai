# Successor-3 campaign failure model (delta)

Inherits `campaign-successor/failure-model.md` and
`campaign-successor-2/failure-model.md` in full. Additions from successor-2's
observed conformance run:

1. **Library exit hooks are part of the stop protocol.**
   `embedded-postgres` registers `async-exit-hook` SIGTERM/SIGINT handlers that
   stop the database. Under campaign control the supervisor's SIGTERM must
   mean "reconcile against a still-live database", so the owner driver now
   removes every foreign SIGTERM/SIGINT listener after `postgres.start()` and
   keeps orderly shutdown in `finally` via explicit `stop()`. Verified
   mechanism: minimal repro showed SIGTERM to a parent with a user handler
   still killed postgres (`ProcessInterrupts`, admin shutdown).
2. **Unhandled pg Client `error` events destroy evidence custody.** The
   successor-2 driver crashed before writing `results.json` because an idle
   pg Client emitted `error` during teardown. Direct `pg.Client` instances now
   carry recording error handlers; query failures still fail honestly through
   `await` error paths.
3. **UNKNOWN reconciliation receipts keep a stable shape** (`before`/`after`
   null, empty arrays) so downstream verification fails on values, not on
   missing keys.
4. **Race tolerance at the boundary.** If the global deadline fires during
   setup (before the boundary marker), the boundary challenge fails honestly
   with evidence instead of being treated as conformance success.
5. Successor-2's conformance phase remains sealed INCOMPLETE; its diagnostic
   did prove GLOBAL_DEADLINE enforcement with zero residual processes and an
   honest UNKNOWN reconciliation receipt. Those receipts are chained in
   `campaign-successor-3/registration.json` and are not re-qualified.
