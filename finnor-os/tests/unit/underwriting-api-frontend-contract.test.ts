import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UnderwritingArtifactComparisonSchema,
  UnderwritingCreateArtifactBindingSchema,
  UnderwritingCreateModelSchema,
  UnderwritingCreateModelVersionSchema,
  UnderwritingCreateRunSchema,
  UnderwritingCreateScenarioSchema,
  UnderwritingCreateSensitivitySchema,
  UnderwritingDecimalSchema,
  UnderwritingProjectionSchema,
} from "../../apps/api/lib/underwriting";
import openapi from "../../openapi.json";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";
const HASH = "a".repeat(64);
const SEMANTIC_HASH = `sha256:${HASH}`;
const ROOT = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function minimalModel() {
  return {
    schemaVersion: "underwriting-model-ir.v1" as const,
    modelKey: "standard_lbo_v1",
    modelVersion: "1.0.0",
    financialConventionVersion: "finnor.standard-lbo/1",
    minimumEngineVersion: "1.0.0",
    periodDefinition: { frequency: "annual" as const, forecastStart: "2027-01-01", count: 1 },
    nodes: [{
      id: "input.value",
      kind: "input" as const,
      valueType: "decimal" as const,
      unit: "money" as const,
      currency: "USD",
      shape: "scalar" as const,
      dependencies: [],
    }],
    circularBlocks: [],
  };
}

describe("P4 underwriting API and frontend truth contracts", () => {
  it("accepts canonical decimal strings and rejects ambiguous floats or formatted money", () => {
    expect(UnderwritingDecimalSchema.parse("12500000.075")).toBe("12500000.075");
    expect(UnderwritingDecimalSchema.safeParse(12.5).success).toBe(false);
    expect(UnderwritingDecimalSchema.safeParse("$12.5m").success).toBe(false);
  });

  it("accepts only strict Model registration and bounded immutable ModelVersion definitions", () => {
    expect(UnderwritingCreateModelSchema.parse({ investmentCaseId: UUID, modelKey: "standard_lbo_v1", name: "Base LBO" }))
      .toEqual({ investmentCaseId: UUID, modelKey: "standard_lbo_v1", name: "Base LBO" });
    expect(UnderwritingCreateModelSchema.safeParse({ investmentCaseId: UUID, modelKey: "standard_lbo_v1", name: "Base", tenantId: UUID_2 }).success).toBe(false);
    expect(UnderwritingCreateModelVersionSchema.parse({ definition: minimalModel() }).definition.nodes).toHaveLength(1);
    expect(UnderwritingCreateModelVersionSchema.safeParse({ definition: { ...minimalModel(), periodDefinition: { frequency: "annual", forecastStart: "2027-01-01", count: 241 } } }).success).toBe(false);
  });

  it("pins a Run to exact InvestmentCase, ModelVersion, worldAt and idempotency identity without actor spoofing", () => {
    const body = { investmentCaseId: UUID, modelVersionId: UUID_2, worldAt: "2026-06-30T23:59:59.000Z", idempotencyKey: "exact-run-1" };
    expect(UnderwritingCreateRunSchema.parse(body)).toEqual(body);
    expect(UnderwritingCreateRunSchema.safeParse({ ...body, tenantId: UUID, userId: UUID }).success).toBe(false);
    expect(UnderwritingCreateRunSchema.safeParse({ ...body, worldAt: "June 30" }).success).toBe(false);
  });

  it("keeps Scenario overrides explicit, bounded and parent-consistent", () => {
    const body = {
      investmentCaseId: UUID,
      modelVersionId: UUID_2,
      parentScenarioId: UUID,
      scenario: {
        schemaVersion: "underwriting-scenario.v1" as const,
        name: "Downside",
        parentScenarioId: UUID,
        overrides: [{ nodeId: "exit.multiple", value: "7", reason: "Explicit downside" }],
        semanticHash: SEMANTIC_HASH,
      },
    };
    expect(UnderwritingCreateScenarioSchema.parse(body)).toEqual(body);
    expect(UnderwritingCreateScenarioSchema.safeParse({ ...body, parentScenarioId: UUID_2 }).success).toBe(false);
    expect(UnderwritingCreateScenarioSchema.safeParse({ ...body, scenario: { ...body.scenario, overrides: Array.from({ length: 101 }, () => body.scenario.overrides[0]) } }).success).toBe(false);
  });

  it("enforces the exact 2,500-cell sensitivity ceiling and explicit output nodes", () => {
    const body = {
      baseRunId: UUID,
      idempotencyKey: "sensitivity-1",
      definition: {
        schemaVersion: "underwriting-sensitivity.v1" as const,
        name: "Entry / exit",
        rowAxis: { nodeId: "entry.multiple", values: Array.from({ length: 50 }, (_, index) => String(index + 1)) },
        columnAxis: { nodeId: "exit.multiple", values: Array.from({ length: 50 }, (_, index) => String(index + 1)) },
        outputNodeIds: ["gross_sponsor_moic"],
      },
    };
    expect(UnderwritingCreateSensitivitySchema.parse(body).definition.rowAxis.values).toHaveLength(50);
    expect(UnderwritingCreateSensitivitySchema.safeParse({
      ...body,
      definition: { ...body.definition, columnAxis: { nodeId: "exit.multiple", values: Array.from({ length: 51 }, (_, index) => String(index + 1)) } },
    }).success).toBe(false);
  });

  it("requires exact P3 DocumentVersion/ArtifactAnchor identities and an explicit output comparison policy", () => {
    const binding = {
      investmentCaseId: UUID,
      modelVersionId: UUID_2,
      documentId: UUID,
      documentVersionId: UUID_2,
      direction: "output" as const,
      bindingMode: "write_and_compare" as const,
      modelNodeId: "gross_sponsor_moic",
      anchorId: "cell:1!D5",
      anchorHash: HASH,
      comparisonPolicy: { mode: "EXACT_DECIMAL" as const },
    };
    expect(UnderwritingCreateArtifactBindingSchema.parse(binding)).toEqual(binding);
    expect(UnderwritingCreateArtifactBindingSchema.safeParse({ ...binding, documentVersionId: undefined }).success).toBe(false);
    expect(UnderwritingProjectionSchema.parse({ runId: UUID, documentId: UUID_2, baseVersionId: UUID, idempotencyKey: "projection-1" })).toBeTruthy();
    expect(UnderwritingArtifactComparisonSchema.parse({ runId: UUID, documentId: UUID_2, documentVersionId: UUID })).toBeTruthy();
  });

  it("publishes every required typed underwriting operation in OpenAPI", () => {
    const required = [
      "/api/investment-cases",
      "/api/investment-cases/{id}/underwriting",
      "/api/underwriting/models",
      "/api/underwriting/models/{id}/versions",
      "/api/underwriting/scenarios",
      "/api/underwriting/runs",
      "/api/underwriting/runs/{id}",
      "/api/underwriting/runs/{id}/explain",
      "/api/underwriting/runs/diff",
      "/api/underwriting/model-versions/{id}/affected",
      "/api/underwriting/model-versions/diff",
      "/api/underwriting/sensitivities",
      "/api/underwriting/sensitivities/{id}",
      "/api/underwriting/artifact-bindings",
      "/api/underwriting/projections",
      "/api/underwriting/comparisons",
    ];
    for (const path of required) expect(openapi.paths).toHaveProperty(path);
    expect(Object.keys(openapi.paths).filter((path) => path.includes("underwriting"))).toHaveLength(15);
  });

  it("authenticates every underwriting route and derives tenant/actor from the authenticated context", () => {
    const routeRoot = resolve(ROOT, "apps/api/app/api/underwriting");
    const routes: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.name === "route.ts") routes.push(readFileSync(path, "utf8"));
      }
    };
    visit(routeRoot);
    expect(routes).toHaveLength(14);
    for (const route of routes) {
      expect(route).toContain("requireContext(req)");
      expect(route).toContain("underwritingContext(auth)");
      expect(route).not.toMatch(/body\.(?:tenantId|userId|actorId)/);
    }
  });

  it("renders only exact selected-Run values with ModelVersion, node, unit, currency and period identity", () => {
    const workspace = source("apps/console/components/underwriting/WorkspaceClient.tsx");
    const values = source("apps/console/components/underwriting/ValuePanel.tsx");
    expect(workspace).toContain("Exact selected underwriting run");
    expect(workspace).toContain("result hash");
    expect(values).toContain("data-run-id={runId}");
    expect(values).toContain("data-model-version-id={modelVersionId}");
    expect(values).toContain("node.nodeId");
    expect(values).toContain("node.currency");
    expect(values).toContain("node.unit");
    expect(values).toContain("periodId");
  });

  it("keeps canonical Assumptions, Scenario overrides, P3 projection and Excel comparison visibly distinct", () => {
    const index = source("apps/console/app/underwriting/page.tsx");
    const workspace = source("apps/console/components/underwriting/WorkspaceClient.tsx");
    expect(index).toContain("canonical P1 InvestmentCase");
    expect(index).toContain("without a P4 model remains valid");
    expect(workspace).toContain("Canonical Assumption");
    expect(workspace).toContain("Scenario override");
    expect(workspace).toContain("P4 never writes Excel directly");
    expect(workspace).toContain("Microsoft publication and delegated Excel recalculation remain in the P3 Artifact Workspace");
    expect(workspace).toContain("exact graph traversal · no LLM");
  });
});
