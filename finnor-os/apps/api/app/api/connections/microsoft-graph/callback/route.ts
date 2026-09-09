import { completeMicrosoftGraphAdminConsent, Microsoft365AdministrationError } from "@finnor/data-platform";

export const runtime = "nodejs";
export const maxDuration = 300;

function consoleRedirect(status: string, code?: string): URL {
  const base = (process.env.CONSOLE_ORIGIN ?? "http://localhost:3101").split(",")[0]!.trim();
  const url = new URL("/settings/connections", base);
  url.searchParams.set("microsoft", status);
  if (code) url.searchParams.set("code", code);
  return url;
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const stateValues = url.searchParams.getAll("state");
  const tenantValues = url.searchParams.getAll("tenant");
  const consentValues = url.searchParams.getAll("admin_consent");
  const errorValues = url.searchParams.getAll("error");
  const redirect = (target: URL) => new Response(null, {
    status: 303,
    headers: { location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
  if (stateValues.length !== 1 || !stateValues[0] || stateValues[0].length > 512
      || tenantValues.length > 1 || (tenantValues[0]?.length ?? 0) > 64
      || consentValues.length > 1 || (consentValues[0]?.length ?? 0) > 8
      || errorValues.length > 1 || (errorValues[0]?.length ?? 0) > 128) {
    return redirect(consoleRedirect("failed", "invalid_callback"));
  }
  const adminConsent = consentValues[0]?.toLowerCase() === "true" && errorValues.length === 0;
  try {
    const result = await completeMicrosoftGraphAdminConsent({
      state: stateValues[0],
      returnedDirectoryTenantId: tenantValues[0] ?? null,
      adminConsent,
      providerErrorCode: errorValues[0] ?? null,
      traceId: (() => {
        const candidate = req.headers.get("x-correlation-id")?.trim();
        return candidate && candidate.length <= 160 && !/[\u0000-\u001f\u007f]/.test(candidate) ? candidate : undefined;
      })(),
    });
    return redirect(consoleRedirect(result.status === "active" ? "connected" : "degraded", result.status === "degraded" ? "effective_access_probe_failed" : undefined));
  } catch (error) {
    const code = error instanceof Microsoft365AdministrationError ? error.code : "callback_failed";
    return redirect(consoleRedirect("failed", code));
  }
}
