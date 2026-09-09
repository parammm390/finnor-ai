import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, configureTenantVertical } from "@finnor/db";
import { appendEvidenceVersion, createEvidenceSource } from "@finnor/memory";
import {
  applyArtifactPatch,
  createDraft,
  ingestArtifact,
  type ArtifactActor,
} from "@finnor/artifacts";
import {
  attachCanonicalEvidence,
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
import {
  createStandardLboInputSnapshot,
  createStandardLboModel,
  decimal,
  executeUnderwritingModel,
  type StandardLboInputValues,
  type StandardLboModelConfig,
  type UnderwritingRunResult,
} from "@finnor/underwriting";
import { migrate } from "../../packages/db/migrate";
import {
  GOLDEN_UNDERWRITING_CASES,
  type GoldenLboCase,
} from "../underwriting-corpus/golden-cases";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");
const CORPUS = resolve(import.meta.dirname, "../artifact-corpus/lbo-style.xlsx");
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
  const targetA = randomUUID();
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
      worldAt: knownWorldAt,
      idempotencyKey: `p4-scenario-${randomUUID()}`,
      explicitInputs,
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
});
