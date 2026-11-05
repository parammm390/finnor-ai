import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { OfficePackage } from "@finnor/ooxml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, configureTenantVertical, receiveWork } from "@finnor/db";
import { appendEvidenceVersion, createEvidenceSource } from "@finnor/memory";
import {
  applyArtifactPatch,
  bindArtifact,
  createDraft,
  ingestArtifact,
  type ArtifactActor,
} from "@finnor/artifacts";
import {
  activateInvestmentCase,
  attachCanonicalDocument,
  attachCanonicalEvidence,
  attachWorkToDealGraph,
  compareUnderwritingModelVersions,
  compareUnderwritingRunToArtifact,
  compareUnderwritingRuns,
  createAssumption,
  createDeal,
  createInvestmentCase,
  createUnderwritingArtifactBinding,
  createUnderwritingModel,
  createUnderwritingModelVersion,
  createUnderwritingRun,
  createUnderwritingScenario,
  createUnderwritingSensitivity,
  explainUnderwritingOutput,
  getUnderwritingRun,
  getUnderwritingSensitivity,
  listUnderwritingWorkspace,
  persistPreparedUnderwritingRun,
  prepareUnderwritingRun,
  projectUnderwritingOutputs,
  reviseAssumption,
  type ExplicitUnderwritingInput,
  type PeMutationContext,
} from "@finnor/private-equity";
import { createDefaultPluginRegistry, FinnorOrchestrator } from "@finnor/orchestration";
import { configureAgentProfile } from "../../packages/orchestration/src/workforce-runtime";
import {
  createStandardLboInputSnapshot,
  createStandardLboModel,
  decimal,
  executeUnderwritingModel,
  mul,
  type StandardLboInputValues,
  type StandardLboModelConfig,
  type UnderwritingRunResult,
} from "@finnor/underwriting";
import { migrate } from "../../packages/db/migrate";
import {
  GOLDEN_UNDERWRITING_CASES,
  type GoldenLboCase,
} from "../underwriting-corpus/golden-cases";
import { driveDurableAction } from "./helpers/durable-action";
import { browserHttpFixture } from "../../scripts/v2/browser-http-fixture.mts";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");
const CORPUS = resolve(import.meta.dirname, "../artifact-corpus/lbo-style.xlsx");
const committeeSources = process.env.FINNOR_IC_MEMO_SOURCE_DIR;
const plannerMemo = process.env.FINNOR_IC_MEMO_PLANNER === "1";
const P4_TABLES = [
  "underwriting_models",
  "underwriting_model_versions",
  "underwriting_model_input_bindings",
  "underwriting_scenarios",
  "underwriting_runs",
  "underwriting_sensitivities",
  "underwriting_sensitivity_cells",
  "underwriting_artifact_bindings",
  "underwriting_artifact_projections",
] as const;

interface PersistedRun {
  id: string;
  replayed: boolean;
  result: UnderwritingRunResult;
  inputSnapshot: import("@finnor/underwriting").UnderwritingInputSnapshot;
}

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

async function tenantQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  tenantId: string,
  userId: string,
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const client = new pg.Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path=finnor_os,public");
    await client.query(
      "SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)",
      [tenantId, userId],
    );
    const result = await client.query<T>(text, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function expectRejectedQuery(action: () => Promise<unknown>, pattern: RegExp, label: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(String((error as Error).message), label).toMatch(pattern);
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

function iso(value: Date): string {
  return value.toISOString();
}

function idOf(value: Record<string, unknown>, key = "id"): string {
  const id = value[key];
  if (typeof id !== "string") throw new Error(`${key} was not returned as an ID`);
  return id;
}

function firstGoldenLbo(): GoldenLboCase {
  const value = GOLDEN_UNDERWRITING_CASES.find((item): item is GoldenLboCase => item.kind === "lbo");
  if (!value) throw new Error("The independent golden LBO corpus is empty");
  return structuredClone(value);
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

const available = await canConnect(SUPER_URL);

describe.skipIf(!available)("P4 deterministic PE underwriting persistence and P3 integration", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const ownerA = randomUUID();
  const ownerB = randomUUID();
  const targetA = committeeSources ? "11111111-1111-4111-8111-111111111111" : randomUUID();
  const targetB = randomUUID();
  const ctxA: PeMutationContext = {
    auth: { tenantId: tenantA, userId: ownerA, employeeId: ownerA, role: "owner" },
    provenance: { sourceSystem: "integration:p4-underwriting", createdBy: ownerA },
  };
  const ctxB: PeMutationContext = {
    auth: { tenantId: tenantB, userId: ownerB, employeeId: ownerB, role: "owner" },
    provenance: { sourceSystem: "integration:p4-underwriting", createdBy: ownerB },
  };
  const actorA: ArtifactActor = { tenantId: tenantA, userId: ownerA, employeeId: ownerA, role: "owner" };

  let admin: pg.Client;
  let dealA = "";
  let investmentCaseA = "";
  let investmentCaseB = "";
  let assumptionId = "";
  let replacementAssumptionId = "";
  let evidenceVersionId = "";
  let documentId = "";
  let baseDocumentVersionId = "";
  let projectedDocumentVersionId = "";
  let modelId = "";
  let modelVersionId = "";
  let scenarioId = "";
  let sensitivityId = "";
  let outputBindingId = "";
  let projectionId = "";
  let preSourcesAt = "";
  let knownWorldAt = "";
  let currentWorldAt = "";
  let config: StandardLboModelConfig;
  let values: StandardLboInputValues;
  let explicitInputs: Record<string, ExplicitUnderwritingInput>;
  let baseRun: PersistedRun;
  let noHindsightRun: PersistedRun;
  let scenarioRun: PersistedRun;
  let historicalReplay: PersistedRun;
  let currentRun: PersistedRun;
  let baseReplay: PersistedRun;
  let sensitivity: Record<string, unknown>;
  let comparisonBeforeProjection: Awaited<ReturnType<typeof compareUnderwritingRunToArtifact>>;
  let projection: Record<string, unknown>;
  let projectionReplay: Record<string, unknown>;
  let versionCountBeforeRecoveredProjection = 0;
  let versionCountAfterRecoveredProjection = 0;
  let assumptionHistoryBeforeRevision = 0;
  let runServiceLatencyMs = 0;
  let artifactProjectionLatencyMs = 0;

  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await migrate(SUPER_URL);
    admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query(
      `INSERT INTO finnor_os.tenants(id,client_key,name) VALUES
       ($1,$2,'P4 underwriting project A'),($3,$4,'P4 underwriting project B')`,
      [tenantA, `p4-underwriting-a-${randomUUID()}`, tenantB, `p4-underwriting-b-${randomUUID()}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES
       ($1,$2,$3,'owner','active','P4 Owner A'),($4,$5,$6,'owner','active','P4 Owner B')`,
      [ownerA, tenantA, `p4-owner-a-${randomUUID()}@test.invalid`, ownerB, tenantB, `p4-owner-b-${randomUUID()}@test.invalid`],
    );
    await admin.query(
      `INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES
       ($1,$2,$3,'P4 Target A','other'),($4,$5,$6,'P4 Target B','other')`,
      [targetA, tenantA, `p4-target-a-${randomUUID()}`, targetB, tenantB, `p4-target-b-${randomUUID()}`],
    );

    process.env.DATABASE_URL = APP_URL;
    await closePool();
    await configureTenantVertical({ tenantId: tenantA, verticalKey: "private_equity", expectedVersion: 0, createdBy: ownerA, sourceSystem: "integration:p4-underwriting" });
    await configureTenantVertical({ tenantId: tenantB, verticalKey: "private_equity", expectedVersion: 0, createdBy: ownerB, sourceSystem: "integration:p4-underwriting" });

    const createdDealA = await createDeal(ctxA, {
      targetOrganizationId: targetA,
      name: "P4 deterministic LBO",
      dealLeadEmployeeId: ownerA,
      signedLoiAt: new Date(Date.now() - 86_400_000),
      targetClosingAt: new Date(Date.now() + 30 * 86_400_000),
    });
    dealA = idOf(createdDealA.row as Record<string, unknown>);
    investmentCaseA = idOf((await createInvestmentCase(ctxA, { dealId: dealA, title: "P4 base investment case" })).row as Record<string, unknown>);

    const createdDealB = await createDeal(ctxB, {
      targetOrganizationId: targetB,
      name: "P4 tenant-isolation LBO",
      dealLeadEmployeeId: ownerB,
      signedLoiAt: new Date(Date.now() - 86_400_000),
      targetClosingAt: new Date(Date.now() + 30 * 86_400_000),
    });
    investmentCaseB = idOf((await createInvestmentCase(ctxB, {
      dealId: idOf(createdDealB.row as Record<string, unknown>),
      title: "P4 foreign investment case",
    })).row as Record<string, unknown>);

    await admin.query("SELECT pg_sleep(0.01)");
    preSourcesAt = iso((await admin.query<{ at: Date }>("SELECT clock_timestamp() at")).rows[0]!.at);
    await admin.query("SELECT pg_sleep(0.01)");

    const artifact = await ingestArtifact(actorA, {
      title: "P4 mapped LBO.xlsx",
      bytes: readFileSync(CORPUS),
      origin: "manual_upload",
      sourceSystem: "integration:p4-underwriting",
    });
    documentId = artifact.documentId;
    baseDocumentVersionId = String(artifact.version.id);
    const artifactInput = artifact.ir.nodes.find((node) => node.id === "cell:2!D10");
    const artifactOutput = artifact.ir.nodes.find((node) => node.id === "cell:2!D5");
    if (!artifactInput || !artifactOutput) throw new Error("P4 fixture is missing its exact SpreadsheetIR anchors");

    const evidenceSource = await createEvidenceSource(tenantA, {
      sourceKey: `p4-exit-adjustments-${randomUUID()}`,
      sourceType: "underwriting_fixture",
      title: "P4 exact exit-adjustment evidence",
    });
    const evidence = await appendEvidenceVersion(tenantA, evidenceSource.id, {
      content: "The independently observed exit adjustment is exactly zero.",
      snapshot: { exit: { adjustments: "0" } },
      asOf: new Date(),
      retrievedAt: new Date(),
    });
    evidenceVersionId = evidence.versionId;

    const assumption = await createAssumption(ctxA, {
      dealId: dealA,
      investmentCaseId: investmentCaseA,
      assumptionKey: "exit_multiple",
      statement: "Base exit multiple",
      valueType: "number",
      value: 5,
      unit: "multiple",
      materiality: "critical",
    });
    assumptionId = idOf(assumption.row as Record<string, unknown>);
    await attachCanonicalEvidence(ctxA, {
      dealId: dealA,
      entity: { entityType: "pe_assumption", entityId: assumptionId },
      evidenceSourceId: evidenceSource.id,
      evidenceVersionId,
      relationship: "supports",
    });

    const fixture = firstGoldenLbo();
    config = fixture.config;
    config.modelVersion = "integration-p4-v1";
    config.inputBindings = {
      "entry.enterprise_value": {
        kind: "artifact_anchor",
        documentId,
        documentVersionId: baseDocumentVersionId,
        anchorId: artifactInput.id,
        anchorHash: artifactInput.hash,
      },
      "exit.multiple": { kind: "p1_assumption", assumptionId },
      "exit.adjustments": {
        kind: "evidence_version",
        evidenceVersionId,
        valuePath: "exit.adjustments",
      },
    };
    values = fixture.inputs;
    values.investmentCaseId = investmentCaseA;

    const logicalModel = await createUnderwritingModel(ctxA, {
      investmentCaseId: investmentCaseA,
      modelKey: "standard_lbo_v1",
      name: "P4 standard LBO v1",
    });
    modelId = idOf(logicalModel);
    const modelVersion = await createUnderwritingModelVersion(ctxA, {
      modelId,
      definition: createStandardLboModel(config),
    });
    modelVersionId = idOf(modelVersion);

    await admin.query("SELECT pg_sleep(0.01)");
    knownWorldAt = iso((await admin.query<{ at: Date }>("SELECT clock_timestamp() at")).rows[0]!.at);
    values.worldAt = knownWorldAt;
    explicitInputs = fixtureExplicitInputs(config, values, new Set([
      "entry.enterprise_value", "exit.multiple", "exit.adjustments",
    ]));

    const runStarted = performance.now();
    baseRun = await createUnderwritingRun(ctxA, {
      investmentCaseId: investmentCaseA,
      modelVersionId,
      worldAt: knownWorldAt,
      idempotencyKey: `p4-base-${randomUUID()}`,
      explicitInputs,
    }) as PersistedRun;
    runServiceLatencyMs = performance.now() - runStarted;
    noHindsightRun = await createUnderwritingRun(ctxA, {
      investmentCaseId: investmentCaseA,
      modelVersionId,
      worldAt: preSourcesAt,
      idempotencyKey: `p4-no-hindsight-${randomUUID()}`,
      explicitInputs,
    }) as PersistedRun;

    const scenario = await createUnderwritingScenario(ctxA, {
      investmentCaseId: investmentCaseA,
      modelVersionId,
      scenario: {
        schemaVersion: "underwriting-scenario.v1",
        name: "P4 downside",
        overrides: [{ nodeId: "exit.multiple", value: decimal("4") }],
      },
    });
    scenarioId = idOf(scenario);
    scenarioRun = await createUnderwritingRun(ctxA, {
      investmentCaseId: investmentCaseA,
      modelVersionId,
      scenarioId,
      baseRunId: baseRun.id,
      worldAt: knownWorldAt,
      idempotencyKey: `p4-scenario-${randomUUID()}`,
    }) as PersistedRun;

    sensitivity = await createUnderwritingSensitivity(ctxA, {
      baseRunId: baseRun.id,
      idempotencyKey: `p4-sensitivity-${randomUUID()}`,
      definition: {
        schemaVersion: "underwriting-sensitivity.v1",
        name: "P4 exit-multiple sensitivity",
        rowAxis: { nodeId: "exit.multiple", values: [decimal("4"), decimal("5"), decimal("6")] },
        outputNodeIds: ["gross_sponsor_moic", "gross_sponsor_xirr"],
      },
    });
    sensitivityId = idOf(sensitivity);

    const outputBinding = await createUnderwritingArtifactBinding(ctxA, {
      investmentCaseId: investmentCaseA,
      modelVersionId,
      documentId,
      documentVersionId: baseDocumentVersionId,
      direction: "output",
      bindingMode: "write_and_compare",
      modelNodeId: "output.transaction.entry_enterprise_value",
      anchorId: artifactOutput.id,
      anchorHash: artifactOutput.hash,
      comparisonPolicy: { mode: "EXACT_DECIMAL" },
    });
    outputBindingId = idOf(outputBinding);
    comparisonBeforeProjection = await compareUnderwritingRunToArtifact(ctxA, {
      runId: baseRun.id,
      documentId,
      documentVersionId: baseDocumentVersionId,
    });

    const expectedValue = decimal(String(baseRun.result.outputs["output.transaction.entry_enterprise_value"]!.value));
    const projectionStarted = performance.now();
    const draft = await createDraft(actorA, documentId, baseDocumentVersionId);
    const patched = await applyArtifactPatch(actorA, documentId, {
      baseVersionId: baseDocumentVersionId,
      draftKey: draft.draftKey,
      operations: [{
        type: "set_number",
        sheetId: "2",
        address: "D5",
        value: expectedValue,
        expectedHash: artifactOutput.hash,
      }],
    });
    projectedDocumentVersionId = "version" in patched ? String(patched.version.id) : String(patched.versionId);
    versionCountBeforeRecoveredProjection = (await admin.query<{ count: number }>(
      "SELECT count(*)::int count FROM finnor_os.document_versions WHERE tenant_id=$1 AND document_id=$2",
      [tenantA, documentId],
    )).rows[0]!.count;
    projection = await projectUnderwritingOutputs(ctxA, {
      runId: baseRun.id,
      documentId,
      baseVersionId: baseDocumentVersionId,
      idempotencyKey: `p4-projection-${randomUUID()}`,
    });
    artifactProjectionLatencyMs = performance.now() - projectionStarted;
    projectionId = idOf(projection);
    versionCountAfterRecoveredProjection = (await admin.query<{ count: number }>(
      "SELECT count(*)::int count FROM finnor_os.document_versions WHERE tenant_id=$1 AND document_id=$2",
      [tenantA, documentId],
    )).rows[0]!.count;
    projectionReplay = await projectUnderwritingOutputs(ctxA, {
      runId: baseRun.id,
      documentId,
      baseVersionId: baseDocumentVersionId,
      idempotencyKey: String(projection.idempotency_key),
    });

    assumptionHistoryBeforeRevision = (await admin.query<{ count: number }>(
      "SELECT count(*)::int count FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND entity_type='pe_assumption' AND entity_id=$2",
      [tenantA, assumptionId],
    )).rows[0]!.count;
    await admin.query("SELECT pg_sleep(0.01)");
    replacementAssumptionId = randomUUID();
    await reviseAssumption(ctxA, {
      assumptionId,
      expectedVersion: 1,
      replacement: {
        id: replacementAssumptionId,
        statement: "Revised current exit multiple",
        valueType: "number",
        value: 6,
        unit: "multiple",
        materiality: "critical",
      },
    });
    await admin.query("SELECT pg_sleep(0.01)");
    currentWorldAt = iso((await admin.query<{ at: Date }>("SELECT clock_timestamp() at")).rows[0]!.at);
    historicalReplay = await createUnderwritingRun(ctxA, {
      investmentCaseId: investmentCaseA,
      modelVersionId,
      worldAt: knownWorldAt,
      idempotencyKey: `p4-historical-replay-${randomUUID()}`,
      explicitInputs,
    }) as PersistedRun;
    currentRun = await createUnderwritingRun(ctxA, {
      investmentCaseId: investmentCaseA,
      modelVersionId,
      worldAt: currentWorldAt,
      idempotencyKey: `p4-current-old-binding-${randomUUID()}`,
      explicitInputs,
    }) as PersistedRun;
    baseReplay = await createUnderwritingRun(ctxA, {
      investmentCaseId: investmentCaseA,
      modelVersionId,
      worldAt: knownWorldAt,
      idempotencyKey: String((await admin.query<{ key: string }>(
        "SELECT idempotency_key key FROM finnor_os.underwriting_runs WHERE id=$1",
        [baseRun.id],
      )).rows[0]!.key),
      explicitInputs,
    }) as PersistedRun;
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await admin?.end();
    process.env.DATABASE_URL = SUPER_URL;
  });

  it("keeps P1/Core/P3 canonical ownership while persisting exact P4 identities", async () => {
    const owners = await admin.query<{ entity_type: string; source_table: string; writable_owner: string }>(
      `SELECT entity_type,source_table,writable_owner FROM finnor_os.canonical_truth_registry
       WHERE entity_type IN ('pe_investment_case','pe_assumption','document','evidence') ORDER BY entity_type`,
    );
    expect(owners.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity_type: "pe_assumption", writable_owner: "@finnor/private-equity" }),
      expect.objectContaining({ entity_type: "pe_investment_case", writable_owner: "@finnor/private-equity" }),
    ]));
    expect((await admin.query(
      "SELECT count(*)::int count FROM finnor_os.canonical_truth_registry WHERE entity_type LIKE 'underwriting%'",
    )).rows[0]?.count).toBe(0);
    const row = (await admin.query(
      `SELECT model.investment_case_id::text,version.model_id::text,version.semantic_hash,
              run.model_semantic_hash,run.input_hash,run.result_hash,run.engine_version,run.status,run.validity
       FROM finnor_os.underwriting_models model
       JOIN finnor_os.underwriting_model_versions version ON version.tenant_id=model.tenant_id AND version.model_id=model.id
       JOIN finnor_os.underwriting_runs run ON run.tenant_id=version.tenant_id AND run.model_version_id=version.id
       WHERE run.id=$1`,
      [baseRun.id],
    )).rows[0];
    expect(row).toMatchObject({
      investment_case_id: investmentCaseA,
      model_id: modelId,
      status: "SUCCEEDED",
      validity: "VALID",
    });
    expect(row.semantic_hash).toBe(row.model_semantic_hash);
    expect(row.input_hash).toBe(baseRun.inputSnapshot.semanticHash);
    expect(row.result_hash).toBe(baseRun.result.resultSemanticHash);
  });

  it("returns exact typed failures for a missing logical model, missing ModelVersion, and stored semantic-hash corruption", async () => {
    const missingModelConfig = structuredClone(config);
    missingModelConfig.modelVersion = "missing-logical-model-probe";
    await expect(createUnderwritingModelVersion(ctxA, {
      modelId: randomUUID(),
      definition: createStandardLboModel(missingModelConfig),
    })).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });

    await expect(prepareUnderwritingRun(ctxA, {
      investmentCaseId: investmentCaseA,
      modelVersionId: randomUUID(),
      worldAt: knownWorldAt,
      explicitInputs,
    })).rejects.toMatchObject({ code: "MODEL_VERSION_NOT_FOUND" });

    const originalHash = (await admin.query<{ semantic_hash: string }>(
      "SELECT semantic_hash FROM finnor_os.underwriting_model_versions WHERE id=$1",
      [modelVersionId],
    )).rows[0]!.semantic_hash;
    try {
      await admin.query("ALTER TABLE finnor_os.underwriting_model_versions DISABLE TRIGGER immutable_underwriting_history");
      await admin.query(
        "UPDATE finnor_os.underwriting_model_versions SET semantic_hash=$1 WHERE id=$2",
        [`sha256:${"f".repeat(64)}`, modelVersionId],
      );
      await admin.query("ALTER TABLE finnor_os.underwriting_model_versions ENABLE TRIGGER immutable_underwriting_history");
      await expect(prepareUnderwritingRun(ctxA, {
        investmentCaseId: investmentCaseA,
        modelVersionId,
        worldAt: knownWorldAt,
        explicitInputs,
      })).rejects.toMatchObject({ code: "MODEL_SEMANTIC_HASH_MISMATCH" });
    } finally {
      await admin.query("ALTER TABLE finnor_os.underwriting_model_versions DISABLE TRIGGER immutable_underwriting_history");
      await admin.query("UPDATE finnor_os.underwriting_model_versions SET semantic_hash=$1 WHERE id=$2", [originalHash, modelVersionId]);
      await admin.query("ALTER TABLE finnor_os.underwriting_model_versions ENABLE TRIGGER immutable_underwriting_history");
    }
  });

  it("resolves exact P1, EvidenceVersion, and P3 inputs without hindsight or missing-to-zero coercion", () => {
    expect(baseRun.result).toMatchObject({ status: "SUCCEEDED", validity: "VALID" });
    expect(baseRun.inputSnapshot.values["entry.enterprise_value"]).toMatchObject({
      value: "100",
      truthClass: "OBSERVED_FACT",
      status: "KNOWN",
      provenance: [expect.objectContaining({
        kind: "artifact_anchor",
        id: documentId,
        versionId: baseDocumentVersionId,
        anchorId: "cell:2!D10",
      })],
    });
    expect(baseRun.inputSnapshot.values["exit.adjustments"]).toMatchObject({
      value: "0",
      truthClass: "OBSERVED_FACT",
      status: "KNOWN",
      provenance: [expect.objectContaining({ kind: "evidence_version", id: evidenceVersionId })],
    });
    expect(baseRun.inputSnapshot.values["exit.multiple"]).toMatchObject({
      value: "5",
      truthClass: "CANONICAL_ASSUMPTION",
      status: "KNOWN",
      provenance: expect.arrayContaining([expect.objectContaining({ kind: "p1_assumption", id: assumptionId })]),
    });

    expect(noHindsightRun.result).toMatchObject({
      status: "FAILED",
      validity: "INCOMPLETE",
      failure: { code: "UNKNOWN_INPUT" },
    });
    expect(noHindsightRun.inputSnapshot.values["entry.enterprise_value"]).toMatchObject({
      value: null,
      status: "UNKNOWN",
      reason: "ARTIFACT_VERSION_NOT_KNOWN_AT_WORLD_AT_OR_NOT_VISIBLE",
    });
    expect(noHindsightRun.inputSnapshot.values["exit.adjustments"]).toMatchObject({
      value: null,
      status: "UNKNOWN",
      reason: "EVIDENCE_VERSION_NOT_KNOWN_AT_WORLD_AT_OR_NOT_VISIBLE",
    });
    expect(noHindsightRun.inputSnapshot.values["exit.multiple"]).toMatchObject({
      value: null,
      status: "UNKNOWN",
      reason: "NO_ASSUMPTION_VERSION_KNOWN_AT_WORLD_AT",
    });
  });

  it("reproduces an old world exactly after P1 truth changes and fails closed on an obsolete exact binding", async () => {
    expect(historicalReplay.inputSnapshot.semanticHash).toBe(baseRun.inputSnapshot.semanticHash);
    expect(historicalReplay.result.resultSemanticHash).toBe(baseRun.result.resultSemanticHash);
    expect(baseReplay).toMatchObject({ id: baseRun.id, replayed: true });
    expect(currentRun.result).toMatchObject({
      status: "FAILED",
      validity: "INCOMPLETE",
      failure: { code: "UNKNOWN_INPUT" },
    });
    expect(currentRun.inputSnapshot.values["exit.multiple"]).toMatchObject({
      value: null,
      truthClass: "CANONICAL_ASSUMPTION",
      status: "UNKNOWN",
      reason: "ASSUMPTION_SUPERSEDED_AT_WORLD_AT",
    });
    expect((await admin.query(
      "SELECT value::text,state FROM finnor_os.pe_assumptions WHERE tenant_id=$1 AND id=$2",
      [tenantA, replacementAssumptionId],
    )).rows[0]).toEqual({ value: "6", state: "active" });
  });

  it("keeps scenarios and sensitivity cells immutable, coherent, and pinned to exact Runs", async () => {
    expect(assumptionHistoryBeforeRevision).toBe(1);
    expect(scenarioRun.result.resultSemanticHash).not.toBe(baseRun.result.resultSemanticHash);
    expect(scenarioRun.inputSnapshot.values["exit.multiple"]).toMatchObject({
      value: "4",
      truthClass: "SCENARIO_OVERRIDE",
      status: "KNOWN",
    });
    expect(baseRun.inputSnapshot.values["exit.multiple"]).toMatchObject({ value: "5", truthClass: "CANONICAL_ASSUMPTION" });
    const pinnedReplay = await createUnderwritingRun(ctxA, {
      investmentCaseId: investmentCaseA, modelVersionId, scenarioId, baseRunId: baseRun.id,
      worldAt: knownWorldAt, idempotencyKey: `p4-pinned-replay-${randomUUID()}`,
    }) as PersistedRun;
    expect(pinnedReplay.inputSnapshot.semanticHash).toBe(scenarioRun.inputSnapshot.semanticHash);
    expect(pinnedReplay.result.resultSemanticHash).toBe(scenarioRun.result.resultSemanticHash);
    const detail = await getUnderwritingSensitivity(ctxA, sensitivityId) as { cells: Array<Record<string, unknown>>; complete: boolean; cellCount: number };
    expect(sensitivity).toMatchObject({ status: "SUCCEEDED", replayed: false });
    expect(detail).toMatchObject({ complete: true, cellCount: 3 });
    expect(detail.cells).toHaveLength(3);
    expect(new Set(detail.cells.map((cell) => cell.runId)).size).toBe(3);
    expect(detail.cells.every((cell) => typeof cell.resultHash === "string" || typeof (cell.result as { resultSemanticHash?: string })?.resultSemanticHash === "string")).toBe(true);
  });

  it("uses exact SpreadsheetIR anchors, exposes mismatch, and recovers a P3-operation/P4-projection crash boundary", () => {
    expect(comparisonBeforeProjection).toMatchObject({
      runId: baseRun.id,
      documentId,
      documentVersionId: baseDocumentVersionId,
      status: "MISMATCH",
      comparisons: [expect.objectContaining({
        bindingId: outputBindingId,
        modelNodeId: "output.transaction.entry_enterprise_value",
        anchorId: "cell:2!D5",
        modelValue: "100",
        artifactValue: "25",
        status: "MISMATCH",
      })],
    });
    expect(projection).toMatchObject({
      id: projectionId,
      run_id: baseRun.id,
      document_id: documentId,
      base_version_id: baseDocumentVersionId,
      result_version_id: projectedDocumentVersionId,
      status: "SUCCEEDED",
      replayed: false,
    });
    expect(projection.comparisons).toEqual([
      expect.objectContaining({ status: "MATCH", modelValue: "100", artifactValue: "100" }),
    ]);
    expect(versionCountAfterRecoveredProjection).toBe(versionCountBeforeRecoveredProjection);
    expect(projectionReplay).toMatchObject({ id: projectionId, replayed: true });
  });

  it("enforces FORCE RLS and tenant isolation on every P4 tenant relation", async () => {
    const catalog = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>(
      `SELECT relation.relname,relation.relrowsecurity,relation.relforcerowsecurity,
              (SELECT count(*)::int FROM pg_policies policy
                WHERE policy.schemaname='finnor_os' AND policy.tablename=relation.relname AND policy.policyname='tenant_isolation') policies
       FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       WHERE namespace.nspname='finnor_os' AND relation.relname=ANY($1::text[]) ORDER BY relation.relname`,
      [P4_TABLES],
    );
    expect(catalog.rows).toHaveLength(P4_TABLES.length);
    expect(catalog.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity && row.policies === 1)).toBe(true);
    for (const table of P4_TABLES) {
      const visible = await tenantQuery<{ count: number }>(tenantA, ownerA, `SELECT count(*)::int count FROM finnor_os.${table} WHERE tenant_id=$1`, [tenantA]);
      const hidden = await tenantQuery<{ count: number }>(tenantB, ownerB, `SELECT count(*)::int count FROM finnor_os.${table} WHERE tenant_id=$1`, [tenantA]);
      expect(visible.rows[0]!.count, `${table} should contain tenant A proof data`).toBeGreaterThan(0);
      expect(hidden.rows[0]!.count, `${table} leaked tenant A rows`).toBe(0);
    }
    await expect(getUnderwritingRun(ctxB, baseRun.id)).rejects.toMatchObject({ code: "PE_ENTITY_NOT_FOUND" });
    await expect(tenantQuery(
      tenantB,
      ownerB,
      `INSERT INTO finnor_os.underwriting_models(tenant_id,investment_case_id,model_key,name,created_by)
       VALUES($1,$2,'cross_tenant_probe','must fail',$3)`,
      [tenantA, investmentCaseA, ownerB],
    )).rejects.toMatchObject({ code: "42501" });
  });

  it("enforces database immutability on every P4 relation", async () => {
    const rowIds: Record<(typeof P4_TABLES)[number], string> = {
      underwriting_models: modelId,
      underwriting_model_versions: modelVersionId,
      underwriting_model_input_bindings: String((await admin.query(
        "SELECT id FROM finnor_os.underwriting_model_input_bindings WHERE tenant_id=$1 AND model_version_id=$2 ORDER BY input_node_id LIMIT 1",
        [tenantA, modelVersionId],
      )).rows[0]!.id),
      underwriting_scenarios: scenarioId,
      underwriting_runs: baseRun.id,
      underwriting_sensitivities: sensitivityId,
      underwriting_sensitivity_cells: String((await admin.query(
        "SELECT id FROM finnor_os.underwriting_sensitivity_cells WHERE tenant_id=$1 AND sensitivity_id=$2 ORDER BY row_index,column_index LIMIT 1",
        [tenantA, sensitivityId],
      )).rows[0]!.id),
      underwriting_artifact_bindings: outputBindingId,
      underwriting_artifact_projections: projectionId,
    };
    for (const table of P4_TABLES) {
      const timestampColumn = table === "underwriting_runs" ? "computed_at" : "created_at";
      await expectRejectedQuery(
        () => admin.query(`UPDATE finnor_os.${table} SET ${timestampColumn}=${timestampColumn} WHERE id=$1`, [rowIds[table]]),
        /underwriting history is immutable/i,
        `${table} accepted an UPDATE`,
      );
    }
    await expectRejectedQuery(
      () => admin.query("DELETE FROM finnor_os.underwriting_runs WHERE id=$1", [baseRun.id]),
      /underwriting history is immutable/i,
      "underwriting_runs accepted a DELETE",
    );
  });

  it("rejects corrupted prepared results and converges retry-after-commit without partial completed rows", async () => {
    const prepared = await prepareUnderwritingRun(ctxA, {
      investmentCaseId: investmentCaseA,
      modelVersionId,
      worldAt: knownWorldAt,
      explicitInputs,
    });
    const calculated = executeUnderwritingModel(prepared.compiled, prepared.baseSnapshot, prepared.scenario);
    const output = calculated.outputs["output.transaction.entry_enterprise_value"]!;
    const tampered: UnderwritingRunResult = {
      ...calculated,
      outputs: {
        ...calculated.outputs,
        "output.transaction.entry_enterprise_value": { ...output, value: decimal("999") },
      },
    };
    const corruptKey = `p4-corrupt-${randomUUID()}`;
    await expect(persistPreparedUnderwritingRun(ctxA, {
      prepared,
      result: tampered,
      idempotencyKey: corruptKey,
    })).rejects.toMatchObject({ code: "RESULT_SEMANTIC_HASH_MISMATCH" });
    expect((await admin.query(
      "SELECT count(*)::int count FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND idempotency_key=$2",
      [tenantA, corruptKey],
    )).rows[0]?.count).toBe(0);

    const replayKey = `p4-after-commit-${randomUUID()}`;
    const persistenceStarted = performance.now();
    const first = await persistPreparedUnderwritingRun(ctxA, { prepared, result: calculated, idempotencyKey: replayKey });
    const persistenceLatencyMs = performance.now() - persistenceStarted;
    const replay = await persistPreparedUnderwritingRun(ctxA, { prepared, result: calculated, idempotencyKey: replayKey });
    expect(first).toMatchObject({ replayed: false });
    expect(replay).toMatchObject({ id: first.id, replayed: true });
    expect((await admin.query(
      "SELECT count(*)::int count FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND idempotency_key=$2",
      [tenantA, replayKey],
    )).rows[0]?.count).toBe(1);
    expect(runServiceLatencyMs).toBeLessThan(2_000);
    expect(persistenceLatencyMs).toBeLessThan(1_000);
    expect(artifactProjectionLatencyMs).toBeLessThan(5_000);
    console.info("P4_INTEGRATION_BENCHMARK " + JSON.stringify({
      runServiceLatencyMs,
      persistenceLatencyMs,
      artifactProjectionLatencyMs,
    }));
  });

  it("provides deterministic explanations, diffs, and bounded audit events", async () => {
    const explanation = await explainUnderwritingOutput(ctxA, baseRun.id, "gross_sponsor_moic");
    expect(explanation).toMatchObject({ nodeId: "gross_sponsor_moic" });
    expect(JSON.stringify(explanation)).toContain("entry.enterprise_value");
    const runDiff = await compareUnderwritingRuns(ctxA, baseRun.id, scenarioRun.id);
    expect(runDiff).toMatchObject({
      modelVersionChanged: false,
      scenarioIdentityChanged: true,
      causalAttribution: "DEPENDENCY_GRAPH",
      changedInputs: { "exit.multiple": expect.any(Object) },
    });
    expect(await compareUnderwritingModelVersions(ctxA, modelVersionId, modelVersionId)).toMatchObject({
      leftSemanticHash: expect.any(String),
      rightSemanticHash: expect.any(String),
      changedNodeIds: [],
      addedNodeIds: [],
      removedNodeIds: [],
      financialConventionChanged: false,
      runtimeConventionChanged: false,
    });
    const workspace = await listUnderwritingWorkspace(ctxA, investmentCaseA) as { runs: unknown[]; artifactBindings: unknown[]; artifactProjections: unknown[] };
    expect(workspace.runs.length).toBeGreaterThanOrEqual(8);
    expect(workspace.artifactBindings).toHaveLength(1);
    expect(workspace.artifactProjections).toHaveLength(1);
    const events = await admin.query<{ event_type: string; bytes: number; payload: Record<string, unknown> }>(
      `SELECT event_type,octet_length(payload::text)::int bytes,payload FROM finnor_os.business_events
       WHERE tenant_id=$1 AND event_type LIKE 'underwriting_%' ORDER BY occurred_at,id`,
      [tenantA],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      "underwriting_model_version_created",
      "underwriting_run_completed",
      "underwriting_run_invalid",
      "underwriting_sensitivity_completed",
      "underwriting_projection_created",
    ]));
    expect(events.rows.every((row) => row.bytes < 2_048)).toBe(true);
    expect(JSON.stringify(events.rows)).not.toContain("inputSnapshot");
    expect(JSON.stringify(events.rows)).not.toContain("sponsorCashFlows");
  });

  it("rejects exact cross-tenant P1 Assumption, EvidenceVersion, and P3 bindings at service/database boundaries", async () => {
    const foreignModel = await createUnderwritingModel(ctxB, {
      investmentCaseId: investmentCaseB,
      modelKey: "standard_lbo_v1",
      name: "Foreign P4 model",
    });
    const foreignAssumptionConfig = structuredClone(config);
    foreignAssumptionConfig.modelVersion = "foreign-assumption-probe";
    foreignAssumptionConfig.inputBindings = {
      "exit.multiple": { kind: "p1_assumption", assumptionId },
    };
    await expect(createUnderwritingModelVersion(ctxB, {
      modelId: idOf(foreignModel),
      definition: createStandardLboModel(foreignAssumptionConfig),
    })).rejects.toBeTruthy();
    expect((await admin.query(
      "SELECT count(*)::int count FROM finnor_os.underwriting_model_versions WHERE tenant_id=$1 AND model_id=$2",
      [tenantB, idOf(foreignModel)],
    )).rows[0]?.count).toBe(0);

    const foreignEvidenceSource = await createEvidenceSource(tenantB, {
      sourceKey: `p4-foreign-evidence-${randomUUID()}`,
      sourceType: "underwriting_fixture",
      title: "Foreign evidence must remain tenant-isolated",
    });
    const foreignEvidence = await appendEvidenceVersion(tenantB, foreignEvidenceSource.id, {
      content: "Cross-tenant evidence probe",
      snapshot: { exit: { adjustments: "0" } },
      asOf: new Date(),
      retrievedAt: new Date(),
    });
    const foreignEvidenceConfig = structuredClone(config);
    foreignEvidenceConfig.modelVersion = "foreign-evidence-probe";
    foreignEvidenceConfig.inputBindings = {
      "exit.adjustments": {
        kind: "evidence_version",
        evidenceVersionId: foreignEvidence.versionId,
        valuePath: "exit.adjustments",
      },
    };
    await expect(createUnderwritingModelVersion(ctxA, {
      modelId,
      definition: createStandardLboModel(foreignEvidenceConfig),
    })).rejects.toBeTruthy();

    const validForeignConfig = structuredClone(config);
    validForeignConfig.modelVersion = "foreign-valid-model";
    validForeignConfig.inputBindings = {};
    const validForeignVersion = await createUnderwritingModelVersion(ctxB, {
      modelId: idOf(foreignModel),
      definition: createStandardLboModel(validForeignConfig),
    });
    await expect(createUnderwritingArtifactBinding(ctxB, {
      investmentCaseId: investmentCaseB,
      modelVersionId: idOf(validForeignVersion),
      documentId,
      documentVersionId: baseDocumentVersionId,
      direction: "output",
      bindingMode: "compare_only",
      modelNodeId: "output.transaction.entry_enterprise_value",
      anchorId: "cell:2!D5",
      anchorHash: "0".repeat(64),
      comparisonPolicy: { mode: "EXACT_DECIMAL" },
    })).rejects.toBeTruthy();
  });

  it("runs a governed Work-scoped downside Scenario through the durable action and verifies its receipt", async () => {
    const roleId = randomUUID();
    const policyId = randomUUID();
    await admin.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,$3,$4)",
      [roleId, tenantA, `p4-underwriting-${randomUUID()}`, "P4 Underwriting Test Authority"]);
    await admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4::jsonb)",
      [tenantA, ownerA, roleId, JSON.stringify({ kind: "tenant" })]);
    await admin.query(`INSERT INTO finnor_os.role_authority_grants
      (tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required)
      VALUES($1,$2,'*','*','allow','high',false)`, [tenantA, roleId]);
    if (plannerMemo) await configureAgentProfile(tenantA, createDefaultPluginRegistry(), {
      key: "p4-committee-planner", name: "Committee memo planner", actor: ctxA.auth,
      capabilityGrants: [
        { kind: "action", capability: "select_ic_underwriting_run" },
        { kind: "action", capability: "create_ic_memo_draft" },
        { kind: "action", capability: "select_ic_memo_version" },
        { kind: "check", capability: "check:objective_success" },
      ],
      autonomyLimits: { maxActions: 4, maxQueries: 11, maxReplans: 8, maxPlannerCalls: 8, maxWallClockMs: 120_000 },
    });
    await admin.query(`INSERT INTO finnor_os.domain_policies
      (id,tenant_id,action_type,policy,requires_confirmation,confirmation_template,version,effective_from)
      VALUES($1,$2,'create_underwriting_run','{}'::jsonb,false,NULL,1,now())`, [policyId, tenantA]);
    await admin.query(`INSERT INTO finnor_os.domain_policy_revisions
      (id,tenant_id,policy_id,action_type,version,policy,requires_confirmation,confirmation_template,effective_from)
      VALUES($1,$2,$3,'create_underwriting_run',1,'{}'::jsonb,false,NULL,now())`, [randomUUID(), tenantA, policyId]);

    const instruction = "Stress the exact exit multiple, record a new Underwriting Run and prepare an Investment Committee working memo.";
    const work = await receiveWork({
      tenantId: tenantA, userId: ownerA, channel: "console",
      instruction,
      idempotencyKey: `p4-governed-run-${randomUUID()}`,
    });
    await attachWorkToDealGraph(ctxA, {
      dealId: dealA, workId: work.workId,
      entities: [{ entityType: "pe_deal", entityId: dealA, relationship: "about" }],
    });
    const orchestrator = new FinnorOrchestrator();
    const objective = await orchestrator.startObjective(instruction, ctxA.auth, {
      channel: "console", workId: work.workId, workInputId: work.workInputId, instructionId: work.instructionId,
      deferInitialIteration: true,
    });
    expect(objective.workId).toBe(work.workId);
    const drafted = await orchestrator.draftKnownAction("create_underwriting_run", {
      dealId: dealA, investmentCaseId: investmentCaseA, modelVersionId, baseRunId: baseRun.id,
      scenario: { name: "Governed exit multiple downside", overrides: [
        { nodeId: "exit.multiple", value: "3.75", reason: "Test a lower exit multiple against the pinned base Run." },
      ] },
    }, tenantA, { workId: work.workId, initiatedBy: ownerA, source: "p4-governed-integration" });
    expect(drafted.result).toMatchObject({ status: "success", output: { durableWorkerExecution: true, queued: true } });
    const executed = await driveDurableAction(tenantA, drafted.action.id);
    expect(executed, JSON.stringify(executed)).toMatchObject({ status: "success", output: {
      canonicalMutationOwner: "createUnderwritingRun", canonicalObserved: true, verified: true,
      workAttachment: "underwriting_run_work_id",
    } });
    const result = executed.output.canonicalState as Record<string, unknown>;
    expect(result).toMatchObject({ workId: work.workId, investmentCaseId: investmentCaseA,
      modelVersionId, status: "SUCCEEDED", validity: "VALID" });
    expect(typeof result.scenarioId).toBe("string");
    const readback = await getUnderwritingRun(ctxA, String(result.id));
    expect(readback).toMatchObject({ workId: work.workId, scenarioId: result.scenarioId,
      resultHash: result.resultHash });
    const receipt = await admin.query<{ finalized: boolean; verified: boolean; failed: boolean }>(
      `SELECT finalized_at IS NOT NULL finalized,
              verification->>'state'='verified' verified,
              failure IS NOT NULL failed
         FROM finnor_os.decision_receipts
        WHERE tenant_id=$1 AND domain_action_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [tenantA, drafted.action.id],
    );
    expect(receipt.rows[0]).toEqual({ finalized: true, verified: true, failed: false });

    await activateInvestmentCase(ctxA, { investmentCaseId: investmentCaseA, expectedVersion: 1 });
    const committeeOrgUnitId = randomUUID();
    const committeePolicyId = randomUUID();
    const policyRevisionId = randomUUID();
    const committeePolicy = JSON.stringify({
      schemaVersion: "pe-ic-policy.v1",
      quorum: { kind: "MIN_COUNT", minimum: 1 }, threshold: { kind: "SIMPLE_MAJORITY" },
      abstentionsCountForQuorum: true, deferralsCountForQuorum: false,
      abstentionsCountAsNonApprove: true, deferralsCountAsNonApprove: true,
      memoChange: "REQUIRE_REVOTE", underwritingRunChange: "REQUIRE_NEW_RECOMMENDATION",
      requiredQuestionWaiverAllowed: false, conditionWaiverAllowed: false,
      allowedPrimaryRunValidities: ["VALID"],
    });
    await admin.query(
      "INSERT INTO finnor_os.org_units(id,tenant_id,unit_key,name,kind,active) VALUES($1,$2,$3,'Investment Committee','team',true)",
      [committeeOrgUnitId, tenantA, `ic-${committeeOrgUnitId}`],
    );
    await admin.query(`INSERT INTO finnor_os.domain_policies
      (id,tenant_id,action_type,policy,requires_confirmation,version,effective_from)
      VALUES($1,$2,'private_equity:ic_process',$3::jsonb,false,1,now()),
            ($4,$2,'create_ic_memo_draft','{}'::jsonb,false,1,now())`,
      [committeePolicyId, tenantA, committeePolicy, randomUUID()]);
    await admin.query(`INSERT INTO finnor_os.domain_policy_revisions
      (id,tenant_id,policy_id,action_type,version,policy,requires_confirmation,effective_from)
      SELECT CASE WHEN action_type='private_equity:ic_process' THEN $1::uuid ELSE $2::uuid END,
             tenant_id,id,action_type,version,policy,requires_confirmation,effective_from
        FROM finnor_os.domain_policies WHERE tenant_id=$3 AND action_type IN ('private_equity:ic_process','create_ic_memo_draft')`,
      [policyRevisionId, randomUUID(), tenantA]);

    const peer = randomUUID();
    await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','P4 Peer')",
      [peer, tenantA, `p4-peer-${peer}@test.invalid`]);
    const http = await browserHttpFixture(admin, tenantA, ownerA, peer);
    try {
      const configured = await http.request("private-equity/ic/committee-configurations", {
        committeeOrgUnitId, policyRevisionId, idempotencyKey: randomUUID(),
        members: [{ employeeId: ownerA, memberRole: "CHAIR", chair: true, votingEligible: true,
          effectiveFrom: new Date(Date.now() - 60_000).toISOString() }],
      });
      expect(configured.status, JSON.stringify(configured.body)).toBe(201);
      const opened = await http.request("private-equity/ic/cases", {
        dealId: dealA, investmentCaseId: investmentCaseA, committeeConfigVersionId: configured.body.config.id,
        primaryUnderwritingRunId: plannerMemo ? baseRun.id : result.id, workId: work.workId, idempotencyKey: randomUUID(),
      });
      expect(opened.status, JSON.stringify(opened.body)).toBe(201);
      const icCaseId = opened.body.row.id;
      const casePath = `private-equity/ic/cases/${icCaseId}`;
      const preparing = await http.request(`${casePath}/begin-preparation`, { expectedVersion: 1 });
      expect(preparing.status, JSON.stringify(preparing.body)).toBe(200);
      const sources: Array<{ title: string; documentId: string; versionId: string; sha256: string }> = [];
      if (committeeSources) {
        for (const [title, path, admitted] of [
          ["Management financials", "management/financials.xlsx", true],
          ["Quality of earnings", "qoe/financials.pdf", true],
          ["Investigation-only report", "qoe/financials.pdf", false],
        ] as const) {
          const source = await ingestArtifact(actorA, {
            title, origin: "manual_upload", bytes: readFileSync(resolve(committeeSources, path)),
          });
          const anchor = source.ir.nodes.find(node => node.kind === "cell" || node.kind === "page");
          if (!anchor) throw new Error("Committee source has no anchor");
          await bindArtifact(actorA, source.documentId, {
            versionId: source.version.id, anchorId: anchor.id, anchorHash: anchor.hash, targetKind: "canonical_entity",
            targetEntityType: admitted ? "pe_ic_case" : "external_organization", targetId: admitted ? icCaseId : targetA,
          });
          if (admitted) {
            await attachCanonicalDocument(ctxA, {
              dealId: dealA, entity: { entityType: "pe_ic_case", entityId: icCaseId },
              documentId: source.documentId, linkRole: "governing",
            });
          }
          sources.push({ title, documentId: source.documentId, versionId: source.version.id, sha256: source.version.byte_sha256 });
        }
      }
      const output = process.env.FINNOR_IC_MEMO_EVIDENCE_DIR;
      if (output) await mkdir(output, { recursive: true, mode: 0o700 });
      const selectionInput = {
        artifactRole: "MEMO", underwritingRunId: result.id, evidenceCutoffAt: new Date().toISOString(),
      };
      let readCase = await http.read(casePath);
      expect(readCase.status).toBe(200);
      if (!plannerMemo) {
        const memoDraft = await orchestrator.draftKnownAction("create_ic_memo_draft", {
          dealId: dealA, icCaseId, expectedCaseVersion: preparing.body.row.version, title: "P4 investment review",
        }, tenantA, { workId: work.workId, initiatedBy: ownerA, source: "p4-governed-integration" });
        expect(memoDraft.result).toMatchObject({ status: "success", output: { durableWorkerExecution: true, queued: true } });
        const memo = await driveDurableAction(tenantA, memoDraft.action.id);
        const effect = await admin.query(
          "SELECT status, effect, observed_result, verification FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2",
          [tenantA, memoDraft.action.id],
        );
        if (output) {
          await mkdir(output, { recursive: true, mode: 0o700 });
          await writeFile(resolve(output, "memo-effect.json"), JSON.stringify(effect.rows, null, 2), { mode: 0o600 });
        }
        expect(memo, JSON.stringify(memo)).toMatchObject({ status: "success", output: { verified: true } });
        const state = memo.output.canonicalState as Record<string, unknown>;
        const versionId = String(state.documentVersionId);
        const downloaded = await http.readResponse(`documents/${state.documentId}`, { versionId });
        expect(downloaded.status).toBe(200);
        expect(downloaded.headers.get("content-disposition")).toBe('attachment; filename="P4 investment review.docx"');
        const bytes = Buffer.from(await downloaded.arrayBuffer());
        expect(effect.rows).toMatchObject([{ status: "verified", verification: { state: "verified", observed: {
          icCaseId, underwritingRunId: result.id, documentId: state.documentId, documentVersionId: versionId,
          byteSha256: createHash("sha256").update(bytes).digest("hex"),
        } } }]);
        const xml = new OfficePackage(bytes).text("word/document.xml");
        const exactSource = await http.readResponse(`documents/${documentId}`, { versionId: baseDocumentVersionId });
        expect(exactSource.status).toBe(200);
        expect(Buffer.from(await exactSource.arrayBuffer())).toEqual(readFileSync(CORPUS));
        const untrusted = await http.request(casePath, undefined, "invalid", http.origin, "GET");
        expect(untrusted.status).toBe(401);
        const initialSelection = {
          ...selectionInput, expectedCaseVersion: preparing.body.row.version,
          documentId: state.documentId, documentVersionId: versionId,
        };
        const sourceCompleteness = committeeSources ? "CONFLICTING" : "INCOMPLETE";
        if (committeeSources) {
          const promotion = await http.request(`${casePath}/memos`, {
            ...initialSelection, sourceCompleteness: "COMPLETE", idempotencyKey: randomUUID(),
          });
          if (output) {
            await writeFile(resolve(output, "investment-review.docx"), bytes, { mode: 0o600 });
            await writeFile(resolve(output, "committee-sources.json"), JSON.stringify({ sources, promotion }, null, 2), { mode: 0o600 });
          }
          expect(promotion.status, JSON.stringify(promotion.body)).toBe(409);
          expect(promotion.body.code).toBe("IC_MEMO_SOURCE_COMPLETENESS_CONFLICT");
          expect(state.sourceCompleteness).toBe("CONFLICTING");
          expect(xml).toContain("USD 18,000,000");
          expect(xml).toContain("USD 20,000,000");
          expect(xml).toContain("USD 2,000,000");
          expect(xml).toContain("Financials!C2");
          expect(xml).toContain("page 1");
          for (const source of sources.slice(0, 2)) {
            expect(xml).toContain(`document_version:${source.versionId}`);
            expect(xml).toContain(source.sha256);
          }
          expect(xml).not.toContain("Investigation-only report");
          expect(xml).not.toContain(sources[2]!.versionId);
        }
        const selection = await http.request(`${casePath}/memos`, {
          ...initialSelection, sourceCompleteness, idempotencyKey: randomUUID(),
        });
        expect(selection.status, JSON.stringify(selection.body)).toBe(201);
        readCase = await http.read(casePath);
        expect(readCase.status).toBe(200);
        expect(readCase.body).toMatchObject({
          case: { state: "PREPARING", primaryUnderwritingRunId: result.id },
          memo: { documentVersionId: versionId, underwritingRunId: result.id, sourceCompleteness },
        });
        if (output) {
          await writeFile(resolve(output, "investment-review.docx"), bytes, { mode: 0o600 });
          await writeFile(resolve(output, "underwriting-source.xlsx"), readFileSync(CORPUS), { mode: 0o600 });
          await writeFile(resolve(output, "owner-readback.json"), JSON.stringify({
            inputs: { tenantA, workId: work.workId, objectiveLoopId: objective.objectiveLoopId, dealA, investmentCaseA, documentId, baseDocumentVersionId },
            underwriting: readback, draft: memo, selectedCase: readCase.body, http: http.observed,
          }, null, 2), { mode: 0o600 });
        }

        expect(xml).toContain("Entry valuation and funding");
        expect(xml).toContain("Entry enterprise value · USD 100.");
        expect(xml).toContain(`document_version:${baseDocumentVersionId}`);
        expect(xml).toContain("cell:2!D10");
      }
      if (committeeSources) {
        const fixture = firstGoldenLbo();
        const modelConfig: StandardLboModelConfig = {
          ...fixture.config, modelKey: "committee_ebitda", modelVersion: "committee-ebitda-v1",
          entryValuationMethod: "metric_multiple", entryValuationMetric: "EBITDA", inputBindings: {},
        };
        const definition = createStandardLboModel(modelConfig);
        const model = await createUnderwritingModel(ctxA, {
          investmentCaseId: investmentCaseA, modelKey: definition.modelKey, name: "Committee EBITDA sensitivity",
        });
        const modelVersion = await createUnderwritingModelVersion(ctxA, { modelId: idOf(model), definition });
        const scenarioModelVersionId = idOf(modelVersion);
        const valuationWorldAt = new Date().toISOString();
        const inputValues = fixtureExplicitInputs(modelConfig, {
          ...fixture.inputs, investmentCaseId: investmentCaseA, worldAt: valuationWorldAt,
          entry: { ...fixture.inputs.entry, metricValue: decimal("20"), multiple: decimal("8") },
        }, new Set());
        for (const node of definition.nodes) {
          const input = inputValues[node.id];
          if (!input || node.kind !== "input" || node.unit !== "money" || input.value === null) continue;
          input.value = typeof input.value === "string" ? mul(input.value, "1000000")
            : typeof input.value === "object" ? Object.fromEntries(
              Object.entries(input.value).map(([period, value]) => [period, mul(String(value), "1000000")]),
            ) : input.value;
        }
        const scenarioBase = await createUnderwritingRun(ctxA, {
          investmentCaseId: investmentCaseA, modelVersionId: scenarioModelVersionId, worldAt: valuationWorldAt,
          idempotencyKey: randomUUID(), explicitInputs: inputValues,
        });
        expect(scenarioBase.result).toMatchObject({ status: "SUCCEEDED", validity: "VALID" });

        const scenarioPayload = {
          dealId: dealA, investmentCaseId: investmentCaseA, modelVersionId: scenarioModelVersionId, baseRunId: scenarioBase.id,
        };
        const actionContext = { workId: work.workId, initiatedBy: ownerA, source: "p4-governed-integration" };
        const alternatives: Array<Record<string, unknown> & { id: string; scenarioId: string }> = [];
        for (const [index, ebitda, enterpriseValue] of [[0, "20000000", "160000000"], [1, "18000000", "144000000"]] as const) {
          const source = sources[index]!;
          const candidate = await orchestrator.draftKnownAction("create_underwriting_run", {
            ...scenarioPayload, committeeEbitda: { icCaseId, documentVersionId: source.versionId, periodEnd: "2025-12-31" },
          }, tenantA, actionContext);
          if (output) await writeFile(resolve(output, `scenario-draft-${index}.json`), JSON.stringify(candidate, null, 2), { mode: 0o600 });
          expect(candidate.result).toMatchObject({ status: "success", output: { durableWorkerExecution: true, queued: true } });
          const executed = await driveDurableAction(tenantA, candidate.action.id);
          expect(executed, JSON.stringify(executed)).toMatchObject({ status: "success", output: { verified: true } });
          const run = await http.read(`underwriting/runs/${(executed.output.canonicalState as Record<string, unknown>).id}`);
          expect(run.status, JSON.stringify(run.body)).toBe(200);
          expect(run.body).toMatchObject({
            workId: work.workId, modelVersionId: scenarioModelVersionId, status: "SUCCEEDED", validity: "VALID",
            inputSnapshot: { values: { "entry.metric_value": {
              value: ebitda, truthClass: "SCENARIO_OVERRIDE",
              provenance: [{ kind: "committee_financial_assertion", id: source.documentId,
                versionId: source.versionId, byteSha256: source.sha256, committeeCaseId: icCaseId }],
            } } },
            result: { outputs: { "output.transaction.entry_enterprise_value": { value: enterpriseValue, currency: "USD" } } },
          });
          alternatives.push({ ...run.body, id: idOf(run.body), scenarioId: idOf(run.body, "scenarioId") });
        }
        const [managementRun, qoeRun] = alternatives;
        if (!managementRun || !qoeRun) throw new Error("Both Committee scenarios are required");
        expect(managementRun.scenarioId).not.toBe(qoeRun.scenarioId);
        const comparisonInput = {
          dealId: dealA, icCaseId, expectedCaseVersion: readCase.body.case.version,
          title: "Committee EBITDA alternatives", alternativeRunIds: [managementRun.id, qoeRun.id],
        };
        if (output && plannerMemo) await writeFile(resolve(output, "planner-inputs.json"), JSON.stringify({
          instruction, workId: work.workId, objectiveLoopId: objective.objectiveLoopId, caseId: icCaseId,
          primaryRunId: result.id, alternativeRunIds: comparisonInput.alternativeRunIds,
        }, null, 2), { mode: 0o600 });
        const planAction = async (actionType: string) => {
          const observations = [];
          for (let iteration = 0; iteration < 8; iteration++) {
            const outcome = await orchestrator.runObjectiveIteration({ tenantId: tenantA, workId: work.workId, objectiveLoopId: objective.objectiveLoopId });
            const actions = await admin.query<{ id: string; status: string; payload: Record<string, unknown>; effect_hash: string | null }>(
              `SELECT action.id, action.status, action.payload, effect.semantic_hash AS effect_hash
                 FROM finnor_os.domain_actions action LEFT JOIN finnor_os.business_effects effect ON effect.id=action.business_effect_id
                WHERE action.tenant_id=$1 AND action.work_id=$2 AND action.action_type=$3 ORDER BY action.created_at`,
              [tenantA, work.workId, actionType],
            );
            const steps = await admin.query(`SELECT step_number, phase, iteration_outcome, decision, decision_reason, observation, failure FROM finnor_os.work_objective_steps
              WHERE tenant_id=$1 AND objective_loop_id=$2 ORDER BY step_number`, [tenantA, objective.objectiveLoopId]);
            observations.push({ outcome, actions: actions.rows, steps: steps.rows });
            if (output) await writeFile(resolve(output, `planner-${actionType}.json`), JSON.stringify(observations, null, 2), { mode: 0o600 });
            expect(actions.rows.length).toBeLessThanOrEqual(1);
            const action = actions.rows[0];
            if (action) return action;
            expect(outcome).toBe("continue");
          }
          throw new Error(`Objective did not produce ${actionType}`);
        };
        const approvePlannedAction = async (action: Awaited<ReturnType<typeof planAction>>) => {
          if (action.status !== "pending") return;
          expect(action.effect_hash).toBeTruthy();
          const approved = await http.request(`actions/${action.id}/confirm`, {
            expectedEffectHash: action.effect_hash, typedConfirmation: true,
          });
          expect(approved.status, JSON.stringify(approved.body)).toBe(200);
        };
        const executePlannedAction = async (actionType: string, action: Awaited<ReturnType<typeof planAction>>) => {
          await approvePlannedAction(action);
          const execution = await driveDurableAction(tenantA, action.id);
          const state = await admin.query(`SELECT action.status, effect.status AS effect_status, effect.verification
            FROM finnor_os.domain_actions action LEFT JOIN finnor_os.business_effects effect ON effect.id=action.business_effect_id
            WHERE action.tenant_id=$1 AND action.id=$2`, [tenantA, action.id]);
          if (output) await writeFile(resolve(output, `planner-executed-${actionType}.json`), JSON.stringify({ execution, state: state.rows }, null, 2), { mode: 0o600 });
          expect(execution, JSON.stringify(execution)).toMatchObject({ status: "success", output: { verified: true } });
          return execution;
        };
        let comparisonActionId: string;
        let exported;
        if (plannerMemo) {
          const primary = await planAction("select_ic_underwriting_run");
          expect(primary.payload.underwritingRunId).toBe(result.id);
          await executePlannedAction("select_ic_underwriting_run", primary);
          readCase = await http.read(casePath);
          expect(readCase.body.case.primaryUnderwritingRunId).toBe(result.id);
          comparisonInput.expectedCaseVersion = readCase.body.case.version;
          const comparison = await planAction("create_ic_memo_draft");
          expect(comparison.payload.alternativeRunIds).toEqual(expect.arrayContaining(comparisonInput.alternativeRunIds));
          expect(comparison.payload.alternativeRunIds).toHaveLength(comparisonInput.alternativeRunIds.length);
          comparisonActionId = comparison.id;
          exported = await executePlannedAction("create_ic_memo_draft", comparison);
        } else {
          const comparison = await orchestrator.draftKnownAction("create_ic_memo_draft", comparisonInput, tenantA, actionContext);
          if (output) await writeFile(resolve(output, "comparison-draft.json"), JSON.stringify(comparison, null, 2), { mode: 0o600 });
          expect(comparison.result).toMatchObject({ status: "success", output: { queued: true } });
          comparisonActionId = comparison.action.id;
          exported = await driveDurableAction(tenantA, comparisonActionId);
        }
        expect(exported, JSON.stringify(exported)).toMatchObject({ status: "success", output: { verified: true } });
        const comparisonState = exported.output.canonicalState as Record<string, unknown>;
        const comparisonVersion = idOf(comparisonState, "documentVersionId");
        const comparisonDocument = idOf(comparisonState, "documentId");
        const comparisonResponse = await http.readResponse(`documents/${comparisonDocument}`, { versionId: comparisonVersion });
        expect(comparisonResponse.status).toBe(200);
        const comparisonBytes = Buffer.from(await comparisonResponse.arrayBuffer());
        const comparisonXml = new OfficePackage(comparisonBytes).text("word/document.xml");
        expect(comparisonXml).toContain("Underwriting alternatives for disputed EBITDA");
        expect(comparisonXml).toContain("USD 160,000,000");
        expect(comparisonXml).toContain("USD 144,000,000");
        expect(comparisonXml).toContain("USD 16,000,000");
        for (const run of alternatives) expect(comparisonXml).toContain(`underwriting_run:${run.id}`);
        if (plannerMemo) {
          const selection = await planAction("select_ic_memo_version");
          expect(selection.payload).toMatchObject({ documentId: comparisonDocument, documentVersionId: comparisonVersion, sourceCompleteness: "CONFLICTING" });
          await executePlannedAction("select_ic_memo_version", selection);
        } else {
          const selection = await http.request(`${casePath}/memos`, {
            ...selectionInput, expectedCaseVersion: readCase.body.case.version, documentId: comparisonDocument,
            documentVersionId: comparisonVersion, sourceCompleteness: "CONFLICTING", idempotencyKey: randomUUID(),
          });
          expect(selection.status, JSON.stringify(selection.body)).toBe(201);
        }
        readCase = await http.read(casePath);
        expect(readCase.status).toBe(200);
        expect(readCase.body).toMatchObject({
          case: { state: "PREPARING", primaryUnderwritingRunId: result.id, finalDecisionId: null },
          memo: { documentVersionId: comparisonVersion, sourceCompleteness: "CONFLICTING" },
        });
        const wrongBasis = await orchestrator.draftKnownAction("create_ic_memo_draft", {
          ...comparisonInput, expectedCaseVersion: readCase.body.case.version, alternativeRunIds: [managementRun.id, String(result.id)],
        }, tenantA, actionContext);
        expect(wrongBasis.result).toMatchObject({
          status: "failure", output: { groundingBlocked: true, code: "IC_MEMO_ALTERNATIVES_CONFLICT" },
        });
        if (output) {
          const settled = await admin.query(
            "SELECT status, effect, verification FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2",
            [tenantA, comparisonActionId],
          );
          await writeFile(resolve(output, "committee-alternatives.docx"), comparisonBytes, { mode: 0o600 });
          await writeFile(resolve(output, "comparison-owner.json"), JSON.stringify({
            selected: readCase.body, effect: settled.rows[0], rejected: wrongBasis.result,
          }, null, 2), { mode: 0o600 });
        }
        const memoPath = `documents/${comparisonDocument}`;
        const versionQuery = { versionId: comparisonVersion };
        const selectionId = readCase.body.memo.id;
        const preChangeAsOf = readCase.body.asOf;
        const observePinnedMemo = async (identity: "actor" | "other" = "actor") => {
          const download = await http.readResponse(memoPath, versionQuery, identity);
          const currentDownload = await http.readResponse(memoPath, {}, identity);
          const artifact = await http.readResponse(`${memoPath}/artifact`, versionQuery, identity);
          const semantic = await http.readResponse(`${memoPath}/artifact/ir/${comparisonVersion}`, { limit: "500" }, identity);
          const committee = await http.read(casePath, identity);
          const historical = await http.readResponse(casePath, { asOf: preChangeAsOf }, identity);
          const historicalBody = await historical.json();
          const downloaded = Buffer.from(await download.arrayBuffer());
          return {
            statuses: [download.status, currentDownload.status, artifact.status, semantic.status],
            byteSha256: download.ok ? createHash("sha256").update(downloaded).digest("hex") : null,
            renderedAlternatives: /160,000,000|144,000,000/.test(await semantic.text()),
            committeeStatus: committee.status,
            pinnedArtifact: committee.body.artifacts?.memo?.documentVersionId ?? null,
            selectionId: committee.body.case?.currentMemoId ?? null,
            historicalPinnedArtifact: historicalBody.artifacts?.memo?.documentVersionId ?? null,
          };
        };
        const accessibleMemo = await observePinnedMemo();
        const peerBeforeRevocation = await observePinnedMemo("other");
        const peerAssignments = await admin.query(`UPDATE finnor_os.employee_role_assignments SET active=false
          WHERE tenant_id=$1 AND employee_id=$2 AND active RETURNING role_id`, [tenantA, peer]);
        expect(peerAssignments.rows.length).toBeGreaterThan(0);
        const peerMemo = await observePinnedMemo("other");
        const workspacePath = `investment-cases/${investmentCaseA}/underwriting`;
        const visibleWorkspace = await http.read(workspacePath);
        expect(visibleWorkspace.status).toBe(200);
        expect(visibleWorkspace.body.scenarios).toEqual(expect.arrayContaining(alternatives.map(run => expect.objectContaining({ id: run.scenarioId }))));
        const visibleWork = await http.read(`works/${work.workId}`);
        expect(visibleWork.status).toBe(200);
        expect(JSON.stringify(visibleWork.body)).not.toMatch(/18000000|20000000|144000000|160000000/);
        const excluded = await orchestrator.draftKnownAction("create_underwriting_run", {
          ...scenarioPayload, committeeEbitda: { icCaseId, documentVersionId: sources[2]!.versionId, periodEnd: "2025-12-31" },
        }, tenantA, actionContext);
        expect(excluded.result).toMatchObject({ status: "failure", output: { groundingBlocked: true, code: "IC_SCENARIO_SOURCE_CONFLICT" } });
        const incompatible = await orchestrator.draftKnownAction("create_underwriting_run", {
          ...scenarioPayload, modelVersionId, baseRunId: baseRun.id,
          committeeEbitda: { icCaseId, documentVersionId: sources[0]!.versionId, periodEnd: "2025-12-31" },
        }, tenantA, actionContext);
        expect(incompatible.result).toMatchObject({ status: "failure", output: { groundingBlocked: true, code: "IC_SCENARIO_MODEL_CONFLICT" } });
        const deniedGrant = randomUUID();
        await admin.query(`INSERT INTO finnor_os.role_authority_grants
          (id,tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required)
          VALUES($1,$2,$3,'query:pe_world_state','document','deny','high',false)`,
          [deniedGrant, tenantA, roleId]);
        const revoked = await http.read(`underwriting/runs/${managementRun.id}`);
        const revokedWorkspace = await http.read(workspacePath);
        const revokedMemo = await observePinnedMemo();
        const revokedDraft = await http.request(`${memoPath}/artifact/drafts`, { baseVersionId: comparisonVersion });
        await admin.query("DELETE FROM finnor_os.role_authority_grants WHERE tenant_id=$1 AND id=$2", [tenantA, deniedGrant]);
        const restoredMemo = await observePinnedMemo();
        expect(revoked.status, JSON.stringify(revoked.body)).toBe(404);
        expect(JSON.stringify(revoked.body)).not.toContain("160000000");
        expect(revokedWorkspace.status).toBe(200);
        expect(revokedWorkspace.body.scenarios.some((scenario: { id: string }) => alternatives.some(run => run.scenarioId === scenario.id))).toBe(false);
        const queued = await orchestrator.draftKnownAction("create_underwriting_run", {
          ...scenarioPayload, committeeEbitda: { icCaseId, documentVersionId: sources[1]!.versionId, periodEnd: "2025-12-31" },
        }, tenantA, actionContext);
        expect(queued.result).toMatchObject({ status: "success", output: { queued: true } });
        const staleComparison = await orchestrator.draftKnownAction("create_ic_memo_draft", {
          ...comparisonInput, expectedCaseVersion: readCase.body.case.version, title: "Stale Committee EBITDA alternatives",
        }, tenantA, actionContext);
        expect(staleComparison.result).toMatchObject({ status: "success", output: { queued: true } });
        const archiveSource = async () => {
          await admin.query("UPDATE finnor_os.documents SET archived_at=now() WHERE tenant_id=$1 AND id=$2",
            [tenantA, sources[1]!.documentId]);
        };
        if (output && process.env.FINNOR_IC_MEMO_MOUNTED === "1") {
          const thread = await http.request("threads", { title: "Committee EBITDA alternatives", workId: work.workId });
          expect(thread.status, JSON.stringify(thread.body)).toBe(201);
          const { verifyMountedCommitteeMemo } = await import("../../scripts/transformation/mounted-financial-explanation");
          await verifyMountedCommitteeMemo({
            output, authOrigin: http.authOrigin, apiOrigin: http.origin, email: http.loginEmail,
            threadId: idOf(thread.body.thread), dealId: dealA, caseId: icCaseId,
            documentId: comparisonDocument, versionId: comparisonVersion,
            byteSha256: createHash("sha256").update(comparisonBytes).digest("hex"), archiveSource,
          });
        } else await archiveSource();
        const archivedMemo = await observePinnedMemo();
        if (output) await writeFile(resolve(output, "selected-memo-authority.json"), JSON.stringify({
          documentId: comparisonDocument, documentVersionId: comparisonVersion,
          accessible: accessibleMemo, peerBeforeRevocation, peer: peerMemo, peerRevokedAssignments: peerAssignments.rows,
          revoked: revokedMemo, revokedDraft, restored: restoredMemo, archived: archivedMemo,
        }, null, 2), { mode: 0o600 });
        expect(accessibleMemo).toMatchObject({
          statuses: [200, 200, 200, 200], byteSha256: createHash("sha256").update(comparisonBytes).digest("hex"),
          renderedAlternatives: true, committeeStatus: 200, selectionId,
          pinnedArtifact: comparisonVersion, historicalPinnedArtifact: comparisonVersion,
        });
        expect(peerBeforeRevocation).toEqual(accessibleMemo);
        expect(restoredMemo).toEqual(accessibleMemo);
        expect(revokedDraft.status).toBe(404);
        for (const unavailable of [peerMemo, revokedMemo, archivedMemo]) {
          expect(unavailable).toEqual({
            statuses: [404, 404, 404, 404], byteSha256: null,
            renderedAlternatives: false, committeeStatus: 200, selectionId,
            pinnedArtifact: null, historicalPinnedArtifact: null,
          });
        }
        const archivedDuringQueue = await driveDurableAction(tenantA, queued.action.id);
        expect(archivedDuringQueue).toMatchObject({ status: "failure" });
        expect(archivedDuringQueue.error).toContain("Select one admitted positive EBITDA assertion");
        const rejectedComparison = await driveDurableAction(tenantA, staleComparison.action.id);
        expect(rejectedComparison).toMatchObject({ status: "failure" });
        expect(rejectedComparison.error).toMatch(/committee|alternative/i);
        const staleDraft = await admin.query("SELECT id FROM finnor_os.documents WHERE tenant_id=$1 AND id=$2",
          [tenantA, staleComparison.action.id]);
        expect(staleDraft.rows).toEqual([]);
        if (output) await writeFile(resolve(output, "stale-comparison.json"), JSON.stringify({
          result: rejectedComparison, createdDocuments: staleDraft.rows,
        }, null, 2), { mode: 0o600 });
        const stale = await http.request("underwriting/runs", {
          investmentCaseId: investmentCaseA, modelVersionId: scenarioModelVersionId, baseRunId: scenarioBase.id,
          scenarioId: qoeRun.scenarioId, worldAt: valuationWorldAt, idempotencyKey: randomUUID(), workId: work.workId,
        });
        expect(stale.status, JSON.stringify(stale.body)).toBe(409);
        const archived = await http.read(`underwriting/runs/${qoeRun.id}`);
        expect(archived.status, JSON.stringify(archived.body)).toBe(404);
        expect(JSON.stringify(archived.body)).not.toContain("144000000");
        const rows = await admin.query("SELECT id FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND model_version_id=$2", [tenantA, scenarioModelVersionId]);
        expect(rows.rowCount).toBe(3);
        if (output) await writeFile(resolve(output, "committee-alternatives.json"), JSON.stringify({
          alternatives, base: scenarioBase, excluded: excluded.result, incompatible: incompatible.result,
          revoked, revokedWorkspaceStatus: revokedWorkspace.status, archivedDuringQueue, stale, archived, persistedRunCount: rows.rowCount,
        }, null, 2), { mode: 0o600 });

        const attempted = await orchestrator.draftKnownAction("prepare_ic_recommendation", {
          dealId: dealA, icCaseId, expectedCaseVersion: readCase.body.case.version,
          memoId: readCase.body.memo.id, underwritingRunId: result.id,
        }, tenantA, { workId: work.workId, initiatedBy: ownerA, source: "p4-governed-integration" });
        expect(attempted.result).toMatchObject({
          status: "failure", output: { groundingBlocked: true, code: "IC_MEMO_SOURCE_INCOMPLETE" },
        });
        const effect = await admin.query(
          "SELECT id FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2",
          [tenantA, attempted.action.id],
        );
        expect(effect.rows).toEqual([]);
        if (output) {
          await writeFile(resolve(output, "recommendation-refusal.json"), JSON.stringify(attempted.result, null, 2), { mode: 0o600 });
        }
      }


    } finally {
      await http.close();
    }
  }, process.env.FINNOR_IC_MEMO_MOUNTED === "1" || plannerMemo ? 210_000 : 45_000);
});
