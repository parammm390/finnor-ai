# Retained owner-regression exception

Base: `a72b4f402cfa1bbf51e518891db2d893b9a71aca`.

`evidence/p1-regressions-03/results.json`, case `future-port-refusal`, fails
because the unchanged original P1 test expects P5 `PENDING_OWNER_CONTRACT`.
Unchanged C `program-synthesis/ports.ts` instead reports
`CURRENT_TYPED_PURE_INTERFACE_DEPENDENCY_JOINED`. Its business invocation remains
`PENDING_CURRENT_S3_S4_S5_S6_AND_INDEPENDENT_S8`; the pure dependency port does not
grant consequential execution or admission.

Both files are unchanged from C. The 12-file P6 native proposal does not modify
either file. This is a recorded baseline source/assertion inconsistency, not a
P6 protected-port pass. The failing run remains exit1.

The serial P1/P5 owners must decide the intended public port contract and update
the source or original assertion in their owned successor. P6 did neither.
The selected 14-case P1 replay and separate original capital/reservation case
have their own passing receipts. They do not relabel this assertion or other
NOT_RUN owner cases.

P7's first replay failed to reach its physical intake window. The unchanged
serial second replay passes all six stories. Both receipts remain; no fabricated
root cause or reliability estimate is attached.
