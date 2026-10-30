/**
 * Independent owner reads for the Z0 mounted scenario: admin SQL (O-SQL) and the
 * API called from Node with its own password grant (O-API). Neither is ever the
 * browser's token or the panel's code path.
 */
import { sha } from "./z0-mounted-lib.mts";

export type Q = (text: string, params?: unknown[]) => Promise<any[]>;
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const units = (value: unknown) => BigInt(typeof value === "number" ? value : String(value));

export async function witness(q: Q, parent: any) {
  const [reservations] = await q("SELECT count(*)::int count, md5(coalesce(string_agg(reservation_id||status||envelopes::text,'|' ORDER BY reservation_id),'')) digest FROM finnor_os.s5_reservations WHERE tenant_id=$1", [parent.tenantId]);
  const [charges] = await q("SELECT count(*)::int count, coalesce(sum(units),0)::text units FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1", [parent.tenantId]);
  const [sessions] = await q("SELECT count(*)::int count, count(cancel_requested_at)::int cancels, md5(coalesce(string_agg(id::text||status||generation::text,'|' ORDER BY id),'')) digest FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1", [parent.tenantId]);
  const [requests] = await q("SELECT count(*)::int count FROM finnor_os.application_semantics_requests WHERE tenant_id=$1", [parent.tenantId]);
  const [works] = await q("SELECT count(*)::int count, md5(coalesce(string_agg(id::text||status,'|' ORDER BY id),'')) digest FROM finnor_os.works WHERE tenant_id=$1", [parent.tenantId]);
  const [peRequests] = await q("SELECT count(*)::int count FROM finnor_os.pe_requests WHERE tenant_id=$1", [parent.tenantId]);
  const jobs = await q("SELECT type,status,count(*)::int n FROM finnor_os.jobs WHERE tenant_id=$1 AND type LIKE '%application%' GROUP BY 1,2 ORDER BY 1,2", [parent.tenantId]);
  return { reservations, charges, sessions, requests: requests.count, works, peRequests: peRequests.count, applicationJobs: jobs };
}

/** Everything a mounted fact is compared against for one original Work and one of its sessions. */
export async function readOwnerTruth(args: { q: Q; owner: any; parent: any; sessionId: string; acquisitionInput?: any }) {
  const { q, owner, parent, sessionId } = args;
  const root = { entityType: "pe_deal", entityId: parent.dealId };
  const [session] = await q("SELECT id,status,reason,generation,deadline_at,cancel_requested_at,reservation_ref,original_parent_ref,parent_id,request,work_id FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND id=$2", [parent.tenantId, sessionId]);
  const [episode] = await q("SELECT original_deadline,wall_deadline,attempts,acquisition_calls FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND id=$2", [parent.tenantId, parent.episodeId]);
  const [compiler] = await q("SELECT status,revision FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND id=$2", [parent.tenantId, parent.compilerRequestId]);
  const [reservation] = await q("SELECT status,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2", [parent.tenantId, parent.parentReservation.id]);
  const charges = await q("SELECT resource_id,unit,units::text units,phase,charge_key,created_at FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY created_at,charge_key", [parent.tenantId, parent.parentReservation.id]);
  const running = new Map<string, bigint>();
  const chargeRows = charges.map((row: any) => {
    const key = row.resource_id + "|" + row.unit;
    const after = (running.get(key) ?? 0n) + units(row.units);
    running.set(key, after);
    return { resourceId: row.resource_id, unit: row.unit, units: String(row.units), phase: row.phase, usedAfter: after.toString() };
  });
  const budget = (reservation?.envelopes ?? []).map((envelope: any) => {
    const limit = (envelope.quantities as unknown[]).reduce((sum: bigint, quantity) => sum + units(quantity), 0n);
    const used = running.get(envelope.resourceId + "|" + envelope.unit) ?? 0n;
    return { resourceId: envelope.resourceId, unit: envelope.unit, limit: limit.toString(), used: used.toString(), remaining: (limit - used).toString() };
  });
  const requests = await q("SELECT id,status,possible_egress,observation_ref IS NOT NULL observed FROM finnor_os.application_semantics_requests WHERE tenant_id=$1 AND session_id=$2 ORDER BY created_at,id", [parent.tenantId, sessionId]);
  const [accepted] = await q("SELECT body->'detail'->'acceptanceRef' ref FROM finnor_os.application_semantics_events WHERE tenant_id=$1 AND session_id=$2 AND kind='S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED' ORDER BY created_at DESC LIMIT 1", [parent.tenantId, sessionId]);
  const [consumed] = await q("SELECT count(*)::int n FROM finnor_os.p1_events WHERE tenant_id=$1 AND request_id=$2 AND kind='P1_ORIGINAL_APPLICATION_MODEL_CONSUMED'", [parent.tenantId, parent.programId]);
  const [work] = await q("SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [parent.tenantId, parent.workId]);
  const [program] = await q("SELECT jsonb_array_length(coalesce(body->'nodes','[]'::jsonb)) nodes, (SELECT count(*)::int FROM jsonb_array_elements(coalesce(body->'nodes','[]'::jsonb)) n WHERE n->'action' IS NOT NULL AND n->'action' <> 'null'::jsonb) executable FROM finnor_os.p1_programs WHERE tenant_id=$1 AND id=$2", [parent.tenantId, parent.headId]);

  const projectionCall = await owner.operation("application-projection", { root, workId: parent.workId });
  const projection = projectionCall.body;
  const api = projection?.sessions?.find((item: any) => item.id === sessionId) ?? null;
  const readCall = await owner.operation("institution-read", { requestId: parent.compilerRequestId });
  const institution = readCall.body;

  const disagreements: string[] = [];
  const same = (label: string, left: unknown, right: unknown) => { if (JSON.stringify(left) !== JSON.stringify(right)) disagreements.push(`${label}: sql=${JSON.stringify(left)} api=${JSON.stringify(right)}`); };
  if (projectionCall.status !== 200 || !api) disagreements.push(`application-projection status ${projectionCall.status} session ${api ? "found" : "missing"}`);
  else {
    same("status", session.status, api.status);
    same("deadline", iso(session.deadline_at), iso(api.deadlineAt));
    same("charge count", chargeRows.length, api.charges?.length);
    same("effect count", requests.length, api.effects?.length);
    same("budget", budget, (api.institutional?.budget?.resources ?? []).map((r: any) => ({ resourceId: r.resourceId, unit: r.unit, limit: r.limit, used: r.used, remaining: r.remaining })));
    same("consumed", consumed.n > 0, api.institutional?.modelConsumedByOriginalP1);
    same("original deadline", iso(episode.original_deadline), api.institutional?.originalDeadlineAt && iso(api.institutional.originalDeadlineAt));
    same("wall deadline", iso(episode.wall_deadline), api.institutional?.wallDeadlineAt && iso(api.institutional.wallDeadlineAt));
  }
  if (readCall.status !== 200) disagreements.push(`institution-read status ${readCall.status}`);
  else {
    same("compiler status", compiler.status, institution.status);
    same("compiler revision", compiler.revision, institution.revision);
    same("compiler attempts", episode.attempts, institution.costs?.compilerAttempts);
    same("acquisition units", episode.acquisition_calls, institution.costs?.acquisitionCalls);
  }

  const envelope = api?.model?.envelope ?? null;
  const claims = envelope ? [
    ...(envelope.observed_claims ?? []).map((c: any) => ({ cls: "observed", key: c.id })),
    ...(envelope.inferred_claims ?? []).map((c: any) => ({ cls: "inferred", key: c.id })),
    ...(envelope.predicted_claims ?? []).map((c: any) => ({ cls: "predicted", key: c.id })),
    ...(envelope.unresolved_claims ?? []).map((c: any) => ({ cls: "unresolved", key: c.code })),
  ] : [];

  const sessionRequest = session.request ?? {};
  return {
    root, sessionId, session: { status: session.status, reason: session.reason, generation: session.generation, deadlineAt: iso(session.deadline_at),
      cancelRequestedAt: session.cancel_requested_at ? iso(session.cancel_requested_at) : null, reservationId: session.reservation_ref?.id ?? null },
    request: { resourceDemand: sessionRequest.resourceDemand ?? args.acquisitionInput?.resourceDemand ?? null,
      targets: sessionRequest.targets ?? args.acquisitionInput?.targets ?? null,
      deadlineAt: sessionRequest.deadlineAt ?? args.acquisitionInput?.deadlineAt ?? null,
      sourceOfValues: sessionRequest.resourceDemand ? "O-SQL application_semantics_sessions.request" : "acquisition input held by the scenario" },
    episode: { originalDeadlineAt: iso(episode.original_deadline), wallDeadlineAt: iso(episode.wall_deadline), attempts: episode.attempts, acquisitionCalls: episode.acquisition_calls },
    compiler: { status: compiler.status, revision: compiler.revision },
    reservation: { id: parent.parentReservation.id, status: reservation?.status ?? null }, budget, charges: chargeRows,
    requests, acceptanceRefId: accepted?.ref?.id ?? null, consumedByOriginalP1: consumed.n > 0,
    workStatus: work?.status ?? null, program: { nodes: program?.nodes ?? 0, executable: program?.executable ?? 0 },
    api: { projectionStatus: projectionCall.status, projectionSha256: projectionCall.bodySha256, institutionReadStatus: readCall.status, institutionReadSha256: readCall.bodySha256,
      session: api, institution },
    claims, claimCounts: envelope ? { observed: envelope.observed_claims?.length ?? 0, inferred: envelope.inferred_claims?.length ?? 0,
      predicted: envelope.predicted_claims?.length ?? 0, unresolved: envelope.unresolved_claims?.length ?? 0 } : null,
    markers: [
      ["workId", parent.workId], ["dealId", parent.dealId], ["tenantId", parent.tenantId], ["ownerId", parent.ownerId], ["sessionId", sessionId],
      ["programId", parent.programId], ["compilerRequestId", parent.compilerRequestId], ["responsibilityIdentity", parent.responsibilityIdentity],
      ["reservationId", parent.parentReservation.id], ["institutionId", parent.institutionId], ["computeResource", parent.resources.compute], ["humanResource", parent.resources.human],
    ].map(([label, value]) => ({ label: String(label), value: String(value) })).filter(marker => marker.value.length >= 16),
    disagreements, truthSha256: sha({ budget, chargeRows, requests, status: session.status }),
  };
}
