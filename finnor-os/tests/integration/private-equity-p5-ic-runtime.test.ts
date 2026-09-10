import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, configureTenantVertical } from "@finnor/db";
import {
  activateIcCondition,
  activateInvestmentCase,
  answerIcQuestion,
  attachCanonicalDocument,
  attachIcQuestionSource,
  beginIcPreparation,
  closeIcVoting,
  createDeal,
  createIcCase,
  createIcCommitteeConfiguration,
  createIcCondition,
  createIcQuestion,
  createIcRecommendation,
  createInvestmentCase,
  finalizeIcDecision,
  getIcWorkspace,
  groundIcMemoDocumentVersion,
  markIcReadyForReview,
  markIcReadyForVote,
  openIcVoting,
  prepareIcDecisionProposal,
  recordIcDissent,
  recordIcVote,
  resolveIcQuestion,
  satisfyIcCondition,
  selectIcMemoVersion,
  withdrawIcCase,
  type IcPolicySnapshot,
  type PeMutationContext,
} from "@finnor/private-equity";
import { migrate } from "../../packages/db/migrate";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function context(tenantId: string, employeeId: string): PeMutationContext {
  return {
    auth: { tenantId, userId: employeeId, employeeId, role: "owner" },
    provenance: { sourceSystem: "integration:p5-ic", createdBy: employeeId },
  };
}

function idOf(value: Record<string, unknown>, key = "id"): string {
  const id = value[key];
  if (typeof id !== "string") throw new Error(`${key} was not returned as an ID`);
  return id;
}

async function tenantQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  tenantId: string,
  userId: string,
  sql: string,
  values: unknown[] = [],
  actorId = userId,
): Promise<pg.QueryResult<T>> {
  const client = new pg.Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path=finnor_os,public");
    await client.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true),set_config('app.pe_actor',$3,true)",
      [tenantId, userId, actorId],
    );
    const result = await client.query<T>(sql, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function expectRejected(action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await action();
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current);
      messages.push(String((current as Error).message));
      current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
    }
    expect(messages.join("\ncaused by: ")).toMatch(pattern);
    return;
  }
  throw new Error(`Expected rejection matching ${pattern}`);
}

const available = await canConnect(SUPER_URL);

describe.skipIf(!available)("P5 governed PE Investment Committee runtime", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const members = Array.from({ length: 20 }, () => randomUUID());
  const benchmarkMembers = [...members, ...Array.from({ length: 30 }, () => randomUUID())];
  const outsider = randomUUID();
  const ownerA = members[0]!;
  const ownerB = randomUUID();
  const targetA = randomUUID();
  const targetB = randomUUID();
  const orgUnitA = randomUUID();
  const policyId = randomUUID();
  const policyRevisionId = randomUUID();
  const workId = randomUUID();
  const memoDocumentId = randomUUID();
  const memoVersionId = randomUUID();
  const memoAnchorId = "p5-memo-summary";
  const memoAnchorHash = "b".repeat(64);
  const wrongRootDocumentId = randomUUID();
  const wrongRootVersionId = randomUUID();
  const ctxA = context(tenantA, ownerA);
  const ctxB = context(tenantB, ownerB);
  const policy: IcPolicySnapshot = {
    schemaVersion: "pe-ic-policy.v1",
    quorum: { kind: "MIN_COUNT", minimum: 11 },
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

  let admin: pg.Client;
  let dealId = "";
  let investmentCaseId = "";
  let wrongDealId = "";
  let wrongInvestmentCaseId = "";
  let foreignDealId = "";
  let foreignInvestmentCaseId = "";
  let runId = "";
  let wrongRunId = "";
  let configId = "";
  let benchmarkConfigId = "";
  let icCaseId = "";
  let memoId = "";
  let recommendationId = "";
  let proposalId = "";
  let finalDecisionId = "";
  let rejectVoteId = "";

  interface RaceFixture {
    dealId: string;
    investmentCaseId: string;
    runId: string;
    icCaseId: string;
    memoId: string;
    recommendationId: string;
    questionId?: string;
    questionVersion?: number;
    proposalId?: string;
  }

  async function currentWorkspace() {
    return getIcWorkspace(ctxA, { icCaseId });
  }

  async function currentVersion(): Promise<number> {
    return Number((await currentWorkspace()).case.version);
  }

  async function seedRun(tenantId: string, caseId: string, suffix: string): Promise<string> {
    const modelId = randomUUID();
    const modelVersionId = randomUUID();
    const createdRunId = randomUUID();
    const modelHash = `sha256:${suffix.repeat(64).slice(0, 64)}`;
    const inputHash = `sha256:${suffix.toUpperCase().repeat(64).slice(0, 64).toLowerCase()}`;
    const resultHash = `sha256:${suffix === "a" ? "c" : "d".repeat(64)}`;
    const normalizedResultHash = resultHash.length === 71 ? resultHash : `sha256:${suffix === "a" ? "c".repeat(64) : "d".repeat(64)}`;
    const worldAt = new Date(Date.now() - 60_000);
    const modelDefinition = {
      schemaVersion: "underwriting-model-ir.v1",
      financialConventionVersion: "test-convention.v1",
      minimumEngineVersion: "test-engine.v1",
      modelVersion: "v1",
      nodes: [{ id: "revenue", kind: "input" }],
    };
    const inputSnapshot = { semanticHash: inputHash, investmentCaseId: caseId, worldAt: worldAt.toISOString(), values: {} };
    const result = {
      resultSemanticHash: normalizedResultHash,
      modelSemanticHash: modelHash,
      inputSemanticHash: inputHash,
      engineVersion: "test-engine.v1",
      status: "SUCCEEDED",
      validity: "VALID",
      checks: [],
    };
    await admin.query(
      `INSERT INTO finnor_os.underwriting_models(id,tenant_id,investment_case_id,model_key,name,created_by)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [modelId, tenantId, caseId, `p5-${suffix}-${modelId}`, `P5 model ${suffix}`, ownerA],
    );
    await admin.query(
      `INSERT INTO finnor_os.underwriting_model_versions(
         id,tenant_id,investment_case_id,model_id,version_key,schema_version,financial_convention_version,
         minimum_engine_version,semantic_hash,model_definition,created_by
       ) VALUES($1,$2,$3,$4,'v1','underwriting-model-ir.v1','test-convention.v1','test-engine.v1',$5,$6::jsonb,$7)`,
      [modelVersionId, tenantId, caseId, modelId, modelHash, JSON.stringify(modelDefinition), ownerA],
    );
    await admin.query(
      `INSERT INTO finnor_os.underwriting_runs(
         id,tenant_id,investment_case_id,model_version_id,world_at,computed_at,engine_version,model_semantic_hash,
         input_hash,input_snapshot,result_hash,result,status,validity,idempotency_key,created_by
       ) VALUES($1,$2,$3,$4,$5,clock_timestamp(),'test-engine.v1',$6,$7,$8::jsonb,$9,$10::jsonb,'SUCCEEDED','VALID',$11,$12)`,
      [createdRunId, tenantId, caseId, modelVersionId, worldAt, modelHash, inputHash, JSON.stringify(inputSnapshot),
        normalizedResultHash, JSON.stringify(result), `p5-run-${createdRunId}`, ownerA],
    );
    return createdRunId;
  }

  async function buildRaceFixture(input: {
    stage: "READY_FOR_VOTE" | "VOTING" | "CONDITIONS_PENDING";
    outcome?: "INVEST" | "DECLINE";
    answeredOptionalQuestion?: boolean;
    committeeConfigVersionId?: string;
    existingRoot?: { dealId: string; investmentCaseId: string; runId: string; reconsidersDecisionId?: string };
  }): Promise<RaceFixture> {
    let fixtureDealId: string;
    let fixtureInvestmentCaseId: string;
    let fixtureRunId: string;
    if (input.existingRoot) {
      fixtureDealId = input.existingRoot.dealId;
      fixtureInvestmentCaseId = input.existingRoot.investmentCaseId;
      fixtureRunId = input.existingRoot.runId;
    } else {
      fixtureDealId = idOf((await createDeal(ctxA, {
        targetOrganizationId: targetA, name: `P5 race Deal ${randomUUID()}`, dealLeadEmployeeId: ownerA,
        signedLoiAt: new Date(Date.now() - 86_400_000), targetClosingAt: new Date(Date.now() + 30 * 86_400_000),
      })).row as Record<string, unknown>);
      fixtureInvestmentCaseId = idOf((await createInvestmentCase(ctxA, {
        dealId: fixtureDealId, title: `P5 race InvestmentCase ${randomUUID()}`,
      })).row as Record<string, unknown>);
      await activateInvestmentCase(ctxA, { investmentCaseId: fixtureInvestmentCaseId, expectedVersion: 1 });
      await attachCanonicalDocument(ctxA, {
        dealId: fixtureDealId,
        entity: { entityType: "pe_investment_case", entityId: fixtureInvestmentCaseId },
        documentId: memoDocumentId,
        linkRole: "governing",
      });
      fixtureRunId = await seedRun(tenantA, fixtureInvestmentCaseId, "e");
    }

    const opened = await createIcCase(ctxA, {
      id: randomUUID(), dealId: fixtureDealId, investmentCaseId: fixtureInvestmentCaseId,
      committeeConfigVersionId: input.committeeConfigVersionId ?? configId, primaryUnderwritingRunId: fixtureRunId,
      reconsidersDecisionId: input.existingRoot?.reconsidersDecisionId,
      idempotencyKey: `p5-race-case-${randomUUID()}`,
    });
    const fixtureCaseId = idOf(opened.row as Record<string, unknown>);
    const preparing = await beginIcPreparation(ctxA, { icCaseId: fixtureCaseId, expectedVersion: 1 });
    const selected = await selectIcMemoVersion(ctxA, {
      id: randomUUID(), icCaseId: fixtureCaseId, expectedCaseVersion: Number(preparing.row.version),
      artifactRole: "MEMO", documentId: memoDocumentId, documentVersionId: memoVersionId,
      underwritingRunId: fixtureRunId, evidenceCutoffAt: new Date(Date.now() - 1_000).toISOString(),
      sourceCompleteness: "COMPLETE", idempotencyKey: `p5-race-memo-${randomUUID()}`,
    });
    const fixtureMemoId = idOf(selected.memo);
    let questionId: string | undefined;
    let questionVersion: number | undefined;
    if (input.answeredOptionalQuestion) {
      const question = await createIcQuestion(ctxA, {
        id: randomUUID(), icCaseId: fixtureCaseId, expectedCaseVersion: Number(selected.case.version),
        question: "Optional race-safe clarification", requiredBeforeVote: false, requiredBeforeDecision: false,
        idempotencyKey: `p5-race-question-${randomUUID()}`,
      });
      questionId = idOf(question.question);
      const sourced = await attachIcQuestionSource(ctxA, {
        icCaseId: fixtureCaseId, questionId, expectedQuestionVersion: 1,
        link: {
          source: { kind: "UNDERWRITING_RUN", underwritingRunId: fixtureRunId }, relationship: "ANSWERS",
          idempotencyKey: `p5-race-question-source-${randomUUID()}`,
        },
      });
      const answered = await answerIcQuestion(ctxA, {
        icCaseId: fixtureCaseId, questionId, expectedQuestionVersion: Number(sourced.question.version),
        answer: "Answered against the exact pinned P4 Run.",
      });
      questionVersion = Number(answered.row.version);
    }
    const current = await getIcWorkspace(ctxA, { icCaseId: fixtureCaseId });
    const review = await markIcReadyForReview(ctxA, { icCaseId: fixtureCaseId, expectedVersion: Number(current.case.version) });
    const recommendation = await createIcRecommendation(ctxA, {
      id: randomUUID(), icCaseId: fixtureCaseId, expectedCaseVersion: Number(review.row.version),
      outcome: input.outcome ?? "INVEST", rationale: "Independent race fixture Recommendation.",
      memoId: fixtureMemoId, underwritingRunId: fixtureRunId,
      idempotencyKey: `p5-race-rec-${randomUUID()}`,
    });
    const fixtureRecommendationId = idOf(recommendation.recommendation);
    const ready = await markIcReadyForVote(ctxA, {
      icCaseId: fixtureCaseId, expectedVersion: Number(recommendation.case.version),
    });
    const fixture: RaceFixture = {
      dealId: fixtureDealId, investmentCaseId: fixtureInvestmentCaseId, runId: fixtureRunId,
      icCaseId: fixtureCaseId, memoId: fixtureMemoId, recommendationId: fixtureRecommendationId,
      ...(questionId ? { questionId, questionVersion } : {}),
    };
    if (input.stage === "READY_FOR_VOTE") return fixture;
    const voting = await openIcVoting(ctxA, {
      icCaseId: fixtureCaseId, expectedCaseVersion: Number(ready.row.version),
      recommendationId: fixtureRecommendationId, memoId: fixtureMemoId, underwritingRunId: fixtureRunId,
      idempotencyKey: `p5-race-open-${randomUUID()}`,
    });
    if (input.stage === "VOTING") return fixture;
    const basisVersion = Number(voting.case.votingBasisVersion);
    await Promise.all(members.slice(0, 11).map((employeeId) => recordIcVote(context(tenantA, employeeId), {
      id: randomUUID(), icCaseId: fixtureCaseId, recommendationId: fixtureRecommendationId,
      memoId: fixtureMemoId, underwritingRunId: fixtureRunId, expectedVotingBasisVersion: basisVersion,
      choice: "APPROVE", idempotencyKey: `p5-race-vote-${fixtureCaseId}-${employeeId}`,
    })));
    const beforeClose = await getIcWorkspace(ctxA, { icCaseId: fixtureCaseId });
    const closed = await closeIcVoting(ctxA, {
      icCaseId: fixtureCaseId, expectedCaseVersion: Number(beforeClose.case.version),
      expectedVoteSetVersion: Number(beforeClose.case.voteSetVersion), idempotencyKey: `p5-race-close-${randomUUID()}`,
    });
    fixture.proposalId = idOf(closed.proposal);
    return fixture;
  }

  async function votingBasis(fixture: RaceFixture) {
    const workspace = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    return {
      workspace,
      votingBasisVersion: Number(workspace.case.votingBasisVersion),
      caseVersion: Number(workspace.case.version),
      voteSetVersion: Number(workspace.case.voteSetVersion),
    };
  }

  type CrashTable = "pe_ic_cases" | "pe_ic_questions" | "pe_ic_recommendations" | "pe_ic_votes"
    | "pe_ic_conditions" | "decision_receipts" | "pe_decisions";

  async function installCrashTrigger(input: {
    table: CrashTable;
    event: "INSERT" | "UPDATE";
    order?: "before_business_event" | "after_business_event";
    predicates: Array<{ path: readonly string[]; value: string }>;
    label: string;
  }): Promise<() => Promise<void>> {
    const suffix = randomUUID().replaceAll("-", "");
    const prefix = input.order === "before_business_event" ? "aa" : "zz";
    const triggerName = `${prefix}_p5_crash_${suffix}`;
    const functionName = `p5_crash_${suffix}`;
    const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const predicate = input.predicates.map(({ path, value }) => {
      if (path.length === 0 || path.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) throw new Error("unsafe crash predicate path");
      return `to_jsonb(NEW)#>>${literal(`{${path.join(",")}}`)}=${literal(value)}`;
    }).join(" AND ");
    if (!/^[a-z_]+$/.test(input.table) || !/^[A-Z]+$/.test(input.event)) throw new Error("unsafe crash trigger target");
    await admin.query(
      `CREATE FUNCTION finnor_os.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $crash$
       BEGIN
         IF ${predicate} THEN
           RAISE EXCEPTION 'P5_INJECTED_CRASH:${input.label}' USING ERRCODE='P5001';
         END IF;
         RETURN NEW;
       END $crash$`,
    );
    await admin.query(
      `CREATE TRIGGER ${triggerName} AFTER ${input.event} ON finnor_os.${input.table}
       FOR EACH ROW EXECUTE FUNCTION finnor_os.${functionName}()`,
    );
    return async () => {
      await admin.query(`DROP TRIGGER IF EXISTS ${triggerName} ON finnor_os.${input.table}`);
      await admin.query(`DROP FUNCTION IF EXISTS finnor_os.${functionName}()`);
    };
  }

  async function crashOnce(
    trigger: Parameters<typeof installCrashTrigger>[0],
    action: () => Promise<unknown>,
  ): Promise<void> {
    const cleanup = await installCrashTrigger(trigger);
    try {
      await expectRejected(action, new RegExp(`P5_INJECTED_CRASH:${trigger.label}`));
    } finally {
      await cleanup();
    }
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await migrate(SUPER_URL);
    admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query(
      `INSERT INTO finnor_os.tenants(id,client_key,name) VALUES
       ($1,$2,'P5 IC project A'),($3,$4,'P5 IC project B')`,
      [tenantA, `p5-ic-a-${randomUUID()}`, tenantB, `p5-ic-b-${randomUUID()}`],
    );
    const userRows = [
      ...benchmarkMembers.map((id, index) => [id, tenantA, `p5-member-${index}-${randomUUID()}@test.invalid`, `IC Member ${index}`]),
      [outsider, tenantA, `p5-outsider-${randomUUID()}@test.invalid`, "IC Outsider"],
      [ownerB, tenantB, `p5-owner-b-${randomUUID()}@test.invalid`, "P5 Owner B"],
    ];
    for (const [id, tenantId, email, name] of userRows) {
      await admin.query(
        "INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active',$4)",
        [id, tenantId, email, name],
      );
    }
    await admin.query(
      `INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES
       ($1,$2,$3,'P5 Target A','other'),($4,$5,$6,'P5 Target B','other')`,
      [targetA, tenantA, `p5-target-a-${randomUUID()}`, targetB, tenantB, `p5-target-b-${randomUUID()}`],
    );
    await admin.query(
      "INSERT INTO finnor_os.org_units(id,tenant_id,unit_key,name,kind,active) VALUES($1,$2,$3,'Investment Committee','team',true)",
      [orgUnitA, tenantA, `ic-${randomUUID()}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.domain_policies(id,tenant_id,action_type,policy,requires_confirmation,version,effective_from)
       VALUES($1,$2,'private_equity:ic_process',$3::jsonb,false,1,now())`,
      [policyId, tenantA, JSON.stringify(policy)],
    );
    await admin.query(
      `INSERT INTO finnor_os.domain_policy_revisions(
         id,tenant_id,policy_id,action_type,version,policy,requires_confirmation,effective_from
       ) VALUES($1,$2,$3,'private_equity:ic_process',1,$4::jsonb,false,now())`,
      [policyRevisionId, tenantA, policyId, JSON.stringify(policy)],
    );
    await admin.query(
      `INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,created_by,idempotency_key)
       VALUES($1,$2,'received','console','Run the governed P5 IC process',$3,$4)`,
      [workId, tenantA, ownerA, `p5-work-${workId}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.documents(id,tenant_id,kind,title,source_system,created_by) VALUES
       ($1,$3,'ic_memo','P5 exact IC Memo','integration:p5-ic',$4),
       ($2,$3,'ic_memo','P5 wrong-root Memo','integration:p5-ic',$4)`,
      [memoDocumentId, wrongRootDocumentId, tenantA, ownerA],
    );
    await admin.query(
      `INSERT INTO finnor_os.document_versions(
         id,tenant_id,document_id,version_ordinal,origin,format,media_type,byte_sha256,size_bytes,created_by
       ) VALUES
       ($1,$3,$4,1,'finnor_generated','docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',$6,100,$7),
       ($2,$3,$5,1,'finnor_generated','docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',$6,100,$7)`,
      [memoVersionId, wrongRootVersionId, tenantA, memoDocumentId, wrongRootDocumentId, "a".repeat(64), ownerA],
    );
    await admin.query(
      `INSERT INTO finnor_os.artifact_ir_snapshots(
         tenant_id,version_id,parser_schema,kind,semantic_hash,parse_status,fidelity_status,ir
       ) VALUES($1,$2,'artifact-ir.v1','docx',$3,'parsed','preserved',$4::jsonb)`,
      [tenantA, memoVersionId, "c".repeat(64), JSON.stringify({ nodes: [{ id: memoAnchorId, hash: memoAnchorHash, kind: "paragraph" }] })],
    );

    process.env.DATABASE_URL = APP_URL;
    await closePool();
    await configureTenantVertical({ tenantId: tenantA, verticalKey: "private_equity", expectedVersion: 0, createdBy: ownerA, sourceSystem: "integration:p5-ic" });
    await configureTenantVertical({ tenantId: tenantB, verticalKey: "private_equity", expectedVersion: 0, createdBy: ownerB, sourceSystem: "integration:p5-ic" });

    dealId = idOf((await createDeal(ctxA, {
      targetOrganizationId: targetA, name: "P5 IC primary Deal", dealLeadEmployeeId: ownerA,
      signedLoiAt: new Date(Date.now() - 86_400_000), targetClosingAt: new Date(Date.now() + 30 * 86_400_000),
    })).row as Record<string, unknown>);
    investmentCaseId = idOf((await createInvestmentCase(ctxA, { dealId, title: "P5 IC InvestmentCase" })).row as Record<string, unknown>);
    await activateInvestmentCase(ctxA, { investmentCaseId, expectedVersion: 1 });

    wrongDealId = idOf((await createDeal(ctxA, {
      targetOrganizationId: targetA, name: "P5 IC wrong-root Deal", dealLeadEmployeeId: ownerA,
      signedLoiAt: new Date(Date.now() - 86_400_000), targetClosingAt: new Date(Date.now() + 30 * 86_400_000),
    })).row as Record<string, unknown>);
    wrongInvestmentCaseId = idOf((await createInvestmentCase(ctxA, { dealId: wrongDealId, title: "Wrong-root InvestmentCase" })).row as Record<string, unknown>);
    await activateInvestmentCase(ctxA, { investmentCaseId: wrongInvestmentCaseId, expectedVersion: 1 });

    foreignDealId = idOf((await createDeal(ctxB, {
      targetOrganizationId: targetB, name: "P5 IC foreign Deal", dealLeadEmployeeId: ownerB,
      signedLoiAt: new Date(Date.now() - 86_400_000), targetClosingAt: new Date(Date.now() + 30 * 86_400_000),
    })).row as Record<string, unknown>);
    foreignInvestmentCaseId = idOf((await createInvestmentCase(ctxB, { dealId: foreignDealId, title: "Foreign InvestmentCase" })).row as Record<string, unknown>);
    await activateInvestmentCase(ctxB, { investmentCaseId: foreignInvestmentCaseId, expectedVersion: 1 });

    await attachCanonicalDocument(ctxA, {
      dealId, entity: { entityType: "pe_investment_case", entityId: investmentCaseId },
      documentId: memoDocumentId, linkRole: "governing",
    });
    await attachCanonicalDocument(ctxA, {
      dealId: wrongDealId, entity: { entityType: "pe_investment_case", entityId: wrongInvestmentCaseId },
      documentId: wrongRootDocumentId, linkRole: "governing",
    });
    runId = await seedRun(tenantA, investmentCaseId, "a");
    wrongRunId = await seedRun(tenantA, wrongInvestmentCaseId, "b");

    const config = await createIcCommitteeConfiguration(ctxA, {
      id: randomUUID(), committeeOrgUnitId: orgUnitA, policyRevisionId,
      members: members.map((employeeId, index) => ({
        employeeId, memberRole: index === 0 ? "CHAIR" : "MEMBER", chair: index === 0,
        votingEligible: true, effectiveFrom: new Date(Date.now() - 3_600_000).toISOString(),
      })),
      idempotencyKey: `p5-config-${randomUUID()}`,
    });
    configId = idOf(config.config);
    const benchmarkConfig = await createIcCommitteeConfiguration(ctxA, {
      id: randomUUID(), committeeOrgUnitId: orgUnitA, policyRevisionId,
      members: benchmarkMembers.map((employeeId, index) => ({
        employeeId, memberRole: index === 0 ? "CHAIR" : "MEMBER", chair: index === 0,
        votingEligible: true, effectiveFrom: new Date(Date.now() - 3_600_000).toISOString(),
      })),
      idempotencyKey: `p5-benchmark-config-${randomUUID()}`,
    });
    benchmarkConfigId = idOf(benchmarkConfig.config);
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await admin?.end();
    process.env.DATABASE_URL = SUPER_URL;
  });

  it("rejects missing, cross-root and cross-InvestmentCase prerequisites before mutation", async () => {
    const opened = await createIcCase(ctxA, {
      id: randomUUID(), dealId, investmentCaseId, committeeConfigVersionId: configId,
      primaryUnderwritingRunId: runId, workId, idempotencyKey: `p5-case-${randomUUID()}`,
    });
    icCaseId = idOf(opened.row as Record<string, unknown>);
    await beginIcPreparation(ctxA, { icCaseId, expectedVersion: 1 });

    await expectRejected(
      () => groundIcMemoDocumentVersion(ctxA, { icCaseId, documentId: wrongRootDocumentId, documentVersionId: wrongRootVersionId }),
      /active PE Document link.*ICCase Deal root/i,
    );
    await expectRejected(
      () => selectIcMemoVersion(ctxA, {
        icCaseId, expectedCaseVersion: 2, artifactRole: "MEMO", documentId: memoDocumentId,
        documentVersionId: memoVersionId, underwritingRunId: wrongRunId,
        evidenceCutoffAt: new Date(Date.now() - 1_000).toISOString(), sourceCompleteness: "COMPLETE",
        idempotencyKey: `p5-wrong-run-${randomUUID()}`,
      }),
      /crosses InvestmentCase|foreign key|missing, later/i,
    );
    expect(await currentVersion()).toBe(2);
  });

  it("runs Question → Evidence → Recommendation → Condition on exact P3/P4 truth", async () => {
    const selected = await selectIcMemoVersion(ctxA, {
      icCaseId, expectedCaseVersion: await currentVersion(), artifactRole: "MEMO", documentId: memoDocumentId,
      documentVersionId: memoVersionId, underwritingRunId: runId,
      evidenceCutoffAt: new Date(Date.now() - 1_000).toISOString(), sourceCompleteness: "COMPLETE",
      semanticChecks: { artifactOwner: "P3", financeOwner: "P4" }, idempotencyKey: `p5-memo-${randomUUID()}`,
    });
    memoId = idOf(selected.memo);

    const questionResult = await createIcQuestion(ctxA, {
      id: randomUUID(), icCaseId, expectedCaseVersion: await currentVersion(),
      question: "Does the downside case preserve minimum liquidity?", priority: "CRITICAL",
      requiredBeforeVote: true, requiredBeforeDecision: true, workId,
      idempotencyKey: `p5-question-${randomUUID()}`,
    });
    const questionId = idOf(questionResult.question);

    await expectRejected(
      () => markIcReadyForVote(ctxA, { icCaseId, expectedVersion: Number(questionResult.case.version) }),
      /Invalid ICCase transition|required IC Questions|Voting requires/i,
    );

    const sourced = await attachIcQuestionSource(ctxA, {
      icCaseId, questionId, expectedQuestionVersion: 1,
      link: {
        source: { kind: "UNDERWRITING_RUN", underwritingRunId: runId }, relationship: "ANSWERS",
        truthStatus: "ATTACHED", idempotencyKey: `p5-question-source-${randomUUID()}`,
      },
    });
    expect(sourced.question.substantiationStatus).toBe("ATTACHED");
    const answered = await answerIcQuestion(ctxA, {
      icCaseId, questionId, expectedQuestionVersion: Number(sourced.question.version),
      answer: "The exact pinned P4 Run passes every required error-severity check.",
    });
    await resolveIcQuestion(ctxA, { icCaseId, questionId, expectedQuestionVersion: Number(answered.row.version) });
    await markIcReadyForReview(ctxA, { icCaseId, expectedVersion: await currentVersion() });

    const recommendation = await createIcRecommendation(ctxA, {
      id: randomUUID(), icCaseId, expectedCaseVersion: await currentVersion(), outcome: "INVEST_WITH_CONDITIONS",
      rationale: "Approve on the exact Memo and P4 Run, subject to the explicit pre-decision verification.",
      memoId, underwritingRunId: runId,
      sources: [{
        source: { kind: "UNDERWRITING_RUN", underwritingRunId: runId }, relationship: "SUPPORTS",
        idempotencyKey: `p5-rec-source-${randomUUID()}`,
      }],
      idempotencyKey: `p5-rec-${randomUUID()}`,
    });
    recommendationId = idOf(recommendation.recommendation);

    const condition = await createIcCondition(ctxA, {
      id: randomUUID(), icCaseId, expectedCaseVersion: await currentVersion(), sourceRecommendationId: recommendationId,
      conditionType: "PRE_DECISION", title: "Verify downside liquidity",
      description: "Confirm the exact successful P4 Run remains the selected voting basis.",
      ownerEmployeeId: ownerA, workId, required: true, evidenceRequired: true,
      idempotencyKey: `p5-condition-${randomUUID()}`,
    });
    const conditionId = idOf(condition.condition);
    const active = await activateIcCondition(ctxA, { icCaseId, conditionId, expectedConditionVersion: 1 });
    const satisfied = await satisfyIcCondition(ctxA, {
      icCaseId, conditionId, expectedConditionVersion: Number(active.row.version),
      verification: {
        source: { kind: "UNDERWRITING_RUN", underwritingRunId: runId }, relationship: "VERIFIES",
        idempotencyKey: `p5-condition-proof-${randomUUID()}`,
      },
    });
    expect(satisfied.condition.state).toBe("SATISFIED");
    expect((await currentWorkspace()).readiness.blockers).not.toContain("REQUIRED_QUESTION_BLOCKS_DECISION");
  });

  it("authenticates 20 simultaneous member Votes, converges retries, and preserves Dissent", async () => {
    await markIcReadyForVote(ctxA, { icCaseId, expectedVersion: await currentVersion() });
    const beforeOpen = await currentWorkspace();
    const opened = await openIcVoting(ctxA, {
      icCaseId, expectedCaseVersion: Number(beforeOpen.case.version), recommendationId, memoId,
      underwritingRunId: runId, idempotencyKey: `p5-open-voting-${randomUUID()}`,
    });
    const votingBasisVersion = Number(opened.case.votingBasisVersion);

    await expectRejected(
      () => recordIcVote(context(tenantA, outsider), {
        icCaseId, recommendationId, memoId, underwritingRunId: runId, expectedVotingBasisVersion: votingBasisVersion,
        choice: "APPROVE", idempotencyKey: `p5-outsider-vote-${randomUUID()}`,
      }),
      /effective eligible member|IC_VOTER_INELIGIBLE/i,
    );

    const firstVoteId = randomUUID();
    const firstVoteKey = `p5-vote-retry-${randomUUID()}`;
    const attempts = [
      ...Array.from({ length: 10 }, () => recordIcVote(context(tenantA, members[0]!), {
        id: firstVoteId, icCaseId, recommendationId, memoId, underwritingRunId: runId,
        expectedVotingBasisVersion: votingBasisVersion, choice: "APPROVE", rationale: "Approve exact basis.",
        idempotencyKey: firstVoteKey,
      })),
      ...members.slice(1).map((employeeId, index) => recordIcVote(context(tenantA, employeeId), {
        id: randomUUID(), icCaseId, recommendationId, memoId, underwritingRunId: runId,
        expectedVotingBasisVersion: votingBasisVersion, choice: index === 18 ? "REJECT" : "APPROVE",
        rationale: index === 18 ? "Reject due to downside concentration." : "Approve exact basis.",
        idempotencyKey: `p5-vote-${employeeId}`,
      })),
    ];
    const votes = await Promise.all(attempts);
    expect(votes.filter((value) => !value.idempotent)).toHaveLength(20);
    expect(new Set(votes.map((value) => idOf(value.vote))).size).toBe(20);
    rejectVoteId = idOf(votes.at(-1)!.vote);

    const dissent = await recordIcDissent(context(tenantA, members.at(-1)!), {
      id: randomUUID(), icCaseId, voteId: rejectVoteId,
      rationale: "The downside concentration remains material even though the committee majority approves.",
      sources: [{
        source: { kind: "UNDERWRITING_RUN", underwritingRunId: runId }, relationship: "SUPPORTS",
        idempotencyKey: `p5-dissent-source-${randomUUID()}`,
      }],
      idempotencyKey: `p5-dissent-${randomUUID()}`,
    });
    expect(dissent.dissent.employeeId).toBe(members.at(-1));

    const workspace = await currentWorkspace();
    expect(workspace.votes).toHaveLength(20);
    expect(workspace.dissents).toHaveLength(1);
    expect(workspace.readiness.aggregation?.quorum.status).toBe("QUORUM_MET");
    expect(workspace.readiness.aggregation?.threshold.status).toBe("THRESHOLD_MET");

    const prepared = await prepareIcDecisionProposal(ctxA, {
      id: randomUUID(), icCaseId, expectedCaseVersion: Number(workspace.case.version),
      expectedVoteSetVersion: Number(workspace.case.voteSetVersion), idempotencyKey: `p5-proposal-${randomUUID()}`,
    });
    expect(prepared.aggregation.process.status).toBe("PROCESS_ELIGIBLE");
    expect(prepared.aggregation.proposedOutcome).toBe("INVEST_WITH_CONDITIONS");
  }, 120_000);

  it("closes voting and finalizes exactly one canonical P1 Decision with convergent retry", async () => {
    const workspace = await currentWorkspace();
    const closed = await closeIcVoting(ctxA, {
      icCaseId, expectedCaseVersion: Number(workspace.case.version),
      expectedVoteSetVersion: Number(workspace.case.voteSetVersion), idempotencyKey: `p5-close-${randomUUID()}`,
    });
    expect(closed.aggregation.process.status).toBe("PROCESS_ELIGIBLE");
    proposalId = idOf(closed.proposal);

    const finalizationKey = `p5-finalize-${randomUUID()}`;
    const request = {
      icCaseId, decisionProposalId: proposalId, expectedCaseVersion: Number(closed.case.version),
      title: "Investment Committee Decision — P5 exact basis",
      rationale: "Finalized from the exact pinned policy, membership, Memo, Run, Questions, Votes, Dissent and Conditions.",
      idempotencyKey: finalizationKey,
    };
    const finalized = await finalizeIcDecision(ctxA, request);
    const retried = await finalizeIcDecision(ctxA, request);
    finalDecisionId = idOf(finalized.decision);
    expect(finalized.idempotent).toBe(false);
    expect(retried.idempotent).toBe(true);
    expect(idOf(retried.decision)).toBe(finalDecisionId);
    expect(finalized.decision.state).toBe("final");
    expect(finalized.decision.decisionType).toBe("investment_committee");

    const counts = (await admin.query<{ decisions: number; links: number; receipts: number }>(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.pe_decisions WHERE tenant_id=$1 AND id=$2) decisions,
        (SELECT count(*)::int FROM finnor_os.pe_ic_decision_links WHERE tenant_id=$1 AND ic_case_id=$3) links,
        (SELECT count(*)::int FROM finnor_os.decision_receipts WHERE tenant_id=$1 AND id=$4 AND finalized_at IS NOT NULL) receipts`,
      [tenantA, finalDecisionId, icCaseId, finalized.receiptId],
    )).rows[0]!;
    expect(counts).toEqual({ decisions: 1, links: 1, receipts: 1 });
    const proof = await currentWorkspace();
    expect(proof.case.state).toBe("DECIDED");
    expect(proof.decision?.id).toBe(finalDecisionId);
    expect(proof.decisionProof?.decisionReceiptId).toBe(finalized.receiptId);
    expect(proof.dissents).toHaveLength(1);
  }, 120_000);

  it("enforces RLS, immutable Vote history, authenticated DB identity, and metadata-only events", async () => {
    expect((await tenantQuery(tenantB, ownerB,
      "SELECT id FROM finnor_os.pe_ic_cases WHERE id=$1", [icCaseId])).rows).toHaveLength(0);

    await expectRejected(
      () => tenantQuery(tenantA, ownerA,
        "UPDATE finnor_os.pe_ic_votes SET rationale='forged' WHERE id=$1", [rejectVoteId]),
      /permission denied|immutable/i,
    );
    await expectRejected(
      () => tenantQuery(tenantA, ownerA,
        `INSERT INTO finnor_os.pe_ic_votes(
           tenant_id,deal_id,investment_case_id,ic_case_id,recommendation_id,memo_id,underwriting_run_id,
           voting_basis_version,employee_id,choice,idempotency_key
         ) SELECT tenant_id,deal_id,investment_case_id,id,current_recommendation_id,current_memo_id,
                  primary_underwriting_run_id,voting_basis_version,$2,'APPROVE',$3
             FROM finnor_os.pe_ic_cases WHERE id=$1`,
        [icCaseId, members[1], `p5-forged-${randomUUID()}`], outsider),
      /authenticated canonical employee|voting basis/i,
    );

    const events = await admin.query<{ event_type: string; payload: Record<string, unknown> }>(
      "SELECT event_type,payload FROM finnor_os.business_events WHERE tenant_id=$1 AND entity_id=ANY($2::uuid[]) ORDER BY occurred_at,id",
      [tenantA, [icCaseId, finalDecisionId]],
    );
    expect(events.rows.some((row) => row.event_type === "ic_case_opened")).toBe(true);
    expect(events.rows.some((row) => row.event_type === "ic_decision_finalized")).toBe(true);
    const allPayload = JSON.stringify(events.rows.map((row) => row.payload));
    expect(allPayload).not.toContain("downside concentration");
    expect(allPayload).not.toContain("minimum liquidity");
    expect(allPayload).not.toContain("Finalized from the exact pinned");

    const decisionEvent = await admin.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM finnor_os.business_events WHERE tenant_id=$1 AND event_type='ic_decision_finalized' AND payload->>'decisionId'=$2",
      [tenantA, finalDecisionId],
    );
    expect(decisionEvent.rows).toHaveLength(1);
    expect(JSON.stringify(decisionEvent.rows[0]!.payload)).not.toMatch(/rationale|memo|answer|evidence/i);
  });

  it("races two conflicting Votes from the same authenticated member", async () => {
    const fixture = await buildRaceFixture({ stage: "VOTING" });
    const basis = await votingBasis(fixture);
    const results = await Promise.allSettled([
      recordIcVote(context(tenantA, members[0]!), {
        id: randomUUID(), icCaseId: fixture.icCaseId, recommendationId: fixture.recommendationId,
        memoId: fixture.memoId, underwritingRunId: fixture.runId, expectedVotingBasisVersion: basis.votingBasisVersion,
        choice: "APPROVE", idempotencyKey: `p5-conflict-approve-${randomUUID()}`,
      }),
      recordIcVote(context(tenantA, members[0]!), {
        id: randomUUID(), icCaseId: fixture.icCaseId, recommendationId: fixture.recommendationId,
        memoId: fixture.memoId, underwritingRunId: fixture.runId, expectedVotingBasisVersion: basis.votingBasisVersion,
        choice: "REJECT", idempotencyKey: `p5-conflict-reject-${randomUUID()}`,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const stored = await admin.query<{ choice: string }>(
      "SELECT choice FROM finnor_os.pe_ic_votes WHERE tenant_id=$1 AND recommendation_id=$2 AND employee_id=$3",
      [tenantA, fixture.recommendationId, members[0]],
    );
    expect(stored.rows).toHaveLength(1);
    expect(["APPROVE", "REJECT"]).toContain(stored.rows[0]!.choice);
  }, 120_000);

  it("races voting close against a new Vote without losing or accepting a late Vote", async () => {
    const fixture = await buildRaceFixture({ stage: "VOTING" });
    let basis = await votingBasis(fixture);
    await Promise.all(members.slice(0, 11).map((employeeId) => recordIcVote(context(tenantA, employeeId), {
      id: randomUUID(), icCaseId: fixture.icCaseId, recommendationId: fixture.recommendationId,
      memoId: fixture.memoId, underwritingRunId: fixture.runId, expectedVotingBasisVersion: basis.votingBasisVersion,
      choice: "APPROVE", idempotencyKey: `p5-close-race-seed-${fixture.icCaseId}-${employeeId}`,
    })));
    basis = await votingBasis(fixture);
    const closeKey = `p5-close-race-${randomUUID()}`;
    const results = await Promise.allSettled([
      closeIcVoting(ctxA, {
        icCaseId: fixture.icCaseId, expectedCaseVersion: basis.caseVersion,
        expectedVoteSetVersion: basis.voteSetVersion, idempotencyKey: closeKey,
      }),
      recordIcVote(context(tenantA, members[11]!), {
        id: randomUUID(), icCaseId: fixture.icCaseId, recommendationId: fixture.recommendationId,
        memoId: fixture.memoId, underwritingRunId: fixture.runId, expectedVotingBasisVersion: basis.votingBasisVersion,
        choice: "APPROVE", idempotencyKey: `p5-close-race-vote-${randomUUID()}`,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    let after = await votingBasis(fixture);
    if (after.workspace.case.state === "VOTING") {
      await closeIcVoting(ctxA, {
        icCaseId: fixture.icCaseId, expectedCaseVersion: after.caseVersion,
        expectedVoteSetVersion: after.voteSetVersion, idempotencyKey: `p5-close-after-race-${randomUUID()}`,
      });
      after = await votingBasis(fixture);
    }
    expect(after.workspace.case.state).toBe("CONDITIONS_PENDING");
    expect(after.workspace.votes).toHaveLength(results[1]!.status === "fulfilled" ? 12 : 11);
    expect(after.workspace.decisionProposal).not.toBeNull();
  }, 120_000);

  it("races a Recommendation revision against a Vote on the prior exact revision", async () => {
    const fixture = await buildRaceFixture({ stage: "VOTING" });
    const basis = await votingBasis(fixture);
    const results = await Promise.allSettled([
      createIcRecommendation(ctxA, {
        id: randomUUID(), icCaseId: fixture.icCaseId, expectedCaseVersion: basis.caseVersion,
        outcome: "DEFER", rationale: "Material revision requires an explicit new vote basis.",
        memoId: fixture.memoId, underwritingRunId: fixture.runId,
        idempotencyKey: `p5-rec-vote-race-${randomUUID()}`,
      }),
      recordIcVote(context(tenantA, members[0]!), {
        id: randomUUID(), icCaseId: fixture.icCaseId, recommendationId: fixture.recommendationId,
        memoId: fixture.memoId, underwritingRunId: fixture.runId, expectedVotingBasisVersion: basis.votingBasisVersion,
        choice: "APPROVE", idempotencyKey: `p5-rec-vote-race-vote-${randomUUID()}`,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const after = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    if (results[0]!.status === "fulfilled") {
      expect(after.case.state).toBe("READY_FOR_REVIEW");
      expect(after.currentRecommendation?.id).not.toBe(fixture.recommendationId);
      expect(after.votes).toHaveLength(0);
    } else {
      expect(after.case.state).toBe("VOTING");
      expect(after.currentRecommendation?.id).toBe(fixture.recommendationId);
      expect(after.votes).toHaveLength(1);
    }
  }, 120_000);

  it("races a Memo revision selection against opening voting", async () => {
    const fixture = await buildRaceFixture({ stage: "READY_FOR_VOTE" });
    const before = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    const expected = Number(before.case.version);
    const results = await Promise.allSettled([
      selectIcMemoVersion(ctxA, {
        id: randomUUID(), icCaseId: fixture.icCaseId, expectedCaseVersion: expected,
        artifactRole: "MEMO", documentId: memoDocumentId, documentVersionId: memoVersionId,
        underwritingRunId: fixture.runId, evidenceCutoffAt: new Date(Date.now() - 1_000).toISOString(),
        sourceCompleteness: "COMPLETE", changeClassification: "MANUAL_REVIEW_REQUIRED",
        idempotencyKey: `p5-memo-open-race-${randomUUID()}`,
      }),
      openIcVoting(ctxA, {
        icCaseId: fixture.icCaseId, expectedCaseVersion: expected,
        recommendationId: fixture.recommendationId, memoId: fixture.memoId, underwritingRunId: fixture.runId,
        idempotencyKey: `p5-memo-open-race-open-${randomUUID()}`,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const after = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    expect(["VOTING", "READY_FOR_REVIEW"]).toContain(after.case.state);
    if (after.case.state === "VOTING") expect(after.memo?.id).toBe(fixture.memoId);
    else expect(after.currentRecommendation).toBeNull();
  }, 120_000);

  it("races Question resolution against opening voting and retains both truths when ordered safely", async () => {
    const fixture = await buildRaceFixture({ stage: "READY_FOR_VOTE", answeredOptionalQuestion: true });
    const before = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    const results = await Promise.allSettled([
      resolveIcQuestion(ctxA, {
        icCaseId: fixture.icCaseId, questionId: fixture.questionId!, expectedQuestionVersion: fixture.questionVersion!,
      }),
      openIcVoting(ctxA, {
        icCaseId: fixture.icCaseId, expectedCaseVersion: Number(before.case.version),
        recommendationId: fixture.recommendationId, memoId: fixture.memoId, underwritingRunId: fixture.runId,
        idempotencyKey: `p5-question-open-race-${randomUUID()}`,
      }),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const after = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    expect(after.questions.find((question) => question.id === fixture.questionId)?.state).toBe("RESOLVED");
    expect(["READY_FOR_VOTE", "VOTING"]).toContain(after.case.state);
    expect(after.votes).toHaveLength(0);
    expect(after.case.finalDecisionId).toBeNull();
  }, 120_000);

  it("races Condition creation against Decision finalization", async () => {
    const fixture = await buildRaceFixture({ stage: "CONDITIONS_PENDING" });
    const before = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    const expected = Number(before.case.version);
    const results = await Promise.allSettled([
      createIcCondition(ctxA, {
        id: randomUUID(), icCaseId: fixture.icCaseId, expectedCaseVersion: expected,
        sourceRecommendationId: fixture.recommendationId, conditionType: "MONITORING",
        title: "Race-created monitoring Condition", description: "Must not disappear across finalization.",
        ownerEmployeeId: ownerA, required: false, evidenceRequired: false,
        idempotencyKey: `p5-condition-final-race-${randomUUID()}`,
      }),
      finalizeIcDecision(ctxA, {
        icCaseId: fixture.icCaseId, decisionProposalId: fixture.proposalId!, expectedCaseVersion: expected,
        title: "P5 condition race Decision", rationale: "Only one coherent side of the race may commit.",
        idempotencyKey: `p5-condition-final-race-final-${randomUUID()}`,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const after = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    if (results[0]!.status === "fulfilled") {
      expect(after.case.state).toBe("CONDITIONS_PENDING");
      expect(after.conditions).toHaveLength(1);
      expect(after.decision).toBeNull();
    } else {
      expect(after.case.state).toBe("DECIDED");
      expect(after.conditions).toHaveLength(0);
      expect(after.decision).not.toBeNull();
    }
  }, 120_000);

  it("converges two simultaneous identical finalization requests to one P1 Decision", async () => {
    const fixture = await buildRaceFixture({ stage: "CONDITIONS_PENDING" });
    const before = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    const request = {
      icCaseId: fixture.icCaseId, decisionProposalId: fixture.proposalId!,
      expectedCaseVersion: Number(before.case.version), title: "P5 concurrent finalization Decision",
      rationale: "Two requests share one exact finalization identity.", idempotencyKey: `p5-double-final-${randomUUID()}`,
    };
    const results = await Promise.all([finalizeIcDecision(ctxA, request), finalizeIcDecision(ctxA, request)]);
    expect(results.filter((result) => result.idempotent)).toHaveLength(1);
    expect(new Set(results.map((result) => idOf(result.decision))).size).toBe(1);
    const count = await admin.query<{ count: number }>(
      "SELECT count(*)::int count FROM finnor_os.pe_ic_decision_links WHERE tenant_id=$1 AND ic_case_id=$2",
      [tenantA, fixture.icCaseId],
    );
    expect(count.rows[0]!.count).toBe(1);
  }, 120_000);

  it("races P1 Decision supersession against an authenticated Decision read", async () => {
    const reconsideration = await buildRaceFixture({
      stage: "CONDITIONS_PENDING", outcome: "DECLINE",
      existingRoot: { dealId, investmentCaseId, runId, reconsidersDecisionId: finalDecisionId },
    });
    const before = await getIcWorkspace(ctxA, { icCaseId: reconsideration.icCaseId });
    const finalization = finalizeIcDecision(ctxA, {
      icCaseId: reconsideration.icCaseId, decisionProposalId: reconsideration.proposalId!,
      expectedCaseVersion: Number(before.case.version), title: "P5 reconsidered IC Decision",
      rationale: "Supersede the prior P1 Decision through the governed reconsideration path.",
      idempotencyKey: `p5-supersede-read-race-${randomUUID()}`,
    });
    const [, racingRead] = await Promise.all([
      finalization,
      getIcWorkspace(ctxA, { icCaseId }),
    ]);
    expect(["DECIDED", "SUPERSEDED"]).toContain(racingRead.case.state);
    const oldAfter = await getIcWorkspace(ctxA, { icCaseId });
    const replacementAfter = await getIcWorkspace(ctxA, { icCaseId: reconsideration.icCaseId });
    expect(oldAfter.case.state).toBe("SUPERSEDED");
    expect(oldAfter.decision?.state).toBe("superseded");
    expect(replacementAfter.case.state).toBe("DECIDED");
    expect(replacementAfter.decision?.supersedesDecisionId).toBe(finalDecisionId);
  }, 120_000);

  it("crash/replay: after ICCase row before BusinessEvent converges to one case, event, and Work link", async () => {
    const crashCaseId = randomUUID();
    const idempotencyKey = `p5-crash-case-${randomUUID()}`;
    const request = {
      id: crashCaseId, dealId, investmentCaseId, committeeConfigVersionId: configId,
      primaryUnderwritingRunId: runId, workId, idempotencyKey,
    };
    await crashOnce({
      table: "pe_ic_cases", event: "INSERT", order: "before_business_event",
      predicates: [{ path: ["id"], value: crashCaseId }], label: "after_ic_case_row_before_event",
    }, () => createIcCase(ctxA, request));
    const rolledBack = await admin.query<{ cases: number; events: number; links: number }>(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.pe_ic_cases WHERE tenant_id=$1 AND id=$2) cases,
        (SELECT count(*)::int FROM finnor_os.business_events WHERE tenant_id=$1 AND entity_id=$2) events,
        (SELECT count(*)::int FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND entity_id=$2) links`,
      [tenantA, crashCaseId],
    );
    expect(rolledBack.rows[0]).toEqual({ cases: 0, events: 0, links: 0 });

    const replay = await createIcCase(ctxA, request);
    expect(idOf(replay.row as Record<string, unknown>)).toBe(crashCaseId);
    const converged = await admin.query<{ cases: number; events: number; links: number }>(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.pe_ic_cases WHERE tenant_id=$1 AND id=$2) cases,
        (SELECT count(*)::int FROM finnor_os.business_events WHERE tenant_id=$1 AND entity_id=$2 AND event_type='ic_case_opened') events,
        (SELECT count(*)::int FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND work_id=$3 AND entity_type='pe_ic_case' AND entity_id=$2) links`,
      [tenantA, crashCaseId, workId],
    );
    expect(converged.rows[0]).toEqual({ cases: 1, events: 1, links: 1 });
    await withdrawIcCase(ctxA, { icCaseId: crashCaseId, expectedVersion: 1 });
  }, 120_000);

  it("crash/replay: after Question create before Core Work link converges without an orphan", async () => {
    const fixtureCase = await createIcCase(ctxA, {
      id: randomUUID(), dealId, investmentCaseId, committeeConfigVersionId: configId,
      primaryUnderwritingRunId: runId, idempotencyKey: `p5-crash-question-case-${randomUUID()}`,
    });
    const fixtureCaseId = idOf(fixtureCase.row as Record<string, unknown>);
    await beginIcPreparation(ctxA, { icCaseId: fixtureCaseId, expectedVersion: 1 });
    const questionId = randomUUID();
    const request = {
      id: questionId, icCaseId: fixtureCaseId, expectedCaseVersion: 2,
      question: "Crash-injected Question must remain atomically linked to Core Work.",
      requiredBeforeVote: true, requiredBeforeDecision: true, workId,
      idempotencyKey: `p5-crash-question-${randomUUID()}`,
    };
    await crashOnce({
      table: "pe_ic_questions", event: "INSERT", order: "after_business_event",
      predicates: [{ path: ["id"], value: questionId }], label: "after_question_before_work_link",
    }, () => createIcQuestion(ctxA, request));
    expect((await admin.query("SELECT id FROM finnor_os.pe_ic_questions WHERE tenant_id=$1 AND id=$2", [tenantA, questionId])).rows).toHaveLength(0);

    await createIcQuestion(ctxA, request);
    const converged = await admin.query<{ questions: number; links: number; events: number }>(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.pe_ic_questions WHERE tenant_id=$1 AND id=$2) questions,
        (SELECT count(*)::int FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND work_id=$3 AND entity_type='pe_ic_question' AND entity_id=$2) links,
        (SELECT count(*)::int FROM finnor_os.business_events WHERE tenant_id=$1 AND entity_id=$2 AND event_type='ic_question_opened') events`,
      [tenantA, questionId, workId],
    );
    expect(converged.rows[0]).toEqual({ questions: 1, links: 1, events: 1 });
  }, 120_000);

  it("crash/replay: after Recommendation create before exact P3 ArtifactAnchor link converges atomically", async () => {
    const fixture = await buildRaceFixture({ stage: "READY_FOR_VOTE" });
    const before = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    const recommendationId = randomUUID();
    const sourceKey = `p5-crash-rec-anchor-${randomUUID()}`;
    const request = {
      id: recommendationId, icCaseId: fixture.icCaseId, expectedCaseVersion: Number(before.case.version),
      outcome: "DECLINE" as const, rationale: "Crash-injected revision pins one exact P3 memo anchor.",
      memoId: fixture.memoId, underwritingRunId: fixture.runId,
      sources: [{
        source: {
          kind: "ARTIFACT_ANCHOR" as const, documentId: memoDocumentId, documentVersionId: memoVersionId,
          anchorId: memoAnchorId, anchorHash: memoAnchorHash,
        },
        relationship: "SUPPORTS" as const, idempotencyKey: sourceKey,
      }],
      idempotencyKey: `p5-crash-rec-${randomUUID()}`,
    };
    await crashOnce({
      table: "pe_ic_recommendations", event: "INSERT", order: "after_business_event",
      predicates: [{ path: ["id"], value: recommendationId }], label: "after_recommendation_before_artifact_link",
    }, () => createIcRecommendation(ctxA, request));
    expect((await admin.query("SELECT id FROM finnor_os.pe_ic_recommendations WHERE tenant_id=$1 AND id=$2", [tenantA, recommendationId])).rows).toHaveLength(0);

    const replay = await createIcRecommendation(ctxA, request);
    expect(replay.sourceLinks).toHaveLength(1);
    const converged = await admin.query<{ recommendations: number; anchors: number }>(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.pe_ic_recommendations WHERE tenant_id=$1 AND id=$2) recommendations,
        (SELECT count(*)::int FROM finnor_os.pe_ic_source_links
          WHERE tenant_id=$1 AND owner_kind='RECOMMENDATION' AND owner_id=$2
            AND source_kind='ARTIFACT_ANCHOR' AND document_version_id=$3 AND anchor_id=$4 AND anchor_hash=$5) anchors`,
      [tenantA, recommendationId, memoVersionId, memoAnchorId, memoAnchorHash],
    );
    expect(converged.rows[0]).toEqual({ recommendations: 1, anchors: 1 });
  }, 120_000);

  it("crash/replay: after Vote insert before response converges to one immutable effective Vote", async () => {
    const fixture = await buildRaceFixture({ stage: "VOTING" });
    const before = await votingBasis(fixture);
    const voteId = randomUUID();
    const request = {
      id: voteId, icCaseId: fixture.icCaseId, recommendationId: fixture.recommendationId,
      memoId: fixture.memoId, underwritingRunId: fixture.runId,
      expectedVotingBasisVersion: before.votingBasisVersion, choice: "APPROVE" as const,
      rationale: "Crash-safe exact Vote.", idempotencyKey: `p5-crash-vote-${randomUUID()}`,
    };
    await crashOnce({
      table: "pe_ic_votes", event: "INSERT", order: "after_business_event",
      predicates: [{ path: ["id"], value: voteId }], label: "after_vote_before_response",
    }, () => recordIcVote(ctxA, request));
    const rolledBack = await votingBasis(fixture);
    expect(rolledBack.workspace.votes).toHaveLength(0);
    expect(rolledBack.voteSetVersion).toBe(before.voteSetVersion);

    const replay = await recordIcVote(ctxA, request);
    expect(idOf(replay.vote)).toBe(voteId);
    const converged = await votingBasis(fixture);
    expect(converged.workspace.votes).toHaveLength(1);
    expect(converged.voteSetVersion).toBe(before.voteSetVersion + 1);
  }, 120_000);

  it("crash/replay: after voting snapshot before status update retains VOTING then converges once", async () => {
    const fixture = await buildRaceFixture({ stage: "VOTING" });
    let basis = await votingBasis(fixture);
    await Promise.all(members.slice(0, 11).map((employeeId) => recordIcVote(context(tenantA, employeeId), {
      id: randomUUID(), icCaseId: fixture.icCaseId, recommendationId: fixture.recommendationId,
      memoId: fixture.memoId, underwritingRunId: fixture.runId, expectedVotingBasisVersion: basis.votingBasisVersion,
      choice: "APPROVE", idempotencyKey: `p5-crash-close-seed-${fixture.icCaseId}-${employeeId}`,
    })));
    basis = await votingBasis(fixture);
    const idempotencyKey = `p5-crash-close-${randomUUID()}`;
    const request = {
      icCaseId: fixture.icCaseId, expectedCaseVersion: basis.caseVersion,
      expectedVoteSetVersion: basis.voteSetVersion, idempotencyKey,
    };
    await crashOnce({
      table: "decision_receipts", event: "INSERT", order: "after_business_event",
      predicates: [
        { path: ["tenant_id"], value: tenantA },
        { path: ["proposed_action", "action"], value: "close_ic_voting" },
        { path: ["proposed_action", "icCaseId"], value: fixture.icCaseId },
      ],
      label: "after_voting_snapshot_before_status_update",
    }, () => closeIcVoting(ctxA, request));
    const rolledBack = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    expect(rolledBack.case.state).toBe("VOTING");
    expect(rolledBack.decisionProposal).toBeNull();

    const replay = await closeIcVoting(ctxA, request);
    expect(replay.case.state).toBe("CONDITIONS_PENDING");
    const converged = await admin.query<{ proposals: number; receipts: number }>(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.pe_ic_decision_proposals WHERE tenant_id=$1 AND ic_case_id=$2::uuid) proposals,
        (SELECT count(*)::int FROM finnor_os.decision_receipts
          WHERE tenant_id=$1 AND proposed_action->>'action'='close_ic_voting'
            AND proposed_action->>'icCaseId'=$2::text AND proposed_action->>'idempotencyKey'=$3::text) receipts`,
      [tenantA, fixture.icCaseId, idempotencyKey],
    );
    expect(converged.rows[0]).toEqual({ proposals: 1, receipts: 1 });
  }, 120_000);

  it("crash/replay: after Condition transition before BusinessEvent restores prior state then converges", async () => {
    const fixture = await buildRaceFixture({ stage: "READY_FOR_VOTE" });
    const before = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    const created = await createIcCondition(ctxA, {
      id: randomUUID(), icCaseId: fixture.icCaseId, expectedCaseVersion: Number(before.case.version),
      sourceRecommendationId: fixture.recommendationId, conditionType: "MONITORING",
      title: "Crash-safe monitoring Condition", description: "Transition and event must commit together.",
      ownerEmployeeId: ownerA, required: false, evidenceRequired: false,
      idempotencyKey: `p5-crash-condition-${randomUUID()}`,
    });
    const conditionId = idOf(created.condition);
    const request = { icCaseId: fixture.icCaseId, conditionId, expectedConditionVersion: 1 };
    await crashOnce({
      table: "pe_ic_conditions", event: "UPDATE", order: "before_business_event",
      predicates: [{ path: ["id"], value: conditionId }, { path: ["state"], value: "ACTIVE" }],
      label: "after_condition_transition_before_event",
    }, () => activateIcCondition(ctxA, request));
    expect((await admin.query<{ state: string }>(
      "SELECT state FROM finnor_os.pe_ic_conditions WHERE tenant_id=$1 AND id=$2", [tenantA, conditionId],
    )).rows[0]?.state).toBe("PROPOSED");

    await activateIcCondition(ctxA, request);
    const converged = await admin.query<{ state: string; version: number; events: number }>(
      `SELECT condition.state,condition.version,
         (SELECT count(*)::int FROM finnor_os.business_events event WHERE event.tenant_id=$1 AND event.entity_id=$2) events
       FROM finnor_os.pe_ic_conditions condition WHERE condition.tenant_id=$1 AND condition.id=$2`,
      [tenantA, conditionId],
    );
    expect(converged.rows[0]).toMatchObject({ state: "ACTIVE", version: 2, events: 2 });
  }, 120_000);

  it("crash/replay: after P1 recordDecision before P5 linkage rolls back and creates one canonical Decision", async () => {
    const fixture = await buildRaceFixture({ stage: "CONDITIONS_PENDING" });
    const before = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    const idempotencyKey = `p5-crash-after-record-decision-${randomUUID()}`;
    const request = {
      icCaseId: fixture.icCaseId, decisionProposalId: fixture.proposalId!,
      expectedCaseVersion: Number(before.case.version), title: "Crash-safe P1 Decision after recordDecision",
      rationale: "P1 Decision and P5 linkage remain one atomic finalization.", idempotencyKey,
    };
    await crashOnce({
      table: "pe_decisions", event: "INSERT", order: "after_business_event",
      predicates: [
        { path: ["tenant_id"], value: tenantA },
        { path: ["investment_case_id"], value: fixture.investmentCaseId },
        { path: ["decision_type"], value: "investment_committee" },
      ],
      label: "after_p1_record_before_p5_link",
    }, () => finalizeIcDecision(ctxA, request));
    expect((await admin.query(
      "SELECT id FROM finnor_os.pe_decisions WHERE tenant_id=$1 AND investment_case_id=$2 AND decision_type='investment_committee'",
      [tenantA, fixture.investmentCaseId],
    )).rows).toHaveLength(0);

    const replay = await finalizeIcDecision(ctxA, request);
    const converged = await admin.query<{ decisions: number; links: number }>(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.pe_decisions WHERE tenant_id=$1 AND investment_case_id=$2 AND decision_type='investment_committee') decisions,
        (SELECT count(*)::int FROM finnor_os.pe_ic_decision_links WHERE tenant_id=$1 AND ic_case_id=$3) links`,
      [tenantA, fixture.investmentCaseId, fixture.icCaseId],
    );
    expect(replay.decision.state).toBe("final");
    expect(converged.rows[0]).toEqual({ decisions: 1, links: 1 });
  }, 120_000);

  it("crash/replay: after P1 finalizeDecision before response rolls back then converges with one Receipt", async () => {
    const fixture = await buildRaceFixture({ stage: "CONDITIONS_PENDING" });
    const before = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    const idempotencyKey = `p5-crash-after-finalize-decision-${randomUUID()}`;
    const request = {
      icCaseId: fixture.icCaseId, decisionProposalId: fixture.proposalId!,
      expectedCaseVersion: Number(before.case.version), title: "Crash-safe P1 finalized Decision",
      rationale: "Final state, Receipt, effect, and linkage converge after retry.", idempotencyKey,
    };
    await crashOnce({
      table: "pe_decisions", event: "UPDATE", order: "after_business_event",
      predicates: [
        { path: ["tenant_id"], value: tenantA },
        { path: ["investment_case_id"], value: fixture.investmentCaseId },
        { path: ["state"], value: "final" },
      ],
      label: "after_p1_finalize_before_response",
    }, () => finalizeIcDecision(ctxA, request));
    expect((await admin.query(
      "SELECT id FROM finnor_os.pe_decisions WHERE tenant_id=$1 AND investment_case_id=$2 AND decision_type='investment_committee'",
      [tenantA, fixture.investmentCaseId],
    )).rows).toHaveLength(0);

    const replay = await finalizeIcDecision(ctxA, request);
    const retried = await finalizeIcDecision(ctxA, request);
    expect(retried.idempotent).toBe(true);
    expect(idOf(retried.decision)).toBe(idOf(replay.decision));
    const receipts = await admin.query<{ count: number }>(
      `SELECT count(*)::int count FROM finnor_os.decision_receipts
        WHERE tenant_id=$1 AND proposed_action->>'action'='finalize_ic_decision'
          AND proposed_action->>'icCaseId'=$2 AND proposed_action->>'idempotencyKey'=$3`,
      [tenantA, fixture.icCaseId, idempotencyKey],
    );
    expect(receipts.rows[0]!.count).toBe(1);
  }, 120_000);

  it("crash/replay: after Core DecisionReceipt creation before completion leaves no partial proof", async () => {
    const fixture = await buildRaceFixture({ stage: "CONDITIONS_PENDING" });
    const before = await getIcWorkspace(ctxA, { icCaseId: fixture.icCaseId });
    const idempotencyKey = `p5-crash-after-receipt-${randomUUID()}`;
    const request = {
      icCaseId: fixture.icCaseId, decisionProposalId: fixture.proposalId!,
      expectedCaseVersion: Number(before.case.version), title: "Crash-safe Receipt boundary Decision",
      rationale: "A receipt cannot outlive a rolled-back canonical finalization.", idempotencyKey,
    };
    await crashOnce({
      table: "decision_receipts", event: "INSERT", order: "after_business_event",
      predicates: [
        { path: ["tenant_id"], value: tenantA },
        { path: ["proposed_action", "action"], value: "finalize_ic_decision" },
        { path: ["proposed_action", "icCaseId"], value: fixture.icCaseId },
      ],
      label: "after_receipt_before_completion",
    }, () => finalizeIcDecision(ctxA, request));
    const rolledBack = await admin.query<{ receipts: number; decisions: number; links: number }>(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.decision_receipts
          WHERE tenant_id=$1 AND proposed_action->>'icCaseId'=$2::text AND proposed_action->>'idempotencyKey'=$3::text) receipts,
        (SELECT count(*)::int FROM finnor_os.pe_decisions WHERE tenant_id=$1 AND investment_case_id=$4 AND decision_type='investment_committee') decisions,
        (SELECT count(*)::int FROM finnor_os.pe_ic_decision_links WHERE tenant_id=$1 AND ic_case_id=$2::uuid) links`,
      [tenantA, fixture.icCaseId, idempotencyKey, fixture.investmentCaseId],
    );
    expect(rolledBack.rows[0]).toEqual({ receipts: 0, decisions: 0, links: 0 });

    await finalizeIcDecision(ctxA, request);
    const converged = await admin.query<{ receipts: number; decisions: number; links: number }>(
      `SELECT
        (SELECT count(*)::int FROM finnor_os.decision_receipts
          WHERE tenant_id=$1 AND proposed_action->>'icCaseId'=$2::text AND proposed_action->>'idempotencyKey'=$3::text) receipts,
        (SELECT count(*)::int FROM finnor_os.pe_decisions WHERE tenant_id=$1 AND investment_case_id=$4 AND decision_type='investment_committee') decisions,
        (SELECT count(*)::int FROM finnor_os.pe_ic_decision_links WHERE tenant_id=$1 AND ic_case_id=$2::uuid) links`,
      [tenantA, fixture.icCaseId, idempotencyKey, fixture.investmentCaseId],
    );
    expect(converged.rows[0]).toEqual({ receipts: 1, decisions: 1, links: 1 });
  }, 120_000);

  describe("measured P5 IC database performance and enforced limits", () => {
    interface BenchmarkMetrics {
      loadAggregateMs: number;
      openQuestionMs: number;
      concurrentVotes50Ms: number;
      closeVotingAggregate50Ms: number;
      decisionProposalMs: number;
      finalDecisionTransactionMs: number;
      loadDecisionProofMs: number;
      questions100Ms: number;
      conditions50Ms: number;
    }
    const guardrails: Readonly<BenchmarkMetrics> = Object.freeze({
      loadAggregateMs: 5_000,
      openQuestionMs: 2_000,
      concurrentVotes50Ms: 15_000,
      closeVotingAggregate50Ms: 5_000,
      decisionProposalMs: 5_000,
      finalDecisionTransactionMs: 5_000,
      loadDecisionProofMs: 5_000,
      questions100Ms: 30_000,
      conditions50Ms: 20_000,
    });
    let metrics: BenchmarkMetrics;
    let questionCount = 0;
    let conditionCount = 0;
    let finalDecisionCount = 0;

    beforeAll(async () => {
      const questionFixture = await buildRaceFixture({ stage: "READY_FOR_VOTE" });
      const questionBasis = await getIcWorkspace(ctxA, { icCaseId: questionFixture.icCaseId });
      const revised = await createIcRecommendation(ctxA, {
        id: randomUUID(), icCaseId: questionFixture.icCaseId,
        expectedCaseVersion: Number(questionBasis.case.version), outcome: "CONTINUE_DILIGENCE",
        rationale: "Open the measured Question phase without changing P3/P4 truth.",
        memoId: questionFixture.memoId, underwritingRunId: questionFixture.runId,
        idempotencyKey: `p5-benchmark-question-revision-${randomUUID()}`,
      });
      let expectedCaseVersion = Number(revised.case.version);
      const questionBatchStarted = performance.now();
      const firstQuestionStarted = performance.now();
      const firstQuestion = await createIcQuestion(ctxA, {
        id: randomUUID(), icCaseId: questionFixture.icCaseId, expectedCaseVersion,
        question: "Measured open Question 1", requiredBeforeVote: false, requiredBeforeDecision: false,
        idempotencyKey: `p5-benchmark-question-${questionFixture.icCaseId}-1`,
      });
      const openQuestionMs = performance.now() - firstQuestionStarted;
      expectedCaseVersion = Number(firstQuestion.case.version);
      for (let index = 2; index <= 100; index += 1) {
        const created = await createIcQuestion(ctxA, {
          id: randomUUID(), icCaseId: questionFixture.icCaseId, expectedCaseVersion,
          question: `Measured open Question ${index}`, requiredBeforeVote: false, requiredBeforeDecision: false,
          idempotencyKey: `p5-benchmark-question-${questionFixture.icCaseId}-${index}`,
        });
        expectedCaseVersion = Number(created.case.version);
      }
      const questions100Ms = performance.now() - questionBatchStarted;
      await expectRejected(() => createIcQuestion(ctxA, {
        id: randomUUID(), icCaseId: questionFixture.icCaseId, expectedCaseVersion,
        question: "Measured rejected Question 101", requiredBeforeVote: false, requiredBeforeDecision: false,
        idempotencyKey: `p5-benchmark-question-${questionFixture.icCaseId}-101`,
      }), /open Question limit exceeded \(100\)/i);
      questionCount = (await admin.query<{ count: number }>(
        "SELECT count(*)::int count FROM finnor_os.pe_ic_questions WHERE tenant_id=$1 AND ic_case_id=$2 AND state='OPEN'",
        [tenantA, questionFixture.icCaseId],
      )).rows[0]!.count;

      const conditionFixture = await buildRaceFixture({ stage: "READY_FOR_VOTE" });
      let conditionCaseVersion = Number((await getIcWorkspace(ctxA, { icCaseId: conditionFixture.icCaseId })).case.version);
      const conditionBatchStarted = performance.now();
      for (let index = 1; index <= 50; index += 1) {
        const created = await createIcCondition(ctxA, {
          id: randomUUID(), icCaseId: conditionFixture.icCaseId, expectedCaseVersion: conditionCaseVersion,
          sourceRecommendationId: conditionFixture.recommendationId, conditionType: "MONITORING",
          title: `Measured IC Condition ${index}`, description: "Bounded measured monitoring Condition.",
          ownerEmployeeId: ownerA, required: false, evidenceRequired: false,
          idempotencyKey: `p5-benchmark-condition-${conditionFixture.icCaseId}-${index}`,
        });
        conditionCaseVersion = Number(created.case.version);
      }
      const conditions50Ms = performance.now() - conditionBatchStarted;
      await expectRejected(() => createIcCondition(ctxA, {
        id: randomUUID(), icCaseId: conditionFixture.icCaseId, expectedCaseVersion: conditionCaseVersion,
        sourceRecommendationId: conditionFixture.recommendationId, conditionType: "MONITORING",
        title: "Measured rejected Condition 51", description: "Must exceed the active Condition ceiling.",
        ownerEmployeeId: ownerA, required: false, evidenceRequired: false,
        idempotencyKey: `p5-benchmark-condition-${conditionFixture.icCaseId}-51`,
      }), /active Condition limit exceeded \(50\)/i);
      conditionCount = (await admin.query<{ count: number }>(
        "SELECT count(*)::int count FROM finnor_os.pe_ic_conditions WHERE tenant_id=$1 AND ic_case_id=$2 AND state IN ('PROPOSED','ACTIVE')",
        [tenantA, conditionFixture.icCaseId],
      )).rows[0]!.count;

      const votingFixture = await buildRaceFixture({
        stage: "VOTING", committeeConfigVersionId: benchmarkConfigId,
      });
      let started = performance.now();
      await getIcWorkspace(ctxA, { icCaseId: votingFixture.icCaseId });
      const loadAggregateMs = performance.now() - started;
      const basis = await votingBasis(votingFixture);
      started = performance.now();
      await Promise.all(benchmarkMembers.map((employeeId) => recordIcVote(context(tenantA, employeeId), {
        id: randomUUID(), icCaseId: votingFixture.icCaseId, recommendationId: votingFixture.recommendationId,
        memoId: votingFixture.memoId, underwritingRunId: votingFixture.runId,
        expectedVotingBasisVersion: basis.votingBasisVersion, choice: "APPROVE",
        idempotencyKey: `p5-benchmark-vote-${votingFixture.icCaseId}-${employeeId}`,
      })));
      const concurrentVotes50Ms = performance.now() - started;
      const voted = await votingBasis(votingFixture);
      started = performance.now();
      await prepareIcDecisionProposal(ctxA, {
        id: randomUUID(), icCaseId: votingFixture.icCaseId,
        expectedCaseVersion: voted.caseVersion, expectedVoteSetVersion: voted.voteSetVersion,
        idempotencyKey: `p5-benchmark-proposal-${randomUUID()}`,
      });
      const decisionProposalMs = performance.now() - started;
      started = performance.now();
      const closed = await closeIcVoting(ctxA, {
        icCaseId: votingFixture.icCaseId,
        expectedCaseVersion: voted.caseVersion, expectedVoteSetVersion: voted.voteSetVersion,
        idempotencyKey: `p5-benchmark-close-${randomUUID()}`,
      });
      const closeVotingAggregate50Ms = performance.now() - started;
      expect(closed.aggregation.effectiveVotes).toHaveLength(50);
      started = performance.now();
      const finalized = await finalizeIcDecision(ctxA, {
        icCaseId: votingFixture.icCaseId, decisionProposalId: idOf(closed.proposal),
        expectedCaseVersion: Number(closed.case.version), title: "Measured 50-member P5 IC Decision",
        rationale: "Finalized from the measured exact 50-member pinned snapshot.",
        idempotencyKey: `p5-benchmark-final-${randomUUID()}`,
      });
      const finalDecisionTransactionMs = performance.now() - started;
      started = performance.now();
      const proof = await getIcWorkspace(ctxA, { icCaseId: votingFixture.icCaseId });
      const loadDecisionProofMs = performance.now() - started;
      expect(proof.decisionProof?.decisionReceiptId).toBe(finalized.receiptId);
      finalDecisionCount = (await admin.query<{ count: number }>(
        "SELECT count(*)::int count FROM finnor_os.pe_decisions WHERE tenant_id=$1 AND investment_case_id=$2 AND decision_type='investment_committee'",
        [tenantA, votingFixture.investmentCaseId],
      )).rows[0]!.count;

      metrics = {
        loadAggregateMs,
        openQuestionMs,
        concurrentVotes50Ms,
        closeVotingAggregate50Ms,
        decisionProposalMs,
        finalDecisionTransactionMs,
        loadDecisionProofMs,
        questions100Ms,
        conditions50Ms,
      };
      console.info("P5_IC_BENCHMARK " + JSON.stringify({ metrics, guardrails, observed: {
        eligibleVoters: 50, effectiveVotes: 50, openQuestions: questionCount,
        activeConditions: conditionCount, canonicalDecisions: finalDecisionCount,
      } }));
    }, 120_000);

    it("loads the exact IC aggregate inside the measured guardrail", () => {
      expect(metrics.loadAggregateMs).toBeLessThan(guardrails.loadAggregateMs);
    });

    it("opens one Question inside the measured guardrail", () => {
      expect(metrics.openQuestionMs).toBeLessThan(guardrails.openQuestionMs);
    });

    it("records fifty authenticated concurrent Votes inside the measured guardrail", () => {
      expect(metrics.concurrentVotes50Ms).toBeLessThan(guardrails.concurrentVotes50Ms);
    });

    it("closes and aggregates the exact fifty-member Vote set inside the measured guardrail", () => {
      expect(metrics.closeVotingAggregate50Ms).toBeLessThan(guardrails.closeVotingAggregate50Ms);
    });

    it("computes and persists an immutable DecisionProposal inside the measured guardrail", () => {
      expect(metrics.decisionProposalMs).toBeLessThan(guardrails.decisionProposalMs);
    });

    it("finalizes one canonical P1 Decision transaction inside the measured guardrail", () => {
      expect(metrics.finalDecisionTransactionMs).toBeLessThan(guardrails.finalDecisionTransactionMs);
      expect(finalDecisionCount).toBe(1);
    });

    it("loads the complete authenticated Decision proof inside the measured guardrail", () => {
      expect(metrics.loadDecisionProofMs).toBeLessThan(guardrails.loadDecisionProofMs);
    });

    it("enforces and measures the exact 100-Question and 50-active-Condition limits", () => {
      expect(questionCount).toBe(100);
      expect(conditionCount).toBe(50);
      expect(metrics.questions100Ms).toBeLessThan(guardrails.questions100Ms);
      expect(metrics.conditions50Ms).toBeLessThan(guardrails.conditions50Ms);
    });
  });
});
