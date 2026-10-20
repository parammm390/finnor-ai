# Durable X1 Work contract — specified before primary implementation

The authenticated caller supplies Work, exact Work revision, source grant handles,
and an idempotency key. Current standing mandate, original bytes, canonical state,
rights and resources are loaded by their owners. Caller mappings, candidate checks,
action payloads, new deadlines and replacement funding are not accepted.

Credible failures and required observations:

* Cross-tenant/principal/Work handles fail before acquisition. A revoked principal
  cannot see retained artifacts. Work A→B→A and late responses cannot restore A's
  private projection in B.
* Physical delivery must have the registered job type, protocol, live claim token
  and fence. A stale delivery cannot publish a candidate or move the current head.
* Independent rejection publishes a retained failed check and an exact gap; it
  cannot acquire mapping admission, a programme or effect authority.
* Before candidate acceptance, owner admission, head publication, consumer use and
  each dispatch, current source/mandate/rights/resource dependencies are reread.
  A changed dependency fences only its sound affected closure. Historical heads,
  possible effects and charges remain reconstructible.
* Idempotent submit reuses its original request. A material revision is traced;
  the original Work episode budget and deadline cannot be reset. The owner may
  refuse new child work under an exhausted, revoked or incompatible parent.
* All declared duties (up to 128) are retained. Native PlanGraphs remain within
  the frozen 40-node bound. Physical duty deliveries are bounded and checkpointed
  within the same programme/episode; no input truncation is permitted.
* Supported independent duties proceed even with exact unresolved interpretations.
  Creating a Request, Workstream or Finding never establishes fulfillment,
  approval, transaction settlement or a protected S6 dispatch.
* Crash after effect acceptance retains UNKNOWN. Recovery reads the original
  action/command/BusinessEffect and canonical owner before any retry. Cancellation
  fences future dispatch without claiming release or settlement of possible use.
* The full 14-field InstitutionProgram and 34-field envelope are immutable,
  digest-bound projections of existing owners. Missing receipts/prices/custody are
  explicit unknowns, never inferred authorizations, zero costs or qualification.

Independent E2E expectations are canonical source/mandate inputs, frozen business
assignments and canonical/provider readback, never generated from candidate output.
Reuse named engineering cases A–H and retain failed observations before repairs.
The physical queue, SQL claim, worker log, checker process and mounted Work are
required positive boundaries; offline checks alone are insufficient.
