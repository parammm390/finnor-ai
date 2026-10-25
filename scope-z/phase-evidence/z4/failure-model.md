# Z4 pre-implementation failure, security and verification model

## Frozen meaning

One runtime-supplied, bounded straight-line integer step, at most 16 instructions
and 8 mutable registers. Per-step inputs are signed32; registers and all
instruction results are checked signed64. Add/sub/mul, signed less-than,
equality and Boolean select are exact. Multiplication has no scale conversion.
Units are checked by a static type pass: add/sub/compare/select require equal
units; multiply only permits a dimensionless operand; predicates are
dimensionless booleans. No division, floats, implicit rounding, arbitrary JS,
secret-input, protected or execution-authority claim is admitted.

Register reads observe sequential instruction order. Input operands refer to
the current input row. T is exactly one of 1,2,4,8,16,64,256. Initial/final
registers, actual T, runtime program/constants/type/unit/rounding definitions,
ordered input commitment, tenant/principal/Work/input revision/rights, parent
reservation/deadline and compiler/checker/backend/parameters are bound.

## Failure inventory and independent observations

* Producer lies about output, state, code, constants, opcode, length or input:
  independently retained request and original interpreter disagree, or the real
  backend proof verifier rejects the wrong public relation.
* Field-valid integer-invalid witness: circuit range decompositions and checked
  integer equality prevent wrapping. A deliberately separate field relation may
  prove a field computation, but cannot pass the signed64 consumer contract.
* Missing signedness, comparison boundaries, select predicate, multiply bound,
  compiler wiring or input commitment: inspect the actual emitted constraints
  against an independent compiler contract; independently replay original
  integer meanings. Neither check replaces the pinned cryptographic verifier.
* Forged verifier key/parameters/encoding/backend/source: verifier reconstructs
  the admitted relation from original program, loads only the installed pinned
  binary, compares parameter identity and rejects trailing/noncanonical bytes.
* Wrong tenant/principal/permitted use, revoked rights, stale Work or owner
  model/policy/source: resolve current native authority before disclosure and
  immediately before consumption. A producer success flag never grants use.
* Crash at durable claim, artifact/checkpoint, delivery before verifier/ack:
  physically stop an owned process in offline diagnostics; native guarded
  replay must preserve the same real job/Work/reservation/deadline, fence
  obsolete claims, charge redelivery/check/fallback against remaining original
  S5 resources and retain S6 UNKNOWN. No new grant or fresh parent on retry.
* Partial artifact, duplicate/cancel, symlink/path traversal, source substitution,
  stdout flood, malformed JSON/proof, child descendants/time/memory exhaustion:
  immutable private bounded files, exact identity, bounded credential-free
  processes and kill/reap on cancellation. Retain costs/failure/UNKNOWN.
* Unsupported semantics, security domain or absent native authority: typed
  refusal, not approximate acceptance or a fake owner. Protected source and
  private input security remain outside this public-input profile.
* Cost illusion: report setup, compilation, independent correspondence,
  proving, each verification, original interpreter, storage, invalidation,
  recovery and installation separately. Unmetered money/tokens/human work and
  aggregate RSS are unknown. Actual eligible native reuse N is currently zero.

## Finite verification registration, before product code

Freeze exactly the locked 32 structural families, eight fresh public cases each:
two independently calculated supported positives; a wrong-result falsifier;
an explicit impossible/unsupported case; authority/information mutation;
currentness mutation; remaining-budget breach; durable interruption. Public
fixtures are synthetic, non-executable and never protected admission.
The fixture generator records literal expected states using independent family
formulae, not the product interpreter. Family definition, seed and denominator
are immutable after generation. One full sweep, bounded affected reruns after a
recorded defect; no post-code unit-test campaign.

Critical process-level cases additionally cover every proof/public-input/
range/code/length/version/parameter mutation, semantic boundary and leakage/
resource guard listed above. Each expected refusal must fail for its named
predicate. Never count a timeout or unrelated schema error as proof rejection.

Scaling diagnostics: all seven T values, five alternating proof-verifier and
full-original-check observations per T, with setup/compile/prove and both cold/
warm verification accounted. Diagnostic repetitions are not eligible demand.
Report finite ratios without invented exponents or extrapolated crossover.
Protected 40 unseen definitions, real native Work/UI/recovery, qualified X/Y
comparator and financial horizons have separate NOT_RUN/BLOCKED gates.

Executable native replay must be implemented but must refuse without an exact,
explicit existing-target authorization manifest, actual credentials/current
source/binary identities and original Work. It must neither initialize a DB,
seed Auth, grant permissions, create listeners nor invent owners.
