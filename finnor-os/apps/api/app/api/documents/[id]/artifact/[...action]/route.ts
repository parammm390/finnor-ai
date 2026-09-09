import {
  addArtifactComment,
  addArtifactLineage,
  applyArtifactPatch,
  artifactContext,
  bindArtifact,
  compareArtifacts,
  createDraft,
  getArtifact,
  publishArtifact,
  publishNewArtifactToMicrosoft,
  queryArtifactIR,
  readArtifactPublication,
  readArtifactProviderCreation,
  recalculateArtifactWorkbook,
  reviewArtifact,
  ArtifactError,
  type ArtifactPatch,
  type ArtifactCreateWriteMode,
  type ArtifactWriteMode,
} from "@finnor/artifacts";
import { requireContext } from "../../../../../../lib/auth";
import { artifactActor, artifactErrorResponse, boundedJson, requiredString, requiredUuid, UUID } from "../../../../../../lib/artifacts";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ id: string; action: string[] }> };

function segment(action: string[], index: number): string {
  return action[index] ?? "";
}

function boundedInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ArtifactError("INVALID_PAGINATION");
  return parsed;
}

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id, action } = await params;
    if (!UUID.test(id)) return Response.json({ error: "Invalid Document ID", code: "invalid_id" }, { status: 400 });
    const actor = artifactActor(await requireContext(req));
    const url = new URL(req.url);
    let result: unknown;
    if (segment(action, 0) === "versions" && action.length === 2) {
      const versionId = requiredUuid(segment(action, 1), "INVALID_VERSION_ID");
      const artifact = await getArtifact(actor, id, versionId);
      result = { version: artifact.version, heads: artifact.heads, semanticHash: artifact.ir.semanticHash, calculationStatus: artifact.calculationStatus, warnings: artifact.ir.warnings };
    } else if (segment(action, 0) === "ir" && action.length === 2) {
      const versionId = requiredUuid(segment(action, 1), "INVALID_VERSION_ID");
      const ids = url.searchParams.getAll("id").slice(0, 200);
      const kinds = url.searchParams.getAll("kind").slice(0, 20);
      result = await queryArtifactIR(actor, id, versionId, {
        ...(ids.length ? { ids } : {}),
        ...(kinds.length ? { kinds } : {}),
        ...(url.searchParams.get("search") ? { search: url.searchParams.get("search")! } : {}),
        ...(url.searchParams.get("sheetId") ? { sheetId: url.searchParams.get("sheetId")!.slice(0, 512) } : {}),
        ...(url.searchParams.get("address") ? { address: url.searchParams.get("address")!.slice(0, 128) } : {}),
        ...(url.searchParams.get("range") ? { range: url.searchParams.get("range")!.slice(0, 256) } : {}),
        ...(url.searchParams.get("dependencyOf") ? { dependencyOf: url.searchParams.get("dependencyOf")!.slice(0, 2_048) } : {}),
        ...(url.searchParams.get("dependentOf") ? { dependentOf: url.searchParams.get("dependentOf")!.slice(0, 2_048) } : {}),
        offset: boundedInteger(url.searchParams.get("offset"), 0),
        limit: boundedInteger(url.searchParams.get("limit"), 100),
      });
    } else if (segment(action, 0) === "diff") {
      result = await compareArtifacts(actor, id, requiredUuid(url.searchParams.get("left"), "INVALID_LEFT_VERSION"), requiredUuid(url.searchParams.get("right"), "INVALID_RIGHT_VERSION"));
    } else if (["comments", "reviews", "bindings", "lineage"].includes(segment(action, 0))) {
      const versionId = requiredUuid(url.searchParams.get("versionId"), "INVALID_VERSION_ID");
      const context = await artifactContext(actor, id, versionId);
      result = context[segment(action, 0) as "comments" | "reviews" | "bindings" | "lineage"];
    } else if (segment(action, 0) === "publications" && action.length === 2) {
      result = await readArtifactPublication(actor, id, requiredUuid(segment(action, 1), "INVALID_PUBLICATION_ID"));
      if (!result) return Response.json({ error: "Publication not found", code: "not_found" }, { status: 404 });
    } else if (segment(action, 0) === "provider-creations" && action.length === 2) {
      result = await readArtifactProviderCreation(actor, id, requiredUuid(segment(action, 1), "INVALID_PROVIDER_CREATION_ID"));
      if (!result) return Response.json({ error: "Provider creation not found", code: "not_found" }, { status: 404 });
    } else if (segment(action, 0) === "context" && action.length === 1) {
      result = await artifactContext(actor, id, requiredUuid(url.searchParams.get("versionId"), "INVALID_VERSION_ID"));
    } else {
      return Response.json({ error: "Unknown artifact operation", code: "not_found" }, { status: 404 });
    }
    return Response.json(result, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return artifactErrorResponse(error);
  }
}

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id, action } = await params;
    if (!UUID.test(id)) return Response.json({ error: "Invalid Document ID", code: "invalid_id" }, { status: 400 });
    const actor = artifactActor(await requireContext(req));
    const body = await boundedJson(req);
    let result: unknown;
    let responseStatus = 201;
    if (segment(action, 0) === "drafts") {
      result = await createDraft(actor, id, requiredUuid(body.baseVersionId, "INVALID_BASE_VERSION"));
    } else if (segment(action, 0) === "patches") {
      result = await applyArtifactPatch(actor, id, body as unknown as ArtifactPatch);
    } else if (segment(action, 0) === "comments") {
      result = await addArtifactComment(actor, id, {
        versionId: requiredUuid(body.versionId, "INVALID_VERSION_ID"),
        anchorId: requiredString(body.anchorId, "INVALID_ANCHOR", 2_048),
        anchorHash: requiredString(body.anchorHash, "INVALID_ANCHOR_HASH", 64),
        body: requiredString(body.body, "INVALID_COMMENT", 10_000),
        ...(body.parentCommentId ? { parentCommentId: requiredUuid(body.parentCommentId, "INVALID_PARENT_COMMENT") } : {}),
      });
    } else if (segment(action, 0) === "reviews") {
      const states = new Set(["requested", "approved", "changes_requested", "withdrawn", "comment_resolved"]);
      const state = requiredString(body.state, "INVALID_REVIEW_STATE", 40);
      if (!states.has(state)) throw new ArtifactError("INVALID_REVIEW_STATE");
      result = await reviewArtifact(actor, id, {
        versionId: requiredUuid(body.versionId, "INVALID_VERSION_ID"),
        state: state as "requested" | "approved" | "changes_requested" | "withdrawn" | "comment_resolved",
        ...(body.commentId ? { commentId: requiredUuid(body.commentId, "INVALID_COMMENT_ID") } : {}),
      });
    } else if (segment(action, 0) === "bindings") {
      const targetKind = requiredString(body.targetKind, "INVALID_BINDING_TARGET", 40);
      if (!["evidence_version", "canonical_entity", "document_version"].includes(targetKind)) throw new ArtifactError("INVALID_BINDING_TARGET");
      result = await bindArtifact(actor, id, {
        versionId: requiredUuid(body.versionId, "INVALID_VERSION_ID"),
        anchorId: requiredString(body.anchorId, "INVALID_ANCHOR", 2_048),
        anchorHash: requiredString(body.anchorHash, "INVALID_ANCHOR_HASH", 64),
        targetKind: targetKind as "evidence_version" | "canonical_entity" | "document_version",
        targetId: requiredUuid(body.targetId, "INVALID_TARGET_ID"),
        ...(body.targetEntityType ? { targetEntityType: requiredString(body.targetEntityType, "INVALID_TARGET_TYPE", 160) } : {}),
        ...(body.targetAnchor ? { targetAnchor: requiredString(body.targetAnchor, "INVALID_TARGET_ANCHOR", 2_048) } : {}),
      });
    } else if (segment(action, 0) === "lineage") {
      const relation = requiredString(body.relation, "INVALID_LINEAGE_RELATION", 40);
      if (!["supersedes", "derived_from", "copied_from", "template_instantiation", "rendered_from", "merged_from"].includes(relation)) throw new ArtifactError("INVALID_LINEAGE_RELATION");
      result = await addArtifactLineage(actor, {
        sourceVersionId: requiredUuid(body.sourceVersionId, "INVALID_SOURCE_VERSION"),
        targetVersionId: requiredUuid(body.targetVersionId, "INVALID_TARGET_VERSION"),
        relation: relation as "supersedes" | "derived_from" | "copied_from" | "template_instantiation" | "rendered_from" | "merged_from",
      });
    } else if (segment(action, 0) === "publish") {
      const mode = requiredString(body.mode, "INVALID_WRITE_MODE", 40) as ArtifactWriteMode;
      if (!["APP_ONLY_FILE_REPLACE", "DELEGATED_FILE_REPLACE"].includes(mode)) throw new ArtifactError("INVALID_WRITE_MODE");
      result = await publishArtifact(actor, {
        documentId: id,
        localVersionId: requiredUuid(body.localVersionId, "INVALID_LOCAL_VERSION"),
        baseVersionId: requiredUuid(body.baseVersionId, "INVALID_BASE_VERSION"),
        mode,
      });
      responseStatus = (result as { status?: string }).status === "conflict" ? 409 : 200;
    } else if (segment(action, 0) === "publish-new") {
      const mode = requiredString(body.mode, "INVALID_WRITE_MODE", 40) as ArtifactCreateWriteMode;
      if (!["APP_ONLY_FILE_CREATE", "DELEGATED_FILE_CREATE"].includes(mode)) throw new ArtifactError("INVALID_WRITE_MODE");
      if (body.conflictBehavior !== "fail") throw new ArtifactError("PROVIDER_CREATE_CONFLICT_BEHAVIOR_MUST_FAIL");
      result = await publishNewArtifactToMicrosoft(actor, {
        documentId: id,
        localVersionId: requiredUuid(body.localVersionId, "INVALID_LOCAL_VERSION"),
        integrationId: requiredUuid(body.integrationId, "INVALID_INTEGRATION_ID"),
        sourceScopeId: requiredUuid(body.sourceScopeId, "INVALID_SOURCE_SCOPE_ID"),
        driveId: requiredString(body.driveId, "INVALID_PROVIDER_DRIVE_ID", 1_024),
        parentItemId: requiredString(body.parentItemId, "INVALID_PROVIDER_PARENT_ID", 1_024),
        name: requiredString(body.name, "INVALID_PROVIDER_FILE_NAME", 255),
        mode,
        conflictBehavior: "fail",
      });
      responseStatus = (result as { status?: string }).status === "conflict" ? 409 : 200;
    } else if (segment(action, 0) === "recalculate") {
      const ranges = Array.isArray(body.ranges) ? body.ranges.filter((item): item is { worksheetId: string; address: string } => {
        return Boolean(item && typeof item === "object" && typeof (item as Record<string, unknown>).worksheetId === "string" && typeof (item as Record<string, unknown>).address === "string");
      }) : [];
      result = await recalculateArtifactWorkbook(actor, { documentId: id, versionId: requiredUuid(body.versionId, "INVALID_VERSION_ID"), ranges });
      responseStatus = 200;
    } else {
      return Response.json({ error: "Unknown artifact operation", code: "not_found" }, { status: 404 });
    }
    return Response.json(result, { status: responseStatus, headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return artifactErrorResponse(error);
  }
}
