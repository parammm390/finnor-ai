import { ZodError } from "zod";
import { OrganizationTransformationError } from "@finnor/private-equity/src/organization-transformation/contracts";
import { WorkforceAllocationError } from "@finnor/private-equity/src/workforce-allocation";
import { errorResponse } from "../../../../lib/auth";
export const organizationPrivateHeaders = {
  "cache-control": "no-store, private", "vary": "Authorization", "x-content-type-options": "nosniff",
};
export async function organizationJson(req: Request) {
  const reader = req.body?.getReader(), limit = 2 * 1024 * 1024;
  if (!reader) throw new OrganizationTransformationError("W5_INVALID_JSON", 400);
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new OrganizationTransformationError("W5_REQUEST_BYTE_BOUND", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks, length).toString("utf8")); }
  catch { throw new OrganizationTransformationError("W5_INVALID_JSON", 400); }
}
export function organizationHttpError(error: unknown) {
  if (error instanceof OrganizationTransformationError) return Response.json({ error: error.code },
    { status: error.status, headers: organizationPrivateHeaders });
  if (error instanceof WorkforceAllocationError) return Response.json({ error: error.code },
    { status: 409, headers: organizationPrivateHeaders });
  if (error instanceof ZodError) return Response.json({ error: "W5_INVALID_INPUT", issues: error.flatten() },
    { status: 400, headers: organizationPrivateHeaders });
  const response = errorResponse(error);
  for (const [name, value] of Object.entries(organizationPrivateHeaders)) response.headers.set(name, value);
  return response;
}
