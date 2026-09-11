import { createIcCommitteeConfiguration } from "@finnor/private-equity";
import { handleIcPost, IcCommitteeConfigurationSchema } from "../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  return handleIcPost(req, IcCommitteeConfigurationSchema, createIcCommitteeConfiguration, 201);
}
