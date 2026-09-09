import { listArtifactTemplates, registerArtifactTemplate } from "@finnor/artifacts";
import { requireContext } from "../../../lib/auth";
import { artifactActor, artifactErrorResponse, boundedJson, requiredString, requiredUuid } from "../../../lib/artifacts";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const result = await listArtifactTemplates(artifactActor(await requireContext(req)));
    return Response.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return artifactErrorResponse(error); }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const actor = artifactActor(await requireContext(req));
    const body = await boundedJson(req, 16_384);
    const result = await registerArtifactTemplate(actor, requiredUuid(body.documentId, "INVALID_DOCUMENT_ID"), {
      versionId: requiredUuid(body.versionId, "INVALID_VERSION_ID"),
      templateKey: requiredString(body.templateKey, "INVALID_TEMPLATE_KEY", 160),
    });
    return Response.json(result, { status: 201 });
  } catch (error) { return artifactErrorResponse(error); }
}
