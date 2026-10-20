# Retained engineering failures

Raw inputs, assertions, process outcomes and SQL/HTTP artifacts remain under
`evidence/`. Final evidence is selected explicitly; failed runs are not overwritten
or counted as passes. The finite semantic profile and protected gate did not change.

| Failure | Correction |
| --- | --- |
| Missing governing-source bytes and denied Mission launch | Proceeded only on the owner's explicit direction; no Mission or source-custody claim |
| Initial API build exhausted a 2 GiB heap | Used the recorded 4 GiB build heap; fixed the resulting actual integration type errors |
| Embedded PostgreSQL lacked `libpq.so.5` | Rebuilt its locked native lifecycle; no hosted database substituted |
| Emitted S7 adapter resolved a bundle-relative source URL | Preserved canonical delivered source custody; disclosed legacy `tsx` registration |
| Guarded programme job rejected immediate recovery | Kept native standard backoff instead of weakening the queue invariant |
| Retained prior-job selection and empty-probe cache | Observed ordinary fair queue ticks; did not assume every tick selected Y1 |
| Missing Work and missing exact action PlanNode | Added exact Work checks and native action/query/check nodes, not loose SQL bypasses |
| Checkpoint test blocked its own candidate UPDATE | Moved the task-only gate after the checkpoint commit, onto lease renewal |
| Expired lease fixture violated acquisition ordering | Preserved acquisition time and expired it by one microsecond |
| Next inlined `NODE_ENV` into the disposable guard | Bound runtime environment inspection while retaining production refusal |
| Production probe expected a Y1-specific 403 | Recorded the earlier canonical protected-secrets bootstrap 500; no emergency override |
| Browser downloaded after native Work completion | Downloaded while current and retained the later normal Work closure |
| Token refresh remounted WORLD and lost an uncertain key | Added bounded actor/Work-verified in-memory handoff; both real signed-refresh races passed |
| Browser tick ran before the next Work's accepted construction | Waited for durable acceptance and checked canonical progress across bounded native ticks |
| New native query was advertised in flat public OpenAPI | Preserved the exact two-reader native catalogue and removed the internal invocation from public query schemas |
| Dedicated `.mts` typecheck initially failed | Enabled explicit extension imports and fixed the inferred child-request type |

Public source-HTTP pilot 10 passed its 17 cases. The expanded emitted campaign
passed 24 cases and mounted campaign 6 passed all six browser cases. These are
engineering results, not protected qualification. The final packet separately
requires passing reconstruction and repeated installed/browser reports.
