# S8 ProcedureCapsule port, proposed v1

Status: **PROPOSED / BLOCKED_EXTERNAL**. This is an owner review packet, not a
capability registry, signer, evaluator, promotion controller, or activation.
The exact C S8 interface remains `s8-capability-v1`, accepting
`finnor.s8.allocation-method.v1` on `s5-joint-finite-v1`. Do not reinterpret that
payload, migrate existing revisions into procedures, or weaken its signatures.

## Required owner-owned port

The serial integrator must allocate a **new** discriminated payload/interface
version, `s8-procedure-capsule-v1`, while retaining the existing allocation path.
The following operations belong to existing S8/S6 owner transport:

1. **Register immutable module preimages.** Resolve the capsule, emitted bytes,
   compiler options/libraries, input/output schemas, predicates, dependencies,
   fallback, runtime image and resource profile. Reject inconsistent preimages,
   missing parent custody, cycles, unregistered imports and substituted bytes.
   P6's ordinary archive is never an S8 revision or executable permission.
2. **Register an independently signed evaluation protocol.** Bind the frozen
   module/source cut, completed equipped baseline, rights, dependent clusters,
   hidden companies/schemas/compositions, scoring assets, all attempted
   candidates, cold/warm splits and full-cost horizon before scoring.
3. **Read independent evaluation evidence.** Authenticate the actual evaluator,
   custody, signature, protocol and result commitment. Missing total costs,
   novelty, prior-domain regressions or scientific support cannot become zero
   or PASS. Preserve allocation/P5 regressions.
4. **Issue an exact admission revision.** Existing S8 authority must bind tenant,
   principal, current rights, capsule/module/compiler/library/runtime/dependency
   digests, domain, preconditions, producer, resource ceiling, validity interval,
   evaluation revision and admitted fallback. `admission:null` never qualifies.
5. **Acquire a nonreplayable use lease.** Validate activation/canary/rollback,
   expiry/revocation and remaining original Work/mandate/S5 grant. Return a
   principal/Work/version-bound invocation nonce, never production credentials.
6. **Recheck immediately before invocation and publication.** Re-resolve all
   admitted preimages and current rights, schema, semantics, dependencies,
   original deadline and resource envelope. Match the original full P1
   acceptance, not merely the core output. S6 executes only the registered bytes
   in an independently qualified cell. S7 owns reconciled incurred costs.
7. **Record use/unknown/recovery and counterexamples.** Preserve unknown possible
   effects and S6 obligations. New counterexamples require reassessment and
   revision/rollback. They do not mutate old bytes or inherit old admission.

## Concrete existing P6 consumer

`procedure-admission-request` produces the proposed request from an authenticated,
immutable capsule. `procedure-component` resolves its exact ordinary preimages.
The Work UI reads domain/history, selects a disposable proposal and sends only
`procedure:{capsuleId,mode}` to the original P1 request. Caller-supplied admission
or module bytes are not accepted.

`admission.ts` refuses every protected request with
`S8_VERSIONED_PROCEDURE_ADMISSION_AND_USE_PORT_REQUIRED`. There is no hidden
environment toggle or ordinary-to-protected promotion. The integrated lease
consumer must replace that refusal only after the reviewed new port and release
exist; the ordinary path and all current owner tests remain separate.

## Owners must supply

- S1/S6 complete analytical episode custody, permissions and decision-time cut.
- S4 canonical mandate/fallback and S5 original reservation/funding references.
- S6 runtime image, host/isolation and aggregate CPU/memory/disk qualification.
- S7 measured preparation, testing, correction, integration and maintenance
  costs, billing reconciliation and the prospective reuse denominator.
- S8 independent evaluator authority/protocol/results, admission revision,
  activation, current use/revocation lease, canary and rollback references.
- Serial shared-boundary successor commit/tree and actual migration histories.

No local key, fake lease, private authority service or borrowed allocation-method
admission is included. Rejection of forged/expired/mismatched future S8 leases
must be rerun against the implemented owner port, not inferred from today's
blanket protected refusal.
