import { ArtifactError, createBlankArtifact } from "@finnor/artifacts";
import { requireContext } from "../../../lib/auth";
import { artifactActor, artifactErrorResponse, boundedJson, requiredString } from "../../../lib/artifacts";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const actor = artifactActor(await requireContext(req));
    const body = await boundedJson(req, 16_384);
    const kind = requiredString(body.kind, "INVALID_ARTIFACT_KIND", 8);
    if (!["xlsx", "docx", "pptx"].includes(kind)) throw new ArtifactError("INVALID_ARTIFACT_KIND");
    const result = await createBlankArtifact(actor, { kind: kind as "xlsx" | "docx" | "pptx", title: requiredString(body.title, "INVALID_ARTIFACT_TITLE", 500) });
    return Response.json({ documentId: result.documentId, version: result.version, semanticHash: result.ir.semanticHash }, { status: 201 });
  } catch (error) {
    return artifactErrorResponse(error);
  }
}
