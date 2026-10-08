# Owner and producer ports

No new Phase2Envelope, authority ledger or caller booleans.
Tenant/principal come only from authenticated context. Owner refs reuse actual
ExperimentRefSchema; S1 uses loadEnterpriseBeliefView/validateBeliefViewPin,
underwriting uses prepareUnderwritingRun, S5 readEnterpriseAllocation/validate,
S3 resolveEnterpriseInterventionModelForControl/createInterventionControlAdapter.
S6 uses its actual signed owner transport's reviewed
`read-execution-handoff`, not provider dispatch. Real owner currentness never
becomes admission.

Native programme refs are tagged REGISTERED_NATIVE with exact source digest and
fixed input/output schema/domain. P1 HarnessProgram is a distinct future port,
returning PENDING_DEPENDENCY until authentic schema/admission exists.

P4 cut: `finnor.evidence-request.v1`, `finnor.evidence-handle.v1`,
`finnor.derivation-ir.v1`, `finnor.evidence-derivation.v1`. Finite bounds64 nodes,
16 inputs/outputs,1000 rows,8MiB,30s. Owner acquisition stays outside cell.
P3 consumes actual `currentDerivation` and materialized handle readers outside
the cell. The fixed credential-free native child reruns actual producer operators;
P3 independently checks source/unique/exact arithmetic with bounded BigInt
rationals. Unsupported operators remain outside this independent checker domain.
Actual scope/Work/rights/clocks/witness/dependency/runtime/cost bindings remain.
`COMPLETE_SELECTED_UNIVERSE` is not global source completeness.
The public request names `derivationId`, not a fabricated `derivationRef`.

M1 cut: DecisionSlice dependency/coverage/omission/projection/context contract.
Current producer reader and exact Work/input/S1 pin required. Slice is not a
database snapshot and unresolved evidence demands are not usable branch inputs.
The adapter reads actual `readCurrentDecisionSlice`: slice, binding, publication
and projection input. Its supported domain is one known acyclic underwriting
candidate, retaining every gap/mandate/projection field and `projectionLoss:null`.
It does not substitute an allocation/policy or infer a complete enterprise state.
Absent source/adapters still return PENDING_DEPENDENCY, not fabricated artefacts.

The tested independent join base is exact commit
`32d7d6ba6e8bfe344a04a63ffee34e4904df654e`, tree
`3f17622a4446428eedfa007fdb6ad53800f7c29c`. It includes committed M1
`485370d403b78b94eaed93f52dd3a800e2bbc2be` and exact P4 feature import
`2343bbd63b08b6d0b55fd02dbb19918fdfe4b8ae`. T1–T6 passed in
`scope-evidence/run-2026-10-05T02-29-11-152Z-781e6b6c/`.
That is a joined ordinary software milestone, not either producer's full gate.

Live-read accepts only an S6 owner-issued obligation and exact reviewed decoded
read intent, never caller URL/method/SQL/token. The real signed local ledger
domain captures existing historical handoff evidence once; branch replay does
not reacquire it or make it current. Foreign scope and changed route pins refuse.
Production provider reads, dispatch and protected admission remain unpassed.

Continuation returns candidate/evidence refs to S4/S5/S6. P3 cannot replay fixture
transcripts, issue financing requests, approve, reserve money or set SETTLED.
