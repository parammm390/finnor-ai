import { artifactContext, getArtifact } from "@finnor/artifacts";
import { requireContext } from "../../../../../lib/auth";
import { artifactActor, artifactErrorResponse, requireReadableArtifact, UUID } from "../../../../../lib/artifacts";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    if (!UUID.test(id)) return Response.json({ error: "Invalid Document ID", code: "invalid_id" }, { status: 400 });
    const ctx = await requireContext(req);
    const actor = artifactActor(ctx);
    const requestedVersion = new URL(req.url).searchParams.get("versionId") ?? undefined;
    if (requestedVersion && !UUID.test(requestedVersion)) return Response.json({ error: "Invalid DocumentVersion ID", code: "invalid_id" }, { status: 400 });
    await requireReadableArtifact(ctx, id);
    const artifact = await getArtifact(actor, id, requestedVersion);
    const context = await artifactContext(actor, id, artifact.version.id);
    return Response.json({
      documentId: id,
      document: artifact.document,
      version: artifact.version,
      versions: artifact.versions,
      heads: artifact.heads,
      semantic: {
        schema: artifact.ir.schema,
        kind: artifact.ir.kind,
        semanticHash: artifact.ir.semanticHash,
        nodeCount: artifact.ir.nodes.length,
        warnings: artifact.ir.warnings,
        calculationStatus: artifact.calculationStatus,
      },
      comments: context.comments,
      reviews: context.reviews,
      bindings: context.bindings,
      lineage: context.lineage,
      publications: context.publications,
      providerCreations: context.providerCreations,
    }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return artifactErrorResponse(error);
  }
}
