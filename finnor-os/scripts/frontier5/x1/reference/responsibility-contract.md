# X1 institution-responsibility-v1 lowering and typed S5 demand contract (frozen pre-code)

Frozen before `institution-program/responsibility.ts` and
`institution-program/resource-demand.ts` exist. Cases live in
`responsibility-cases.mts`; expectations in `responsibility-expectations.json`.
The fixture basis is the independently frozen `original-input.json` +
`base-candidate.json` corpus already accepted by the separate checker.

## Observable contract

1. `deriveInstitutionResponsibilities` is pure: independently checked
   obligations + admitted canonical refs + current authority in, one typed
   `finnor.x1.institution-responsibility-programme.v1` and one
   `finnor.x1.institution-responsibility.v1` per obligation out. No I/O, no
   clock, no randomness; identical inputs give byte-identical output.
2. Every responsibility binds the full obligation: trigger (witness, source,
   record, occurrence/availability chronology), rule (id, mandate id+revision,
   trigger kind), materiality, deterministic priority, original deadline taken
   only from the mandate rule, responsible principal, permissible operation
   class, preconditions, frozen structural postcondition, independent observer
   ref, and a discriminated effect binding (`ordinary` | `none`).
3. Stable obligation identity is `x1-obligation:` + SHA-256 of a versioned,
   injective tuple (tenant, institution, mandate id, rule id, canonical subject
   identity without its mutable entity version,
   trigger sourceId, trigger recordId, trigger occurrence). The slash witness
   is display-only and must not be parsed or joined across cuts. Derivation
   revision additionally binds the
   admission digests and currentness vector, so a material input change yields
   a new derivation revision under the same stable identity.
4. An obligation whose subject is not an admitted canonical fact, whose
   operation lost current authority, or whose operation is deal-scoped but has
   a non-deal subject is never lowered and never dropped: it appears in
   `unresolved` with its exact reason.
5. The three ordinary operations are the only supported effect classes, and
   only while present in both the frozen profile and the current authorized
   operation set. Authority loss at lowering time yields `effectBinding.kind =
   "none"`, never dispatch.
6. The programme dependency graph is typed institution evidence (trigger ->
   rule -> obligation -> canonical subject), bounded by the frozen profile
   (2048 nodes / 16384 edges). It is never reinterpreted as a numeric S4
   control problem and never claims S3 causal qualification; the qualification
   string says so literally. The module imports no numeric S4 synthesis.
7. `buildInstitutionResourceDemand` produces a typed
   `finnor.x1.institution-resource-demand.v1` whose quantities are declared
   accounting, qualification `DECLARED_ACCOUNTING_NOT_FUNDING`. Without a
   bound current S5 reservation envelope, `planInstitutionDemandCharge`
   refuses with `X1_DEMAND_UNFUNDED`: P1-style counters and the X1 budget row
   are not funding.
8. Charges are stable original-parent charges: `x1-charge:` + SHA-256 of
   (demand digest, responsibility stable identity, phase, ordinal), phases
   EXECUTION/RECOVERY/HUMAN, EXECUTION and RECOVERY occupy COMPUTE `request`
   units, HUMAN occupies HUMAN_ATTENTION `seconds`. All phases draw down one
   shared cumulative parent envelope limit with exact decimal accounting;
   ordinal is unique per phase, 1..64, units 1..100000.
9. Identical charge replay returns the identical charge (semantic replay);
   the same charge key with a changed semantic payload refuses
   `X1_CHARGE_REPLAY_CONFLICT`; exceeding the remaining parent envelope
   refuses `X1_CHARGE_BUDGET_EXHAUSTED`; a responsibility identity foreign to
   the demand's programme refuses `X1_CHARGE_RESPONSIBILITY_FOREIGN`.
10. The parent deadline is the earliest mandate rule deadline; no caller or
    retry can extend it.
11. The S5 owner adapter reserves only against currently registered
    `COMPUTE/request` and `HUMAN_ATTENTION/seconds` cumulative resources. Its
    tenant-wide `s5-portfolio` lock serializes institution and finite-policy
    reservations. Institution reservations appear in the ordinary S5 snapshot
    as outstanding commitments so legacy finite clearing sees the same
    occupation; existing finite commitments are included in the institution
    capacity check. A separate X1/P1 allowance cannot satisfy this predicate.
12. S5 consumption is an intent/retained exposure, not a completed provider
    effect or monetary billing. Semantic replay keeps the same original
    reservation, charge key and deadline. Release is allowed only when no
    consumption/charge/possible effect exists. Resource revision, rights or
    expiry fences new use while retaining the old liability.
13. A native action node needs a frozen, checker-bound ordinary action payload
    from the mandate and established canonical target/related refs. The sparse
    original fixture has no such payload: it can prove derivation, but must not
    manufacture a Request/workstream/finding or claim native completion. The
    P1 owner may bind an actual PlanGraph/ObjectiveLoop only after an exact
    payload, current Work/input/principal, S5 reservation and current operation
    authority are established. The independent canonical observer, not a P1
    proposal, decides completion.

## Credible regressions covered

- Obligation silently dropped when its canonical subject is unadmitted.
- Deadline reset or caller-supplied at lowering.
- Effect class dispatched without current authority.
- Institutional dependency graph handed to numeric S4 synthesis, or an S3
  causal qualification fabricated.
- Double charge after retry, per-restart budget renewal, or a fresh X1 budget
  row treated as funding.
- Human-attention demand drawn from a COMPUTE envelope or vice versa.
- Two separately accepted cuts with `(work-1, branch/request-A)` and
  `(work-1/branch, request-A)` have the same display witness but distinct
  stable duties; a coherent material revision of either same tuple preserves
  identity while changing its derivation revision. Within-cut witness collision
  refusal remains intact.
- A stale source rights binding must be rejected at SOURCE_AUTHORITY; the
  positive revision cut refreshes each authorized source and the current vector.

## Existing coverage gap and owner boundary

The checker proves obligations against original sources and the mandate, but
nothing yet carries them into actual S4/P1 progression or S5 resources. The
owner boundary: S4/P1 owns the versioned responsibility programme and native
PlanGraph/ObjectiveLoop binding; S5 owns the reservation lock, currentness and
consumption these typed demands pass through; the existing gated action/runtime
bridge owns any ordinary effect dispatch (a later feature). This feature
creates no job type, no protected authority and no numeric S4 policy.
