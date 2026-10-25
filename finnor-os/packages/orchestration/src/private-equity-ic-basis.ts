import {readWorkAcquisitionDecision} from '@finnor/private-equity/src/acquisition/decision';
import {acquisitionIcRunId} from '@finnor/private-equity/src/acquisition/ic';
import {sql} from 'drizzle-orm';
import {withTenant} from '@finnor/db';
import type {TenantContext} from '@finnor/shared-types';

const isRecord=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const financialInput=(input:Record<string,unknown>|null)=>input?{nodeId:input.nodeId,valueType:input.valueType,unit:input.unit,currency:input.currency,shape:input.shape,truthClass:input.truthClass,status:input.status,value:input.value}:null;

export async function inspectPrivateEquityIcBasis(ctx: TenantContext, dealId: string, workId: string): Promise<Record<string, unknown>> {
  const tenantId=ctx.tenantId;
  const acquisition=await readWorkAcquisitionDecision({auth:ctx},{workId,dealId});
  const acquisitionRunId=acquisition?acquisitionIcRunId(acquisition):null;
  return withTenant(tenantId, async (db) => {
    const investments = await db.execute(sql`
      SELECT id::text,title,state,version FROM finnor_os.pe_investment_cases
      WHERE tenant_id=${tenantId}::uuid AND deal_id=${dealId}::uuid
      ORDER BY updated_at DESC,id LIMIT 8
    `);
    const versions = await db.execute(sql`
      SELECT version.id::text,version.investment_case_id::text,version.version_key,version.model_definition
      FROM finnor_os.underwriting_model_versions version
      JOIN finnor_os.pe_investment_cases investment
        ON investment.tenant_id=version.tenant_id AND investment.id=version.investment_case_id
      WHERE version.tenant_id=${tenantId}::uuid AND investment.deal_id=${dealId}::uuid
      ORDER BY version.created_at DESC,version.id LIMIT 8
    `);
    const runs = await db.execute(sql`
      SELECT run.id::text,run.investment_case_id::text,run.model_version_id::text,run.work_id::text,
             run.scenario_id::text,run.status,run.validity,run.computed_at,run.input_snapshot
      FROM finnor_os.underwriting_runs run
      JOIN finnor_os.pe_investment_cases investment
        ON investment.tenant_id=run.tenant_id AND investment.id=run.investment_case_id
      WHERE run.tenant_id=${tenantId}::uuid AND investment.deal_id=${dealId}::uuid
      ORDER BY CASE WHEN run.id=${acquisitionRunId}::uuid THEN 0 WHEN run.work_id=${workId}::uuid THEN 1 WHEN run.scenario_id IS NULL THEN 2 ELSE 3 END,
        run.computed_at DESC,run.id LIMIT 16
    `);
    const cases = await db.execute(sql`
      SELECT id::text,investment_case_id::text,committee_config_version_id::text,final_decision_id::text,
             state,version,primary_underwriting_run_id::text,current_memo_id::text,current_deck_id::text,current_recommendation_id::text
      FROM finnor_os.pe_ic_cases
      WHERE tenant_id=${tenantId}::uuid AND deal_id=${dealId}::uuid
      ORDER BY updated_at DESC,id LIMIT 8
    `);
    const configs = await db.execute(sql`
      SELECT id::text,config_version,committee_org_unit_id::text
      FROM finnor_os.pe_ic_committee_config_versions
      WHERE tenant_id=${tenantId}::uuid ORDER BY created_at DESC,id LIMIT 8
    `);
    const templates = await db.execute(sql`
      SELECT DISTINCT ON (template_key) template_key,version_id::text,kind,status
      FROM finnor_os.artifact_templates
      WHERE tenant_id=${tenantId}::uuid ORDER BY template_key,created_at DESC LIMIT 20
    `);
    const memoDrafts = await db.execute(sql`
      SELECT link.entity_id::text ic_case_id,document.id::text document_id,
             version.id::text document_version_id,version.created_at,
             document.external_id action_id
      FROM finnor_os.pe_document_links link
      JOIN finnor_os.documents document ON document.tenant_id=link.tenant_id AND document.id=link.document_id
      JOIN finnor_os.document_versions version ON version.tenant_id=document.tenant_id AND version.document_id=document.id
      WHERE link.tenant_id=${tenantId}::uuid AND link.deal_id=${dealId}::uuid
        AND link.entity_type='pe_ic_case' AND link.archived_at IS NULL
        AND document.source_system='ic_memo_draft' AND document.archived_at IS NULL
        AND version.source_ref=document.external_id
      ORDER BY version.created_at DESC,version.id LIMIT 12
    `);
    const memoSelections = await db.execute(sql`
      SELECT id::text,ic_case_id::text,document_id::text,document_version_id::text,
             source_completeness,underwriting_run_id::text,created_at
      FROM finnor_os.pe_ic_memos WHERE tenant_id=${tenantId}::uuid AND deal_id=${dealId}::uuid
        AND artifact_role='MEMO' ORDER BY created_at DESC,id LIMIT 12
    `);
    return {
      dealId,
      acquisitionDecision:acquisition?{decisionId:acquisition.decisionId,status:acquisition.status,workInputId:acquisition.workInputId,primaryUnderwritingRunId:acquisitionRunId,qualification:acquisition.result?.maximumBid.qualification??null}:null,
      investmentCases: investments.rows,
      modelVersions: versions.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        const definition = isRecord(row.model_definition) ? row.model_definition : {};
        const nodes = Array.isArray(definition.nodes) ? definition.nodes : [];
        return {
          id: row.id, investmentCaseId: row.investment_case_id, versionKey: row.version_key,
          // The objective planner can only construct or validate these scenario
          // inputs. Carrying every model node for every historical version can
          // exceed the durable inspection bound and erase the entire IC basis.
          inputNodes: nodes.filter((node) => isRecord(node) && node.kind === "input"
            && ["operating.revenue_explicit", "operating.revenue_growth", "exit.multiple"].includes(String(node.id)))
            .map((node) => ({ id: node.id, unit: node.unit, shape: node.shape, valueType: node.valueType })),
        };
      }),
      recentRuns: runs.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        const snapshot = isRecord(row.input_snapshot) ? row.input_snapshot : {};
        const values = isRecord(snapshot.values) ? snapshot.values : {};
        const revenue = isRecord(values["operating.revenue_explicit"]) ? values["operating.revenue_explicit"] : null;
        const growth = isRecord(values["operating.revenue_growth"]) ? values["operating.revenue_growth"] : null;
        const exitMultiple = isRecord(values["exit.multiple"]) ? values["exit.multiple"] : null;
        return {
          id: row.id, investmentCaseId: row.investment_case_id, modelVersionId: row.model_version_id,
          workId: row.work_id, scenarioId: row.scenario_id, status: row.status, validity: row.validity, computedAt: row.computed_at,
          revenueInput: financialInput(revenue),
          growthInput: financialInput(growth),
          exitMultipleInput: financialInput(exitMultiple),
        };
      }),
      icCases: cases.rows.map((raw) => {
        const row = raw as Record<string, unknown>;
        return {
          id: row.id, investmentCaseId: row.investment_case_id, committeeConfigVersionId: row.committee_config_version_id,
          state: row.state, version: row.version, primaryUnderwritingRunId: row.primary_underwriting_run_id,
          currentMemoId: row.current_memo_id, currentDeckId: row.current_deck_id,
          currentRecommendationId: row.current_recommendation_id,
          finalDecisionId: row.final_decision_id,
        };
      }),
      committeeConfigVersions: configs.rows,
      artifactTemplates: templates.rows,
      generatedMemoDrafts: memoDrafts.rows,
      memoSelections: memoSelections.rows,
    };
  });
}
