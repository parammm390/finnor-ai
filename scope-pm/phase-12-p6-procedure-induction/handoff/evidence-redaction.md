# Evidence redaction boundary

The user authorized fixing the Droid Shield flagged evidence before retrying
the owned commit. The scanner blocked 34 files and reported 271 potential
secret locations. No commit was created by that attempt.

Redact flagged execution-token and execution-key string values in those exact
files, including copies in embedded JSON diagnostics. A second scanner pass
identified four `executionKey` disclosures in the same authorized P1 files.
Never print or archive the values elsewhere. Keep
file-level before/after SHA256, redacted JSON locations, and all recorded case
identifiers and PASS/FAIL/NOT_RUN outcomes. Refresh only derived evidence-file
hashes. Do not rewrite product module/capsule references, historical source
freezes, accepted outputs, authority, cost unknowns or failed-run statuses.

Credible failures to prevent: editing an unflagged owner record; changing a case
outcome; removing a failure; leaking a token in a redaction log; claiming a
sanitized snapshot is the exact original digest preimage; updating an immutable
product reference to match redacted display bytes; or bypassing Droid Shield.

Sanitized snapshots are disclosure-safe views, not original immutable product
preimages. Their product reference digests still identify the unmodified native
archive. File-level original hashes retain the link to the observed raw record,
but do not independently prove the removed values. The redaction receipt grants
no custody, signature, admission, scientific evaluation or economic authority.
Original independent GateP6 qualification remains unavailable.
