import { instantiateArtifactTemplate } from "@finnor/artifacts";
import { requireContext } from "../../../../../lib/auth";
import { artifactActor, artifactErrorResponse, boundedJson, requiredString } from "../../../../../lib/artifacts";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }): Promise<Response> {
  try {
    const actor = artifactActor(await requireContext(req));
    const { key } = await params;
    const body = await boundedJson(req, 16_384);
    const result = await instantiateArtifactTemplate(actor, { templateKey: requiredString(key, "INVALID_TEMPLATE_KEY", 160), title: requiredString(body.title, "INVALID_ARTIFACT_TITLE", 500) });
    return Response.json(result, { status: 201 });
  } catch (error) { return artifactErrorResponse(error); }
}
