import { randomUUID } from "node:crypto";
import {
  ArtifactError,
  applyArtifactPatch,
  createDraft,
  getArtifact,
  type ArtifactActor,
} from "@finnor/artifacts";
import { type SpreadsheetOperation } from "@finnor/spreadsheet-ir";
import {
  compareArtifactValue,
  decimal,
  fail,
  inputSnapshotHash,
  runResultHash,
  type ArtifactValueComparison,
  type ComparisonPolicy,
  type CompiledUnderwritingModel,
  type ModelValue,
  type UnderwritingInputSnapshot,
  type UnderwritingRunResult,
} from "@finnor/underwriting";
import { recordBusinessEvent } from "@finnor/data-platform";
import type { PeMutationContext } from "./types";
import { assertPeText, assertPeUuid, peProvenance, peTransaction, type PeClient } from "./repository";
import { recordUnderwritingMetric } from "./underwriting-telemetry";
import {
  boundUnderwritingCells,
  observedUnderwritingCell,
  selectedUnderwritingValue,
  type UnderwritingWorkbookIr as WorkbookIr,
} from "./underwriting-artifact-values";

interface BindingRow {
  id: string;
  investment_case_id: string;
  model_version_id: string;
  document_id: string;
  document_version_id: string;
  direction: "input" | "output";
  binding_mode: "read_only" | "write_and_compare" | "compare_only";
  model_node_id: string;
  anchor_id: string;
  anchor_hash: string;
  value_selector: string | null;
  comparison_policy: ComparisonPolicy | null;
  binding_version: number;
}

interface RunRow {
  id: string;
  investment_case_id: string;
  model_version_id: string;
  input_hash: string;
  input_snapshot: UnderwritingInputSnapshot;
  result_hash: string;
  result: UnderwritingRunResult;
}

function decimalArtifactValue(value: string | number | boolean | null): string | number | null {
  if (typeof value === "boolean") fail("ARTIFACT_VALUE_UNSUPPORTED", "A boolean SpreadsheetIR value cannot be compared with a decimal underwriting output");
  return value;
}

function actor(ctx: PeMutationContext): ArtifactActor {
  return {
    tenantId: ctx.auth.tenantId,
    userId: ctx.auth.userId,
    role: ctx.auth.role,
    ...(ctx.auth.employeeId ? { employeeId: ctx.auth.employeeId } : {}),
  };
}

async function loadCompiledModel(client: PeClient, tenantId: string, modelVersionId: string): Promise<CompiledUnderwritingModel> {
  const row = (await client.query<{ definition: import("@finnor/underwriting").UnderwritingModelIR; semantic_hash: string }>(
    "SELECT model_definition definition,semantic_hash FROM finnor_os.underwriting_model_versions WHERE tenant_id=$1 AND id=$2",
    [tenantId, modelVersionId],
  )).rows[0];
  if (!row) fail("MODEL_VERSION_NOT_FOUND", "Underwriting ModelVersion was not found in the authenticated tenant");
  const { compileUnderwritingModel } = await import("@finnor/underwriting");
  const compiled = compileUnderwritingModel(row.definition);
  if (compiled.semanticHash !== row.semantic_hash) fail("MODEL_SEMANTIC_HASH_MISMATCH", "Stored ModelVersion hash mismatch");
  return compiled;
}

export async function createUnderwritingArtifactBinding(ctx: PeMutationContext, input: {
  investmentCaseId: string;
  modelVersionId: string;
  documentId: string;
  documentVersionId: string;
  direction: "input" | "output";
  bindingMode: "read_only" | "write_and_compare" | "compare_only";
  modelNodeId: string;
  anchorId: string;
  anchorHash: string;
  valueSelector?: string;
  comparisonPolicy?: ComparisonPolicy;
  supersedesBindingId?: string;
}): Promise<Record<string, unknown>> {
  for (const [label, value] of Object.entries({ investmentCaseId: input.investmentCaseId, modelVersionId: input.modelVersionId, documentId: input.documentId, documentVersionId: input.documentVersionId })) assertPeUuid(value, label);
  if (input.supersedesBindingId) assertPeUuid(input.supersedesBindingId, "supersedesBindingId");
  assertPeText(input.modelNodeId, "modelNodeId");
  assertPeText(input.anchorId, "anchorId");
  const artifact = await getArtifact(actor(ctx), input.documentId, input.documentVersionId);
  const ir = artifact.ir as unknown as WorkbookIr;
  if (!['xlsx', 'xlsm'].includes(ir.kind)) fail("ARTIFACT_NOT_SPREADSHEET", "Underwriting artifact binding requires a spreadsheet DocumentVersion");
  return peTransaction(ctx, async (_db, client) => {
    const compiled = await loadCompiledModel(client, ctx.auth.tenantId, input.modelVersionId);
    const node = compiled.nodeById[input.modelNodeId];
    if (!node || (input.direction === "input" ? node.kind !== "input" : node.kind !== "output")) fail("ARTIFACT_VALUE_UNSUPPORTED", "Binding direction does not match the exact model node", { modelNodeId: input.modelNodeId });
    if (input.direction === "input" && input.bindingMode !== "read_only") fail("MODEL_SCHEMA_INVALID", "Input artifact bindings are read-only");
    if (input.direction === "output" && (!input.comparisonPolicy || input.bindingMode === "read_only")) fail("MODEL_SCHEMA_INVALID", "Output artifact binding requires an explicit comparison policy and output mode");
    boundUnderwritingCells(ir, { anchorId: input.anchorId, anchorHash: input.anchorHash, valueSelector: input.valueSelector }, node.shape, compiled.periods, { requireBoundHash: true, allowSeriesCellSelector: true });
    let bindingVersion = 1;
    if (input.supersedesBindingId) {
      const prior = (await client.query<{ binding_version: number }>("SELECT binding_version FROM finnor_os.underwriting_artifact_bindings WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, input.supersedesBindingId])).rows[0];
      if (!prior) fail("ARTIFACT_ANCHOR_CONFLICT", "Superseded artifact binding was not found");
      bindingVersion = prior.binding_version + 1;
    }
    const inserted = await client.query(
      `INSERT INTO finnor_os.underwriting_artifact_bindings(
         tenant_id,investment_case_id,model_version_id,document_id,document_version_id,direction,binding_mode,
         model_node_id,anchor_id,anchor_hash,value_selector,comparison_policy,binding_version,supersedes_binding_id,created_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15) RETURNING *`,
      [ctx.auth.tenantId, input.investmentCaseId, input.modelVersionId, input.documentId, input.documentVersionId,
        input.direction, input.bindingMode, input.modelNodeId, input.anchorId, input.anchorHash, input.valueSelector ?? null,
        input.comparisonPolicy ? JSON.stringify(input.comparisonPolicy) : null, bindingVersion, input.supersedesBindingId ?? null, peProvenance(ctx).createdBy],
    );
    return inserted.rows[0] as Record<string, unknown>;
  });
}

async function loadRunAndBindings(client: PeClient, tenantId: string, runId: string, documentId: string, documentVersionId: string): Promise<{ run: RunRow; bindings: BindingRow[]; compiled: CompiledUnderwritingModel }> {
  const run = (await client.query<RunRow>(
    "SELECT id::text,investment_case_id::text,model_version_id::text,input_hash,input_snapshot,result_hash,result FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2",
    [tenantId, runId],
  )).rows[0];
  if (!run) fail("MODEL_VERSION_NOT_FOUND", "Underwriting Run was not found in the authenticated tenant");
  if (run.input_snapshot.semanticHash !== run.input_hash || inputSnapshotHash(run.input_snapshot) !== run.input_hash) {
    recordUnderwritingMetric({ tenantId, runId }, "underwriting_result_hash_mismatches", 1, "count");
    fail("INPUT_SEMANTIC_HASH_MISMATCH", "Artifact operation refused a Run with a corrupted InputSnapshot hash", { runId });
  }
  if (run.result.resultSemanticHash !== run.result_hash || runResultHash(run.result) !== run.result_hash) {
    recordUnderwritingMetric({ tenantId, runId }, "underwriting_result_hash_mismatches", 1, "count");
    fail("RESULT_SEMANTIC_HASH_MISMATCH", "Artifact operation refused a Run with a corrupted result hash", { runId });
  }
  const bindings = await client.query<BindingRow>(
    `SELECT id::text,investment_case_id::text,model_version_id::text,document_id::text,document_version_id::text,direction,
            binding_mode,model_node_id,anchor_id,anchor_hash,value_selector,comparison_policy,binding_version
       FROM finnor_os.underwriting_artifact_bindings
      WHERE tenant_id=$1 AND investment_case_id=$2 AND model_version_id=$3 AND document_id=$4 AND document_version_id=$5
        AND direction='output' AND NOT EXISTS(
          SELECT 1 FROM finnor_os.underwriting_artifact_bindings newer
           WHERE newer.tenant_id=underwriting_artifact_bindings.tenant_id
             AND newer.supersedes_binding_id=underwriting_artifact_bindings.id
        ) ORDER BY model_node_id,anchor_id`,
    [tenantId, run.investment_case_id, run.model_version_id, documentId, documentVersionId],
  );
  if (!bindings.rows.length) fail("ARTIFACT_ANCHOR_CONFLICT", "No exact output bindings exist for this Run and DocumentVersion");
  return { run, bindings: bindings.rows, compiled: await loadCompiledModel(client, tenantId, run.model_version_id) };
}

export async function compareUnderwritingRunToArtifact(ctx: PeMutationContext, input: {
  runId: string;
  documentId: string;
  documentVersionId: string;
}): Promise<{ runId: string; documentId: string; documentVersionId: string; status: "MATCH" | "MISMATCH" | "INCOMPLETE"; comparisons: Array<Record<string, unknown>> }> {
  for (const [label, value] of Object.entries(input)) assertPeUuid(value, label);
  const loaded = await peTransaction(ctx, async (_db, client) => loadRunAndBindings(client, ctx.auth.tenantId, input.runId, input.documentId, input.documentVersionId), { readOnly: true });
  const artifact = await getArtifact(actor(ctx), input.documentId, input.documentVersionId);
  const ir = artifact.ir as unknown as WorkbookIr;
  const comparisons: Array<Record<string, unknown>> = [];
  for (const binding of loaded.bindings) {
    const output = loaded.run.result.outputs[binding.model_node_id];
    if (!output || output.valueType !== "decimal") fail("ARTIFACT_VALUE_UNSUPPORTED", "Only deterministic decimal Run outputs can be reconciled with Excel", { modelNodeId: binding.model_node_id });
    const cells = boundUnderwritingCells(ir, { anchorId: binding.anchor_id, anchorHash: binding.anchor_hash, valueSelector: binding.value_selector }, output.shape, loaded.compiled.periods, { requireBoundHash: true, allowSeriesCellSelector: true });
    for (const cell of cells) {
      const observed = observedUnderwritingCell(cell.node, artifact.calculationStatus);
      const comparison = compareArtifactValue({
        modelValue: decimal(selectedUnderwritingValue(output.value, output.shape, cell.selector)),
        artifactValue: decimalArtifactValue(observed.value),
        calculationStatus: observed.calculationStatus,
        policy: binding.comparison_policy!,
      });
      comparisons.push({ bindingId: binding.id, modelNodeId: binding.model_node_id, anchorId: cell.node.id, selector: cell.selector, ...comparison });
    }
  }
  const mismatch = comparisons.some((item) => item.status === "MISMATCH");
  const incomplete = comparisons.some((item) => !["MATCH", "MISMATCH"].includes(String(item.status)));
  if (mismatch) recordUnderwritingMetric({ tenantId: ctx.auth.tenantId, investmentCaseId: loaded.run.investment_case_id, modelVersionId: loaded.run.model_version_id, runId: input.runId }, "underwriting_artifact_mismatches", 1, "count");
  if (comparisons.some((item) => item.status === "EXCEL_STALE")) recordUnderwritingMetric({ tenantId: ctx.auth.tenantId, runId: input.runId }, "underwriting_excel_stale_comparisons", 1, "count");
  return { runId: input.runId, documentId: input.documentId, documentVersionId: input.documentVersionId, status: incomplete ? "INCOMPLETE" : mismatch ? "MISMATCH" : "MATCH", comparisons };
}

function projectionFailure(error: unknown): { status: "FAILED" | "VERSION_CONFLICT" | "ANCHOR_CONFLICT"; code: string } {
  const code = error instanceof ArtifactError ? error.code : error instanceof Error ? error.message : "ARTIFACT_PROJECTION_FAILED";
  if (/STALE_BRANCH_HEAD|VERSION|DOCUMENT_VERSION/.test(code)) return { status: "VERSION_CONFLICT", code };
  if (/STALE_ANCHOR|ANCHOR|DEFINED_NAME|RANGE/.test(code)) return { status: "ANCHOR_CONFLICT", code };
  return { status: "FAILED", code: code.slice(0, 240) };
}

export async function projectUnderwritingOutputs(ctx: PeMutationContext, input: {
  runId: string;
  documentId: string;
  baseVersionId: string;
  idempotencyKey: string;
}): Promise<Record<string, unknown>> {
  assertPeUuid(input.runId, "runId");
  assertPeUuid(input.documentId, "documentId");
  assertPeUuid(input.baseVersionId, "baseVersionId");
  assertPeText(input.idempotencyKey, "projection idempotencyKey");
  const existing = await peTransaction(ctx, async (_db, client) => (await client.query(
    "SELECT * FROM finnor_os.underwriting_artifact_projections WHERE tenant_id=$1 AND idempotency_key=$2",
    [ctx.auth.tenantId, input.idempotencyKey],
  )).rows[0] as Record<string, unknown> | undefined, { readOnly: true });
  if (existing) {
    if (existing.run_id !== input.runId || existing.document_id !== input.documentId || existing.base_version_id !== input.baseVersionId) fail("IDEMPOTENCY_CONFLICT", "Projection idempotency key is bound to a different request");
    return { ...existing, replayed: true };
  }
  const loaded = await peTransaction(ctx, async (_db, client) => loadRunAndBindings(client, ctx.auth.tenantId, input.runId, input.documentId, input.baseVersionId), { readOnly: true });
  const writeBindings = loaded.bindings.filter((binding) => binding.binding_mode === "write_and_compare");
  if (!writeBindings.length) fail("ARTIFACT_VALUE_UNSUPPORTED", "No write-and-compare output binding exists for this exact DocumentVersion");
  const artifact = await getArtifact(actor(ctx), input.documentId, input.baseVersionId);
  const ir = artifact.ir as unknown as WorkbookIr;
  const operations: SpreadsheetOperation[] = [];
  for (const binding of writeBindings) {
    const output = loaded.run.result.outputs[binding.model_node_id];
    if (!output || output.valueType !== "decimal") fail("ARTIFACT_VALUE_UNSUPPORTED", "Projection requires a deterministic decimal OutputNode", { modelNodeId: binding.model_node_id });
    for (const cell of boundUnderwritingCells(ir, { anchorId: binding.anchor_id, anchorHash: binding.anchor_hash, valueSelector: binding.value_selector }, output.shape, loaded.compiled.periods, { requireBoundHash: true, allowSeriesCellSelector: true })) {
      const exact = decimal(selectedUnderwritingValue(output.value, output.shape, cell.selector));
      operations.push({ type: "set_number", sheetId: cell.sheetId, address: cell.address, value: exact, expectedHash: cell.node.hash });
    }
  }
  let resultVersionId: string | null = null;
  let artifactOperationId: string | null = null;
  try {
    const recovery = await peTransaction(ctx, async (_db, client) => (await client.query<{ id: string; result_version_id: string }>(
      `SELECT id::text,result_version_id::text FROM finnor_os.artifact_operations
        WHERE tenant_id=$1 AND document_id=$2 AND base_version_id=$3 AND status='succeeded' AND patch->'operations'=$4::jsonb
        ORDER BY created_at DESC LIMIT 1`,
      [ctx.auth.tenantId, input.documentId, input.baseVersionId, JSON.stringify(operations)],
    )).rows[0], { readOnly: true });
    if (recovery) {
      resultVersionId = recovery.result_version_id;
      artifactOperationId = recovery.id;
    } else {
      const draft = await createDraft(actor(ctx), input.documentId, input.baseVersionId);
      const patched = await applyArtifactPatch(actor(ctx), input.documentId, { baseVersionId: input.baseVersionId, draftKey: draft.draftKey, operations });
      resultVersionId = "version" in patched ? String(patched.version.id) : String(patched.versionId);
      artifactOperationId = await peTransaction(ctx, async (_db, client) => (await client.query<{ id: string }>(
        "SELECT id::text FROM finnor_os.artifact_operations WHERE tenant_id=$1 AND document_id=$2 AND result_version_id=$3",
        [ctx.auth.tenantId, input.documentId, resultVersionId],
      )).rows[0]?.id ?? null, { readOnly: true });
    }
    const resultArtifact = await getArtifact(actor(ctx), input.documentId, resultVersionId);
    const resultIr = resultArtifact.ir as unknown as WorkbookIr;
    const comparisons: Array<Record<string, unknown>> = [];
    for (const binding of writeBindings) {
      const output = loaded.run.result.outputs[binding.model_node_id]!;
      for (const cell of boundUnderwritingCells(resultIr, { anchorId: binding.anchor_id, anchorHash: binding.anchor_hash, valueSelector: binding.value_selector }, output.shape, loaded.compiled.periods, { requireBoundHash: false, allowSeriesCellSelector: true })) {
        const observed = observedUnderwritingCell(cell.node, resultArtifact.calculationStatus);
        const comparison: ArtifactValueComparison = compareArtifactValue({
          modelValue: decimal(selectedUnderwritingValue(output.value, output.shape, cell.selector)), artifactValue: decimalArtifactValue(observed.value),
          calculationStatus: observed.calculationStatus, policy: binding.comparison_policy!,
        });
        comparisons.push({ bindingId: binding.id, modelNodeId: binding.model_node_id, anchorId: cell.node.id, selector: cell.selector, ...comparison });
      }
    }
    const inserted = await peTransaction(ctx, async (db, client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4262))", [`${ctx.auth.tenantId}:${input.idempotencyKey}`]);
      const replay = (await client.query("SELECT * FROM finnor_os.underwriting_artifact_projections WHERE tenant_id=$1 AND idempotency_key=$2", [ctx.auth.tenantId, input.idempotencyKey])).rows[0];
      if (replay) return { ...replay, replayed: true };
      const row = (await client.query(
        `INSERT INTO finnor_os.underwriting_artifact_projections(
           tenant_id,investment_case_id,run_id,document_id,base_version_id,result_version_id,artifact_operation_id,
           binding_ids,status,comparisons,idempotency_key,failure_code,created_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'SUCCEEDED',$9::jsonb,$10,NULL,$11) RETURNING *`,
        [ctx.auth.tenantId, loaded.run.investment_case_id, input.runId, input.documentId, input.baseVersionId,
          resultVersionId, artifactOperationId, JSON.stringify(writeBindings.map((binding) => binding.id)), JSON.stringify(comparisons),
          input.idempotencyKey, peProvenance(ctx).createdBy],
      )).rows[0];
      await recordBusinessEvent(db, {
        tenantId: ctx.auth.tenantId, entityType: "underwriting_artifact_projection", entityId: String(row.id),
        eventType: "underwriting_projection_created",
        payload: { investmentCaseId: loaded.run.investment_case_id, modelVersionId: loaded.run.model_version_id, runId: input.runId, projectionId: row.id, artifactVersionId: resultVersionId, status: "SUCCEEDED" },
        source: "@finnor/private-equity",
      });
      if (comparisons.some((comparison) => comparison.status === "MISMATCH")) await recordBusinessEvent(db, {
        tenantId: ctx.auth.tenantId, entityType: "underwriting_artifact_projection", entityId: String(row.id),
        eventType: "underwriting_artifact_mismatch",
        payload: { investmentCaseId: loaded.run.investment_case_id, modelVersionId: loaded.run.model_version_id, runId: input.runId, projectionId: row.id, artifactVersionId: resultVersionId, status: "MISMATCH" },
        source: "@finnor/private-equity",
      });
      return { ...row, replayed: false };
    });
    recordUnderwritingMetric({ tenantId: ctx.auth.tenantId, investmentCaseId: loaded.run.investment_case_id, modelVersionId: loaded.run.model_version_id, runId: input.runId }, "underwriting_artifact_projections", 1, "count");
    return inserted;
  } catch (error) {
    const failure = projectionFailure(error);
    return peTransaction(ctx, async (_db, client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4262))", [`${ctx.auth.tenantId}:${input.idempotencyKey}`]);
      const replay = (await client.query("SELECT * FROM finnor_os.underwriting_artifact_projections WHERE tenant_id=$1 AND idempotency_key=$2", [ctx.auth.tenantId, input.idempotencyKey])).rows[0];
      if (replay) return { ...replay, replayed: true };
      const row = (await client.query(
        `INSERT INTO finnor_os.underwriting_artifact_projections(
           tenant_id,investment_case_id,run_id,document_id,base_version_id,result_version_id,artifact_operation_id,
           binding_ids,status,comparisons,idempotency_key,failure_code,created_by
         ) VALUES($1,$2,$3,$4,$5,NULL,NULL,$6::jsonb,$7,'[]'::jsonb,$8,$9,$10) RETURNING *`,
        [ctx.auth.tenantId, loaded.run.investment_case_id, input.runId, input.documentId, input.baseVersionId,
          JSON.stringify(writeBindings.map((binding) => binding.id)), failure.status, input.idempotencyKey, failure.code, peProvenance(ctx).createdBy],
      )).rows[0];
      return { ...row, replayed: false };
    });
  }
}
