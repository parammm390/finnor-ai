# X phase production-readiness request, 20 October 2026

**REQUESTED REVIEW, BLOCKED. NOT APPROVED. DO NOT MERGE OR DEPLOY.**

This documentation-only request accompanies draft engineering PR
[#143](https://github.com/parammm390/finnor-ai/pull/143). It requests review of
release conditions, ownership, rollout and rollback. It does not request that
an operator execute a production action now.

## Source and authority

| Item | Recorded state |
| --- | --- |
| Integration review commit | `10bf17fbb269203e9ad5e47bced539f863210576` |
| Integration review tree | `a24e038a2d130373dd501d0498bb48444a7b828c` |
| Main source used for this request | `cf18f3491993564a5acbc28a62188699a2b29a31` |
| Candidate migration head | `0194_x_phase_charge_phase_union.sql`, 217 files |
| Main source contract migration head | `0188_observation_source_version_binding.sql` |
| Actual production component identities/database head | NOT READ OR VERIFIED by this request |
| Final releasable artifact, release ID and rollback deployment IDs | NOT YET REGISTERED |
| Deployment/provisioning/protected admission/customer effects/Mission | NOT AUTHORIZED |

The review commit is not a release seal or a qualified production artifact.
Do not infer live production state from either Git migration-head constant.
The final release must be repinned after all blocking engineering/evidence
changes, with a clean canonical main worktree and matching artifact identities.

**Important workflow boundary:** the existing
`.github/workflows/production-release.yml` triggers on pushes to main.
Merging even this documentation PR can start the release pipeline. Keep both
requests draft, do not enable auto-merge, and obtain explicit owner approval
before any merge or release action. A documentation approval is not deployment
approval. This request changes no workflow, environment, grant or protection.

## What is available for review

PR #143 preserves current main and authentic X1/X2 histories alongside the
sealed local X3–X5 programme. It integrates native owners, worker contracts,
typed resource aggregation, separate X2/X3 S8 namespaces and cancellation
contracts, authenticated maintained UI, and immutable migration history.
Only migration 0194 is new to the historical SQL union.

Full-change review found nine source defects; independent validation and
follow-up resolve all nine in source. Repair regressions and failed attempts
remain retained. Recorded premerge source-cut checks include passing backend,
frontend and driver types, lint with existing warnings, three populated/fresh
PostgreSQL upgrade scenarios, four authenticated X1 API/owner cases and two
concurrent-publication/original-parent cases.

These are bounded development results, not qualification of the committed
production image or the complete five-engine system. Final committed-cut
credential detection scans 4,031 files and 223 newly reachable commits. Its
five tree/one history findings have source-bound noncredential dispositions;
raw scanner verdicts remain nonzero and policy is unchanged. No private
credentials, signed local fixtures or raw database contents are attached.

## Blocking engineering and evidence

Every item below is open unless supported by a separately registered,
independently checked final-cut receipt.

1. **Actual five-engine composition.** Implement immutable X1-to-X2 parent and
   shared-resource binding, currently `institutionalProgramRef: null`. Prove
   InstitutionProgram to native Work/S4, ApplicationActionModel and enterprise
   package, guarded identified model, independently accepted effects, learned
   policy, S8 and fresh maintained Work. Five owners or panels do not prove it.
2. **X2 live/safety coverage.** All five integrated native campaigns fail
   overall. The latest reaches the real ordinary-worker second-use pause but
   times out at the original seven-second negative suite after eighteen
   complete refusal state comparisons and two controls. The nineteenth
   matching response lacks its ending-state read and is not credited.
   Do not widen the deadline, remove comparisons or reuse a failed episode.
   Independently acquired/live isolated subjects, expired activation,
   cumulative use/cost and remaining composition/access/drift/injection/
   sibling/completed-history checks remain open.
3. **Affected runtime repairs.** Complete actual post-settlement S8 outage/
   recovery without duplicate effects, installation-authority expiry rollback,
   queued-evaluation generation changes, unpublished revision rejection,
   cancellation/publication, mixed-principal capacity/R3 consumption and
   generation-aware mounted-panel proofs. Source review/types are not E2Es.
4. **Final artifact compatibility.** Complete emitted/installed Linux,
   production worker bootstrap/image/managed-secret parity and fresh
   committed-cut reconstruction. Local Node 22.23.3 development results do not
   automatically qualify the current release workflow's Node 22.22.3.
   Preserve exact dependency locks, historical SQL bytes and lineage guards.
5. **Independent qualification/economics.** The governing populations,
   elapsed horizons, resource/correctness/regret/calibration floors, qualified
   baselines and equipped matched comparisons are unmet or UNKNOWN. No
   operational 100x, mature financial result or native Mission completion
   is asserted.

Binding qualification populations remain separate:

| Gate | Required population/horizon, not a local result |
| --- | --- |
| X1 | 10 unseen institutions, 30-day replay and actual 7-day soak |
| X2 | 20 applications and 200 withheld workflows |
| X3 | 20 products and 60 lifecycle episodes |
| X4 | 36 systems across 6 mechanism families |
| X5 | 3 sequences, 10 cycles, at least 1,000 fresh paired assignments per sequence |
| Integrated operational | At least 30 institution-period blocks, 90 days, 100 deals, 10 system types, 1,000 missions and 10,000 opportunities; fixed weights, saturated demand, matched comparators, five single-engine ablations and all-disabled |
| Operational comparison | Independently qualified positive baselines and `L_candidate >= 100 * max(U_comparators)`, with all inherited floors |
| Mature financial | Separate S7/36-month/$100m H2 gate, not inferred from operational or component results |

Keep B_live distinct from qualified B_V and equipped B_ref. Do not invent a
baseline, sample, elapsed day, Mission identity, receipt or economic denominator.

## Requested review and approval record

No reviewer, operator or on-call owner is invented or assigned by this request.
The responsible owners must identify themselves in the review record.

| Decision | Current disposition |
| --- | --- |
| Engineering owner accepts complete final-cut chain/E2E/reconstruction evidence | PENDING, BLOCKED |
| Independent checker accepts qualification/oracles and claim boundaries | PENDING, BLOCKED |
| Security/authority owner accepts RLS/currentness/revocation/source custody | PENDING |
| Database owner accepts lineage, 0194 populated upgrade, backup/restore and rollback compatibility | PENDING |
| Release/operator owner records exact component IDs, scoped canary, budgets, observation window and rollback IDs | PENDING, UNSPECIFIED |
| Product/economic owner accepts external grants, comparisons and claim scope | PENDING, BLOCKED |
| Explicit production mutation authorization for exact final SHA and operations | NOT REQUESTED FOR EXECUTION NOW; NOT GRANTED |
| Protected admission/customer-effect/Mission authority | NOT GRANTED |

Any eventual infrastructure action also needs confirmation of the project's
selected Region and applicable plan/spend status under existing project
guidance. Do not infer an allowed Region from an old deployment contract or
provision anything as part of this review request.

## Conditional rollout plan, not executed

1. **Freeze a releasable cut.** Close the engineering/qualification blockers.
   Register final source/tree/lock/source-closure/artifact hashes, exact
   migration union, independent receipts, environment and authorization scope.
   Review staged changes and repeat credential/history detection with
   source-bound disposition. Do not restamp old passes onto new bytes.
2. **Observe and protect the current deployment.** Authorized operators record
   every required component's actual release identity, database migration
   history/role state, queue/lease state, current signed consumer policy,
   backup/PITR reference and verified rollback-compatible artifact IDs.
   These are currently UNKNOWN; absence of this record blocks mutation.
3. **Approve one exact bounded release.** Use the existing canonical main,
   clean-worktree, `finnor-production-release` serialization, post-merge
   certification and production-environment/OIDC authorization mechanisms.
   Do not bypass a failed job, protection, lineage check or signature.
   Supply exact authorized canary tenant/principal/Work/domain, existing-owner
   admission controls, budgets, observation window and stop conditions.
   No default scope or new bypass flag is implied by this document.
4. **Deploy consistently through the canonical release path.** Only after
   separate explicit authorization, release the same pinned identity across
   frontend, API, compute classes and supplier canaries. Apply only the
   reviewed forward migrations with the database owner's admission checks.
   Do not edit historical SQL or run ad hoc production DDL.
5. **Observe the approved canary.** Check release/readiness identity, ordinary
   restricted roles, exact currentness/revocation, canonical original-parent
   capacity/charges, no duplicate dispatch/effects, retained UNKNOWN outcomes,
   independent outcome receipts and maintained Work/UI. Respect original
   deadlines, leases and resource limits. Stop on any critical violation,
   unexplained identity/schema drift, unaccounted effect or failed gate.
6. **Expand only by a new recorded decision.** Reconcile the complete canary
   assignment denominator and observed costs before any expanded authority.
   A passing canary does not create protected admission, customer authority,
   Mission authority, operational 100x or mature financial qualification.

## Conditional rollback/recovery plan, not executed

1. Stop new admissions through the existing supported native owner controls,
   with authorized scope. Preserve signed journals, original requests,
   generations, leases, reservations, charges, unresolved effects and receipts.
   Do not delete history, reset budgets or free possibly used resources.
2. Drain/reconcile original in-flight work through supported recovery. Keep
   unresolved outcomes UNKNOWN; do not replay business mutations to recreate
   an acknowledgement. Preserve original deadlines and default leases.
3. Use only the previously recorded rollback-compatible component identities.
   Verify their database/source-lineage compatibility before shifting traffic.
   If old binaries cannot safely read the forward schema, halt and use an
   independently approved forward fix rather than forcing a rollback.
4. Treat 0194 and the historical migration set as forward-only. Do not run an
   improvised down migration or edit `_migrations`. Any database restore needs
   separate explicit owner approval, a verified backup/PITR target, and
   reconciliation of accepted/unresolved effects and subsequent data.
5. Verify restored release/readiness/authority/queue identities and independently
   reconcile effects/costs before reopening admissions. Retain both failed and
   recovery evidence. No automatic resumption, regrading or widened authority.

## Execution statement

This request performs no production read, deployment, migration, environment
update, secret change, infrastructure creation, protected admission, customer
effect, Mission run, merge or release-workflow dispatch. Review and publication
are the only requested outside-platform actions.
