import { randomUUID } from "node:crypto";
import type { PeMutationContext } from "../../types";
import { authorize } from "../../owner-context";
import { canonical, digest, parseInput, SubmitSchema, ProjectionSchema, RequestSchema, RevokeSchema,
  type SessionRow, type Profile, type Artifact } from "./contracts";
import { transaction, principal, profileTx, requestTx, eventTx, enqueueTx, artifactTx, reference, bestEffortTerminalAudit } from "./store";
import { inspectOwners, assertOwnerCutTx } from "./owners";
import { loadedBuild } from "./source";
import { recheckOriginalS8Admission } from "./native-s8";
/** Bounded private display, never substituted for the retained full proof.
 * Complete input/certificate/envelope/check remain immutable in artifact storage. */
function artifactProjection(artifact: Artifact) {
  const c = artifact.certificate, e = artifact.envelope;
  return { schema: "finnor.z5.native-artifact-projection.v1", ref: artifact.ref, fullProofRetained: true,
    fixedRevisions: artifact.payload.input.components.map(component => ({ id: component.id, revision: component.revision,
      correspondence: component.correspondence })),
    fullArtifactDigest: digest(artifact), envelopeProjection: {
      sourceCommit: e.sourceCommit, sourceTree: e.sourceTree, gaps: e.gaps, supportedDomain: e.supportedDomain,
      producerBuildIdentity: { sourceDigest: e.producerBuildIdentity.sourceDigest,
        installedBuildId: e.producerBuildIdentity.installedBuildId, node: e.producerBuildIdentity.node },
      costAndResourceReceiptReferences: e.costAndResourceReceiptReferences },
    certificate: { schema: c.schema, disposition: c.disposition, reasons: c.reasons, correspondence: c.correspondence,
      original: c.original, discharge: c.discharge, translation: c.translation, costs: c.costs,
      context: c.context ? { conditionality: c.context.conditionality, maximality: c.context.maximality,
        semantics: c.context.semantics, stateCount: c.context.states.length, edgeCount: c.context.edges.length } : null,
      replacement: c.replacement ? { status: c.replacement.status, component: c.replacement.component, revision: c.replacement.revision,
        reasons: c.replacement.reasons, preorder: c.replacement.preorder, bridge: c.replacement.bridge,
        relationPairs: c.replacement.relation.length } : null,
      originalCounterexample: c.originalCounterexample ? { ...c.originalCounterexample,
        steps: c.originalCounterexample.steps.slice(0, 128), complete: c.originalCounterexample.steps.length <= 128 } : null } };
}
function eventProjection(body: unknown) {
  const b = body as { kind: string; generation: number; detail?: Record<string, unknown> };
  const detail: Record<string, unknown> = {};
  for (const key of ["point", "processId", "deliveryId", "claimFence", "costRef", "reason", "disposition", "artifactDigest"])
    if (b.detail?.[key] !== undefined) detail[key] = b.detail[key];
  return { ref: reference("S4", "institution-composition-event", body), kind: b.kind, generation: b.generation, detail,
    fullEventRetained: true };
}

export async function submitInstitutionLink(ctx: PeMutationContext, raw: unknown) {
  const request = SubmitSchema.parse(raw);
  if (Buffer.byteLength(canonical(request)) > 65536) throw Error("Z5_REQUEST_BYTE_BOUND");
  const requestDigest = digest(request);
  const existing = await transaction(ctx, async c => {
    const prior = (await c.query<{ id: string }>(
      "SELECT id FROM finnor_os.z5_link_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3 FOR SHARE",
      [ctx.auth.tenantId, principal(ctx), request.idempotencyKey])).rows[0];
    if (!prior) return null;
    const row = await requestTx(ctx, c, prior.id);
    if (row.request_digest !== requestDigest) throw Error("Z5_ORIGINAL_IDEMPOTENCY_CONFLICT");
    return { requestId: row.id, workId: row.work_id, disposition: row.status, semanticReplay: true,
      newAllowance: false, executionAuthorityGranted: false };
  });
  if (existing) return existing;
  const profile = await transaction(ctx, c => profileTx(ctx, c, request.profileRef));
  if (profile.workId !== request.workId || digest(profile.root) !== digest(request.root)) throw Error("Z5_FIXED_PROFILE_WORK_ROOT_MISMATCH");
  const cut = await inspectOwners(ctx, request, profile), build = await loadedBuild();
  const input = parseInput({ ...profile.contract, live: cut.live }), id = randomUUID();
  return transaction(ctx, async c => {
    const prior = (await c.query<SessionRow>(
      `SELECT * FROM finnor_os.z5_link_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3 FOR UPDATE`,
      [ctx.auth.tenantId, principal(ctx), request.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.request_digest !== requestDigest) throw Error("Z5_ORIGINAL_IDEMPOTENCY_CONFLICT");
      return { requestId: prior.id, workId: prior.work_id, disposition: prior.status, semanticReplay: true,
        newAllowance: false, executionAuthorityGranted: false };
    }
    await assertOwnerCutTx(ctx, c, request, profile, cut);
    await c.query(`INSERT INTO finnor_os.z5_link_episodes(tenant_id,principal_id,work_id,deadline_at,parent_reservation,responsibility_identity)
      VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(tenant_id,principal_id,work_id) DO NOTHING`,
    [ctx.auth.tenantId, principal(ctx), request.workId, request.originalDeadline, canonical(request.parentReservation), request.responsibilityIdentity]);
    const episode = (await c.query<{ requests: number; deliveries: number; deadline_at: Date;
      parent_reservation: unknown; responsibility_identity: string }>(
      "SELECT * FROM finnor_os.z5_link_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 FOR UPDATE",
      [ctx.auth.tenantId, principal(ctx), request.workId])).rows[0]!;
    if (episode.deadline_at.getTime() !== Date.parse(request.originalDeadline)
      || digest(episode.parent_reservation) !== digest(request.parentReservation) || episode.responsibility_identity !== request.responsibilityIdentity)
      throw Error("Z5_ORIGINAL_EPISODE_CANNOT_RESTART_OR_REPLACE_ALLOWANCE");
    if (episode.requests >= 4 || episode.deliveries >= 4)
      return { requestId: null, workId: request.workId, disposition: "INCOMPLETE", reason: "ORIGINAL_EPISODE_EXHAUSTED",
        semanticReplay: false, newAllowance: false, exposureRetained: true, executionAuthorityGranted: false };
    await c.query("UPDATE finnor_os.z5_link_episodes SET requests=requests+1 WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3",
      [ctx.auth.tenantId, principal(ctx), request.workId]);
    await c.query(`INSERT INTO finnor_os.z5_link_requests
      (tenant_id,principal_id,id,work_id,root,request,request_digest,idempotency_key,input,cut,profile_ref,
       work_input_id,work_input_digest,rights_revision,source_digest,deadline_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16)`,
    [ctx.auth.tenantId, principal(ctx), id, request.workId, canonical(request.root), canonical(request), requestDigest,
      request.idempotencyKey, canonical(input), canonical(cut), canonical(request.profileRef), cut.workInputId,
      cut.workInputDigest, cut.rightsRevision, build.sourceDigest, request.originalDeadline]);
    const row = await requestTx(ctx, c, id);
    await eventTx(ctx, c, row, "ORIGINAL_FIXED_COMPONENT_LINK_REQUESTED", "submitted", {
      sourceDigest: build.sourceDigest, profileRef: request.profileRef, inputDigest: digest(input), liveDigest: cut.liveDigest,
      fixedRevisions: input.components.map(x => ({ id: x.id, revision: x.revision })), newComponentsSynthesized: 0 });
    await enqueueTx(ctx, c, row);
    return { requestId: id, workId: request.workId, disposition: "QUEUED", semanticReplay: false,
      newAllowance: false, executionAuthorityGranted: false };
  });
}
export async function readInstitutionLink(ctx: PeMutationContext, raw: unknown) {
  const input = RequestSchema.parse(raw);
  const row = await transaction(ctx, c => requestTx(ctx, c, input.requestId));
  if (row.work_id !== input.workId || digest(row.root) !== digest(input.root)) throw Error("Z5_EXACT_WORK_ROOT_REQUIRED");
  let current = !row.cancel_requested && !["STALE", "REVOKED", "CANCELLED", "UNKNOWN", "INCOMPLETE"].includes(row.status);
  let checked: { profile: Profile; cut: Awaited<ReturnType<typeof inspectOwners>> } | null = null;
  if (current) {
    try {
      const profile = await transaction(ctx, c => profileTx(ctx, c, row.profile_ref));
      const actual = await inspectOwners(ctx, row.request, profile), build = await loadedBuild();
      if (digest(actual) !== digest(row.cut) || row.source_digest !== build.sourceDigest) throw Error("Z5_OWNER_CUT_OR_SOURCE_CHANGED");
      if (row.admission) await recheckOriginalS8Admission(row, row.admission);
      checked = { profile, cut: actual };
    } catch {
      current = false;
    }
  }
  return transaction(ctx, async c => {
    const fresh = await requestTx(ctx, c, row.id);
    const stillCurrent = current && checked !== null && fresh.generation === row.generation && !fresh.cancel_requested
      && !["STALE", "REVOKED", "CANCELLED", "UNKNOWN", "INCOMPLETE"].includes(fresh.status);
    if (stillCurrent) await assertOwnerCutTx(ctx, c, fresh.request, checked!.profile, checked!.cut);
    const artifact = fresh.artifact_digest ? await artifactTx(ctx, c, fresh) : null;
    const events = (await c.query<{ body: unknown }>(
      "SELECT body FROM finnor_os.z5_link_events WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 ORDER BY sequence LIMIT 513",
      [row.tenant_id, row.principal_id, row.id])).rows;
    const attempts = (await c.query(
      "SELECT id,delivery_id,claim_fence,charge_ref,body,started_at,finished_at FROM finnor_os.z5_link_attempts WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 ORDER BY started_at LIMIT 5",
      [row.tenant_id, row.principal_id, row.id])).rows;
    const status = ["STALE", "REVOKED", "CANCELLED", "UNKNOWN", "INCOMPLETE"].includes(fresh.status) ? fresh.status
      : fresh.cancel_requested ? "CANCELLED" : stillCurrent ? fresh.status : "STALE";
    return { requestId: row.id, workId: row.work_id, root: row.root, status, storedStatus: fresh.status,
      statusComputedWithoutMutation: status !== fresh.status, current: stillCurrent,
      artifactDigest: fresh.artifact_digest, artifact: artifact ? artifactProjection(artifact) : null,
      profileRef: row.profile_ref, admission: stillCurrent ? fresh.admission : null,
      policyRef: row.request.policyRef, allocationRef: row.request.allocationRef,
      originalInputDigest: digest(row.input), sourceDigest: row.source_digest, liveDigest: row.cut.liveDigest,
      originalDeadline: row.request.originalDeadline, originalReservation: row.request.parentReservation,
      obligations: row.cut.originalObligationRefs, UNKNOWN: "NO_EXTERNAL_EFFECT_OR_INDEPENDENT_SETTLEMENT_INFERRED",
      events: events.slice(0, 512).map(x => eventProjection(x.body)), eventsComplete: events.length <= 512,
      attempts: attempts.map(a => ({ id: a.id, delivery_id: a.delivery_id, claim_fence: a.claim_fence,
        charge_ref: a.charge_ref, started_at: a.started_at, finished_at: a.finished_at,
        interruptedCostTail: "UNKNOWN_UNLESS_TERMINAL_EVIDENCE" })),
      gates: { architecture: "IMPLEMENTED_SOURCE", internalSoftware: "PUBLIC_ENGINEERING_ONLY",
        installedNative: "NOT_RUN", protectedAdmission: "BLOCKED_EXTERNAL", equippedIncrement: "NOT_RUN",
        operational100x: "NOT_RUN", financial100x: "NOT_RUN", production: "NOT_ACTIVATED" },
      mayUse: stillCurrent && artifact?.certificate.disposition === "CHECKED_CANDIDATE",
      protectedAdmission: false, executionAuthorityGranted: false };
  });
}
export async function institutionLinkProjection(ctx: PeMutationContext, raw: unknown) {
  const input = ProjectionSchema.parse(raw);
  const rows = await transaction(ctx, async c => {
    await authorize(ctx, input.root, [{ type: "work", id: input.workId }], [], c);
    return (await c.query<{ id: string }>(
      `SELECT id FROM finnor_os.z5_link_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND root=$4::jsonb
       ORDER BY created_at DESC,id DESC LIMIT 9`, [ctx.auth.tenantId, principal(ctx), input.workId, canonical(input.root)])).rows;
  });
  const requests = [];
  for (const row of rows.slice(0, 8)) requests.push(await readInstitutionLink(ctx, { ...input, requestId: row.id }));
  return { workId: input.workId, root: input.root, requests, complete: rows.length <= 8,
    protectedAdmission: false, executionAuthorityGranted: false };
}
export async function cancelInstitutionLink(ctx: PeMutationContext, raw: unknown) {
  const input = RequestSchema.parse(raw);
  const fence = await transaction(ctx, async c => {
    const row = await requestTx(ctx, c, input.requestId, true);
    if (row.work_id !== input.workId || digest(row.root) !== digest(input.root)) throw Error("Z5_EXACT_WORK_ROOT_REQUIRED");
    if (!row.cancel_requested) {
      await c.query("UPDATE finnor_os.z5_link_requests SET cancel_requested=true,status='CANCELLED',generation=generation+1 WHERE tenant_id=$1 AND id=$2",
        [row.tenant_id, row.id]);
      return { row: await requestTx(ctx, c, row.id), changed: true };
    }
    return { row, changed: false };
  });
  const auditRecorded = fence.changed ? await bestEffortTerminalAudit(ctx, async c => {
    const current = await requestTx(ctx, c, fence.row.id);
    await eventTx(ctx, c, current, "CANCELLED_KEEPING_OLD_OBLIGATIONS", "cancel", {
      cancellationIsNotCompensation: true, newAllowance: false, oldLiabilitiesAndPhysicalDebitsRetained: true });
  }) : null;
  return { requestId: fence.row.id, disposition: "CANCELLED", controlFenceCommitted: true,
    auditRecorded, auditGap: auditRecorded === false ? "TERMINAL_AUDIT_UNAVAILABLE" : null,
    exposureRetained: true, executionAuthorityGranted: false };
}
export async function revokeInstitutionProfile(ctx: PeMutationContext, raw: unknown) {
  const input = RevokeSchema.parse(raw);
  const rows = await transaction(ctx, async c => {
    const profile: Profile = await profileTx(ctx, c, input.profileRef);
    if (profile.workId !== input.workId || digest(profile.root) !== digest(input.root)) throw Error("Z5_EXACT_WORK_ROOT_REQUIRED");
    await c.query("UPDATE finnor_os.z5_component_profiles SET revoked_at=clock_timestamp(),revocation_reason=$4 WHERE tenant_id=$1 AND principal_id=$2 AND profile_id=$3",
      [ctx.auth.tenantId, principal(ctx), input.profileRef.id, input.reason]);
    return (await c.query<SessionRow>(`UPDATE finnor_os.z5_link_requests SET status='REVOKED',generation=generation+1
      WHERE tenant_id=$1 AND principal_id=$2 AND profile_ref->>'id'=$3 AND status<>'REVOKED' RETURNING *`,
    [ctx.auth.tenantId, principal(ctx), input.profileRef.id])).rows;
  });
  const auditRecorded = await bestEffortTerminalAudit(ctx, async c => {
    for (const row of rows) await eventTx(ctx, c, await requestTx(ctx, c, row.id), "FIXED_COMPONENT_CONTRACT_REVOKED", "revoked:" + input.profileRef.id,
      { reason: input.reason, originalObligationsAndReservationRetained: true, noCleanReset: true });
  });
  return { profileRef: input.profileRef, disposition: "REVOKED", requestsInvalidated: rows.length,
    controlFenceCommitted: true, auditRecorded, auditGap: auditRecorded ? null : "TERMINAL_AUDIT_UNAVAILABLE",
    exposureRetained: true, executionAuthorityGranted: false };
}
