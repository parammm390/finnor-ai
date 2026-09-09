import { randomUUID } from "node:crypto";
import { recordBusinessEvent } from "@finnor/data-platform";
import {
  UNDERWRITING_ENGINE_VERSION,
  UNDERWRITING_LIMITS,
  UnderwritingError,
  applyScenario,
  affectedNodes,
  canonicalSerialize,
  compileUnderwritingModel,
  decimal,
  diffModels,
  diffRuns,
  executeUnderwritingModel,
  explainOutput,
  fail,
  inputSnapshotHash,
  scenarioHash,
  sealInputSnapshot,
  runResultHash,
  semanticHash,
  type CompiledUnderwritingModel,
  type InputNode,
  type InputProvenanceRef,
  type InputTruthStatus,
  type ModelValue,
  type ResolvedInput,
  type ScenarioOverride,
  type SensitivityDefinition,
  type TruthClass,
  type UnderwritingInputSnapshot,
  type UnderwritingModelIR,
  type UnderwritingRunResult,
  type UnderwritingScenario,
} from "@finnor/underwriting";
import { PeDomainError, type PeMutationContext } from "./types";
import { assertPeText, assertPeUuid, peProvenance, peTransaction, type PeClient } from "./repository";
import { recordUnderwritingMetric } from "./underwriting-telemetry";
import {
  boundUnderwritingCells,
  observedUnderwritingCell,
  type UnderwritingWorkbookIr,
} from "./underwriting-artifact-values";

interface ModelRow {
  id: string;
  tenant_id: string;
  investment_case_id: string;
  model_key: string;
  name: string;
  created_by: string;
  created_at: Date;
}

interface ModelVersionRow {
  id: string;
  tenant_id: string;
  investment_case_id: string;
  model_id: string;
  version_key: string;
  semantic_hash: string;
  model_definition: UnderwritingModelIR;
  created_at: Date;
}

interface InputBindingRow {
  input_node_id: string;
  source_kind: "p1_assumption" | "evidence_version" | "artifact_anchor" | "explicit" | "model_parameter";
  assumption_id: string | null;
  evidence_version_id: string | null;
  document_id: string | null;
  document_version_id: string | null;
  anchor_id: string | null;
  anchor_hash: string | null;
  value_path: string | null;
  value_selector: string | null;
  stale_after_days: number | null;
}

export interface ExplicitUnderwritingInput {
  value: ModelValue | null;
  truthClass: TruthClass;
  status?: InputTruthStatus;
  provenance?: readonly InputProvenanceRef[];
  reason?: string;
}

export interface CreateUnderwritingRunInput {
  investmentCaseId: string;
  modelVersionId: string;
  worldAt: string;
  idempotencyKey: string;
  scenarioId?: string;
  workId?: string;
  explicitInputs?: Readonly<Record<string, ExplicitUnderwritingInput>>;
}

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail("INVALID_PERIOD", "Timestamp is invalid", { value: String(value) });
  return date.toISOString();
}

function normalizedWorldAt(value: string): string {
  if (typeof value !== "string" || value.length > 80) fail("INVALID_PERIOD", "worldAt must be a bounded ISO timestamp");
  return asIso(value);
}

function createdBy(ctx: PeMutationContext): string {
  return peProvenance(ctx).createdBy;
}

function recordShape(row: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) output[key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
  return output;
}

interface StoredRunIntegrity {
  id: string;
  input_hash: string;
  input_snapshot: UnderwritingInputSnapshot;
  result_hash: string;
  result: UnderwritingRunResult;
}

function assertStoredRunIntegrity(tenantId: string, run: StoredRunIntegrity): void {
  const inputHash = inputSnapshotHash(run.input_snapshot);
  const resultHash = runResultHash(run.result);
  if (run.input_snapshot.semanticHash !== run.input_hash || inputHash !== run.input_hash) {
    recordUnderwritingMetric({ tenantId, runId: run.id }, "underwriting_result_hash_mismatches", 1, "count");
    fail("INPUT_SEMANTIC_HASH_MISMATCH", "Stored Run InputSnapshot failed immutable semantic-hash verification", { runId: run.id });
  }
  if (run.result.resultSemanticHash !== run.result_hash || resultHash !== run.result_hash) {
    recordUnderwritingMetric({ tenantId, runId: run.id }, "underwriting_result_hash_mismatches", 1, "count");
    fail("RESULT_SEMANTIC_HASH_MISMATCH", "Stored Run result failed immutable semantic-hash verification", { runId: run.id });
  }
}

async function loadModelVersion(client: PeClient, tenantId: string, modelVersionId: string): Promise<{ row: ModelVersionRow; compiled: CompiledUnderwritingModel }> {
  const result = await client.query<ModelVersionRow>(
    `SELECT id::text,tenant_id::text,investment_case_id::text,model_id::text,version_key,semantic_hash,model_definition,created_at
       FROM finnor_os.underwriting_model_versions WHERE tenant_id=$1 AND id=$2`,
    [tenantId, modelVersionId],
  );
  const row = result.rows[0];
  if (!row) fail("MODEL_VERSION_NOT_FOUND", "Underwriting ModelVersion was not found in the authenticated tenant", { modelVersionId });
  const compiled = compileUnderwritingModel(row.model_definition);
  if (compiled.semanticHash !== row.semantic_hash) fail("MODEL_SEMANTIC_HASH_MISMATCH", "Stored ModelVersion hash does not match its definition", { modelVersionId });
  return { row, compiled };
}

export async function createUnderwritingModel(ctx: PeMutationContext, input: {
  investmentCaseId: string;
  modelKey: string;
  name: string;
}): Promise<Record<string, unknown>> {
  assertPeUuid(input.investmentCaseId, "investmentCaseId");
  assertPeText(input.name, "Underwriting model name");
  if (!/^[a-z][a-z0-9_.:-]{0,99}$/.test(input.modelKey)) fail("MODEL_SCHEMA_INVALID", "Underwriting modelKey is invalid");
  return peTransaction(ctx, async (_db, client) => {
    const investmentCase = await client.query("SELECT id FROM finnor_os.pe_investment_cases WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, input.investmentCaseId]);
    if (!investmentCase.rows[0]) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "InvestmentCase was not found in the authenticated tenant");
    const inserted = await client.query<ModelRow>(
      `INSERT INTO finnor_os.underwriting_models(tenant_id,investment_case_id,model_key,name,created_by)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,investment_case_id,model_key) DO NOTHING RETURNING *`,
      [ctx.auth.tenantId, input.investmentCaseId, input.modelKey, input.name.trim(), createdBy(ctx)],
    );
    const row = inserted.rows[0] ?? (await client.query<ModelRow>(
      "SELECT * FROM finnor_os.underwriting_models WHERE tenant_id=$1 AND investment_case_id=$2 AND model_key=$3",
      [ctx.auth.tenantId, input.investmentCaseId, input.modelKey],
    )).rows[0]!;
    if (row.name !== input.name.trim()) fail("IDEMPOTENCY_CONFLICT", "Existing modelKey has different immutable metadata", { modelKey: input.modelKey });
    return recordShape(row as unknown as Record<string, unknown>);
  });
}

function validateSource(node: InputNode): void {
  const source = node.source;
  if (!source) return;
  if (source.kind === "p1_assumption" && !source.assumptionId) fail("MODEL_SCHEMA_INVALID", "P1 Assumption binding requires assumptionId", { nodeId: node.id });
  if (source.kind === "evidence_version" && (!source.evidenceVersionId || !source.valuePath)) fail("MODEL_SCHEMA_INVALID", "Evidence binding requires evidenceVersionId and valuePath", { nodeId: node.id });
  if (source.kind === "artifact_anchor" && (!source.documentId || !source.documentVersionId || !source.anchorId || !source.anchorHash)) fail("MODEL_SCHEMA_INVALID", "Artifact input binding requires exact DocumentVersion and anchor", { nodeId: node.id });
  if (source.kind !== "evidence_version" && source.valuePath !== undefined) fail("MODEL_SCHEMA_INVALID", "valuePath is reserved for an exact EvidenceVersion JSON path", { nodeId: node.id });
  if (source.kind !== "artifact_anchor" && source.valueSelector !== undefined) fail("MODEL_SCHEMA_INVALID", "valueSelector is reserved for an exact ArtifactAnchor period", { nodeId: node.id });
}

async function insertModelInputBindings(client: PeClient, ctx: PeMutationContext, investmentCaseId: string, modelVersionId: string, compiled: CompiledUnderwritingModel): Promise<void> {
  for (const node of Object.values(compiled.nodeById)) {
    if (node.kind !== "input" || !node.source) continue;
    validateSource(node);
    if (node.source.kind === "artifact_anchor") {
      const snapshot = (await client.query<{ ir: UnderwritingWorkbookIr }>(
        `SELECT snapshot.ir FROM finnor_os.artifact_ir_snapshots snapshot
          JOIN finnor_os.document_versions version ON version.tenant_id=snapshot.tenant_id AND version.id=snapshot.version_id
         WHERE snapshot.tenant_id=$1 AND version.document_id=$2 AND snapshot.version_id=$3
         ORDER BY snapshot.created_at DESC LIMIT 1`,
        [ctx.auth.tenantId, node.source.documentId, node.source.documentVersionId],
      )).rows[0];
      if (!snapshot) fail("ARTIFACT_ANCHOR_CONFLICT", "Artifact input binding references a missing SpreadsheetIR snapshot", { nodeId: node.id });
      boundUnderwritingCells(snapshot.ir, {
        anchorId: node.source.anchorId!, anchorHash: node.source.anchorHash!, valueSelector: node.source.valueSelector,
      }, node.shape, compiled.periods, { requireBoundHash: true, allowSeriesCellSelector: false });
    }
    await client.query(
      `INSERT INTO finnor_os.underwriting_model_input_bindings(
         tenant_id,investment_case_id,model_version_id,input_node_id,source_kind,assumption_id,evidence_version_id,
         document_id,document_version_id,anchor_id,anchor_hash,value_path,value_selector,stale_after_days,created_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [ctx.auth.tenantId, investmentCaseId, modelVersionId, node.id, node.source.kind,
        node.source.assumptionId ?? null, node.source.evidenceVersionId ?? null, node.source.documentId ?? null,
        node.source.documentVersionId ?? null, node.source.anchorId ?? null, node.source.anchorHash ?? null,
        node.source.valuePath ?? null, node.source.valueSelector ?? null, node.source.staleAfterDays ?? null, createdBy(ctx)],
    );
  }
}

export async function createUnderwritingModelVersion(ctx: PeMutationContext, input: {
  modelId: string;
  definition: UnderwritingModelIR;
  parentVersionId?: string;
}): Promise<Record<string, unknown>> {
  assertPeUuid(input.modelId, "modelId");
  if (input.parentVersionId) assertPeUuid(input.parentVersionId, "parentVersionId");
  let compiled: CompiledUnderwritingModel;
  try { compiled = compileUnderwritingModel(input.definition); } catch (error) {
    recordUnderwritingMetric({ tenantId: ctx.auth.tenantId }, "underwriting_model_compile_failures", 1, "count");
    throw error;
  }
  recordUnderwritingMetric({ tenantId: ctx.auth.tenantId }, "underwriting_model_nodes", input.definition.nodes.length, "count");
  return peTransaction(ctx, async (db, client) => {
    const model = (await client.query<ModelRow>("SELECT * FROM finnor_os.underwriting_models WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, input.modelId])).rows[0];
    if (!model) fail("MODEL_NOT_FOUND", "Underwriting model was not found in the authenticated tenant");
    if (input.definition.modelKey !== model.model_key) fail("MODEL_SCHEMA_INVALID", "ModelIR modelKey differs from its logical model", { expected: model.model_key, actual: input.definition.modelKey });
    const sameVersion = (await client.query<ModelVersionRow>(
      "SELECT * FROM finnor_os.underwriting_model_versions WHERE tenant_id=$1 AND model_id=$2 AND version_key=$3",
      [ctx.auth.tenantId, input.modelId, input.definition.modelVersion],
    )).rows[0];
    if (sameVersion) {
      if (sameVersion.semantic_hash !== compiled.semanticHash) fail("IDEMPOTENCY_CONFLICT", "Model version key already has different semantics");
      return recordShape(sameVersion as unknown as Record<string, unknown>);
    }
    const semanticallySame = (await client.query<ModelVersionRow>(
      "SELECT * FROM finnor_os.underwriting_model_versions WHERE tenant_id=$1 AND model_id=$2 AND semantic_hash=$3",
      [ctx.auth.tenantId, input.modelId, compiled.semanticHash],
    )).rows[0];
    if (semanticallySame) return recordShape(semanticallySame as unknown as Record<string, unknown>);
    const id = randomUUID();
    const inserted = await client.query<ModelVersionRow>(
      `INSERT INTO finnor_os.underwriting_model_versions(
         id,tenant_id,investment_case_id,model_id,version_key,schema_version,financial_convention_version,
         minimum_engine_version,semantic_hash,model_definition,parent_version_id,created_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) RETURNING *`,
      [id, ctx.auth.tenantId, model.investment_case_id, input.modelId, input.definition.modelVersion,
        input.definition.schemaVersion, input.definition.financialConventionVersion, input.definition.minimumEngineVersion,
        compiled.semanticHash, JSON.stringify(input.definition), input.parentVersionId ?? null, createdBy(ctx)],
    );
    await insertModelInputBindings(client, ctx, model.investment_case_id, id, compiled);
    await recordBusinessEvent(db, {
      tenantId: ctx.auth.tenantId,
      entityType: "underwriting_model_version",
      entityId: id,
      eventType: "underwriting_model_version_created",
      payload: { investmentCaseId: model.investment_case_id, modelVersionId: id, modelId: input.modelId, semanticHash: compiled.semanticHash },
      source: "@finnor/private-equity",
    });
    return recordShape(inserted.rows[0] as unknown as Record<string, unknown>);
  });
}

export async function createUnderwritingScenario(ctx: PeMutationContext, input: {
  investmentCaseId: string;
  modelVersionId: string;
  scenario: UnderwritingScenario;
  parentScenarioId?: string;
}): Promise<Record<string, unknown>> {
  assertPeUuid(input.investmentCaseId, "investmentCaseId");
  assertPeUuid(input.modelVersionId, "modelVersionId");
  if (input.parentScenarioId) assertPeUuid(input.parentScenarioId, "parentScenarioId");
  const hash = scenarioHash(input.scenario);
  return peTransaction(ctx, async (_db, client) => {
    const { row, compiled } = await loadModelVersion(client, ctx.auth.tenantId, input.modelVersionId);
    if (row.investment_case_id !== input.investmentCaseId) fail("MODEL_VERSION_NOT_FOUND", "ModelVersion is not attached to the requested InvestmentCase");
    const seen = new Set<string>();
    for (const override of input.scenario.overrides) {
      if (seen.has(override.nodeId) || compiled.nodeById[override.nodeId]?.kind !== "input") fail("SCENARIO_INVALID_TARGET", "Scenario target must be a unique InputNode", { nodeId: override.nodeId });
      seen.add(override.nodeId);
    }
    const definition = { ...input.scenario, semanticHash: hash };
    const inserted = await client.query(
      `INSERT INTO finnor_os.underwriting_scenarios(
         tenant_id,investment_case_id,model_version_id,parent_scenario_id,name,semantic_hash,definition,created_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT(tenant_id,model_version_id,semantic_hash) DO NOTHING RETURNING *`,
      [ctx.auth.tenantId, input.investmentCaseId, input.modelVersionId, input.parentScenarioId ?? null,
        input.scenario.name, hash, JSON.stringify(definition), createdBy(ctx)],
    );
    const result = inserted.rows[0] ?? (await client.query(
      "SELECT * FROM finnor_os.underwriting_scenarios WHERE tenant_id=$1 AND model_version_id=$2 AND semantic_hash=$3",
      [ctx.auth.tenantId, input.modelVersionId, hash],
    )).rows[0];
    return recordShape(result as Record<string, unknown>);
  });
}

function parseExactJsonValue(raw: string | null, node: InputNode): ModelValue | null {
  if (raw === null) return null;
  if (node.shape === "scalar") {
    if (node.valueType === "decimal") {
      const unquoted = raw.startsWith('"') ? JSON.parse(raw) : raw;
      if (typeof unquoted !== "string") fail("INVALID_DECIMAL", "Bound financial input is not an exact decimal string or JSON number token", { nodeId: node.id });
      return decimal(unquoted);
    }
    const parsed = JSON.parse(raw) as unknown;
    if (node.valueType === "boolean") {
      if (typeof parsed !== "boolean") fail("TYPE_MISMATCH", "Bound input is not boolean", { nodeId: node.id });
      return parsed;
    }
    if (typeof parsed !== "string") fail("TYPE_MISMATCH", "Bound date/text input is not a string", { nodeId: node.id });
    return parsed;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("TYPE_MISMATCH", "Bound series input is not an object", { nodeId: node.id });
  const output: Record<string, string | boolean> = {};
  for (const [periodId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (node.valueType === "decimal") {
      if (typeof value !== "string") fail("INVALID_DECIMAL", "Bound series financial values must be decimal strings to avoid JSON float ambiguity", { nodeId: node.id, periodId });
      output[periodId] = decimal(value);
    } else if (node.valueType === "boolean") {
      if (typeof value !== "boolean") fail("TYPE_MISMATCH", "Bound boolean series has an invalid item", { nodeId: node.id, periodId });
      output[periodId] = value;
    } else {
      if (typeof value !== "string") fail("TYPE_MISMATCH", "Bound text/date series has an invalid item", { nodeId: node.id, periodId });
      output[periodId] = value;
    }
  }
  return output;
}

function stalenessStatus(worldAt: string, sourceAt: string | null, staleAfterDays: number | null): InputTruthStatus {
  if (staleAfterDays === null || sourceAt === null) return "KNOWN";
  const age = new Date(worldAt).getTime() - new Date(sourceAt).getTime();
  return age > staleAfterDays * 86_400_000 ? "STALE" : "KNOWN";
}

function unknownInput(node: InputNode, reason: string): ResolvedInput {
  return {
    nodeId: node.id, valueType: node.valueType, unit: node.unit, ...(node.currency ? { currency: node.currency } : {}),
    shape: node.shape, value: null, truthClass: "UNKNOWN", status: "UNKNOWN", provenance: [], reason,
  };
}

async function resolveAssumption(client: PeClient, tenantId: string, investmentCaseId: string, worldAt: string, node: InputNode, binding: InputBindingRow): Promise<ResolvedInput> {
  const row = (await client.query<{
    history_id: string; entity_version: number; state: string; value_type: string; value_text: string | null;
    currency_code: string | null; unit: string | null; recorded_at: Date; observed_at: Date | null;
  }>(
    `SELECT id::text history_id,entity_version,snapshot->>'state' state,snapshot->>'value_type' value_type,
            (snapshot->'value')::text value_text,snapshot->>'currency_code' currency_code,snapshot->>'unit' unit,
            recorded_at,observed_at
       FROM finnor_os.canonical_entity_versions
      WHERE tenant_id=$1 AND entity_type='pe_assumption' AND entity_id=$2 AND recorded_at<=$3::timestamptz
      ORDER BY recorded_at DESC,entity_version DESC LIMIT 1`,
    [tenantId, binding.assumption_id, worldAt],
  )).rows[0];
  if (!row) return unknownInput(node, "NO_ASSUMPTION_VERSION_KNOWN_AT_WORLD_AT");
  const typeOkay = (row.value_type === "currency" && node.unit === "money")
    || (row.value_type === "percent" && node.unit === "rate")
    || (row.value_type === "number" && node.valueType === "decimal")
    || (row.value_type === "boolean" && node.valueType === "boolean")
    || (row.value_type === "date" && node.valueType === "date")
    || (row.value_type === "text" && node.valueType === "text")
    || (row.value_type === "json" && node.shape === "series");
  const currencyOkay = node.unit !== "money" || row.currency_code === node.currency;
  const unitOkay = !row.unit || row.unit === node.unit;
  const provenance: InputProvenanceRef[] = [{
    kind: "p1_assumption", id: binding.assumption_id!, versionId: row.history_id,
    effectiveAt: asIso(row.recorded_at), ...(row.observed_at ? { observedAt: asIso(row.observed_at) } : {}),
  }];
  const evidence = await client.query<{ evidence_version_id: string; retrieved_at: Date }>(
    `SELECT link.evidence_version_id::text,evidence.retrieved_at
       FROM finnor_os.pe_evidence_links link
       JOIN finnor_os.evidence_source_versions evidence ON evidence.id=link.evidence_version_id
      WHERE link.tenant_id=$1 AND link.entity_type='pe_assumption' AND link.entity_id=$2
        AND link.archived_at IS NULL AND link.created_at<=$3::timestamptz AND evidence.retrieved_at<=$3::timestamptz
      ORDER BY evidence.retrieved_at,evidence.id LIMIT 31`,
    [tenantId, binding.assumption_id, worldAt],
  );
  provenance.push(...evidence.rows.map((item) => ({ kind: "evidence_version" as const, id: item.evidence_version_id, retrievedAt: asIso(item.retrieved_at) })));
  const status: InputTruthStatus = row.state !== "active" ? "UNKNOWN"
    : !typeOkay || !currencyOkay || !unitOkay ? "CONFLICTING"
      : stalenessStatus(worldAt, asIso(row.observed_at ?? row.recorded_at), binding.stale_after_days);
  return {
    nodeId: node.id, valueType: node.valueType, unit: node.unit, ...(node.currency ? { currency: node.currency } : {}),
    shape: node.shape, value: status === "UNKNOWN" ? null : parseExactJsonValue(row.value_text, node),
    truthClass: "CANONICAL_ASSUMPTION", status, provenance,
    ...(status === "UNKNOWN" ? { reason: `ASSUMPTION_${row.state.toUpperCase()}_AT_WORLD_AT` } : {}),
    ...(status === "CONFLICTING" ? { reason: "ASSUMPTION_TYPE_UNIT_OR_CURRENCY_CONFLICT" } : {}),
    ...(status === "STALE" ? { reason: "ASSUMPTION_EXCEEDS_DECLARED_STALENESS_POLICY" } : {}),
  };
}

async function resolveEvidence(client: PeClient, tenantId: string, worldAt: string, node: InputNode, binding: InputBindingRow): Promise<ResolvedInput> {
  const row = (await client.query<{
    value_text: string | null; scope: string; source_tenant: string | null; as_of: Date; retrieved_at: Date; content_hash: string;
  }>(
    `SELECT (snapshot #> string_to_array($4,'.'))::text value_text,scope,tenant_id::text source_tenant,as_of,retrieved_at,content_hash
       FROM finnor_os.evidence_source_versions
      WHERE id=$2 AND retrieved_at<=$3::timestamptz AND (scope='public' OR tenant_id=$1)`,
    [tenantId, binding.evidence_version_id, worldAt, binding.value_path],
  )).rows[0];
  if (!row) return unknownInput(node, "EVIDENCE_VERSION_NOT_KNOWN_AT_WORLD_AT_OR_NOT_VISIBLE");
  if (row.value_text === null) return unknownInput(node, "EVIDENCE_VALUE_PATH_MISSING");
  const status = stalenessStatus(worldAt, asIso(row.as_of), binding.stale_after_days);
  return {
    nodeId: node.id, valueType: node.valueType, unit: node.unit, ...(node.currency ? { currency: node.currency } : {}), shape: node.shape,
    value: parseExactJsonValue(row.value_text, node), truthClass: "OBSERVED_FACT", status,
    provenance: [{ kind: "evidence_version", id: binding.evidence_version_id!, semanticHash: row.content_hash, effectiveAt: asIso(row.as_of), retrievedAt: asIso(row.retrieved_at) }],
    ...(status === "STALE" ? { reason: "EVIDENCE_EXCEEDS_DECLARED_STALENESS_POLICY" } : {}),
  };
}

async function resolveArtifactInput(client: PeClient, tenantId: string, worldAt: string, node: InputNode, binding: InputBindingRow, periods: readonly { id: string }[]): Promise<ResolvedInput> {
  const row = (await client.query<{ created_at: Date; calculation_status: string; ir: UnderwritingWorkbookIr }>(
    `SELECT version.created_at,snapshot.calculation_status,snapshot.ir
       FROM finnor_os.document_versions version
       JOIN finnor_os.artifact_ir_snapshots snapshot ON snapshot.tenant_id=version.tenant_id AND snapshot.version_id=version.id
      WHERE version.tenant_id=$1 AND version.document_id=$2 AND version.id=$3 AND version.created_at<=$4::timestamptz
      ORDER BY snapshot.created_at DESC LIMIT 1`,
    [tenantId, binding.document_id, binding.document_version_id, worldAt],
  )).rows[0];
  if (!row) return unknownInput(node, "ARTIFACT_VERSION_NOT_KNOWN_AT_WORLD_AT_OR_NOT_VISIBLE");
  let cells;
  try {
    cells = boundUnderwritingCells(row.ir, {
      anchorId: binding.anchor_id!, anchorHash: binding.anchor_hash!, valueSelector: binding.value_selector,
    }, node.shape, periods, { requireBoundHash: true, allowSeriesCellSelector: false });
  } catch (error) {
    if (error instanceof UnderwritingError && error.code === "ARTIFACT_ANCHOR_CONFLICT") {
      return { ...unknownInput(node, "ARTIFACT_ANCHOR_STALE_OR_MISSING"), status: "CONFLICTING", truthClass: "EXTERNAL_CALCULATED_COMPARISON" };
    }
    return { ...unknownInput(node, "ARTIFACT_BINDING_SHAPE_OR_RANGE_UNSUPPORTED"), status: "UNSUPPORTED", truthClass: "EXTERNAL_CALCULATED_COMPARISON" };
  }
  const observed = cells.map((cell) => ({ cell, observed: observedUnderwritingCell(cell.node, row.calculation_status) }));
  const status: InputTruthStatus = observed.some((item) => item.observed.calculationStatus === "stale") ? "STALE"
    : observed.some((item) => item.observed.calculationStatus !== "verified" || item.observed.value === null) ? "UNKNOWN" : "KNOWN";
  const anyCalculated = observed.some((item) => item.observed.calculated);
  const rawJson = status === "UNKNOWN" ? null : node.shape === "scalar"
    ? JSON.stringify(observed[0]!.observed.value)
    : JSON.stringify(Object.fromEntries(observed.map((item) => [item.cell.selector!, item.observed.value])));
  return {
    nodeId: node.id, valueType: node.valueType, unit: node.unit, ...(node.currency ? { currency: node.currency } : {}), shape: node.shape,
    value: status === "UNKNOWN" ? null : parseExactJsonValue(rawJson, node),
    truthClass: anyCalculated ? "EXTERNAL_CALCULATED_COMPARISON" : "OBSERVED_FACT",
    status,
    provenance: [{ kind: "artifact_anchor", id: binding.document_id!, versionId: binding.document_version_id!, anchorId: binding.anchor_id!, semanticHash: binding.anchor_hash!, effectiveAt: asIso(row.created_at) }],
    ...(status === "STALE" ? { reason: "ARTIFACT_CALCULATION_STALE" } : {}),
    ...(status === "UNKNOWN" ? { reason: "ARTIFACT_VALUE_UNCALCULATED_OR_UNKNOWN" } : {}),
  };
}

function explicitResolved(node: InputNode, input: ExplicitUnderwritingInput | undefined): ResolvedInput {
  if (!input) return unknownInput(node, "EXPLICIT_INPUT_NOT_SUPPLIED");
  if (input.truthClass === "DERIVED_VALUE" || input.truthClass === "EXTERNAL_CALCULATED_COMPARISON" || input.truthClass === "UNKNOWN" || input.truthClass === "SCENARIO_OVERRIDE") {
    fail("MODEL_SCHEMA_INVALID", "Explicit base input has an invalid truth class", { nodeId: node.id, truthClass: input.truthClass });
  }
  return {
    nodeId: node.id, valueType: node.valueType, unit: node.unit, ...(node.currency ? { currency: node.currency } : {}), shape: node.shape,
    value: input.value, truthClass: input.truthClass, status: input.status ?? "KNOWN",
    provenance: input.provenance ?? [{ kind: "human_input", id: node.id }], ...(input.reason ? { reason: input.reason } : {}),
  };
}

async function resolveInputSnapshot(client: PeClient, tenantId: string, row: ModelVersionRow, compiled: CompiledUnderwritingModel, worldAt: string, explicitInputs: Readonly<Record<string, ExplicitUnderwritingInput>>): Promise<Readonly<UnderwritingInputSnapshot>> {
  const bindings = await client.query<InputBindingRow>(
    `SELECT input_node_id,source_kind,assumption_id::text,evidence_version_id::text,document_id::text,document_version_id::text,
            anchor_id,anchor_hash,value_path,value_selector,stale_after_days
       FROM finnor_os.underwriting_model_input_bindings WHERE tenant_id=$1 AND model_version_id=$2`,
    [tenantId, row.id],
  );
  const byNode = new Map(bindings.rows.map((binding) => [binding.input_node_id, binding]));
  const resolved: Record<string, ResolvedInput> = {};
  for (const node of Object.values(compiled.nodeById)) {
    if (node.kind !== "input") continue;
    const binding = byNode.get(node.id);
    if (!binding || binding.source_kind === "explicit" || binding.source_kind === "model_parameter") {
      resolved[node.id] = explicitResolved(node, explicitInputs[node.id]);
    } else if (binding.source_kind === "p1_assumption") {
      resolved[node.id] = await resolveAssumption(client, tenantId, row.investment_case_id, worldAt, node, binding);
    } else if (binding.source_kind === "evidence_version") {
      resolved[node.id] = await resolveEvidence(client, tenantId, worldAt, node, binding);
    } else {
      resolved[node.id] = await resolveArtifactInput(client, tenantId, worldAt, node, binding, compiled.periods);
    }
  }
  for (const nodeId of Object.keys(explicitInputs)) {
    const node = compiled.nodeById[nodeId];
    if (!node || node.kind !== "input") fail("MISSING_DEPENDENCY", "Explicit input targets an unknown node", { nodeId });
    const binding = byNode.get(nodeId);
    if (binding && !["explicit", "model_parameter"].includes(binding.source_kind)) fail("IDEMPOTENCY_CONFLICT", "Explicit input cannot shadow an exact bound source; use a Scenario override", { nodeId });
  }
  return sealInputSnapshot({ schemaVersion: "underwriting-input-snapshot.v1", investmentCaseId: row.investment_case_id, worldAt, values: resolved });
}

async function loadScenario(client: PeClient, tenantId: string, scenarioId: string | undefined, row: ModelVersionRow): Promise<UnderwritingScenario | undefined> {
  if (!scenarioId) return undefined;
  const scenario = (await client.query<{ definition: UnderwritingScenario; semantic_hash: string }>(
    "SELECT definition,semantic_hash FROM finnor_os.underwriting_scenarios WHERE tenant_id=$1 AND investment_case_id=$2 AND model_version_id=$3 AND id=$4",
    [tenantId, row.investment_case_id, row.id, scenarioId],
  )).rows[0];
  if (!scenario) fail("SCENARIO_INVALID_TARGET", "Scenario is not attached to the exact ModelVersion and InvestmentCase");
  if (scenarioHash(scenario.definition) !== scenario.semantic_hash) fail("MODEL_SEMANTIC_HASH_MISMATCH", "Stored Scenario hash mismatch");
  return scenario.definition;
}

export interface PreparedRun {
  row: ModelVersionRow;
  compiled: CompiledUnderwritingModel;
  baseSnapshot: Readonly<UnderwritingInputSnapshot>;
  effectiveSnapshot: Readonly<UnderwritingInputSnapshot>;
  scenario?: UnderwritingScenario;
  scenarioSemanticHash?: string;
}

export async function createUnderwritingSensitivity(ctx: PeMutationContext, input: {
  baseRunId: string;
  definition: SensitivityDefinition;
  idempotencyKey: string;
}): Promise<Record<string, unknown>> {
  assertPeUuid(input.baseRunId, "baseRunId");
  assertPeText(input.idempotencyKey, "sensitivity idempotencyKey");
  if (input.definition.schemaVersion !== "underwriting-sensitivity.v1" || !input.definition.name.trim()) fail("MODEL_SCHEMA_INVALID", "Sensitivity definition is invalid");
  const base = await peTransaction(ctx, async (_db, client) => {
    const run = (await client.query<{
      id: string; investment_case_id: string; model_version_id: string; input_hash: string; input_snapshot: UnderwritingInputSnapshot;
      result_hash: string; result: UnderwritingRunResult;
    }>("SELECT id::text,investment_case_id::text,model_version_id::text,input_hash,input_snapshot,result_hash,result FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, input.baseRunId])).rows[0];
    if (!run) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Base Underwriting Run was not found in the authenticated tenant");
    assertStoredRunIntegrity(ctx.auth.tenantId, run);
    const { row, compiled } = await loadModelVersion(client, ctx.auth.tenantId, run.model_version_id);
    return { run, row, compiled };
  }, { readOnly: true });
  const axes = [input.definition.rowAxis, input.definition.columnAxis].filter(Boolean) as NonNullable<SensitivityDefinition["columnAxis"]>[];
  for (const axis of axes) {
    const node = base.compiled.nodeById[axis.nodeId];
    if (!node || node.kind !== "input") fail("SCENARIO_INVALID_TARGET", "Sensitivity axis target is not an InputNode", { nodeId: axis.nodeId });
    if (!axis.values.length) fail("MODEL_SCHEMA_INVALID", "Sensitivity axis cannot be empty", { nodeId: axis.nodeId });
  }
  if (input.definition.columnAxis?.nodeId === input.definition.rowAxis.nodeId) fail("SCENARIO_INVALID_TARGET", "Sensitivity axes must target different InputNodes");
  for (const outputNodeId of input.definition.outputNodeIds) {
    if (base.compiled.nodeById[outputNodeId]?.kind !== "output") fail("MISSING_DEPENDENCY", "Sensitivity output is not an OutputNode", { outputNodeId });
  }
  const columns = input.definition.columnAxis?.values ?? ([null] as const);
  const cellCount = input.definition.rowAxis.values.length * columns.length;
  if (cellCount > UNDERWRITING_LIMITS.sensitivityCells) fail("SENSITIVITY_LIMIT", "Sensitivity exceeds the cell limit", { cellCount });
  const definitionHash = semanticHash({
    schemaVersion: input.definition.schemaVersion,
    rowAxis: input.definition.rowAxis,
    columnAxis: input.definition.columnAxis,
    outputNodeIds: [...input.definition.outputNodeIds].sort(),
  });
  const cells: Array<{ rowIndex: number; columnIndex: number; overrides: ScenarioOverride[]; runId: string; result: UnderwritingRunResult }> = [];
  const started = Date.now();
  for (let rowIndex = 0; rowIndex < input.definition.rowAxis.values.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const overrides: ScenarioOverride[] = [{ nodeId: input.definition.rowAxis.nodeId, value: input.definition.rowAxis.values[rowIndex]! }];
      if (input.definition.columnAxis) overrides.push({ nodeId: input.definition.columnAxis.nodeId, value: columns[columnIndex] as ModelValue });
      const scenario: UnderwritingScenario = { schemaVersion: "underwriting-scenario.v1", name: `${input.definition.name} [${rowIndex},${columnIndex}]`, overrides };
      const applied = applyScenario(base.compiled, base.run.input_snapshot, scenario);
      const result = executeUnderwritingModel(base.compiled, base.run.input_snapshot, scenario);
      const prepared: PreparedRun = {
        row: base.row,
        compiled: base.compiled,
        baseSnapshot: sealInputSnapshot(base.run.input_snapshot),
        effectiveSnapshot: applied.snapshot,
        scenario,
        scenarioSemanticHash: applied.scenarioSemanticHash,
      };
      const persisted = await persistPreparedUnderwritingRun(ctx, {
        prepared,
        result,
        idempotencyKey: `${input.idempotencyKey}:cell:${rowIndex}:${columnIndex}`,
      });
      cells.push({ rowIndex, columnIndex, overrides, runId: persisted.id, result });
    }
  }
  const failed = cells.filter((cell) => cell.result.status === "FAILED").length;
  const status = failed === 0 ? "SUCCEEDED" : failed === cells.length ? "FAILED" : "PARTIAL";
  const stored = await peTransaction(ctx, async (db, client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4261))", [`${ctx.auth.tenantId}:${input.baseRunId}:${definitionHash}`]);
    const existing = (await client.query<{ id: string }>(
      "SELECT id::text FROM finnor_os.underwriting_sensitivities WHERE tenant_id=$1 AND base_run_id=$2 AND definition_hash=$3",
      [ctx.auth.tenantId, input.baseRunId, definitionHash],
    )).rows[0];
    if (existing) {
      const storedCells = await client.query("SELECT row_index,column_index,run_id::text,coordinates FROM finnor_os.underwriting_sensitivity_cells WHERE tenant_id=$1 AND sensitivity_id=$2 ORDER BY row_index,column_index", [ctx.auth.tenantId, existing.id]);
      return { id: existing.id, replayed: true, status, cells: storedCells.rows.map(recordShape) };
    }
    const sensitivityId = randomUUID();
    await client.query(
      `INSERT INTO finnor_os.underwriting_sensitivities(
         id,tenant_id,investment_case_id,model_version_id,base_run_id,name,definition_hash,definition,status,cell_count,created_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
      [sensitivityId, ctx.auth.tenantId, base.run.investment_case_id, base.run.model_version_id, input.baseRunId,
        input.definition.name.trim(), definitionHash, JSON.stringify(input.definition), status, cells.length, createdBy(ctx)],
    );
    for (const cell of cells) {
      await client.query(
        `INSERT INTO finnor_os.underwriting_sensitivity_cells(
           tenant_id,investment_case_id,model_version_id,sensitivity_id,run_id,row_index,column_index,coordinates
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [ctx.auth.tenantId, base.run.investment_case_id, base.run.model_version_id, sensitivityId, cell.runId,
          cell.rowIndex, cell.columnIndex, JSON.stringify({ overrides: cell.overrides, resultHash: cell.result.resultSemanticHash })],
      );
    }
    await recordBusinessEvent(db, {
      tenantId: ctx.auth.tenantId, entityType: "underwriting_sensitivity", entityId: sensitivityId,
      eventType: "underwriting_sensitivity_completed",
      payload: { investmentCaseId: base.run.investment_case_id, modelVersionId: base.run.model_version_id, sensitivityId, baseRunId: input.baseRunId, status, cellCount: cells.length },
      source: "@finnor/private-equity",
    });
    return { id: sensitivityId, replayed: false, status, cells: cells.map((cell) => ({ rowIndex: cell.rowIndex, columnIndex: cell.columnIndex, runId: cell.runId, overrides: cell.overrides, resultHash: cell.result.resultSemanticHash })) };
  });
  const metricContext = { tenantId: ctx.auth.tenantId, investmentCaseId: base.run.investment_case_id, modelVersionId: base.run.model_version_id };
  recordUnderwritingMetric(metricContext, "underwriting_sensitivity_runs", 1, "count");
  recordUnderwritingMetric(metricContext, "underwriting_sensitivity_cells", cells.length, "count");
  if (failed) recordUnderwritingMetric(metricContext, "underwriting_sensitivity_failures", failed, "count");
  recordUnderwritingMetric(metricContext, "underwriting_run_latency", Date.now() - started, "milliseconds");
  return stored;
}

export async function prepareUnderwritingRun(ctx: PeMutationContext, input: Omit<CreateUnderwritingRunInput, "idempotencyKey" | "workId">): Promise<PreparedRun> {
  assertPeUuid(input.investmentCaseId, "investmentCaseId");
  assertPeUuid(input.modelVersionId, "modelVersionId");
  if (input.scenarioId) assertPeUuid(input.scenarioId, "scenarioId");
  const worldAt = normalizedWorldAt(input.worldAt);
  return peTransaction(ctx, async (_db, client) => {
    const { row, compiled } = await loadModelVersion(client, ctx.auth.tenantId, input.modelVersionId);
    if (row.investment_case_id !== input.investmentCaseId) fail("MODEL_VERSION_NOT_FOUND", "ModelVersion is not attached to the requested InvestmentCase");
    const clock = (await client.query<{ now: Date }>("SELECT transaction_timestamp() now")).rows[0]!.now;
    if (new Date(worldAt).getTime() > clock.getTime()) fail("INVALID_PERIOD", "worldAt cannot be in the future");
    const scenario = await loadScenario(client, ctx.auth.tenantId, input.scenarioId, row);
    const baseSnapshot = await resolveInputSnapshot(client, ctx.auth.tenantId, row, compiled, worldAt, input.explicitInputs ?? {});
    const applied = applyScenario(compiled, baseSnapshot, scenario);
    return { row, compiled, baseSnapshot, effectiveSnapshot: applied.snapshot, scenario, scenarioSemanticHash: applied.scenarioSemanticHash };
  }, { readOnly: true });
}

export async function persistPreparedUnderwritingRun(ctx: PeMutationContext, input: {
  prepared: PreparedRun;
  result: UnderwritingRunResult;
  idempotencyKey: string;
  scenarioId?: string;
  workId?: string;
}): Promise<{ id: string; replayed: boolean; result: UnderwritingRunResult; inputSnapshot: UnderwritingInputSnapshot }> {
  assertPeText(input.idempotencyKey, "underwriting idempotencyKey");
  if (input.idempotencyKey.length > 240) fail("MODEL_SCHEMA_INVALID", "Underwriting idempotency key exceeds 240 characters");
  if (input.workId) assertPeUuid(input.workId, "workId");
  if (input.result.engineVersion !== UNDERWRITING_ENGINE_VERSION
    || input.result.modelSemanticHash !== input.prepared.compiled.semanticHash
    || input.result.inputSemanticHash !== input.prepared.effectiveSnapshot.semanticHash
    || runResultHash(input.result) !== input.result.resultSemanticHash) {
    fail("RESULT_SEMANTIC_HASH_MISMATCH", "Prepared Run result does not match its exact engine/model/input identity");
  }
  return peTransaction(ctx, async (db, client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4260))", [`${ctx.auth.tenantId}:${input.idempotencyKey}`]);
    const existing = (await client.query<{ id: string; investment_case_id: string; model_version_id: string; world_at: Date; input_hash: string; result_hash: string; result: UnderwritingRunResult; input_snapshot: UnderwritingInputSnapshot }>(
      `SELECT id::text,investment_case_id::text,model_version_id::text,world_at,input_hash,result_hash,result,input_snapshot
         FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND idempotency_key=$2`,
      [ctx.auth.tenantId, input.idempotencyKey],
    )).rows[0];
    if (existing) {
      assertStoredRunIntegrity(ctx.auth.tenantId, existing);
      const matches = existing.investment_case_id === input.prepared.row.investment_case_id
        && existing.model_version_id === input.prepared.row.id
        && asIso(existing.world_at) === input.prepared.effectiveSnapshot.worldAt
        && existing.input_hash === input.prepared.effectiveSnapshot.semanticHash
        && existing.result.resultSemanticHash === input.result.resultSemanticHash;
      if (!matches) fail("IDEMPOTENCY_CONFLICT", "Idempotency key is already bound to a different underwriting execution");
      return { id: existing.id, replayed: true, result: existing.result, inputSnapshot: existing.input_snapshot };
    }
    const id = randomUUID();
    await client.query(
      `INSERT INTO finnor_os.underwriting_runs(
         id,tenant_id,investment_case_id,model_version_id,scenario_id,work_id,world_at,engine_version,model_semantic_hash,
         input_hash,input_snapshot,result_hash,result,status,validity,failure_code,idempotency_key,created_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb,$14,$15,$16,$17,$18)`,
      [id, ctx.auth.tenantId, input.prepared.row.investment_case_id, input.prepared.row.id, input.scenarioId ?? null, input.workId ?? null,
        input.prepared.effectiveSnapshot.worldAt, UNDERWRITING_ENGINE_VERSION, input.prepared.compiled.semanticHash,
        input.prepared.effectiveSnapshot.semanticHash, JSON.stringify(input.prepared.effectiveSnapshot), input.result.resultSemanticHash,
        JSON.stringify(input.result), input.result.status, input.result.validity, input.result.failure?.code ?? null, input.idempotencyKey, createdBy(ctx)],
    );
    await recordBusinessEvent(db, {
      tenantId: ctx.auth.tenantId,
      entityType: "underwriting_run",
      entityId: id,
      eventType: input.result.status === "FAILED" || input.result.validity !== "VALID" ? "underwriting_run_invalid" : "underwriting_run_completed",
      payload: {
        investmentCaseId: input.prepared.row.investment_case_id, modelVersionId: input.prepared.row.id, runId: id,
        scenarioId: input.scenarioId ?? null, resultHash: input.result.resultSemanticHash, validity: input.result.validity,
      },
      source: "@finnor/private-equity",
    });
    return { id, replayed: false, result: input.result, inputSnapshot: input.prepared.effectiveSnapshot };
  });
}

export async function createUnderwritingRun(ctx: PeMutationContext, input: CreateUnderwritingRunInput) {
  const started = Date.now();
  const prepared = await prepareUnderwritingRun(ctx, input);
  const result = executeUnderwritingModel(prepared.compiled, prepared.baseSnapshot, prepared.scenario);
  if (result.inputSemanticHash !== prepared.effectiveSnapshot.semanticHash) {
    recordUnderwritingMetric({ tenantId: ctx.auth.tenantId, investmentCaseId: input.investmentCaseId, modelVersionId: input.modelVersionId }, "underwriting_result_hash_mismatches", 1, "count");
    fail("RESULT_SEMANTIC_HASH_MISMATCH", "Execution result references a different InputSnapshot hash");
  }
  const persisted = await persistPreparedUnderwritingRun(ctx, { prepared, result, idempotencyKey: input.idempotencyKey, scenarioId: input.scenarioId, workId: input.workId });
  const metricContext = { tenantId: ctx.auth.tenantId, investmentCaseId: input.investmentCaseId, modelVersionId: input.modelVersionId, runId: persisted.id };
  recordUnderwritingMetric(metricContext, "underwriting_runs_total", 1, "count");
  recordUnderwritingMetric(metricContext, "underwriting_run_latency", Date.now() - started, "milliseconds");
  recordUnderwritingMetric(metricContext, "underwriting_solver_iterations", result.solverDiagnostics.reduce((sum, row) => sum + row.iterations, 0), "count");
  if (result.status === "FAILED") {
    recordUnderwritingMetric(metricContext, "underwriting_run_failures", 1, "count");
    if (result.failure?.code === "MISSING_REQUIRED_INPUT" || result.failure?.code === "UNKNOWN_INPUT") recordUnderwritingMetric(metricContext, "underwriting_missing_inputs", 1, "count");
    if (result.failure?.code === "CONFLICTING_INPUT") recordUnderwritingMetric(metricContext, "underwriting_conflicting_inputs", 1, "count");
    if (result.failure?.code === "STALE_INPUT") recordUnderwritingMetric(metricContext, "underwriting_stale_inputs", 1, "count");
    if (result.failure?.code === "NON_CONVERGENT") recordUnderwritingMetric(metricContext, "underwriting_solver_nonconvergence", 1, "count");
  }
  if (result.validity === "INVALID") recordUnderwritingMetric(metricContext, "underwriting_invalid_runs", 1, "count");
  return persisted;
}

export async function getUnderwritingRun(ctx: PeMutationContext, runId: string): Promise<Record<string, unknown>> {
  assertPeUuid(runId, "runId");
  return peTransaction(ctx, async (_db, client) => {
    const row = (await client.query<StoredRunIntegrity & Record<string, unknown>>("SELECT * FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, runId])).rows[0];
    if (!row) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Underwriting Run was not found in the authenticated tenant");
    assertStoredRunIntegrity(ctx.auth.tenantId, row);
    return recordShape(row);
  }, { readOnly: true });
}

export async function getUnderwritingSensitivity(ctx: PeMutationContext, sensitivityId: string): Promise<Record<string, unknown>> {
  assertPeUuid(sensitivityId, "sensitivityId");
  return peTransaction(ctx, async (_db, client) => {
    const sensitivity = (await client.query(
      "SELECT * FROM finnor_os.underwriting_sensitivities WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, sensitivityId],
    )).rows[0];
    if (!sensitivity) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Underwriting Sensitivity was not found in the authenticated tenant");
    const cells = await client.query<StoredRunIntegrity & Record<string, unknown>>(
      `SELECT cell.row_index,cell.column_index,cell.coordinates,cell.run_id::text,
              run.id::text,run.status run_status,run.validity run_validity,run.input_hash,run.input_snapshot,run.result_hash,run.result
         FROM finnor_os.underwriting_sensitivity_cells cell
         JOIN finnor_os.underwriting_runs run ON run.tenant_id=cell.tenant_id AND run.id=cell.run_id
        WHERE cell.tenant_id=$1 AND cell.sensitivity_id=$2
        ORDER BY cell.row_index,cell.column_index`,
      [ctx.auth.tenantId, sensitivityId],
    );
    for (const cell of cells.rows) assertStoredRunIntegrity(ctx.auth.tenantId, cell);
    return { ...recordShape(sensitivity), cells: cells.rows.map(recordShape), complete: cells.rows.length === Number(sensitivity.cell_count) };
  }, { readOnly: true });
}

export async function getUnderwritingAffectedNodes(ctx: PeMutationContext, modelVersionId: string, nodeId: string): Promise<Record<string, unknown>> {
  assertPeUuid(modelVersionId, "modelVersionId");
  assertPeText(nodeId, "nodeId");
  return peTransaction(ctx, async (_db, client) => {
    const { row, compiled } = await loadModelVersion(client, ctx.auth.tenantId, modelVersionId);
    if (!compiled.nodeById[nodeId]) fail("MISSING_DEPENDENCY", "Affected-node source is not in the exact ModelVersion", { nodeId });
    return { modelVersionId: row.id, modelSemanticHash: compiled.semanticHash, sourceNodeId: nodeId, affectedNodeIds: affectedNodes(compiled, [nodeId]) };
  }, { readOnly: true });
}

export async function compareUnderwritingModelVersions(ctx: PeMutationContext, leftModelVersionId: string, rightModelVersionId: string): Promise<Record<string, unknown>> {
  assertPeUuid(leftModelVersionId, "leftModelVersionId");
  assertPeUuid(rightModelVersionId, "rightModelVersionId");
  return peTransaction(ctx, async (_db, client) => {
    const [left, right] = await Promise.all([
      loadModelVersion(client, ctx.auth.tenantId, leftModelVersionId),
      loadModelVersion(client, ctx.auth.tenantId, rightModelVersionId),
    ]);
    return {
      leftModelVersionId,
      rightModelVersionId,
      investmentCaseChanged: left.row.investment_case_id !== right.row.investment_case_id,
      ...diffModels(left.row.model_definition, right.row.model_definition),
    };
  }, { readOnly: true });
}

function recursiveDependencies(model: CompiledUnderwritingModel, nodeId: string): Set<string> {
  const visited = new Set<string>();
  const visit = (id: string) => {
    for (const dependency of model.dependencyGraph[id] ?? []) {
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      visit(dependency);
    }
  };
  visit(nodeId);
  return visited;
}

export async function compareUnderwritingRuns(ctx: PeMutationContext, leftRunId: string, rightRunId: string): Promise<Record<string, unknown>> {
  assertPeUuid(leftRunId, "leftRunId");
  assertPeUuid(rightRunId, "rightRunId");
  return peTransaction(ctx, async (_db, client) => {
    type ComparedRun = StoredRunIntegrity & { model_version_id: string; model_semantic_hash: string; scenario_id: string | null; engine_version: string };
    const rows = await client.query<ComparedRun>(
      `SELECT id::text,model_version_id::text,scenario_id::text,engine_version,model_semantic_hash,input_hash,input_snapshot,result_hash,result
         FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=ANY($2::uuid[])`,
      [ctx.auth.tenantId, [leftRunId, rightRunId]],
    );
    const left = rows.rows.find((row) => row.id === leftRunId);
    const right = rows.rows.find((row) => row.id === rightRunId);
    if (!left || !right) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "One or both Underwriting Runs were not found in the authenticated tenant");
    for (const run of [left, right]) assertStoredRunIntegrity(ctx.auth.tenantId, run);
    const changedInputs: Record<string, { left: unknown; right: unknown }> = {};
    for (const nodeId of [...new Set([...Object.keys(left.input_snapshot.values), ...Object.keys(right.input_snapshot.values)])].sort()) {
      const before = left.input_snapshot.values[nodeId] ?? null;
      const after = right.input_snapshot.values[nodeId] ?? null;
      if (canonicalSerialize(before) !== canonicalSerialize(after)) changedInputs[nodeId] = { left: before, right: after };
    }
    const resultDiff = diffRuns(left.result, right.result);
    let causalChangedInputsByOutput: Record<string, string[]> = {};
    if (left.model_version_id === right.model_version_id) {
      const { compiled } = await loadModelVersion(client, ctx.auth.tenantId, left.model_version_id);
      const changedIds = new Set(Object.keys(changedInputs));
      causalChangedInputsByOutput = Object.fromEntries(Object.keys(resultDiff.changedOutputs).map((outputId) => [
        outputId,
        [...recursiveDependencies(compiled, outputId)].filter((id) => changedIds.has(id)).sort(),
      ]));
    }
    const projectionBindings = await client.query<{ run_id: string; binding_ids: string[] }>(
      `SELECT run_id::text,binding_ids FROM finnor_os.underwriting_artifact_projections
        WHERE tenant_id=$1 AND run_id=ANY($2::uuid[]) AND status='SUCCEEDED' ORDER BY run_id,created_at,id`,
      [ctx.auth.tenantId, [leftRunId, rightRunId]],
    );
    const bindingIds = (runId: string) => [...new Set(projectionBindings.rows
      .filter((row) => row.run_id === runId)
      .flatMap((row) => row.binding_ids))].sort();
    const leftBindingIds = bindingIds(leftRunId);
    const rightBindingIds = bindingIds(rightRunId);
    return {
      leftRunId,
      rightRunId,
      modelVersionChanged: left.model_version_id !== right.model_version_id,
      modelSemanticHashChanged: left.model_semantic_hash !== right.model_semantic_hash,
      engineVersionChanged: left.engine_version !== right.engine_version,
      scenarioIdentityChanged: left.scenario_id !== right.scenario_id,
      artifactBindingChanged: canonicalSerialize(leftBindingIds) !== canonicalSerialize(rightBindingIds),
      artifactBindingIds: { left: leftBindingIds, right: rightBindingIds },
      changedInputs,
      causalAttribution: left.model_version_id === right.model_version_id ? "DEPENDENCY_GRAPH" : "MODEL_CHANGED",
      causalChangedInputsByOutput,
      ...resultDiff,
    };
  }, { readOnly: true });
}

export async function explainUnderwritingOutput(ctx: PeMutationContext, runId: string, outputNodeId: string) {
  assertPeUuid(runId, "runId");
  assertPeText(outputNodeId, "outputNodeId");
  return peTransaction(ctx, async (_db, client) => {
    const run = (await client.query<StoredRunIntegrity & { model_version_id: string }>(
      "SELECT id::text,model_version_id::text,input_hash,input_snapshot,result_hash,result FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, runId],
    )).rows[0];
    if (!run) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Underwriting Run was not found in the authenticated tenant");
    assertStoredRunIntegrity(ctx.auth.tenantId, run);
    const { compiled } = await loadModelVersion(client, ctx.auth.tenantId, run.model_version_id);
    return explainOutput(compiled, run.input_snapshot, run.result, outputNodeId);
  }, { readOnly: true });
}

export async function listUnderwritingWorkspace(ctx: PeMutationContext, investmentCaseId: string): Promise<Record<string, unknown>> {
  assertPeUuid(investmentCaseId, "investmentCaseId");
  return peTransaction(ctx, async (_db, client) => {
    const investmentCase = (await client.query(
      `SELECT id::text,deal_id::text,title,summary,state,version,created_at,updated_at
         FROM finnor_os.pe_investment_cases WHERE tenant_id=$1 AND id=$2`,
      [ctx.auth.tenantId, investmentCaseId],
    )).rows[0];
    if (!investmentCase) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "InvestmentCase was not found in the authenticated tenant");
    // node-postgres serializes one protocol stream per Client. Issuing Promise.all
    // queries on this transaction client is not parallelism; pg 9 rejects it. Keep
    // the workspace read deterministic and compatible by awaiting each bounded read.
    const models = await client.query("SELECT * FROM finnor_os.underwriting_models WHERE tenant_id=$1 AND investment_case_id=$2 ORDER BY created_at,id LIMIT 100", [ctx.auth.tenantId, investmentCaseId]);
    const versions = await client.query("SELECT id,model_id,version_key,semantic_hash,schema_version,financial_convention_version,minimum_engine_version,parent_version_id,created_by,created_at FROM finnor_os.underwriting_model_versions WHERE tenant_id=$1 AND investment_case_id=$2 ORDER BY created_at DESC,id LIMIT 200", [ctx.auth.tenantId, investmentCaseId]);
    const inputBindings = await client.query("SELECT model_version_id,input_node_id,source_kind,assumption_id,evidence_version_id,document_id,document_version_id,anchor_id,anchor_hash,value_path,value_selector,stale_after_days,created_at FROM finnor_os.underwriting_model_input_bindings WHERE tenant_id=$1 AND investment_case_id=$2 ORDER BY model_version_id,input_node_id LIMIT 10000", [ctx.auth.tenantId, investmentCaseId]);
    const scenarios = await client.query("SELECT * FROM finnor_os.underwriting_scenarios WHERE tenant_id=$1 AND investment_case_id=$2 ORDER BY created_at DESC,id LIMIT 200", [ctx.auth.tenantId, investmentCaseId]);
    const runs = await client.query("SELECT id,model_version_id,scenario_id,work_id,world_at,computed_at,engine_version,model_semantic_hash,input_hash,input_snapshot,result_hash,status,validity,failure_code,idempotency_key,created_by,result FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND investment_case_id=$2 ORDER BY computed_at DESC,id LIMIT 200", [ctx.auth.tenantId, investmentCaseId]);
    const sensitivities = await client.query("SELECT * FROM finnor_os.underwriting_sensitivities WHERE tenant_id=$1 AND investment_case_id=$2 ORDER BY created_at DESC,id LIMIT 100", [ctx.auth.tenantId, investmentCaseId]);
    const bindings = await client.query("SELECT * FROM finnor_os.underwriting_artifact_bindings WHERE tenant_id=$1 AND investment_case_id=$2 ORDER BY created_at DESC,id LIMIT 200", [ctx.auth.tenantId, investmentCaseId]);
    const projections = await client.query("SELECT * FROM finnor_os.underwriting_artifact_projections WHERE tenant_id=$1 AND investment_case_id=$2 ORDER BY created_at DESC,id LIMIT 200", [ctx.auth.tenantId, investmentCaseId]);
    return {
      investmentCase: recordShape(investmentCase),
      models: models.rows.map(recordShape), modelVersions: versions.rows.map(recordShape), modelInputBindings: inputBindings.rows.map(recordShape), scenarios: scenarios.rows.map(recordShape),
      runs: runs.rows.map(recordShape), sensitivities: sensitivities.rows.map(recordShape),
      artifactBindings: bindings.rows.map(recordShape), artifactProjections: projections.rows.map(recordShape),
      complete: true,
    };
  }, { readOnly: true });
}

export async function listInvestmentCasesForUnderwriting(ctx: PeMutationContext): Promise<Record<string, unknown>> {
  return peTransaction(ctx, async (_db, client) => {
    const rows = await client.query(
      `SELECT investment_case.id::text,investment_case.deal_id::text,investment_case.title,investment_case.summary,
              investment_case.state,investment_case.version,investment_case.updated_at,
              count(DISTINCT model.id)::integer model_count,count(DISTINCT run.id)::integer run_count,
              max(run.computed_at) latest_run_at
         FROM finnor_os.pe_investment_cases investment_case
         LEFT JOIN finnor_os.underwriting_models model ON model.tenant_id=investment_case.tenant_id AND model.investment_case_id=investment_case.id
         LEFT JOIN finnor_os.underwriting_runs run ON run.tenant_id=investment_case.tenant_id AND run.investment_case_id=investment_case.id
        WHERE investment_case.tenant_id=$1
        GROUP BY investment_case.id
        ORDER BY investment_case.updated_at DESC,investment_case.id
        LIMIT 200`,
      [ctx.auth.tenantId],
    );
    return { investmentCases: rows.rows.map(recordShape), complete: true };
  }, { readOnly: true });
}

export { UnderwritingError };
