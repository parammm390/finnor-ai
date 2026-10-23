# POSTX.Y1, frozen engineering contract

Base: `07e5a6a182dae37c3b0f3ec056c1d604a684be2b`, tree
`a6e0f0fcfb3baf7795fdcf67265d3b225f6e0a96`. Scope: Y1 only.
Owner guidance: Low. No publication, deployment, provisioning, new protected
grants/signers, or real economic effects are authorized.

## Two whole-shape designs, before semantic implementation

1. **Sparse exact relational synthesis with finite extensional checking.**
   Search dimension-checked affine relations over state quantities, parameters,
   and a unit constant. The input contains observations, invariants and explicit
   missing meaning, not transition code, operator templates or proof scripts.
   Derive maximal safe enablement, read/write footprints, and composition laws by
   comparing complete partial-transition denotations. Persist a reusable theory,
   then lower its instantiated relations through typed owner ports.
2. **Learned finite-state automaton with per-state transition tables.**
   Search partitions and transition edges from observations, then minimize the
   automaton and infer trace equivalences. This supports non-affine finite
   behavior, but generalization is only table completion, parameter reuse is
   weaker, and the checking/publication surface is much larger.

**Selected: design 1.** The fixed profile is `profile.json`. An unsupported
relation is reported, not silently converted to a schedule or an X5 procedure.
The profile cannot be narrowed after failed evaluation. Future profiles require
a new identity and a fresh verification run. No claim extends outside its finite
quantity/parameter domain.

## Semantic contract

`construct(problem, profile, originalEpisode)` returns CANDIDATE, CHECKED,
INCOMPLETE, INFEASIBLE, UNIDENTIFIED, UNSUPPORTED or UNKNOWN. Only a separate
checker can make CHECKED or justify INFEASIBLE. A timeout or exhausted search is
never an infeasibility proof. Conflicting, underdetermined, absent or unbound
meaning remains explicit.

Quantities are canonical exact decimal strings. Currency, unit, accounting basis,
entity, time interval and interpretation references remain attached. There is no
floating-point money, implicit FX, inferred legal consent or invented observation.
The hypothesis space contains at most three signed terms per output row, with
coefficients -1 or 1. All observed positive/negative examples are binding.
Minimum total term count is the preregistered simplicity objective. Distinct
minimum-cost denotations produce UNIDENTIFIED with a distinguishing trace.

Enablement is the finite safe preimage of the declared invariants and domains,
plus the exact authority/consent/interpretation/observation requirements.
Composition laws are synthesized as equal denotations of distinct words of
length at most two, not selected by economic operator names. Definedness,
requirements and resulting state must all agree. Every law needs an enabled
witness; all-disabled equalities are discarded.

## Owner path

* S1: existing bearer verification, current tenant/principal/root/Work authority.
* Y1: immutable request, original bounded episode, durable native job, candidate
  artifact, independent checker receipt and full PostXArtifactEnvelope.
* S8: additive ECONOMIC_ACTION_THEORY typed development admission. It does not
  reuse the S5 method domain, mint a protected grant, or activate production.
* P1/S4: a checked, current semantic module is consumed by an explicit economic
  programme, with exact parameter instantiations and owner-bound preconditions.
* S5: the existing portfolio lock, resource registry, proposals, reservations,
  consumptions, resource charges and history remain the only resource owners.
  Reservation-right state is an additive typed field on the canonical
  reservation, not a Y1 balance ledger. Substitution changes the rights
  distribution atomically without reserving the same capacity twice.
* S6: native domain_actions/business_effects and immutable obligation origins
  retain exact semantic intent. Internal S5 right transitions have a distinct
  adapter, never json-field-replace-v1. Unknown or possible external effects
  retain responsibility; cancellation cannot erase them or release resources.
* S7: canonical owner readback/evidence, not producer success, establishes a
  disposable internal transition observation. No external settlement is claimed.
* P7: exact dependency closure invalidates affected theory/law/programme nodes;
  unaffected artifacts and all obligations/costs remain retained.
* Work: mounted typed inspection, construction, admission, instantiation,
  observation, cancellation/recovery and artifact download. Identity, Work,
  token and request-generation changes fence stale private responses.

Only the disposable local profile permits the internal development adapter.
Protected admission and all external economic adapters fail closed.

## Failure model, recorded before isolated semantic code

Wrong arithmetic/scale; mixed unit/currency/basis/time; implicit FX; overflow;
ambiguous or contradictory observations; all-disabled/vacuous laws; law definedness
or requirement mismatch; coefficient/body/law/certificate substitution; unknown
interpretation or consent; forged source/version; stale Work or source heads;
revoked S1 rights; foreign tenant/principal; unadmitted theory; changed profile;
queue replay, incompatible protocol and stale physical claim; checker timeout,
crash or malformed output; native cost lost on failure; episode reset on resume;
resource contention; double reservation on substitution; partial right movement;
release after possible effects; lost acknowledgement; worker death before or
after owner commit; duplicate effects; stale-generation publication; unrelated
dependency invalidation; stale UI responses; failed download currentness check;
missing emitted checker/assets; migration/head mismatch; reconstruction borrowing
peer dependencies; unmetered costs reported as zero; public fixtures misreported
as protected novelty or comparative gain.

## Independent acceptance predicate

Before implementation, `verification-plan.json` fixes the required cases.
The independent oracle uses Python standard-library exact fractions, has no
producer imports, accepts only bounded data on stdin, and recomputes every finite
transition and every claimed equation. The checker is a separate, time/output/
memory-bounded process with no database credentials or provider tokens.
Engineering oracle custody is not protected evaluator custody.

The end-to-end runner must record original inputs, HTTP status/digests, native
job/delivery fences, checker identity, resource/effect/observation identities,
failed mutations, installed source/asset identities, costs, and rerun commands.
Tests are end-to-end. No post-code unit tests will be added.

## Qualification is a separate gate

The public reservation-right substitution fixture is safety/regression evidence,
not novelty. Existing P1/R2, V arrangements, R6 and all eligible X capabilities
remain available in baseline/fallback comparisons. Matching an existing semantic
body is REUSED, not a new operator family. A generated development population
does not become unseen protected evidence.

Protected qualification requires 20 unseen families, at least 18 accepted,
at least 200 traces per family, at least five incremental families, nonvacuity,
and canonical lowering invariants, against an equipped qualified baseline under
independent custody. No such custody, signed admission, activation, production
economics, complete money/human meters or whole-product 100x gain is assumed.

## Source facts

The exact POST-X PRD, final S lock and reviewed blueprint bytes were not recovered
in the bounded prior search. The owner explicitly directed proceeding from the
issued goal without them. They are not represented as read or hashed. Native
Mission launch was refused by tool policy; no Mission execution is claimed.
Deployment metadata identifies the base commit, not the full running fleet,
database migration state or protected qualification.
