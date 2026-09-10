# PE Phase 5 Actions + Investment Committee certification

Generated: 2026-09-10T00:15:17.421Z

- Result: **PASS — 260/260 unique cases**
- Category coverage: **270/270 memberships**
- Migration: **126 through 0127_pe_actions_ic_runtime.sql**
- Production release: **NOT_EXECUTED_LITERAL_GOAL_NOT_SUPPLIED**

The source roadmap's category numbers add to 270 while its repeated total is 260. This report preserves all category counts using ten explicit dual-tagged boundary cases; it does not silently remove requirements.

- P1 pe_decision remains the sole canonical PE investment Decision.
- IC Votes, Recommendations, Dissents and DecisionProposals are process evidence/state and are not canonical investment Decisions.
- Core Authority decisions are authorization decisions and are not IC Votes or P1 investment Decisions.
- P3 editorial approval is not investment approval.
- P4 remains the sole deterministic underwriting engine; P5 never recalculates finance.
- IC memo/deck content remains P3 Document/DocumentVersion truth; P5 does not create another artifact system.
- Questions attach exact canonical Evidence/P3/P4 references instead of creating an ic_evidence system.
- Committee Votes derive actor identity from authenticated canonical membership and cannot be planner-forged.
- Quorum and vote thresholds are deterministic and evaluated against the exact pinned committee/policy version.
- The final investment outcome is finalized through existing P1 recordDecision/finalizeDecision semantics rather than direct P5 ownership.
- IC Conditions are distinct from transaction closing conditions.
- No separate Work, Event, Authority, Receipt, Evidence, Artifact, Decision, Source Truth, policy or underwriting system was created.
- No P6 planning-core redesign, P7 autonomous workforce, fund/LP system or AWS expansion was smuggled into P5.
- FINNOR can take an exact InvestmentCase through one auditable IC lifecycle from memo/questions/evidence through recommendation, member votes/dissents, conditions and canonical Decision, while executable PE operations are grounded, authorized, verified, recoverable and receipted through the existing Core.

## Verification commands

| Gate | Result | Tests | Duration | Evidence hash |
|---|---:|---:|---:|---|
| remoteFresh | PASS | — | 685 ms | fea9a9133d4d03bb |
| migrationBundle | PASS | — | 176 ms | 9607a08067d07568 |
| openapi | PASS | — | 1166 ms | f2fbdbb7deaab692 |
| authzGenerate | PASS | — | 236 ms | e3b0c44298fc1c14 |
| typecheck | PASS | — | 17046 ms | e3b0c44298fc1c14 |
| authzMatrix | PASS | — | 436 ms | e3b0c44298fc1c14 |
| releaseBoundary | PASS | — | 4998 ms | b96730148108570e |
| actionManifest | PASS | — | 1736 ms | 1621c47acaa8a3de |
| p5Contract | PASS | 14 | 7545 ms | 0a1d5c79c40bdd2a |
| p5Golden | PASS | 16 | 7526 ms | 2517567b9a9d20fd |
| p5AggregationProperty | PASS | 20 | 7476 ms | 7d56c3e5c750f20a |
| plannerIsolation | PASS | 5 | 9766 ms | 84fb83627a5081f3 |
| freshMigration | PASS | — | 1772 ms | 149de9a98fa3dc6b |
| p5Runtime | PASS | 30 | 5624 ms | dd6f76cca8af8d9e |
| p5Upgrade | PASS | 4 | 4264 ms | 92db6837e23b199c |
| p3Regression | PASS | 13 | 4198 ms | 7dc46d0875a073cd |
| p1RuntimeRegression | PASS | 17 | 5232 ms | 02fb4c66f300cc8f |
| p2RuntimeRegression | PASS | 33 | 7012 ms | 0450dba326cc0989 |
| p4RuntimeRegression | PASS | 14 | 5114 ms | a8b711f64e1957df |
| historicalPeRegression | PASS | 24 | 11754 ms | 6f13e57ab43ebb74 |
| coreRegression | PASS | 41 | 7912 ms | 47202c1cd82994c4 |
| fullUnitRegression | PASS | 572 | 50535 ms | 7717abbb145146da |
| p1Certification | PASS | — | 172645 ms | 550cf7a8a65d04bb |
| p2Certification | PASS | — | 96541 ms | 6b94ffa15be5ecb2 |
| p3Certification | PASS | — | 93420 ms | 75fecb610bc73c8a |
| p4Certification | PASS | — | 103338 ms | b8deffc0cb1094ef |
| historicalPe5 | PASS | — | 86929 ms | 301752552f3bf994 |

## Mandatory deterministic ledger

| # | Category membership | Case | Result | Evidence |
|---:|---|---|---:|---|
| 1 | baseline_prerequisite_ownership | The recorded starting commit and tree identify the verified remote-main P4 baseline. | PASS | commands.remoteFresh, prerequisites, architecture, databaseInvariants |
| 2 | baseline_prerequisite_ownership | P1 InvestmentCase remains the canonical PE business context consumed by an ICCase. | PASS | commands.remoteFresh, prerequisites, architecture, databaseInvariants |
| 3 | baseline_prerequisite_ownership | P1 temporal Assumption and Evidence semantics remain available without P5 duplication. | PASS | commands.remoteFresh, prerequisites, architecture, databaseInvariants |
| 4 | baseline_prerequisite_ownership | P2 remains the owner of Microsoft source identity, observations, meetings, and evidence handoff. | PASS | commands.remoteFresh, prerequisites, architecture, databaseInvariants |
| 5 | baseline_prerequisite_ownership | P3 remains the owner of Documents, immutable DocumentVersions, anchors, and publication truth. | PASS | commands.remoteFresh, prerequisites, architecture, databaseInvariants |
| 6 | baseline_prerequisite_ownership | P4 remains the sole deterministic underwriting engine and immutable Run owner. | PASS | commands.remoteFresh, prerequisites, architecture, databaseInvariants |
| 7 | baseline_prerequisite_ownership | Core Work and BusinessEvent remain the workflow and event owners used by P5. | PASS | commands.remoteFresh, prerequisites, architecture, databaseInvariants |
| 8 | baseline_prerequisite_ownership | Core Authority and DecisionReceipt remain the authorization and execution-proof owners used by P5. | PASS | commands.remoteFresh, prerequisites, architecture, databaseInvariants |
| 9 | baseline_prerequisite_ownership | The canonical owner registry contains no new P5 owner for Evidence, Artifact, Work, Authority, Receipt, Decision, policy, or finance. | PASS | commands.remoteFresh, prerequisites, architecture, databaseInvariants |
| 10 | baseline_prerequisite_ownership | P5 introduces no P6 planning-core redesign, P7 workforce, fund or LP system, or AWS expansion. | PASS | commands.remoteFresh, prerequisites, architecture, databaseInvariants |
| 11 | baseline_prerequisite_ownership + decision_proposal_p1_decision | P1 pe_decision remains the sole canonical PE investment Decision owner. | PASS | commands.remoteFresh, prerequisites, architecture, databaseInvariants, commands.p5Runtime, commands.p5Golden, commands.p1Certification |
| 12 | baseline_prerequisite_ownership + condition | An IC Condition remains distinct from the existing transaction closing-condition owner. | PASS | commands.remoteFresh, prerequisites, architecture, databaseInvariants, commands.p5Runtime, commands.p5Golden |
| 13 | ic_schema_state_machine | The migration creates exactly thirteen tenant-scoped P5 IC relations. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 14 | ic_schema_state_machine | Every P5 relation carries tenant_id and participates in same-tenant foreign-key enforcement. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 15 | ic_schema_state_machine | ICCase identity pins one exact P1 InvestmentCase root. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 16 | ic_schema_state_machine | ICCase state vocabulary is exactly DRAFT, PREPARING, READY_FOR_REVIEW, QUESTIONS_OPEN, READY_FOR_VOTE, VOTING, CONDITIONS_PENDING, DECIDED, WITHDRAWN, SUPERSEDED, BLOCKED. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 17 | ic_schema_state_machine | DRAFT transitions only through the explicit begin-preparation or withdrawal commands. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 18 | ic_schema_state_machine | PREPARING reaches READY_FOR_REVIEW only through the named readiness command. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 19 | ic_schema_state_machine | READY_FOR_REVIEW reaches READY_FOR_VOTE only through the named readiness command. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 20 | ic_schema_state_machine | READY_FOR_VOTE reaches VOTING only through the governed open-voting transaction. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 21 | ic_schema_state_machine | VOTING reaches DECIDED only through canonical P1 Decision finalization. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 22 | ic_schema_state_machine | Withdrawal is explicit and cannot masquerade as an investment Decision. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 23 | ic_schema_state_machine | No generic UPDATE_IC or generic PATCH state mutation exists. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 24 | ic_schema_state_machine | Optimistic case-version preconditions reject stale mutations. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 25 | ic_schema_state_machine | Case state timestamps are written by the same transaction as their transition. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 26 | ic_schema_state_machine | ICCase entry rejects missing P1 InvestmentCase prerequisites. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 27 | ic_schema_state_machine | ICCase entry rejects cross-root Deal and InvestmentCase combinations. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 28 | ic_schema_state_machine | ICCase entry rejects cross-tenant prerequisite references. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 29 | ic_schema_state_machine | Append-only IC history and mutable lifecycle rows have separately enforced mutation rules. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 30 | ic_schema_state_machine | Database guards reject invalid state, root, version, and lifecycle combinations independently of the API. | PASS | commands.p5Contract, commands.p5Runtime, databaseInvariants |
| 31 | memo_artifact_version | P5 stores memo selection and review state rather than memo or deck content. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 32 | memo_artifact_version | Memo content remains a Core Document with immutable P3 DocumentVersions. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 33 | memo_artifact_version | Every selected memo records an exact P3 Document ID and DocumentVersion ID. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 34 | memo_artifact_version | Every selected memo records an exact P3 ArtifactAnchor and anchor hash. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 35 | memo_artifact_version | Memo selection rejects a DocumentVersion outside the ICCase root. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 36 | memo_artifact_version | Memo selection rejects a stale or mismatched ArtifactAnchor. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 37 | memo_artifact_version | Memo revisions are append-only selections with explicit predecessor identity. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 38 | memo_artifact_version | At most one memo selection is current for an ICCase version. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 39 | memo_artifact_version | The selected memo version is frozen into the voting snapshot. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 40 | memo_artifact_version | Opening voting fails when no exact memo version is selected. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 41 | memo_artifact_version | A memo change during review is visible as a material version change. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 42 | memo_artifact_version | A memo change after Votes follows the pinned policy and requires a fresh vote when configured. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 43 | memo_artifact_version | Memo generation may draft P3 content but cannot fabricate source-backed claims. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 44 | memo_artifact_version | Every memo claim retains links to canonical Evidence, P3, or P4 truth. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 45 | memo_artifact_version | P3 editorial approval cannot be interpreted as IC investment approval. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 46 | memo_artifact_version | Memo and deck publication stays on the P3 publication and read-back path. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification |
| 47 | memo_artifact_version + question_evidence | An IC memo selection pins an exact tenant- and root-consistent P3 DocumentVersion and ArtifactAnchor. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification, commands.coreRegression |
| 48 | memo_artifact_version + question_evidence | A Question source pins an exact canonical P3 ArtifactAnchor without copying artifact truth into P5. | PASS | commands.p5Runtime, commands.p5Golden, commands.p3Certification, commands.coreRegression |
| 49 | question_evidence | A Question belongs to exactly one tenant-consistent ICCase. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 50 | question_evidence | Question state vocabulary is OPEN, ANSWERED, RESOLVED, WAIVED, SUPERSEDED. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 51 | question_evidence | Question creation records explicit required-before-vote and required-before-Decision flags. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 52 | question_evidence | Question creation creates or links canonical Core Work instead of a P5 work system. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 53 | question_evidence | Question answering preserves the question text and adds an immutable answer revision. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 54 | question_evidence | Question resolution is distinct from merely recording an answer. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 55 | question_evidence | Question supersession preserves the prior question and names its successor. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 56 | question_evidence | A required Question blocks opening voting while unresolved. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 57 | question_evidence | A required-before-Decision Question blocks DecisionProposal eligibility while unresolved. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 58 | question_evidence | A Question waiver requires the exact governed Authority decision. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 59 | question_evidence | A Question waiver preserves the Question and its waiver provenance. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 60 | question_evidence | Question Evidence uses canonical Core Evidence and EvidenceVersion identities. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 61 | question_evidence | Question Evidence can pin a P4 UnderwritingRun and exact output path. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 62 | question_evidence | Question source links are typed and reject ambiguous free-text references. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 63 | question_evidence | A Question source rejects cross-tenant EvidenceVersion references. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 64 | question_evidence | A Question source rejects cross-InvestmentCase Evidence references. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 65 | question_evidence | A Question source rejects a P3 artifact outside the case root. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 66 | question_evidence | A Question source rejects a P4 Run outside the case root. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 67 | question_evidence | No ic_evidence table or duplicate Evidence owner is created. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 68 | question_evidence | Question source lineage remains exact after the canonical source receives a later version. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 69 | question_evidence | Question lifecycle changes emit metadata-only BusinessEvents. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 70 | question_evidence | The 100-open-Question hard limit is enforced in the database. | PASS | commands.p5Runtime, commands.p5Golden, commands.coreRegression |
| 71 | recommendation_versioning | A Recommendation belongs to one exact ICCase and recommendation sequence. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 72 | recommendation_versioning | Recommendation outcomes are INVEST, DECLINE, DEFER, INVEST_WITH_CONDITIONS, and CONTINUE_DILIGENCE. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 73 | recommendation_versioning | Recommendation content records structured rationale references rather than becoming a canonical Decision. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 74 | recommendation_versioning | Recommendation revisions are append-only and retain their predecessor identity. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 75 | recommendation_versioning | Recommendation revision numbers are unique and monotonic within an ICCase. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 76 | recommendation_versioning | A Recommendation pins the selected memo revision. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 77 | recommendation_versioning | A Recommendation pins the selected P4 UnderwritingRun. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 78 | recommendation_versioning | A Recommendation pins the policy and committee configuration used to assess readiness. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 79 | recommendation_versioning | Opening voting requires one exact current Recommendation revision. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 80 | recommendation_versioning | The voting snapshot freezes the Recommendation revision. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 81 | recommendation_versioning | A Recommendation change before voting leaves no stale Vote attached. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 82 | recommendation_versioning | A Recommendation change after Votes follows policy and invalidates the prior voting snapshot when required. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 83 | recommendation_versioning | A replacement P4 Run requires a new Recommendation when the pinned policy says so. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 84 | recommendation_versioning | An ineligible, failed, stale, or conflicting P4 Run cannot back a final Recommendation. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 85 | recommendation_versioning | A Recommendation never translates its outcome into a P1 Decision without committee aggregation. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 86 | recommendation_versioning | A DECLINE Recommendation approved by the committee remains a DECLINE proposal. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 87 | recommendation_versioning | INVEST_WITH_CONDITIONS requires at least one real IC Condition. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 88 | recommendation_versioning | Recommendation creation enforces the twenty-revision hard limit. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 89 | recommendation_versioning | Recommendation semantic provenance remains stable across read order. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification |
| 90 | recommendation_versioning + decision_proposal_p1_decision | A Recommendation pins the exact eligible P4 UnderwritingRun it interprets without recalculating finance. | PASS | commands.p5Runtime, commands.p5Golden, commands.p4Certification, commands.p1Certification, databaseInvariants |
| 91 | committee_membership_quorum_policy | Committee configuration is immutable and versioned. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 92 | committee_membership_quorum_policy | An ICCase pins one exact committee configuration version. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 93 | committee_membership_quorum_policy | Committee members reference canonical employee identities rather than free-text names. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 94 | committee_membership_quorum_policy | Membership effective_from participates in eligibility at the voting snapshot time. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 95 | committee_membership_quorum_policy | Membership effective_until participates in eligibility at the voting snapshot time. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 96 | committee_membership_quorum_policy | A non-voting member cannot enter the eligible-voter denominator. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 97 | committee_membership_quorum_policy | Duplicate eligible membership for one employee fails closed. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 98 | committee_membership_quorum_policy | Committee chair identity is explicit and cannot be inferred from row order. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 99 | committee_membership_quorum_policy | Committee membership is capped at fifty members. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 100 | committee_membership_quorum_policy | Meeting attendance never implies committee membership. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 101 | committee_membership_quorum_policy | Meeting attendance never creates a Vote. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 102 | committee_membership_quorum_policy | The voting snapshot freezes the eligible member set. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 103 | committee_membership_quorum_policy | The voting snapshot freezes the exact committee configuration version. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 104 | committee_membership_quorum_policy | Quorum supports an exact minimum-count rule. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 105 | committee_membership_quorum_policy | Percentage quorum uses deterministic integer ceiling arithmetic. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 106 | committee_membership_quorum_policy | Abstention treatment for quorum is explicit in the pinned policy. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 107 | committee_membership_quorum_policy | Deferral treatment for quorum is explicit in the pinned policy. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 108 | committee_membership_quorum_policy | Missing Votes never count toward quorum unless the exact policy explicitly permits their choice class. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 109 | committee_membership_quorum_policy | Simple-majority threshold uses the exact configured denominator. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 110 | committee_membership_quorum_policy | Supermajority threshold uses exact basis points and deterministic ceiling arithmetic. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 111 | committee_membership_quorum_policy | Unanimous threshold requires every configured denominator member to approve. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 112 | committee_membership_quorum_policy | Named-role concurrence is evaluated in addition to its configured base threshold. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 113 | committee_membership_quorum_policy | Unsupported custom quorum or threshold rules fail as BLOCKED_CONFIG. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 114 | committee_membership_quorum_policy | Core policy identity and version are pinned into the committee snapshot. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 115 | committee_membership_quorum_policy | Policy parsing rejects invented rule shapes rather than approximating them. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 116 | committee_membership_quorum_policy | Policy changes do not rewrite historical voting snapshots. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 117 | committee_membership_quorum_policy | Material memo, Run, Recommendation, or membership changes follow the exact pinned policy. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 118 | committee_membership_quorum_policy | Aggregation output records eligible, participating, approve, reject, abstain, and defer counts. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden |
| 119 | committee_membership_quorum_policy + vote_dissent | Effective voter identity derives from the authenticated employee and pinned eligible committee membership. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 120 | committee_membership_quorum_policy + concurrency_idempotency_recovery | Quorum uses the immutable voting snapshot and remains deterministic under concurrent membership changes. | PASS | commands.p5AggregationProperty, commands.p5Runtime, commands.p5Golden, commands.p3Regression |
| 121 | vote_dissent | Vote choices are APPROVE, REJECT, ABSTAIN, and DEFER. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 122 | vote_dissent | A Vote belongs to one exact voting snapshot and Recommendation revision. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 123 | vote_dissent | Vote actor identity is not accepted from request or planner arguments. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 124 | vote_dissent | The Vote endpoint resolves the authenticated principal to a canonical employee. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 125 | vote_dissent | The Vote transaction verifies that employee is eligible in the pinned snapshot. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 126 | vote_dissent | One effective Vote per member is enforced by a database uniqueness invariant. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 127 | vote_dissent | An identical Vote retry converges to the original immutable Vote. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 128 | vote_dissent | A conflicting second Vote from the same member is rejected. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 129 | vote_dissent | Votes are immutable after insertion. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 130 | vote_dissent | Votes cannot be deleted by the application role. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 131 | vote_dissent | A Vote after voting closure is rejected. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 132 | vote_dissent | A Vote on a superseded Recommendation snapshot is rejected. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 133 | vote_dissent | A Vote on a different ICCase root is rejected. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 134 | vote_dissent | A Vote from an ineligible member is rejected and observed. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 135 | vote_dissent | A member becoming ineligible before snapshot creation is excluded. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 136 | vote_dissent | A member becoming ineligible after snapshot creation does not rewrite historical eligibility. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 137 | vote_dissent | Simultaneous distinct member Votes all persist exactly once. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 138 | vote_dissent | Simultaneous conflicting same-member Votes yield one winner and one explicit conflict. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 139 | vote_dissent | Vote rationale is protected content and absent from metadata-only events and metrics. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 140 | vote_dissent | Dissent is a separate append-only process record, not a Vote choice alias. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 141 | vote_dissent | A Dissent pins the exact Vote and voting snapshot it explains. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 142 | vote_dissent | Dissent actor identity is derived from the authenticated eligible member. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 143 | vote_dissent | Dissent cannot be created for another member. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 144 | vote_dissent | Dissent is preserved after majority approval. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 145 | vote_dissent | Dissent is preserved after canonical P1 Decision finalization. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 146 | vote_dissent | Dissent rationale is not copied into telemetry. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 147 | vote_dissent | A committee-approved Recommendation and its minority rejection Votes coexist without erasure. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 148 | vote_dissent | Vote totals are independent of database row arrival order. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 149 | vote_dissent + authority_security | Dissent remains immutable, tenant-isolated process evidence after the majority outcome is finalized. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants, commands.coreRegression, commands.authzMatrix |
| 150 | condition | IC Condition types are PRE_DECISION, POST_DECISION_PRE_SIGNING, PRE_CLOSING, and MONITORING. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 151 | condition | IC Condition states are PROPOSED, ACTIVE, SATISFIED, WAIVED, FAILED, and SUPERSEDED. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 152 | condition | A Condition belongs to exactly one tenant-consistent ICCase. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 153 | condition | Condition creation records whether the condition is required. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 154 | condition | Condition activation is an explicit state transition. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 155 | condition | Condition satisfaction is an explicit state transition with exact supporting truth. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 156 | condition | Condition waiver requires governed Authority. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 157 | condition | Condition waiver preserves the original Condition and provenance. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 158 | condition | Condition failure is explicit and cannot masquerade as satisfaction. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 159 | condition | Condition supersession preserves its predecessor and successor identities. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 160 | condition | An ACTIVE required PRE_DECISION Condition blocks DecisionProposal eligibility. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 161 | condition | A satisfied PRE_DECISION Condition no longer blocks DecisionProposal eligibility. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 162 | condition | A governed waived PRE_DECISION Condition remains visible and no longer blocks. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 163 | condition | INVEST_WITH_CONDITIONS requires an actual IC Condition row. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 164 | condition | POST_DECISION_PRE_SIGNING Conditions may remain active after the investment Decision. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 165 | condition | PRE_CLOSING Conditions never imply that the transaction has closed. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 166 | condition | MONITORING Conditions remain governance obligations rather than closing state. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 167 | condition | Condition fulfillment links canonical Evidence or exact P3/P4 truth. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 168 | condition | Condition lifecycle creates or links Core Work instead of a P5 task system. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 169 | condition | Condition transitions emit metadata-only BusinessEvents. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 170 | condition | At most fifty active or proposed Conditions are allowed per ICCase. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 171 | condition | A Condition cannot cross tenant or InvestmentCase roots. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 172 | condition | Concurrent Condition creation and Decision finalization serialize to one truthful order. | PASS | commands.p5Runtime, commands.p5Golden, databaseInvariants |
| 173 | decision_proposal_p1_decision | DecisionProposal is immutable aggregated process evidence, not a canonical Decision. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 174 | decision_proposal_p1_decision | DecisionProposal pins the exact ICCase version used for aggregation. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 175 | decision_proposal_p1_decision | DecisionProposal pins the committee configuration and policy versions. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 176 | decision_proposal_p1_decision | DecisionProposal pins the memo, Recommendation, and P4 Run revisions. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 177 | decision_proposal_p1_decision | DecisionProposal pins the exact voting snapshot and effective Vote set. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 178 | decision_proposal_p1_decision | DecisionProposal records Question and Condition blockers explicitly. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 179 | decision_proposal_p1_decision | DecisionProposal records deterministic quorum and threshold results. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 180 | decision_proposal_p1_decision | DecisionProposal semantic hash is stable across equivalent input row order. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 181 | decision_proposal_p1_decision | DecisionProposal fails closed for duplicate effective membership or Votes. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 182 | decision_proposal_p1_decision | DecisionProposal fails closed for an ineligible Vote. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 183 | decision_proposal_p1_decision | A blocked DecisionProposal cannot create a P1 Decision. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 184 | decision_proposal_p1_decision | Finalization requires an eligible immutable DecisionProposal. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 185 | decision_proposal_p1_decision | The canonical P1 Decision uses decision_type investment_committee. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 186 | decision_proposal_p1_decision | The P1 Decision retains exact provenance links to the DecisionProposal and process snapshot. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 187 | decision_proposal_p1_decision | Finalization creates one Core DecisionReceipt through the existing execution fabric. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 188 | decision_proposal_p1_decision | An identical finalization retry returns the one canonical P1 Decision and Receipt. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 189 | decision_proposal_p1_decision | Two simultaneous identical finalizations converge to one canonical P1 Decision. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 190 | decision_proposal_p1_decision | P5 never updates or deletes an existing final P1 Decision. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 191 | decision_proposal_p1_decision | Reconsideration creates a new P1 Decision that supersedes the earlier final Decision. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants |
| 192 | decision_proposal_p1_decision + pe_action_fabric_hardening | Finalization calls the existing P1 recordDecision and finalizeDecision semantics instead of owning Decision rows. | PASS | commands.p5Runtime, commands.p5Golden, commands.p1Certification, databaseInvariants, commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 193 | pe_action_fabric_hardening | The Private Equity action registry contains exactly twenty-four executable actions. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 194 | pe_action_fabric_hardening | The nine P5 additions are planner-safe preparation actions only. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 195 | pe_action_fabric_hardening | open_ic_case is a named durable workflow action with a fixed schema. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 196 | pe_action_fabric_hardening | begin_ic_preparation is a named transition action with a fixed schema. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 197 | pe_action_fabric_hardening | select_ic_memo_version requires exact grounded P3 identifiers. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 198 | pe_action_fabric_hardening | select_ic_underwriting_run requires an exact grounded P4 Run identifier. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 199 | pe_action_fabric_hardening | create_ic_question creates an explicit typed Question rather than a generic update. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 200 | pe_action_fabric_hardening | attach_ic_question_evidence accepts only exact canonical source identities. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 201 | pe_action_fabric_hardening | request_ic_memo_review is a named review-readiness operation. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 202 | pe_action_fabric_hardening | satisfy_ic_condition requires an exact Condition and supporting truth. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 203 | pe_action_fabric_hardening | prepare_ic_decision_proposal computes a draft proposal without finalizing a Decision. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 204 | pe_action_fabric_hardening | Every executable action has exactly one action-hardening specification row. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 205 | pe_action_fabric_hardening | Every P5 action schema rejects tenantId and actorId selectors. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 206 | pe_action_fabric_hardening | Action grounding resolves exact tenant-owned canonical entities before mutation. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 207 | pe_action_fabric_hardening | Action preconditions pin case and referenced object versions. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 208 | pe_action_fabric_hardening | Action authority checks occur outside presentation/UI code. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 209 | pe_action_fabric_hardening | Action effects are recorded through existing Core BusinessEffect semantics. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 210 | pe_action_fabric_hardening | Action verification reads back the postcondition instead of trusting invocation success. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 211 | pe_action_fabric_hardening | Action completion creates or converges on an existing Core DecisionReceipt. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 212 | pe_action_fabric_hardening | Action idempotency keys converge retries without duplicate domain effects. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 213 | pe_action_fabric_hardening | Ambiguous failures trigger read-back recovery before any repeat mutation. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 214 | pe_action_fabric_hardening | The executable registry and fixed manifest agree on all forty-one global actions. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture |
| 215 | pe_action_fabric_hardening + authority_security | Planner input cannot cast a Vote, create a Dissent, waive governance, close voting, or finalize a Decision. | PASS | commands.actionManifest, commands.plannerIsolation, commands.p5Contract, architecture, commands.p5Runtime, commands.coreRegression, commands.authzMatrix, databaseInvariants |
| 216 | authority_security | Core Authority decisions authorize operations but are never IC Votes or P1 investment Decisions. | PASS | commands.p5Runtime, commands.coreRegression, commands.authzMatrix, databaseInvariants |
| 217 | authority_security | Question waiver requires the exact Authority capability and scoped resource. | PASS | commands.p5Runtime, commands.coreRegression, commands.authzMatrix, databaseInvariants |
| 218 | authority_security | Condition waiver requires the exact Authority capability and scoped resource. | PASS | commands.p5Runtime, commands.coreRegression, commands.authzMatrix, databaseInvariants |
| 219 | authority_security | Voting open and close require their exact governed capabilities. | PASS | commands.p5Runtime, commands.coreRegression, commands.authzMatrix, databaseInvariants |
| 220 | authority_security | P1 Decision finalization requires an Authority decision outside the UI. | PASS | commands.p5Runtime, commands.coreRegression, commands.authzMatrix, databaseInvariants |
| 221 | authority_security | Authority denial fails before any P5 or P1 mutation. | PASS | commands.p5Runtime, commands.coreRegression, commands.authzMatrix, databaseInvariants |
| 222 | authority_security | All thirteen P5 relations have enabled and forced tenant RLS. | PASS | commands.p5Runtime, commands.coreRegression, commands.authzMatrix, databaseInvariants |
| 223 | authority_security | Cross-tenant reads and writes fail under the application role. | PASS | commands.p5Runtime, commands.coreRegression, commands.authzMatrix, databaseInvariants |
| 224 | authority_security | Prompt-injected voter, tenant, authority, or finalization instructions cannot alter trusted identity context. | PASS | commands.p5Runtime, commands.coreRegression, commands.authzMatrix, databaseInvariants |
| 225 | authority_security | Audit events and metrics contain identifiers and states but no memo, answer, vote, dissent, evidence, or financial content. | PASS | commands.p5Runtime, commands.coreRegression, commands.authzMatrix, databaseInvariants |
| 226 | concurrency_idempotency_recovery | Two conflicting Votes from one authenticated member produce one immutable effective Vote. | PASS | commands.p5Runtime, commands.p3Regression |
| 227 | concurrency_idempotency_recovery | Voting close racing a new Vote yields either an included Vote or an explicit late-Vote rejection. | PASS | commands.p5Runtime, commands.p3Regression |
| 228 | concurrency_idempotency_recovery | Recommendation revision racing a Vote cannot attach the Vote to the wrong revision. | PASS | commands.p5Runtime, commands.p3Regression |
| 229 | concurrency_idempotency_recovery | Memo revision selection racing voting-open cannot produce a mixed snapshot. | PASS | commands.p5Runtime, commands.p3Regression |
| 230 | concurrency_idempotency_recovery | Question resolution racing voting-open retains a single serializable truth. | PASS | commands.p5Runtime, commands.p3Regression |
| 231 | concurrency_idempotency_recovery | Condition creation racing Decision finalization retains a single serializable truth. | PASS | commands.p5Runtime, commands.p3Regression |
| 232 | concurrency_idempotency_recovery | Two simultaneous finalization requests converge to one P1 Decision. | PASS | commands.p5Runtime, commands.p3Regression |
| 233 | concurrency_idempotency_recovery | P1 Decision supersession racing a Decision proof read returns a coherent before-or-after proof. | PASS | commands.p5Runtime, commands.p3Regression |
| 234 | concurrency_idempotency_recovery | Crash after ICCase insertion and before event publication rolls back and replays cleanly. | PASS | commands.p5Runtime, commands.p3Regression |
| 235 | concurrency_idempotency_recovery | Crash after Vote insertion and before response replays to one immutable Vote. | PASS | commands.p5Runtime, commands.p3Regression |
| 236 | concurrency_idempotency_recovery | Crash between P1 Decision creation, P5 linkage, Receipt creation, and response never leaves a false completed state. | PASS | commands.p5Runtime, commands.p3Regression |
| 237 | api_frontend_contract | The P5 API exposes exactly thirty typed routes and no generic mutation route. | PASS | commands.p5Contract, commands.openapi, commands.authzMatrix, architecture |
| 238 | api_frontend_contract | The Vote API is a separate authenticated human endpoint with no voter selector. | PASS | commands.p5Contract, commands.openapi, commands.authzMatrix, architecture |
| 239 | api_frontend_contract | Every P5 API route is present in generated OpenAPI. | PASS | commands.p5Contract, commands.openapi, commands.authzMatrix, architecture |
| 240 | api_frontend_contract | Every P5 API route is present in the generated authorization matrix. | PASS | commands.p5Contract, commands.openapi, commands.authzMatrix, architecture |
| 241 | api_frontend_contract | The IC aggregate endpoint returns semantic memo, Question, Recommendation, voting, Condition, and Decision proof sections. | PASS | commands.p5Contract, commands.openapi, commands.authzMatrix, architecture |
| 242 | api_frontend_contract | The IC Workspace renders the full lifecycle without raw JSON panels. | PASS | commands.p5Contract, commands.openapi, commands.authzMatrix, architecture |
| 243 | api_frontend_contract | The frontend labels P3 editorial state, P4 finance, Authority, and P1 Decision ownership truthfully. | PASS | commands.p5Contract, commands.openapi, commands.authzMatrix, architecture |
| 244 | api_frontend_contract | The frontend never presents a planner operation as a human Vote, waiver, voting close, or final Decision. | PASS | commands.p5Contract, commands.openapi, commands.authzMatrix, architecture |
| 245 | migration_regression_release_boundary | A fresh database applies every migration through 0127 and creates empty P5 tables. | PASS | commands.freshMigration, commands.p5Upgrade, commands.releaseBoundary, commands.historicalPe5 |
| 246 | migration_regression_release_boundary | A populated P1-P4 database upgrades through 0127 without changing legacy row bytes or identities. | PASS | commands.freshMigration, commands.p5Upgrade, commands.releaseBoundary, commands.historicalPe5 |
| 247 | migration_regression_release_boundary | Legacy P1 investment_committee Decisions remain valid without fabricated P5 history. | PASS | commands.freshMigration, commands.p5Upgrade, commands.releaseBoundary, commands.historicalPe5 |
| 248 | migration_regression_release_boundary | P1 deterministic certification and integration regressions remain green. | PASS | commands.freshMigration, commands.p5Upgrade, commands.releaseBoundary, commands.historicalPe5 |
| 249 | migration_regression_release_boundary | P2 deterministic certification and integration regressions remain green. | PASS | commands.freshMigration, commands.p5Upgrade, commands.releaseBoundary, commands.historicalPe5 |
| 250 | migration_regression_release_boundary | P3 deterministic certification and integration regressions remain green. | PASS | commands.freshMigration, commands.p5Upgrade, commands.releaseBoundary, commands.historicalPe5 |
| 251 | migration_regression_release_boundary | P4 deterministic certification and integration regressions remain green. | PASS | commands.freshMigration, commands.p5Upgrade, commands.releaseBoundary, commands.historicalPe5 |
| 252 | migration_regression_release_boundary | Historical release:pe5 evidence remains intact while release:pe-p5-actions-ic is unambiguous and production release remains gated by literal /GOAL. | PASS | commands.freshMigration, commands.p5Upgrade, commands.releaseBoundary, commands.historicalPe5 |
| 253 | performance_limits | Loading the complete IC aggregate stays inside its measured release guardrail. | PASS | commands.p5Runtime.benchmark |
| 254 | performance_limits | Opening one Question stays inside its measured release guardrail. | PASS | commands.p5Runtime.benchmark |
| 255 | performance_limits | Fifty authenticated concurrent Votes stay inside their measured release guardrail. | PASS | commands.p5Runtime.benchmark |
| 256 | performance_limits | Closing and aggregating a fifty-member Vote set stays inside its measured release guardrail. | PASS | commands.p5Runtime.benchmark |
| 257 | performance_limits | Computing and persisting an immutable DecisionProposal stays inside its measured release guardrail. | PASS | commands.p5Runtime.benchmark |
| 258 | performance_limits | The canonical P1 Decision finalization transaction stays inside its measured release guardrail. | PASS | commands.p5Runtime.benchmark |
| 259 | performance_limits | Loading the authenticated Decision proof stays inside its measured release guardrail. | PASS | commands.p5Runtime.benchmark |
| 260 | performance_limits | The exact 100-open-Question and 50-active-Condition limits are enforced and measured. | PASS | commands.p5Runtime.benchmark |

## Remaining blockers

- Production release was intentionally not executed because literal /GOAL was not supplied; this is outside deterministic P5 completion.

P6 handoff: P6 may consume the immutable IC aggregate, exact DecisionProposal/proof, canonical P1 Decision link, Work/Event/Authority/Receipt evidence, and the nine planner-safe preparation actions. P6 must not forge sovereign committee acts, alter P1/P3/P4 ownership, or redesign P5 state.
