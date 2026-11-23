import { randomUUID } from "node:crypto";
import { employeeAuthoritySnapshotTx } from "@finnor/authority";
import type { PoolClient } from "pg";
import type { PeMutationContext } from "../../types";
import { authorize, principal } from "../../owner-context";
import { withS5PortfolioTransaction as transaction } from "../../allocation-store";
import { productRuntimeIdentity } from "../../interaction-synthesis/product-runtime";
import { InteractionFault, digest, fail } from "../../interaction-synthesis/contracts";
import { LIMITS, type SubmitRequest } from "../../interaction-synthesis/product-contracts";
import { developmentOnly, workCutTx, sourceChangesTx, fixedMeaningsTx, protocolTx, enqueueTx,
  eventTx, currentChangesTx, checkedProtocolTx, invalidateTx } from "../../interaction-synthesis/store";
import { Z2_PRODUCT_LOCK, Z2_VERSION, LIMITS as Z2_LIMITS } from
  "../../../../epistemic-runtime/src/project-z/z2-coalitions/contracts";
import { coalitionProductRuntime } from "./runtime";
import type { NativeCoalitionArtifact } from "./contracts";
import { coalitionMarkerTx, coalitionChangesTx, type CoalitionMarker } from "./guard";

async function fallbackTx(ctx: PeMutationContext, c: PoolClient, request: SubmitRequest, episodeId: string) {
  const candidates = (await c.query<{ id: string }>(`SELECT id FROM finnor_os.y3_requests
    WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND status='CHECKED'
    AND NOT cancelled AND admission IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 33`,
    [ctx.auth.tenantId, principal(ctx), request.workId])).rows;
  if (candidates.length > 32) return null;
  for (const { id } of candidates) {
    const row = await protocolTx(ctx, c, id);
    if (row.episode_id !== episodeId || digest(row.root) !== digest(request.root) ||
      digest(row.request.problem) !== digest(request.problem) || digest(row.request.lowering) !== digest(request.lowering) ||
      digest(row.request.sources) !== digest(request.sources) || !await coalitionMarkerTx(c, row)) continue;
    try {
      const checked = await checkedProtocolTx(ctx, c, row.id);
      if (!(await coalitionChangesTx(c, checked)).length) return checked;
    } catch (error) { if (!(error instanceof InteractionFault)) throw error; }
  }
  return null;
}

/** Uses the original Y3 rows, quota and job type. Marker and enqueue are atomic. */
export async function submitCoalitionProtocol(ctx: PeMutationContext, request: SubmitRequest) {
  developmentOnly();
  if (Buffer.byteLength(JSON.stringify(request)) > Math.min(LIMITS.maxRequestBytes, Z2_LIMITS.maxRequestBytes))
    fail("Z2_REQUEST_BYTE_BOUND", 413);
  const runtime = await productRuntimeIdentity(), z2Runtime = await coalitionProductRuntime();
  return transaction(ctx, async c => {
    await authorize(ctx, request.root, [{ type: "work", id: request.workId }], [], c);
    const requestDigest = digest(request), old = (await c.query<{ id: string; request_digest: string }>(
      "SELECT id,request_digest FROM finnor_os.y3_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
      [ctx.auth.tenantId, principal(ctx), request.idempotencyKey])).rows[0];
    if (old) {
      const row = await protocolTx(ctx, c, old.id), marker = await coalitionMarkerTx(c, row);
      if (old.request_digest !== requestDigest || !marker || marker.requestDigest !== requestDigest)
        fail("Z2_IDEMPOTENCY_CONFLICT", 409);
      return { protocolId: row.id, workId: row.work_id, status: row.status, replayed: true };
    }
    if ((await sourceChangesTx(ctx, c, request)).length) fail("Z2_CURRENT_ORIGINAL_SOURCES_REQUIRED");
    const { theory } = await fixedMeaningsTx(ctx, c, request), work = await workCutTx(ctx, c, request.workId),
      authority = await employeeAuthoritySnapshotTx(ctx.auth, c);
    if (!work.executable || work.id !== theory.work_input_id) fail("Z2_CURRENT_EXECUTABLE_ORIGINAL_WORK_REQUIRED");
    const original = (await c.query<{ id: string; deadline_at: Date; attempts_used: number }>(
      "SELECT id,deadline_at,attempts_used FROM finnor_os.y3_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 FOR UPDATE",
      [ctx.auth.tenantId, principal(ctx), request.workId])).rows[0];
    if (original && (original.deadline_at.getTime() <= Date.now() || original.attempts_used >= LIMITS.maxAttempts))
      fail("Z2_ORIGINAL_EPISODE_EXHAUSTED");
    const episodeId = original?.id ?? randomUUID(), id = randomUUID(),
      deadline = new Date(Math.min(Date.now()+LIMITS.maxEpisodeWallMs, theory.deadline_at.getTime()));
    if (!original) await c.query("INSERT INTO finnor_os.y3_episodes(tenant_id,id,principal_id,work_id,deadline_at) VALUES($1,$2,$3,$4,$5)",
      [ctx.auth.tenantId, episodeId, principal(ctx), request.workId, deadline]);
    if (request.parentProtocolId) {
      const parent = await protocolTx(ctx, c, request.parentProtocolId);
      if (parent.work_id !== request.workId || parent.episode_id !== episodeId || digest(parent.root) !== digest(request.root))
        fail("Z2_ORIGINAL_PARENT_SCOPE");
    }
    const fallback = await fallbackTx(ctx, c, request, episodeId);
    await c.query(`INSERT INTO finnor_os.y3_requests(tenant_id,id,principal_id,root,work_id,work_input_id,work_input_digest,
      episode_id,theory_id,request,request_digest,runtime,rights_revision,idempotency_key,fallback_id)
      VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$15)`,
      [ctx.auth.tenantId, id, principal(ctx), JSON.stringify(request.root), request.workId, work.id, work.digest,
        episodeId, theory.id, JSON.stringify(request), requestDigest, JSON.stringify(runtime),
        String(authority.revision), request.idempotencyKey, fallback?.id ?? null]);
    const row = await protocolTx(ctx, c, id), marker: CoalitionMarker = {
      schema: "finnor.project-z.z2.required.v1", requestDigest, runtime: z2Runtime, productLockDigest: Z2_PRODUCT_LOCK,
      nativeOwnerContract: "INTERACTION_PROTOCOL_S4_EXACT_TERMS_CONSENT_S5_S6_V1"
    };
    await eventTx(c, row, "Z2_REQUIRED", "z2-required", marker);
    const jobId = await enqueueTx(c, { tenantId: row.tenant_id, principalId: row.principal_id, protocolId: id, generation: 1 }, id+":1");
    await eventTx(c, row, "ACCEPTED", "accepted", { requestDigest, runtime, z2RuntimeDigest: z2Runtime.digest,
      z2Version: Z2_VERSION, jobId, originalEpisodeId: episodeId, fallbackId: fallback?.id ?? null,
      fallbackRequiresExactOriginalProblemAndCoalitionCertificate: true, noNewResourceOrEffectAuthority: true });
    return { protocolId: id, workId: request.workId, status: "QUEUED", jobId, replayed: false };
  });
}

export async function readCoalitionProtocol(ctx: PeMutationContext, id: string) {
  developmentOnly();
  return transaction(ctx, async c => {
    const row = await protocolTx(ctx, c, id), marker = await coalitionMarkerTx(c, row);
    if (!marker) fail("Z2_ORIGINAL_PROTOCOL_UNAVAILABLE", 404);
    const changes = [...await currentChangesTx(ctx, c, row), ...await coalitionChangesTx(c, row)];
    await invalidateTx(c, row, changes);
    const artifact = row.artifact as NativeCoalitionArtifact | null;
    return { schema: "finnor.project-z.z2.work-projection.v1", protocolId: row.id, workId: row.work_id, root: row.root,
      current: !changes.length && !row.cancelled && row.status !== "INVALIDATED",
      status: row.cancelled ? "CANCELLED" : changes.length ? "STALE" : row.status, currentnessReasons: changes,
      artifact: artifact?.coalition ?? null, nativeProtocolRef: artifact?.envelope.contentRef ?? null,
      currentTermsId: row.current_terms_id, nativeAdmission: row.admission, lastKnownGoodFallbackId: row.fallback_id,
      originalResources: { episodeId: row.episode_id, deadlineAt: row.deadline_at.toISOString(), attemptsUsed: row.attempts_used,
        maxAttempts: LIMITS.maxAttempts, searchStepsOccupied: row.search_steps_used, retainedBytes: row.retained_bytes },
      actualCompliance: "UNKNOWN", protectedAdmission: false, productionActivated: false };
  });
}
