# X3 review-boundary verification

This supplements, and does not change, the frozen acceptance corpus. It records
review-discovered failure modes before the corresponding fixes. Verification
uses installed HTTP operations, ordinary database roles, physical deliveries,
and the mounted Work interface, not new post-implementation unit tests.

| Failure mode | Required installed observation |
| --- | --- |
| Wall-clock deadline passed to a monotonic database budget | A held database lock terminates within the cumulative operation budget, without a committed command. |
| Independent quantity equality compares decimal spelling | A declaration using equal quantities `1` and `1.0` passes independent checking and the installed decision. |
| Negating stale evidence becomes true in the checker | Stale evidence remains UNKNOWN through negation; the installed decision refuses. |
| Repeated approver lookups diverge | Command and effect stages resolve each approver once per transaction and revalidate at every stage. |
| A forged S5 consumption creates permanent pending responsibility | A valid S4/allocation with a nonexistent consumption refuses without changing the record or creating an obligation. Unknown owner outcomes must retain responsibility. |
| An assignment introduces a foreign-root quantity | A generated literal assignment cannot persist a quantity outside the authorized application root. |
| Work changes while S8 admission appears current | Proposal and current reads compare the exact current Work cut, including after the consumer call. |
| The release validity interval ends during a consumer call | Final admission projections also check the installed release's validity interval at the final host decision. |
| Two fields name different versions of one source | A record with any stale pin is STALE, regardless of field order. |
| An old mutation refresh overwrites new Work status | Delayed old-Work responses cannot restore old records, forms, decisions, or status. |
| Read-only refresh coverage misses the mutation's post-refresh continuation | Commit a real record transition, hold its refresh response, switch Work, then observe status changes through delivery and subsequent rendering. The old transition outcome must never appear in the new Work. |
| Mounted history loses the original business event | Open immutable history in the actual browser and verify the original literal and committed commands before reloading. |
| Valid aggregate records exceed a single JSON node ceiling | Maintenance and safe rollback succeed for a multi-record, 128-entry dataset within the original storage allocation. |
| Eight completed uploads exhaust a permanent principal quota | Completed contracts are durably copied before temporary fragments are released; retries remain idempotent; abandoned uploads expire. Application accounting never decreases. |
| Page reads repeat source resolution per record | A page resolves the union of evidence and relation owners once in the same fenced transaction, while testing every original pin. |
| Rollback reparses the entire specification per record | Rollback validates against the already parsed release model. |
| A migration default introduces a foreign-root quantity | Installation refuses atomically, retaining the prior head and every original record. |
| An approval predicate is UNKNOWN or has no applicable role | Independently checked negative declarations install; ordinary commands refuse with UNKNOWN or empty-policy outcomes without recording approval. |
| Effect revalidation omits literal owner facts | Command and all effect stages resolve the same action, approval and invariant literal pins through canonical current owner facts. |
| Candidate or consumer-policy validity ends during transport | A genuine S8 current reply held past the narrower interval returns no current admission, while the release itself remains valid. |
| S6 commits but the host loses the result before completion | Kill only the owned API after the genuine obligation commits and while its final local transaction is blocked; retain pending responsibility and replay the exact owner operation to one obligation. |
| X3 classification changes existing Company Brain errors | Malformed search, projection and belief-view requests retain the original INVALID_REQUEST code, status and bounded issues. |
| History returns after its record selection changes | Hold a genuine history response, select another real record, then deliver the old success or transport failure. Neither may restore old history or clear the new record. |
| A completed UI invocation keeps its idempotency key | Two consecutive identical creations produce different canonical records. A definitively refused command can re-evaluate after a real disposable authority change; uncertain delivery still retains its original key. |
| Scalar generated controls cannot express UNKNOWN | Use explicit UNKNOWN/reason controls for text, boolean and enum fields in the mounted application, and observe the exact persisted tagged values. Literal text must not be parsed as JSON. |
| An expired evaluator can occupy an admission slot | Exercise the genuine S8 service with a stored evaluation whose evaluator key expires before admission; require an authority refusal and no admitted result. Disposable negative mechanics are not new independent application qualifications. |
| Application and interface consumers duplicate security-sensitive transport | Both typed adapters use one bounded canonical-token transport; retain domain-specific fault names and response binding, and run genuine APPLICATION plus INTERFACE consumer flows. |
| Catalogue hashes an identical source closure for every candidate | The canonical lifecycle validates current policy files once per request; each candidate still checks exact dependency equality. Cheap catalogue filters precede signature checks. Source review, not an invented query-count benchmark, establishes the eliminated scans. |
| Idle polling replaces unchanged React state | Keep existing references when list, selection and canonical application content are unchanged, while continuing actual currentness/authority reads and preserving identity/epoch fences. |
| An evidence adapter invents an execution count | Derive the installed projection's zero from an actual canonical external-action count; a missing observation is not zero. |

All prior failed attempts remain evidence. The final handoff must identify
which observations ran, failed, passed, or remain unavailable.
