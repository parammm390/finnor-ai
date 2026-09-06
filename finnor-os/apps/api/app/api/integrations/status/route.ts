// Active integration status after the Water retirement. Historical provider
// bindings remain auditable in storage but are never advertised as capabilities.

import {
  testTenantVapiConnection,
  testTenantVapiAssistants,
  tenantResendStatus,
  tenantSourceTruthReport,
} from "@finnor/tools";
import { requireContext, errorResponse } from "../../../../lib/auth";

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const [vapi, voiceAssistants, resend, truth] = await Promise.all([
      testTenantVapiConnection(ctx.tenantId),
      testTenantVapiAssistants(ctx.tenantId),
      tenantResendStatus(ctx.tenantId),
      tenantSourceTruthReport(ctx.tenantId),
    ]);
    const integrations = { vapi, resend };
    const summary = {
      configuredCount: Object.values(integrations).filter((health) => health.configured).length,
      healthyCount: Object.values(integrations).filter((health) => health.healthy === true).length,
      unhealthyCount: Object.values(integrations).filter((health) => health.healthy === false).length,
    };
    return Response.json(
      {
        integrations,
        voiceAssistants,
        capabilities: {
          employee_voice: { provider: "vapi", active: true },
          transactional_email: { provider: "resend", active: true },
        },
        summary,
        truth,
        activeProductVertical: "private_equity",
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
