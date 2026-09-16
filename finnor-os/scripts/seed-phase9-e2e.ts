import { createHash } from "node:crypto";
import pg from "pg";
import { assertDisposableDatabaseTarget } from "../packages/db/production-target-guard";
import {
  closePool,
  completeWorkPlanRevision,
  receiveWork,
  transitionWork,
} from "@finnor/db";
import { appendEvidenceVersion, createEvidenceSource } from "@finnor/memory";
import {
  activateIcCondition,
  activateInvestmentCase,
  addDealParty,
  answerIcQuestion,
  attachCanonicalDocument,
  attachCanonicalEvidence,
  attachIcQuestionSource,
  attachWorkToDealGraph,
  beginIcPreparation,
  closeIcVoting,
  createAssumption,
  createClosingCondition,
  createClosingItem,
  createDeal,
  createDealRisk,
  createDeliverable,
  createDependency,
  createFinding,
  createIcCase,
  createIcCommitteeConfiguration,
  createIcCondition,
  createIcQuestion,
  createIcRecommendation,
  createInvestmentCase,
  createMilestone,
  createRequest,
  createThesis,
  createUnderwritingModel,
  createUnderwritingModelVersion,
  createUnderwritingRun,
  createWorkstream,
  finalizeIcDecision,
  getIcWorkspace,
  markClosingConditionEvidencePending,
  markClosingItemReady,
  markIcReadyForReview,
  markIcReadyForVote,
  openIcVoting,
  recordIcDissent,
  recordIcVote,
  resolveIcQuestion,
  satisfyIcCondition,
  selectIcMemoVersion,
  startWorkstream,
  transitionThesis,
  verifyClosingItem,
  type ExplicitUnderwritingInput,
  type IcPolicySnapshot,
  type PeMutationContext,
} from "@finnor/private-equity";
import {
  createStandardLboInputSnapshot,
  createStandardLboModel,
  type StandardLboInputValues,
  type StandardLboModelConfig,
} from "@finnor/underwriting";
import { GOLDEN_UNDERWRITING_CASES, type GoldenLboCase } from "../tests/underwriting-corpus/golden-cases";

const ADMIN_URL = process.env.DATABASE_URL;
assertDisposableDatabaseTarget(ADMIN_URL, "Phase 9 e2e fixture");

const ownerEmail = process.env.TEST_OWNER_EMAIL;
if (!ownerEmail) throw new Error("TEST_OWNER_EMAIL is required so the authenticated browser maps to the disposable fixture owner");

const appUrl = new URL(ADMIN_URL);
appUrl.username = "finnor_app";
appUrl.password = "finnor_app";
const APP_URL = appUrl.toString();

const TENANT_ID = "00000000-0000-4000-8000-000000000001";
const DEAL_ID = "90000000-0000-4000-8000-000000000001";
const INVESTMENT_CASE_ID = "90000000-0000-4000-8000-000000000002";
const THESIS_ID = "90000000-0000-4000-8000-000000000003";
const ASSUMPTION_ID = "90000000-0000-4000-8000-000000000004";
const WORKSTREAM_ID = "90000000-0000-4000-8000-000000000005";
const DEAL_PARTY_ID = "90000000-0000-4000-8000-000000000006";
const REQUEST_ID = "90000000-0000-4000-8000-000000000007";
const DELIVERABLE_ID = "90000000-0000-4000-8000-000000000008";
const FINDING_ID = "90000000-0000-4000-8000-000000000009";
const RISK_ID = "90000000-0000-4000-8000-000000000010";
const CLOSING_CONDITION_ID = "90000000-0000-4000-8000-000000000011";
const CLOSING_ITEM_ID = "90000000-0000-4000-8000-000000000012";
const MILESTONE_ID = "90000000-0000-4000-8000-000000000013";
const DEPENDENCY_ID = "90000000-0000-4000-8000-000000000014";
const PRIMARY_WORK_ID = "90000000-0000-4000-8000-000000000015";
const PRIMARY_INPUT_ID = "90000000-0000-4000-8000-000000000016";
const BLOCKER_WORK_ID = "90000000-0000-4000-8000-000000000017";
const BLOCKER_INPUT_ID = "90000000-0000-4000-8000-000000000018";
const PLAN_REVISION_ID = "90000000-0000-4000-8000-000000000019";
const ACTION_ID = "90000000-0000-4000-8000-000000000020";
const EFFECT_ID = "90000000-0000-4000-8000-000000000021";
const RECEIPT_ID = "90000000-0000-4000-8000-000000000022";
const AGENT_PROFILE_ID = "90000000-0000-4000-8000-000000000023";
const AGENT_REVISION_ID = "90000000-0000-4000-8000-000000000024";
const ASSIGNMENT_ID = "90000000-0000-4000-8000-000000000025";
const LEARNING_OBSERVATION_ID = "90000000-0000-4000-8000-000000000026";
const TARGET_ORGANIZATION_ID = "90000000-0000-4000-8000-000000000027";
const MEMO_DOCUMENT_ID = "90000000-0000-4000-8000-000000000028";
const MEMO_VERSION_ID = "90000000-0000-4000-8000-000000000029";
const QOE_DOCUMENT_ID = "90000000-0000-4000-8000-000000000030";
const QOE_VERSION_ID = "90000000-0000-4000-8000-000000000031";
const ORG_UNIT_ID = "90000000-0000-4000-8000-000000000032";
const POLICY_ID = "90000000-0000-4000-8000-000000000033";
const POLICY_REVISION_ID = "90000000-0000-4000-8000-000000000034";
const COMMITTEE_CONFIG_ID = "90000000-0000-4000-8000-000000000035";
const IC_CASE_ID = "90000000-0000-4000-8000-000000000036";
const IC_MEMO_ID = "90000000-0000-4000-8000-000000000037";
const IC_QUESTION_ID = "90000000-0000-4000-8000-000000000038";
const IC_RECOMMENDATION_ID = "90000000-0000-4000-8000-000000000039";
const IC_CONDITION_ID = "90000000-0000-4000-8000-000000000040";
const VOTE_ONE_ID = "90000000-0000-4000-8000-000000000041";
const VOTE_TWO_ID = "90000000-0000-4000-8000-000000000042";
const VOTE_THREE_ID = "90000000-0000-4000-8000-000000000043";
const DISSENT_ID = "90000000-0000-4000-8000-000000000044";
const MEMBER_TWO_ID = "90000000-0000-4000-8000-000000000045";
const MEMBER_THREE_ID = "90000000-0000-4000-8000-000000000046";
const OBJECTIVE_LOOP_ID = "90000000-0000-4000-8000-000000000047";
const OBJECTIVE_STEP_ID = "90000000-0000-4000-8000-000000000048";
const FOREIGN_TENANT_ID = "99999999-9999-4999-8999-999999999990";
const FOREIGN_OWNER_ID = "99999999-9999-4999-8999-999999999991";
const FOREIGN_ORGANIZATION_ID = "99999999-9999-4999-8999-999999999992";
export const FOREIGN_DEAL_ID = "99999999-9999-4999-8999-999999999999";

const PLAN_NODE_ID = "verify-closing-evidence";

function sha(label: string): string {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function hex(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function idOf(value: Record<string, unknown>, key = "id"): string {
  const id = value[key];
  if (typeof id !== "string") throw new Error(`${key} was not returned as an ID`);
  return id;
}

function context(tenantId: string, employeeId: string): PeMutationContext {
  return {
    auth: { tenantId, userId: employeeId, employeeId, role: "owner" },
    provenance: { sourceSystem: "certification:phase9", createdBy: employeeId },
  };
}

function firstGoldenLbo(): GoldenLboCase {
  const fixture = GOLDEN_UNDERWRITING_CASES.find((item): item is GoldenLboCase => item.kind === "lbo");
  if (!fixture) throw new Error("The independent golden LBO corpus is empty");
  return structuredClone(fixture);
}

function fixtureExplicitInputs(
  config: StandardLboModelConfig,
  values: StandardLboInputValues,
  excluded: ReadonlySet<string>,
): Record<string, ExplicitUnderwritingInput> {
  const snapshot = createStandardLboInputSnapshot(config, values);
  return Object.fromEntries(Object.entries(snapshot.values)
    .filter(([nodeId]) => !excluded.has(nodeId))
    .map(([nodeId, input]) => [nodeId, {
      value: input.value,
      truthClass: "MODEL_PARAMETER" as const,
      status: "KNOWN" as const,
      provenance: [{ kind: "model_parameter" as const, id: nodeId }],
    }]));
}

async function main(): Promise<void> {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    const existing = await admin.query("SELECT 1 FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2", [TENANT_ID, DEAL_ID]);
    if (existing.rowCount) {
      console.log(JSON.stringify({ status: "already_seeded", tenantId: TENANT_ID, dealId: DEAL_ID, foreignDealId: FOREIGN_DEAL_ID }));
      return;
    }

    const owner = (await admin.query<{ id: string }>(
      "SELECT id::text FROM finnor_os.users WHERE tenant_id=$1 AND role='owner' ORDER BY created_at,id LIMIT 1",
      [TENANT_ID],
    )).rows[0];
    if (!owner) throw new Error("Run npm run db:seed before the Phase 9 fixture");
    const ownerId = owner.id;
    await admin.query(
      "UPDATE finnor_os.users SET email=$2,status='active',display_name='Phase 9 Investment Partner' WHERE tenant_id=$1 AND id=$3",
      [TENANT_ID, ownerEmail, ownerId],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES
       ($1,$3,'phase9.ic.member.two@test.invalid','owner','active','IC Member Two'),
       ($2,$3,'phase9.ic.member.three@test.invalid','owner','active','IC Member Three')`,
      [MEMBER_TWO_ID, MEMBER_THREE_ID, TENANT_ID],
    );
    await admin.query(
      `INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind)
       VALUES($1,$2,'phase9-atlas-software','Atlas Software','other')`,
      [TARGET_ORGANIZATION_ID, TENANT_ID],
    );
    await admin.query(
      `INSERT INTO finnor_os.org_units(id,tenant_id,unit_key,name,kind,active)
       VALUES($1,$2,'phase9-investment-committee','Investment Committee','team',true)`,
      [ORG_UNIT_ID, TENANT_ID],
    );

    const policy: IcPolicySnapshot = {
      schemaVersion: "pe-ic-policy.v1",
      quorum: { kind: "MIN_COUNT", minimum: 3 },
      threshold: { kind: "SIMPLE_MAJORITY" },
      abstentionsCountForQuorum: true,
      deferralsCountForQuorum: false,
      abstentionsCountAsNonApprove: true,
      deferralsCountAsNonApprove: true,
      memoChange: "REQUIRE_REVOTE",
      underwritingRunChange: "REQUIRE_NEW_RECOMMENDATION",
      requiredQuestionWaiverAllowed: true,
      conditionWaiverAllowed: true,
      allowedPrimaryRunValidities: ["VALID"],
    };
    await admin.query(
      `INSERT INTO finnor_os.domain_policies(
         id,tenant_id,action_type,policy,requires_confirmation,version,effective_from
       ) VALUES($1,$2,'private_equity:ic_process',$3::jsonb,false,1,now())`,
      [POLICY_ID, TENANT_ID, JSON.stringify(policy)],
    );
    await admin.query(
      `INSERT INTO finnor_os.domain_policy_revisions(
         id,tenant_id,policy_id,action_type,version,policy,requires_confirmation,effective_from
       ) VALUES($1,$2,$3,'private_equity:ic_process',1,$4::jsonb,false,now())`,
      [POLICY_REVISION_ID, TENANT_ID, POLICY_ID, JSON.stringify(policy)],
    );
    await admin.query(
      `INSERT INTO finnor_os.documents(id,tenant_id,kind,title,source_system,created_by) VALUES
       ($1,$3,'ic_memo','Atlas Investment Committee Memo','certification:phase9',$4),
       ($2,$3,'quality_of_earnings','Atlas Quality of Earnings Report','certification:phase9',$4)`,
      [MEMO_DOCUMENT_ID, QOE_DOCUMENT_ID, TENANT_ID, ownerId],
    );
    await admin.query(
      `INSERT INTO finnor_os.document_versions(
         id,tenant_id,document_id,version_ordinal,origin,format,media_type,byte_sha256,size_bytes,created_by
       ) VALUES
       ($1,$3,$4,1,'finnor_generated','docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',$6,12400,$7),
       ($2,$3,$5,1,'manual_upload','pdf','application/pdf',$8,28100,$7)`,
      [MEMO_VERSION_ID, QOE_VERSION_ID, TENANT_ID, MEMO_DOCUMENT_ID, QOE_DOCUMENT_ID, "a".repeat(64), ownerId, "b".repeat(64)],
    );

    process.env.DATABASE_URL = APP_URL;
    await closePool();
    const ctx = context(TENANT_ID, ownerId);
    const work = await receiveWork({
      tenantId: TENANT_ID,
      workId: PRIMARY_WORK_ID,
      instructionId: PRIMARY_INPUT_ID,
      instruction: "Verify the Atlas QoE evidence package and record the governed closing outcome.",
      channel: "console",
      userId: ownerId,
      idempotencyKey: "phase9-primary-work-v1",
    });

    await createDeal(ctx, {
      id: DEAL_ID,
      targetOrganizationId: TARGET_ORGANIZATION_ID,
      name: "Atlas Software acquisition",
      codeName: "ATLAS",
      dealLeadEmployeeId: ownerId,
      signedLoiAt: new Date("2026-08-20T09:00:00.000Z"),
      targetClosingAt: new Date("2026-10-15T17:00:00.000Z"),
    });
    await createInvestmentCase(ctx, {
      id: INVESTMENT_CASE_ID,
      dealId: DEAL_ID,
      title: "Atlas control investment case",
      summary: "Control acquisition of a vertical-market software platform with a source-backed downside case.",
    });
    await activateInvestmentCase(ctx, { investmentCaseId: INVESTMENT_CASE_ID, expectedVersion: 1 });
    await createThesis(ctx, {
      id: THESIS_ID,
      dealId: DEAL_ID,
      investmentCaseId: INVESTMENT_CASE_ID,
      thesisType: "value_creation",
      title: "Durable vertical workflow retention",
      statement: "High recurring revenue and embedded workflow depth support durable retention and measured pricing power.",
    });
    await transitionThesis(ctx, { thesisId: THESIS_ID, expectedVersion: 1, targetState: "active" });

    const evidenceSource = await createEvidenceSource(TENANT_ID, {
      sourceKey: "phase9-atlas-qoe-v1",
      sourceType: "quality_of_earnings",
      canonicalUrl: "https://evidence.invalid/atlas/qoe#customer-concentration",
      title: "Atlas QoE — customer concentration and adjusted EBITDA",
      publisher: "Independent QoE Advisor",
      metadata: { documentId: QOE_DOCUMENT_ID, documentVersionId: QOE_VERSION_ID, page: 42 },
    });
    const evidence = await appendEvidenceVersion(TENANT_ID, evidenceSource.id, {
      content: "The top customer represents 31% of recurring revenue. Adjusted EBITDA is supported after reversing one-time implementation credits.",
      snapshot: { customerConcentrationPercent: 31, adjustedEbitda: "12.5", sourceLocation: { documentId: QOE_DOCUMENT_ID, documentVersionId: QOE_VERSION_ID, page: 42 } },
      asOf: new Date("2026-09-10T12:00:00.000Z"),
      retrievedAt: new Date(),
    });

    await createAssumption(ctx, {
      id: ASSUMPTION_ID,
      dealId: DEAL_ID,
      investmentCaseId: INVESTMENT_CASE_ID,
      assumptionKey: "exit_multiple",
      statement: "Base case exit multiple is 5.0x.",
      valueType: "number",
      value: 5,
      unit: "multiple",
      materiality: "critical",
    });
    await attachCanonicalEvidence(ctx, {
      dealId: DEAL_ID,
      entity: { entityType: "pe_assumption", entityId: ASSUMPTION_ID },
      evidenceSourceId: evidenceSource.id,
      evidenceVersionId: evidence.versionId,
      relationship: "supports",
    });

    const workstream = await createWorkstream(ctx, {
      id: WORKSTREAM_ID,
      dealId: DEAL_ID,
      kind: "financial_diligence",
      name: "Financial and QoE diligence",
      owner: { partyType: "employee", partyId: ownerId },
    });
    await startWorkstream(ctx, { workstreamId: idOf(workstream.row), expectedVersion: 1 });
    await addDealParty(ctx, {
      id: DEAL_PARTY_ID,
      dealId: DEAL_ID,
      party: { partyType: "external_organization", partyId: TARGET_ORGANIZATION_ID },
      role: "target_management",
    });
    await createRequest(ctx, {
      id: REQUEST_ID,
      dealId: DEAL_ID,
      workstreamId: WORKSTREAM_ID,
      requestedFromDealPartyId: DEAL_PARTY_ID,
      owner: { partyType: "employee", partyId: ownerId },
      requestText: "Provide customer-level ARR bridge and renewal support for the top ten customers.",
      requestedAt: new Date("2026-09-09T09:00:00.000Z"),
      dueAt: new Date("2026-09-18T17:00:00.000Z"),
      requiresAcceptedDeliverable: true,
    });
    await createDeliverable(ctx, {
      id: DELIVERABLE_ID,
      dealId: DEAL_ID,
      workstreamId: WORKSTREAM_ID,
      requestId: REQUEST_ID,
      responsibleDealPartyId: DEAL_PARTY_ID,
      description: "Customer-level ARR bridge with renewal evidence.",
      kind: "data_room_schedule",
      dueAt: new Date("2026-09-18T17:00:00.000Z"),
      requiresDocument: true,
      requiredForWorkstreamCompletion: true,
    });
    await createFinding(ctx, {
      id: FINDING_ID,
      dealId: DEAL_ID,
      workstreamId: WORKSTREAM_ID,
      relatedRequestId: REQUEST_ID,
      statement: "Top customer represents 31% of recurring revenue.",
      severity: "critical",
      materiality: "critical",
      owner: { partyType: "employee", partyId: ownerId },
      requiredForWorkstreamCompletion: true,
    });
    await createDealRisk(ctx, {
      id: RISK_ID,
      dealId: DEAL_ID,
      workstreamId: WORKSTREAM_ID,
      statement: "Customer concentration may impair downside debt-service coverage.",
      severity: "critical",
      owner: { partyType: "employee", partyId: ownerId },
      response: "Require signed renewal support and reflect concentration in the downside underwriting case.",
      requiredForWorkstreamCompletion: true,
      originatingFindingIds: [FINDING_ID],
    });
    await attachCanonicalDocument(ctx, { dealId: DEAL_ID, entity: { entityType: "pe_finding", entityId: FINDING_ID }, documentId: QOE_DOCUMENT_ID, linkRole: "source" });
    for (const entity of [
      { entityType: "pe_finding" as const, entityId: FINDING_ID },
      { entityType: "pe_deal_risk" as const, entityId: RISK_ID },
    ]) {
      await attachCanonicalEvidence(ctx, { dealId: DEAL_ID, entity, evidenceSourceId: evidenceSource.id, evidenceVersionId: evidence.versionId, relationship: "supports" });
    }
    await createClosingCondition(ctx, {
      id: CLOSING_CONDITION_ID,
      dealId: DEAL_ID,
      workstreamId: WORKSTREAM_ID,
      conditionText: "Top-customer renewal evidence is verified against the signed contract.",
      category: "commercial",
      requiredForClose: true,
      evidenceRequired: true,
      waiverRequiresApproval: true,
      owner: { partyType: "employee", partyId: ownerId },
      responsibleDealPartyId: DEAL_PARTY_ID,
      dueAt: new Date("2026-10-01T17:00:00.000Z"),
    });
    await markClosingConditionEvidencePending(ctx, { closingConditionId: CLOSING_CONDITION_ID, expectedVersion: 1 });
    await attachCanonicalEvidence(ctx, {
      dealId: DEAL_ID,
      entity: { entityType: "pe_closing_condition", entityId: CLOSING_CONDITION_ID },
      evidenceSourceId: evidenceSource.id,
      evidenceVersionId: evidence.versionId,
      relationship: "supports",
    });
    await createClosingItem(ctx, {
      id: CLOSING_ITEM_ID,
      dealId: DEAL_ID,
      workstreamId: WORKSTREAM_ID,
      itemText: "QoE evidence package is indexed in the closing record.",
      category: "evidence",
      requiredForClose: true,
      verificationEvidenceRequired: true,
      owner: { partyType: "employee", partyId: ownerId },
      dueAt: new Date("2026-09-25T17:00:00.000Z"),
    });
    await markClosingItemReady(ctx, { closingItemId: CLOSING_ITEM_ID, expectedVersion: 1 });
    await createMilestone(ctx, {
      id: MILESTONE_ID,
      dealId: DEAL_ID,
      name: "IC and closing evidence refresh",
      kind: "investment_committee",
      owner: { partyType: "employee", partyId: ownerId },
      targetAt: new Date("2026-09-24T15:00:00.000Z"),
    });
    await createDependency(ctx, {
      id: DEPENDENCY_ID,
      dealId: DEAL_ID,
      blocker: { entityType: "pe_deal_risk", entityId: RISK_ID },
      blocked: { entityType: "pe_closing_condition", entityId: CLOSING_CONDITION_ID },
    });

    const golden = firstGoldenLbo();
    const config = golden.config;
    config.modelVersion = "phase9-e2e-v1";
    config.inputBindings = { "exit.multiple": { kind: "p1_assumption", assumptionId: ASSUMPTION_ID } };
    const values = golden.inputs;
    values.investmentCaseId = INVESTMENT_CASE_ID;
    const model = await createUnderwritingModel(ctx, {
      investmentCaseId: INVESTMENT_CASE_ID,
      modelKey: "standard_lbo_v1",
      name: "Atlas institutional LBO",
    });
    const modelVersion = await createUnderwritingModelVersion(ctx, {
      modelId: idOf(model),
      definition: createStandardLboModel(config),
    });
    const worldAt = new Date().toISOString();
    values.worldAt = worldAt;
    const run = await createUnderwritingRun(ctx, {
      investmentCaseId: INVESTMENT_CASE_ID,
      modelVersionId: idOf(modelVersion),
      worldAt,
      workId: PRIMARY_WORK_ID,
      idempotencyKey: "phase9-underwriting-run-v1",
      explicitInputs: fixtureExplicitInputs(config, values, new Set(["exit.multiple"])),
    });

    await attachCanonicalDocument(ctx, {
      dealId: DEAL_ID,
      entity: { entityType: "pe_investment_case", entityId: INVESTMENT_CASE_ID },
      documentId: MEMO_DOCUMENT_ID,
      linkRole: "governing",
    });
    const committee = await createIcCommitteeConfiguration(ctx, {
      id: COMMITTEE_CONFIG_ID,
      committeeOrgUnitId: ORG_UNIT_ID,
      policyRevisionId: POLICY_REVISION_ID,
      members: [ownerId, MEMBER_TWO_ID, MEMBER_THREE_ID].map((employeeId, index) => ({
        employeeId,
        memberRole: index === 0 ? "CHAIR" : "MEMBER",
        votingEligible: true,
        chair: index === 0,
        effectiveFrom: "2026-01-01T00:00:00.000Z",
      })),
      idempotencyKey: "phase9-committee-config-v1",
    });
    await createIcCase(ctx, {
      id: IC_CASE_ID,
      dealId: DEAL_ID,
      investmentCaseId: INVESTMENT_CASE_ID,
      committeeConfigVersionId: idOf(committee.config),
      primaryUnderwritingRunId: run.id,
      workId: PRIMARY_WORK_ID,
      idempotencyKey: "phase9-ic-case-v1",
    });
    await beginIcPreparation(ctx, { icCaseId: IC_CASE_ID, expectedVersion: 1 });
    const selected = await selectIcMemoVersion(ctx, {
      id: IC_MEMO_ID,
      icCaseId: IC_CASE_ID,
      expectedCaseVersion: 2,
      artifactRole: "MEMO",
      documentId: MEMO_DOCUMENT_ID,
      documentVersionId: MEMO_VERSION_ID,
      underwritingRunId: run.id,
      evidenceCutoffAt: new Date().toISOString(),
      sourceCompleteness: "COMPLETE",
      semanticChecks: { financeOwner: "P4", evidenceOwner: "P3", fixture: "phase9" },
      idempotencyKey: "phase9-ic-memo-v1",
    });
    const question = await createIcQuestion(ctx, {
      id: IC_QUESTION_ID,
      icCaseId: IC_CASE_ID,
      expectedCaseVersion: Number(selected.case.version),
      question: "Does the downside case adequately reflect top-customer concentration?",
      priority: "CRITICAL",
      requiredBeforeVote: true,
      requiredBeforeDecision: true,
      workId: PRIMARY_WORK_ID,
      idempotencyKey: "phase9-ic-question-v1",
    });
    const sourced = await attachIcQuestionSource(ctx, {
      icCaseId: IC_CASE_ID,
      questionId: IC_QUESTION_ID,
      expectedQuestionVersion: 1,
      link: {
        source: { kind: "EVIDENCE_VERSION", evidenceVersionId: evidence.versionId },
        relationship: "ANSWERS",
        truthStatus: "ATTACHED",
        idempotencyKey: "phase9-ic-question-evidence-v1",
      },
    });
    const answered = await answerIcQuestion(ctx, {
      icCaseId: IC_CASE_ID,
      questionId: IC_QUESTION_ID,
      expectedQuestionVersion: Number(sourced.question.version),
      answer: "Yes. The signed source package supports the 31% concentration fact, and the pinned P4 run preserves the downside liquidity checks.",
    });
    await resolveIcQuestion(ctx, { icCaseId: IC_CASE_ID, questionId: IC_QUESTION_ID, expectedQuestionVersion: Number(answered.row.version) });
    let workspace = await getIcWorkspace(ctx, { icCaseId: IC_CASE_ID });
    await markIcReadyForReview(ctx, { icCaseId: IC_CASE_ID, expectedVersion: Number(workspace.case.version) });
    workspace = await getIcWorkspace(ctx, { icCaseId: IC_CASE_ID });
    const recommendation = await createIcRecommendation(ctx, {
      id: IC_RECOMMENDATION_ID,
      icCaseId: IC_CASE_ID,
      expectedCaseVersion: Number(workspace.case.version),
      outcome: "INVEST_WITH_CONDITIONS",
      rationale: "Proceed on the exact memo and P4 run while retaining the explicit customer-renewal closing condition.",
      memoId: IC_MEMO_ID,
      underwritingRunId: run.id,
      sources: [
        { source: { kind: "EVIDENCE_VERSION", evidenceVersionId: evidence.versionId }, relationship: "SUPPORTS", idempotencyKey: "phase9-rec-evidence-v1" },
        { source: { kind: "UNDERWRITING_RUN", underwritingRunId: run.id }, relationship: "SUPPORTS", idempotencyKey: "phase9-rec-run-v1" },
      ],
      idempotencyKey: "phase9-ic-recommendation-v1",
    });
    workspace = await getIcWorkspace(ctx, { icCaseId: IC_CASE_ID });
    const icCondition = await createIcCondition(ctx, {
      id: IC_CONDITION_ID,
      icCaseId: IC_CASE_ID,
      expectedCaseVersion: Number(workspace.case.version),
      sourceRecommendationId: idOf(recommendation.recommendation),
      conditionType: "PRE_DECISION",
      title: "Verify downside liquidity checks",
      description: "Confirm the exact selected P4 run remains valid before the committee vote.",
      ownerEmployeeId: ownerId,
      workId: PRIMARY_WORK_ID,
      required: true,
      evidenceRequired: true,
      idempotencyKey: "phase9-ic-condition-v1",
    });
    const activeCondition = await activateIcCondition(ctx, { icCaseId: IC_CASE_ID, conditionId: IC_CONDITION_ID, expectedConditionVersion: 1 });
    await satisfyIcCondition(ctx, {
      icCaseId: IC_CASE_ID,
      conditionId: IC_CONDITION_ID,
      expectedConditionVersion: Number(activeCondition.row.version),
      verification: { source: { kind: "UNDERWRITING_RUN", underwritingRunId: run.id }, relationship: "VERIFIES", idempotencyKey: "phase9-ic-condition-proof-v1" },
    });
    workspace = await getIcWorkspace(ctx, { icCaseId: IC_CASE_ID });
    await markIcReadyForVote(ctx, { icCaseId: IC_CASE_ID, expectedVersion: Number(workspace.case.version) });
    workspace = await getIcWorkspace(ctx, { icCaseId: IC_CASE_ID });
    const voting = await openIcVoting(ctx, {
      icCaseId: IC_CASE_ID,
      expectedCaseVersion: Number(workspace.case.version),
      recommendationId: IC_RECOMMENDATION_ID,
      memoId: IC_MEMO_ID,
      underwritingRunId: run.id,
      idempotencyKey: "phase9-open-voting-v1",
    });
    const votingBasisVersion = Number(voting.case.votingBasisVersion);
    await recordIcVote(ctx, { id: VOTE_ONE_ID, icCaseId: IC_CASE_ID, recommendationId: IC_RECOMMENDATION_ID, memoId: IC_MEMO_ID, underwritingRunId: run.id, expectedVotingBasisVersion: votingBasisVersion, choice: "APPROVE", rationale: "Approve the exact represented basis.", idempotencyKey: "phase9-vote-one-v1" });
    await recordIcVote(context(TENANT_ID, MEMBER_TWO_ID), { id: VOTE_TWO_ID, icCaseId: IC_CASE_ID, recommendationId: IC_RECOMMENDATION_ID, memoId: IC_MEMO_ID, underwritingRunId: run.id, expectedVotingBasisVersion: votingBasisVersion, choice: "APPROVE", rationale: "Approve with the recorded closing condition.", idempotencyKey: "phase9-vote-two-v1" });
    await recordIcVote(context(TENANT_ID, MEMBER_THREE_ID), { id: VOTE_THREE_ID, icCaseId: IC_CASE_ID, recommendationId: IC_RECOMMENDATION_ID, memoId: IC_MEMO_ID, underwritingRunId: run.id, expectedVotingBasisVersion: votingBasisVersion, choice: "REJECT", rationale: "Customer concentration remains above my tolerance.", idempotencyKey: "phase9-vote-three-v1" });
    await recordIcDissent(context(TENANT_ID, MEMBER_THREE_ID), {
      id: DISSENT_ID,
      icCaseId: IC_CASE_ID,
      voteId: VOTE_THREE_ID,
      rationale: "The downside case remains sensitive to the top-customer renewal despite the majority recommendation.",
      sources: [{ source: { kind: "EVIDENCE_VERSION", evidenceVersionId: evidence.versionId }, relationship: "SUPPORTS", idempotencyKey: "phase9-dissent-evidence-v1" }],
      idempotencyKey: "phase9-dissent-v1",
    });
    workspace = await getIcWorkspace(ctx, { icCaseId: IC_CASE_ID });
    const closed = await closeIcVoting(ctx, {
      icCaseId: IC_CASE_ID,
      expectedCaseVersion: Number(workspace.case.version),
      expectedVoteSetVersion: Number(workspace.case.voteSetVersion),
      idempotencyKey: "phase9-close-voting-v1",
    });
    await finalizeIcDecision(ctx, {
      icCaseId: IC_CASE_ID,
      decisionProposalId: idOf(closed.proposal),
      expectedCaseVersion: Number(closed.case.version),
      title: "Atlas Investment Committee Decision",
      rationale: "Finalized from the pinned memo, P4 run, evidence-backed question, recommendation, quorum, votes, dissent, and satisfied pre-decision condition.",
      idempotencyKey: "phase9-finalize-decision-v1",
    });

    await attachWorkToDealGraph(ctx, {
      dealId: DEAL_ID,
      workId: PRIMARY_WORK_ID,
      entities: [
        { entityType: "pe_deal", entityId: DEAL_ID, relationship: "about" },
        { entityType: "pe_investment_case", entityId: INVESTMENT_CASE_ID, relationship: "about" },
        { entityType: "pe_assumption", entityId: ASSUMPTION_ID, relationship: "about" },
        { entityType: "pe_finding", entityId: FINDING_ID, relationship: "target" },
        { entityType: "pe_deal_risk", entityId: RISK_ID, relationship: "target" },
        { entityType: "pe_closing_item", entityId: CLOSING_ITEM_ID, relationship: "result" },
        { entityType: "pe_ic_case", entityId: IC_CASE_ID, relationship: "about" },
      ],
    });

    const goalHash = sha("phase9:goal:verify-atlas-qoe");
    const constraintHash = sha("phase9:constraints:human-authority");
    const snapshotHash = sha("phase9:world:atlas-qoe");
    const graphHash = sha("phase9:plan:verify-closing-evidence");
    const objectiveStatement = "Verify Atlas QoE evidence and record the governed closing-readiness outcome";
    const successCondition = {
      version: 1,
      statement: "The exact closing item is verified from canonical evidence and the governed outcome is durably recorded.",
      mode: "all",
      source: "explicit",
      criteria: [
        { kind: "all_objective_effects_verified", minimumCount: 1 },
        { kind: "decision_evidence", minimumCount: 1, accepted: ["business_effect"] },
      ],
    };
    const actionPayload = {
      dealId: DEAL_ID,
      closingConditionId: CLOSING_CONDITION_ID,
      closingItemId: CLOSING_ITEM_ID,
      evidenceVersionId: evidence.versionId,
    };
    await admin.query(
      `INSERT INTO finnor_os.work_objective_loops(
         id,tenant_id,work_id,objective,state,revision,step_count,action_count,query_count,
         max_steps,max_actions,max_queries,max_planner_failures,max_consecutive_no_progress,
         deadline_at,created_by,initial_channel,success_condition
       ) VALUES($1,$2,$3,$4,'continue',1,0,0,0,12,2,4,3,3,now()+interval '1 day',$5,'console',$6::jsonb)`,
      [OBJECTIVE_LOOP_ID, TENANT_ID, PRIMARY_WORK_ID, objectiveStatement, ownerId, JSON.stringify(successCondition)],
    );
    await admin.query(
      `INSERT INTO finnor_os.work_plan_revisions(
         id,tenant_id,work_id,work_input_id,objective_loop_id,revision,reason,status,goal_spec,constraint_set,planning_snapshot,
         candidate_summary,validation,plan_graph,score,goal_hash,constraint_hash,world_snapshot_hash,graph_hash,semantic_hash
       ) VALUES($1,$2,$3,$4,$5,1,'initial','active',$6::jsonb,$7::jsonb,$8::jsonb,'{}'::jsonb,
         '{"version":1,"valid":true}'::jsonb,$9::jsonb,'{}'::jsonb,$10,$11,$12,$13,$13)`,
      [
        PLAN_REVISION_ID, TENANT_ID, PRIMARY_WORK_ID, work.workInputId, OBJECTIVE_LOOP_ID,
        JSON.stringify({ version: 1, objective: objectiveStatement, successCondition, semanticHash: goalHash }),
        JSON.stringify({ version: 1, humanAuthorityRequired: true, semanticHash: constraintHash }),
        JSON.stringify({ version: 1, verticalKey: "private_equity", dealId: DEAL_ID, semanticHash: snapshotHash }),
        JSON.stringify({ version: 1, semanticHash: graphHash, nodes: [{ id: PLAN_NODE_ID, kind: "action", actionType: "submit_condition_evidence", payload: actionPayload, groundedPayload: actionPayload }], edges: [] }),
        goalHash, constraintHash, snapshotHash, graphHash,
      ],
    );
    await admin.query(
      `INSERT INTO finnor_os.domain_actions(
         id,tenant_id,action_type,payload,status,summary,grounded_payload,plan_revision_id,plan_node_id,work_id,initiated_by,authority_context
       ) VALUES($1,$2,'submit_condition_evidence',$3::jsonb,'completed','Verified the indexed QoE package against its exact canonical sources',$3::jsonb,$4,$5,$6,$7,$8::jsonb)`,
      [ACTION_ID, TENANT_ID, JSON.stringify(actionPayload), PLAN_REVISION_ID, PLAN_NODE_ID, PRIMARY_WORK_ID, ownerId, JSON.stringify({ outcome: "allowed", humanBoundary: "reviewed", resources: [{ type: "pe_closing_condition", id: CLOSING_CONDITION_ID }] })],
    );
    const verifiedClosingItem = await verifyClosingItem(ctx, {
      dealId: DEAL_ID,
      closingItemId: CLOSING_ITEM_ID,
      expectedVersion: 2,
      verifierEmployeeId: ownerId,
      evidenceSourceId: evidenceSource.id,
      evidenceVersionId: evidence.versionId,
    });
    if (verifiedClosingItem.row.state !== "verified") {
      throw new Error("The Phase 9 governed action did not persist the closing-readiness change");
    }
    const effectHash = hex("phase9:effect:qoe-evidence-indexed");
    await admin.query(
      `INSERT INTO finnor_os.business_effects(
         id,tenant_id,domain_action_id,semantic_hash,scope_hash,operation_class,effect,status,observed_result,verification,authorized_at,execution_started_at,observed_at
       ) VALUES($1,$2,$3,$4,$4,'internal_write',$5::jsonb,'verified',$6::jsonb,$7::jsonb,now(),now(),now())`,
      [
        EFFECT_ID, TENANT_ID, ACTION_ID, effectHash,
        JSON.stringify({ schemaVersion: 1, semanticHash: effectHash, source: { domainActionId: ACTION_ID, actionType: "submit_condition_evidence", workId: PRIMARY_WORK_ID }, targets: [], bindings: [], authority: { reviewedBy: ownerId }, delta: { dealId: DEAL_ID, closingConditionId: CLOSING_CONDITION_ID, closingItemId: CLOSING_ITEM_ID, evidenceVersionId: evidence.versionId, evidencePackageIndexed: true, closingItemState: "verified", conditionState: "evidence_pending" } }),
        JSON.stringify({ evidencePackageIndexed: true, closingItemState: "verified", conditionState: "evidence_pending" }),
        JSON.stringify({ verified: true, verifierEmployeeId: ownerId, sourceRefs: [{ type: "evidence_version", id: evidence.versionId }] }),
      ],
    );
    await admin.query("UPDATE finnor_os.domain_actions SET business_effect_id=$2 WHERE tenant_id=$1 AND id=$3", [TENANT_ID, EFFECT_ID, ACTION_ID]);
    await admin.query(
      `INSERT INTO finnor_os.decision_receipts(
         id,tenant_id,domain_action_id,work_id,objective,evidence,policy_applied,risk_tier,proposed_action,approval,
         expected_result,actual_result,business_effect_id,intended_effect_hash,authorized_effect_hash,executed_effect_hash,verification,finalized_at
       ) VALUES($1,$2,$3,$4,'Verify the Atlas QoE evidence package',$5::jsonb,$6::jsonb,'high',$7::jsonb,$8::jsonb,
         $9::jsonb,$10::jsonb,$11,$12,$12,$12,$13::jsonb,now())`,
      [
        RECEIPT_ID, TENANT_ID, ACTION_ID, PRIMARY_WORK_ID,
        JSON.stringify([{ source: "evidence_version", ref: evidence.versionId, timestamp: new Date().toISOString() }, { source: "document_version", ref: QOE_VERSION_ID, timestamp: new Date().toISOString() }]),
        JSON.stringify({ authority: "human_review", reviewer: ownerId }),
        JSON.stringify(actionPayload),
        JSON.stringify({ required: true, approvedBy: ownerId, at: new Date().toISOString() }),
        JSON.stringify({ evidencePackageIndexed: true, closingItemState: "verified" }),
        JSON.stringify({ evidencePackageIndexed: true, closingItemState: "verified", conditionState: "evidence_pending" }),
        EFFECT_ID, effectHash,
        JSON.stringify({ state: "verified", sourceRefs: [{ type: "evidence_version", id: evidence.versionId }], verifiedBy: ownerId }),
      ],
    );
    const proof = {
      version: 1,
      verified: true,
      finalPlanRevisionId: PLAN_REVISION_ID,
      planRevisionId: PLAN_REVISION_ID,
      planSemanticHash: graphHash,
      goalSemanticHash: goalHash,
      successConditionHash: sha("phase9:success:source-backed-qoe-review"),
      verifiedAt: new Date().toISOString(),
      verification: { state: "verified", receiptId: RECEIPT_ID, businessEffectId: EFFECT_ID },
      sourceRefs: [{ type: "decision_receipt", id: RECEIPT_ID }, { type: "business_effect", id: EFFECT_ID }],
    };
    await admin.query(
      `INSERT INTO finnor_os.work_objective_steps(
         id,tenant_id,objective_loop_id,work_id,step_number,idempotency_key,phase,inspection,inspection_hash,
         decision_kind,decision,decision_reason,domain_action_id,plan_revision_id,plan_node_id,observation,progress_made
       ) VALUES($1,$2,$3,$4,1,'phase9-objective-step-v1','observing',$5::jsonb,$6,'action',$7::jsonb,
         'The selected P6 action node binds the exact Work, evidence version, and closing item',$8,$9,$10,$11::jsonb,true)`,
      [
        OBJECTIVE_STEP_ID, TENANT_ID, OBJECTIVE_LOOP_ID, PRIMARY_WORK_ID,
        JSON.stringify({ dealId: DEAL_ID, closingItemId: CLOSING_ITEM_ID, evidenceVersionId: evidence.versionId }),
        sha("phase9:inspection:atlas-closing-evidence"),
        JSON.stringify({ kind: "action", actionType: "submit_condition_evidence", payload: actionPayload }),
        ACTION_ID, PLAN_REVISION_ID, PLAN_NODE_ID,
        JSON.stringify({ receiptId: RECEIPT_ID, businessEffectId: EFFECT_ID, closingItemState: "verified", conditionState: "evidence_pending" }),
      ],
    );
    await admin.query(
      "UPDATE finnor_os.domain_actions SET objective_step_id=$2 WHERE tenant_id=$1 AND id=$3",
      [TENANT_ID, OBJECTIVE_STEP_ID, ACTION_ID],
    );
    await admin.query(
      `UPDATE finnor_os.work_objective_steps
       SET phase='finished',iteration_outcome='completed',success_verification=$3::jsonb,completed_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [TENANT_ID, OBJECTIVE_STEP_ID, JSON.stringify(proof.verification)],
    );
    if (!(await completeWorkPlanRevision({ tenantId: TENANT_ID, planRevisionId: PLAN_REVISION_ID, completionProof: proof }))) {
      throw new Error("The Phase 9 completion proof was not accepted by the canonical Work plan");
    }
    await admin.query(
      `UPDATE finnor_os.work_objective_loops
       SET state='completed',step_count=1,action_count=1,last_observation=$3::jsonb,
           success_verification=$4::jsonb,success_verified_at=now(),completed_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [TENANT_ID, OBJECTIVE_LOOP_ID, JSON.stringify({ closingItemState: "verified", conditionState: "evidence_pending" }), JSON.stringify(proof.verification)],
    );
    await transitionWork(TENANT_ID, PRIMARY_WORK_ID, "completed", "verified_outcome_recorded", { receiptId: RECEIPT_ID, businessEffectId: EFFECT_ID }, {
      executionModel: "objective",
      finalOutcome: { state: "verified", summary: "QoE evidence review completed; the remaining customer-renewal condition is explicitly still evidence-pending.", receiptId: RECEIPT_ID, businessEffectId: EFFECT_ID },
    });

    const configHash = sha("phase9:agent:closing-evidence-analyst:v1");
    await admin.query("INSERT INTO finnor_os.agent_profiles(id,tenant_id,key,name) VALUES($1,$2,'closing-evidence-analyst','Closing Evidence Analyst')", [AGENT_PROFILE_ID, TENANT_ID]);
    await admin.query(
      `INSERT INTO finnor_os.agent_profile_revisions(
         id,tenant_id,agent_profile_id,revision,model_route,capability_grants,max_concurrent_assignments,autonomy_limits,planning_hints,status,config_hash,created_by
       ) VALUES($1,$2,$3,1,$4::jsonb,$5::jsonb,1,$6::jsonb,$7::jsonb,'active',$8,$9)`,
      [
        AGENT_REVISION_ID, TENANT_ID, AGENT_PROFILE_ID,
        JSON.stringify({ provider: "orchestration_runtime", model: null, purpose: "objective_execution" }),
        JSON.stringify([{ capability: "submit_condition_evidence", kind: "action" }]),
        JSON.stringify({ maxActions: 2, maxQueries: 4, maxReplans: 1, maxPlannerCalls: 2, maxWallClockMs: 900000, maxKnownCostUsd: null, maxKnownTokens: null }),
        JSON.stringify({}),
        configHash, ownerId,
      ],
    );
    await admin.query(
      `INSERT INTO finnor_os.workforce_assignments(
         id,tenant_id,work_id,plan_revision_id,plan_node_id,objective_loop_id,objective_step_id,
         agent_profile_id,agent_revision_id,capability,node_kind,state,attempt,budget_snapshot,
         assignment_reason,assignment_score,domain_action_id,started_at,completed_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'submit_condition_evidence','action','completed',1,$10::jsonb,
         'Exact capability and root-linked Work matched the active immutable AgentProfile revision',$11::jsonb,$12,now()-interval '2 minutes',now()-interval '1 minute')`,
      [
        ASSIGNMENT_ID, TENANT_ID, PRIMARY_WORK_ID, PLAN_REVISION_ID, PLAN_NODE_ID,
        OBJECTIVE_LOOP_ID, OBJECTIVE_STEP_ID, AGENT_PROFILE_ID, AGENT_REVISION_ID,
        JSON.stringify({ maxActions: 2, consumedActions: 1 }),
        JSON.stringify({ capabilityMatch: 1, rootContextMatch: 1 }), ACTION_ID,
      ],
    );
    await admin.query(
      `INSERT INTO finnor_os.learning_observations(
         id,tenant_id,agent_profile_id,agent_revision_id,workforce_assignment_id,capability,node_kind,context_class,
         work_id,plan_revision_id,plan_node_id,outcome_class,verified,source_refs,context_features,measured_metrics,occurred_at,observation_hash
       ) VALUES($1,$2,$3,$4,$5,'submit_condition_evidence','action','private_equity_closing_evidence',$6,$7,$8,
         'verified_completion',true,$9::jsonb,$10::jsonb,$11::jsonb,now(),$12)`,
      [
        LEARNING_OBSERVATION_ID, TENANT_ID, AGENT_PROFILE_ID, AGENT_REVISION_ID, ASSIGNMENT_ID,
        PRIMARY_WORK_ID, PLAN_REVISION_ID, PLAN_NODE_ID,
        JSON.stringify([
          { type: "objective_step", id: OBJECTIVE_STEP_ID },
          { type: "plan_node", id: PLAN_NODE_ID },
          { type: "completion_proof", id: PLAN_REVISION_ID, hash: proof.successConditionHash },
          { type: "business_effect", id: EFFECT_ID, hash: effectHash },
          { type: "decision_receipt", id: RECEIPT_ID },
        ]),
        JSON.stringify({ vertical: "private_equity", dealId: DEAL_ID }),
        JSON.stringify({ latencyMs: 60000, knownCostUsd: null, knownTokens: null, replans: 0, recoveries: 0 }),
        sha("phase9:learning-observation:closing-evidence-analyst:v1"),
      ],
    );

    const blocker = await receiveWork({
      tenantId: TENANT_ID,
      workId: BLOCKER_WORK_ID,
      instructionId: BLOCKER_INPUT_ID,
      instruction: "Obtain and verify the signed top-customer renewal evidence required for closing.",
      channel: "console",
      userId: ownerId,
      idempotencyKey: "phase9-closing-blocker-work-v1",
    });
    await attachWorkToDealGraph(ctx, {
      dealId: DEAL_ID,
      workId: blocker.workId,
      entities: [
        { entityType: "pe_deal", entityId: DEAL_ID, relationship: "about" },
        { entityType: "pe_finding", entityId: FINDING_ID, relationship: "about" },
        { entityType: "pe_deal_risk", entityId: RISK_ID, relationship: "about" },
        { entityType: "pe_closing_condition", entityId: CLOSING_CONDITION_ID, relationship: "target" },
      ],
    });

    await admin.query(
      `INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,'phase9-foreign-project','Phase 9 tenant-isolation project')`,
      [FOREIGN_TENANT_ID],
    );
    await admin.query(
      `INSERT INTO finnor_os.tenant_vertical_assignments(tenant_id,vertical_key,version,effective_from,source_system,created_by)
       VALUES($1,'private_equity',1,now(),'certification:phase9','system:phase9')`,
      [FOREIGN_TENANT_ID],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name)
       VALUES($1,$2,'phase9.foreign.owner@test.invalid','owner','active','Foreign Project Owner')`,
      [FOREIGN_OWNER_ID, FOREIGN_TENANT_ID],
    );
    await admin.query(
      `INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind)
       VALUES($1,$2,'phase9-foreign-target','Foreign Target','other')`,
      [FOREIGN_ORGANIZATION_ID, FOREIGN_TENANT_ID],
    );
    await createDeal(context(FOREIGN_TENANT_ID, FOREIGN_OWNER_ID), {
      id: FOREIGN_DEAL_ID,
      targetOrganizationId: FOREIGN_ORGANIZATION_ID,
      name: "Foreign project acquisition",
      dealLeadEmployeeId: FOREIGN_OWNER_ID,
      signedLoiAt: new Date("2026-08-21T09:00:00.000Z"),
      targetClosingAt: new Date("2026-11-01T17:00:00.000Z"),
    });

    console.log(JSON.stringify({
      status: "seeded",
      tenantId: TENANT_ID,
      ownerId,
      dealId: DEAL_ID,
      investmentCaseId: INVESTMENT_CASE_ID,
      findingId: FINDING_ID,
      riskId: RISK_ID,
      closingConditionId: CLOSING_CONDITION_ID,
      workId: PRIMARY_WORK_ID,
      blockerWorkId: BLOCKER_WORK_ID,
      underwritingRunId: run.id,
      icCaseId: IC_CASE_ID,
      foreignDealId: FOREIGN_DEAL_ID,
    }));
  } finally {
    await closePool().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
