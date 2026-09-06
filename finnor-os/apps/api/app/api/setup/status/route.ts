// Active setup readiness for Core + Private Equity. Historical Water policies and
// provider bindings are intentionally absent from this executable surface.

import { createDefaultPluginRegistry } from "@finnor/orchestration";
import { createHash } from "node:crypto";
import {
  testTenantVapiConnection,
  tenantResendStatus,
  circuitSnapshot,
  tenantSourceTruthReport,
} from "@finnor/tools";
import { testZepProviderConnection, embeddingsProviderStatus } from "@finnor/memory";
import { secretProviderStatus } from "@finnor/security";
import { adminDb, getPool, tenantPhoneNumbers } from "@finnor/db";
import { eq } from "drizzle-orm";
import { requireContext, errorResponse } from "../../../../lib/auth";
import { scanActionTypeReadiness, type ActionTypeDescriptor } from "../../../../../../packages/domain-plugins/shared/setup-readiness";

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const registry = createDefaultPluginRegistry();
    const descriptors: ActionTypeDescriptor[] = registry.actionTypes().map((actionType) => ({
      actionType,
      pluginName: registry.resolve(actionType)!.name,
    }));

    const [actionTypes, vapi, resend, phoneNumberRows, truth, zep] = await Promise.all([
      scanActionTypeReadiness(ctx.tenantId, descriptors),
      testTenantVapiConnection(ctx.tenantId),
      tenantResendStatus(ctx.tenantId),
      adminDb()
        .select({
          phoneNumber: tenantPhoneNumbers.phoneNumber,
          vapiPhoneNumberId: tenantPhoneNumbers.vapiPhoneNumberId,
          label: tenantPhoneNumbers.label,
        })
        .from(tenantPhoneNumbers)
        .where(eq(tenantPhoneNumbers.tenantId, ctx.tenantId)),
      tenantSourceTruthReport(ctx.tenantId),
      testZepProviderConnection(),
    ]);

    const integrations = { vapi, resend, zep, embeddings: embeddingsProviderStatus() };
    const summary = {
      actionTypesTotal: actionTypes.length,
      configured: actionTypes.filter((row) => row.status === "configured").length,
      gatedByChoice: actionTypes.filter((row) => row.status === "gated_by_choice").length,
      unconfigured: actionTypes.filter((row) => row.status === "unconfigured").length,
      integrationsHealthy: Object.values(integrations).filter((health) => health.healthy === true).length,
      integrationsUnhealthy: Object.values(integrations).filter((health) => health.healthy === false).length,
      readyForProduction:
        actionTypes.every((row) => row.status !== "unconfigured") &&
        Object.values(integrations).every((health) => health.healthy !== false) &&
        truth.ready,
    };

    const [databaseRole, circuitPairs] = await Promise.all([
      getPool().query<{ current_user: string; rolbypassrls: boolean }>(
        "SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
      Promise.all(["vapi", "resend"].map(async (provider) => [provider, await circuitSnapshot(provider, ctx.tenantId)] as const)),
    ]);
    const role = databaseRole.rows[0];
    const environment = {
      nodeEnv: process.env.NODE_ENV ?? "development",
      secretProvider: secretProviderStatus(),
      activeProductVertical: "private_equity",
      capabilities: {
        employee_voice: { provider: "vapi" },
        transactional_email: { provider: "resend" },
      },
      bootSafety: {
        authDevBypassConfigured: Object.hasOwn(process.env, "AUTH_DEV_BYPASS"),
        databaseRole: { currentUser: role?.current_user ?? "unknown", bypassRls: Boolean(role?.rolbypassrls) },
        databaseConnectionFingerprint: createHash("sha256").update(process.env.DATABASE_URL ?? "").digest("hex").slice(0, 16),
      },
    };

    return Response.json(
      {
        actionTypes,
        integrations,
        truth,
        summary,
        phoneRouting: { configured: phoneNumberRows.length > 0, numbers: phoneNumberRows },
        environment,
        circuitBreakers: Object.fromEntries(circuitPairs),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
