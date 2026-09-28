/** Disposable Atlas fixture for Golden Flow 3. Never run against a release database. */
import { sql } from "drizzle-orm";
import { closePool, withTenant } from "@finnor/db";
import { createUnderwritingModel, createUnderwritingModelVersion, createUnderwritingRun, type ExplicitUnderwritingInput, type PeMutationContext } from "@finnor/private-equity";
import { buildPeriods, createStandardLboInputSnapshot, createStandardLboModel, decimal, type StandardLboInputValues, type StandardLboModelConfig } from "@finnor/underwriting";
import { GOLDEN_UNDERWRITING_CASES, type GoldenLboCase } from "../tests/underwriting-corpus/golden-cases";
import { assertDisposableDatabaseTarget } from "../packages/db/production-target-guard";

assertDisposableDatabaseTarget(process.env.DATABASE_URL, "CENTROPY exact growth-model fixture");
const tenantId = "00000000-0000-4000-8000-000000000001";
const investmentCaseId = "90000000-0000-4000-8000-000000000002";
const ownerEmail = process.env.TEST_OWNER_EMAIL;
if (!ownerEmail) throw new Error("TEST_OWNER_EMAIL is required");
const fixtureRevision = process.env.CENTROPY_GROWTH_FIXTURE_REVISION ?? "v1";
if (!/^v[1-9]\d{0,2}$/.test(fixtureRevision)) throw new Error("CENTROPY_GROWTH_FIXTURE_REVISION must be a bounded vN label");

async function main(): Promise<void> {
  try {
    const source = await withTenant(tenantId, async (db) => {
      const owner = await db.execute<{ id: string }>(sql`SELECT id::text FROM finnor_os.users WHERE tenant_id=${tenantId}::uuid AND email=${ownerEmail} AND role='owner' AND status='active' LIMIT 1`);
      const base = await db.execute<{ world_at: string }>(sql`
        SELECT world_at::text FROM finnor_os.underwriting_runs
        WHERE tenant_id=${tenantId}::uuid AND investment_case_id=${investmentCaseId}::uuid
          AND scenario_id IS NULL AND model_version_id IN (
            SELECT id FROM finnor_os.underwriting_model_versions WHERE tenant_id=${tenantId}::uuid AND version_key='phase9-e2e-v1'
          )
        ORDER BY computed_at DESC LIMIT 1
      `);
      return { ownerId: owner.rows[0]?.id, worldAt: base.rows[0]?.world_at };
    });
    if (!source.ownerId || !source.worldAt) throw new Error("The disposable Atlas owner and original base Run must exist");
    const golden = GOLDEN_UNDERWRITING_CASES.find((item): item is GoldenLboCase => item.kind === "lbo" && item.id === "01-simple-annual-single-tranche");
    if (!golden) throw new Error("The independent one-period LBO fixture is missing");
    const config: StandardLboModelConfig = structuredClone(golden.config);
    const periodId = buildPeriods(config.periodDefinition)[0]?.id;
    if (!periodId) throw new Error("The growth fixture has no forecast period");
    config.modelVersion = `centropy-growth-bps-e2e-${fixtureRevision}`;
    config.revenueMethod = "growth";
    config.ebitdaMethod = "margin";
    if (fixtureRevision !== "v1") config.inputBindings = {
      "exit.multiple": { kind: "p1_assumption", assumptionId: "90000000-0000-4000-8000-000000000004" },
    };
    const values: StandardLboInputValues = structuredClone(golden.inputs);
    values.investmentCaseId = investmentCaseId;
    values.worldAt = new Date(source.worldAt).toISOString();
    values.operating.baseRevenue = decimal("100");
    values.operating.growthRates = { [periodId]: decimal("0.10") };
    values.operating.ebitdaMargins = { [periodId]: decimal("0.20") };
    delete values.operating.revenue;
    delete values.operating.ebitda;
    const snapshot = createStandardLboInputSnapshot(config, values);
    const explicitInputs: Record<string, ExplicitUnderwritingInput> = Object.fromEntries(Object.entries(snapshot.values)
      .filter(([nodeId]) => !(fixtureRevision !== "v1" && nodeId === "exit.multiple"))
      .map(([nodeId, value]) => [nodeId, {
      value: value.value,
      truthClass: "MODEL_PARAMETER" as const,
      status: "KNOWN" as const,
      provenance: [{ kind: "model_parameter" as const, id: nodeId }],
    }]));
    const ctx: PeMutationContext = {
      auth: { tenantId, userId: source.ownerId, employeeId: source.ownerId, role: "owner" },
      provenance: { sourceSystem: "certification:centropy-growth-bps-local", createdBy: source.ownerId },
    };
    const model = await createUnderwritingModel(ctx, { investmentCaseId, modelKey: "standard_lbo_v1", name: "Atlas institutional LBO" });
    const version = await createUnderwritingModelVersion(ctx, { modelId: String(model.id), definition: createStandardLboModel(config) });
    const run = await createUnderwritingRun(ctx, {
      investmentCaseId, modelVersionId: String(version.id), worldAt: values.worldAt,
      idempotencyKey: `centropy-growth-bps-base-${fixtureRevision}`, explicitInputs,
    });
    if (run.result.status !== "SUCCEEDED" || run.result.validity !== "VALID") throw new Error("The growth-model base Run is not valid");
    console.log(JSON.stringify({ status: "ready", modelVersionId: version.id, baseRunId: run.id, investmentCaseId, periodId,
      baseGrowthRate: snapshot.values["operating.revenue_growth"]?.value, baseExitMultiple: snapshot.values["exit.multiple"]?.value,
      runStatus: run.result.status, runValidity: run.result.validity }));
  } finally { await closePool(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
