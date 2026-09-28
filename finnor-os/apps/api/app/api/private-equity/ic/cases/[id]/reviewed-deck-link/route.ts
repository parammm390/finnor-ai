import { artifactContext, ArtifactError, getArtifact } from "@finnor/artifacts";
import { attachCanonicalDocument, getIcWorkspace, groundIcMemoDocumentVersion, PeDomainError } from "@finnor/private-equity";
import { artifactActor, artifactErrorResponse } from "../../../../../../../lib/artifacts";
import { requireContext } from "../../../../../../../lib/auth";
import { icContext, icErrorResponse, icJson, IcReviewedDeckLinkSchema, IcUuidSchema, parseIcBody } from "../../../../../../../lib/ic";
import { z } from "zod";

export const runtime = "nodejs";

const SELECTABLE_STATES = new Set(["DRAFT", "PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN", "READY_FOR_VOTE"]);
const CaseBasisSchema = z.object({
  state: z.string(), version: z.number().int().positive(), dealId: IcUuidSchema, investmentCaseId: IcUuidSchema,
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const [auth, body, route] = await Promise.all([requireContext(req), parseIcBody(req, IcReviewedDeckLinkSchema), params]);
    const ctx = icContext(auth);
    const icCaseId = IcUuidSchema.parse(route.id);
    const workspace = await getIcWorkspace(ctx, { icCaseId });
    const caseBasis = CaseBasisSchema.parse(workspace.case);
    if (!SELECTABLE_STATES.has(caseBasis.state)) {
      throw new PeDomainError("IC_DECK_CASE_NOT_SELECTABLE", "Select a new, active IC case before linking a reviewed deck");
    }
    if (caseBasis.version !== body.expectedCaseVersion) {
      throw new PeDomainError("IC_STALE_PRECONDITION", "IC case changed. Refresh and review its exact basis again");
    }

    const actor = artifactActor(ctx.auth);
    const artifact = await getArtifact(actor, body.documentId, body.documentVersionId);
    if (artifact.ir.kind !== "pptx") {
      throw new PeDomainError("IC_DECK_FORMAT_MISMATCH", "Only a persisted PPTX version can be linked as an IC deck");
    }
    const history = await artifactContext(actor, body.documentId, body.documentVersionId);
    if (history.reviews.length >= 200) {
      throw new PeDomainError("IC_DECK_REVIEW_LIMIT", "The bounded review history cannot prove the latest review for this version");
    }
    const latestReview = history.reviews.at(-1);
    if (latestReview?.state !== "approved") {
      throw new PeDomainError("IC_DECK_REVIEW_REQUIRED", "The exact deck version needs a recorded approval before IC linkage");
    }

    const linked = await attachCanonicalDocument(ctx, {
      dealId: caseBasis.dealId,
      entity: { entityType: "pe_investment_case", entityId: caseBasis.investmentCaseId },
      documentId: body.documentId,
      linkRole: "governing",
    });
    const readback = await groundIcMemoDocumentVersion(ctx, { icCaseId, documentId: body.documentId, documentVersionId: body.documentVersionId });
    if (readback.id !== body.documentVersionId || readback.documentId !== body.documentId) {
      throw new PeDomainError("IC_DECK_LINK_MISMATCH", "The Deal-root readback did not match the reviewed deck version");
    }
    return icJson({ link: linked.row, idempotent: linked.idempotent, documentVersion: readback }, linked.idempotent ? 200 : 201);
  } catch (error) {
    if (error instanceof ArtifactError || error instanceof Error && error.message.startsWith("DOCUMENT_VERSION_CONTENT_")) return artifactErrorResponse(error);
    return icErrorResponse(error);
  }
}
