import { randomUUID } from "node:crypto";
import { revisions, schemaIdentity, principal, tx, authorize } from "../evidence-execution/store";
import type { PeMutationContext } from "../types";
import { ProfileRegistrationSchema, SubmitSchema, WorkReadSchema, R4_METHOD, R4_CHECKER, type R4Profile, type R4RunRow } from "./contracts";
import { hash, stable } from "./exact";
import { resolveProfileOwners, currentOwners, scientificConsumers, decideOwner, retainFallback } from "./owners";
import { append, artifact, profile, runRow, runtimeIdentity, workCut, readArtifact, invalidate, costs, currentLocal } from "./store";
import { profileView, planView } from "./view";

export async function registerProfile(ctx: PeMutationContext, value: unknown) {
  const registration = ProfileRegistrationSchema.parse(value);
  const work = await workCut(ctx, registration.root, registration.workId, registration.workInputId);
  const owners = await resolveProfileOwners(ctx, registration);
  const runtime = await runtimeIdentity(), schemaDigest = await schemaIdentity(ctx), id = randomUUID();
  const dependencyKeys = [
    "rights:tenant", "work-inputs:" + registration.workId, "r4:work:" + registration.workId,
    "r4:profile:" + registration.workId + ":" + principal(ctx),
    ...owners.binding.S1.sourceHandles.map((s: any) => "evidence:" + s.sourceId),
    ...registration.problem.variables.flatMap(v => {
      const coordinates = [...owners.beliefPins];
      return coordinates.map(pin => "metric-series:" + pin.root.entityType + ":" + pin.root.entityId + ":*");
    }),
    "r4:s5-grant:" + registration.allocationRef.contentDigest,
    ...owners.binding.S5.resourceHeads.map((r: any) => "r4:s5-resource:" + r.id),
    "r4:s7:" + registration.estimandId, "r4:s7:" + registration.targetRecordId,
  ];
  const problem = structuredClone(registration.problem);
  problem.identities = { domain: "r4-owner-profile-v1", owners: "owner-cut:" + hash(owners.binding), method: R4_METHOD, checker: R4_CHECKER };
  const base = {
    id, tenantId: ctx.auth.tenantId, principalId: principal(ctx), root: registration.root,
    workId: registration.workId, workInputId: work.id, workInputDigest: work.digest,
    registration, problem, ownerBinding: owners.binding, beliefPins: owners.beliefPins,
    runtime, schemaDigest, knowledgeAt: new Date().toISOString(),
    qualification: "AUTHENTICATED_OWNER_DECLARATIONS_UNADMITTED" as const,
  };
  const result = await tx(ctx, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["r4:profile:" + ctx.auth.tenantId + ":" + principal(ctx) + ":" + registration.workId]);
    await workCut(ctx, registration.root, registration.workId, registration.workInputId, c, true);
    const previous = (await c.query("SELECT profile_id,revision FROM finnor_os.r4_profile_heads WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 FOR UPDATE",
      [ctx.auth.tenantId, principal(ctx), registration.workId])).rows[0];
    if ((previous?.profile_id ?? null) !== registration.priorProfileId) throw Error("R4_PROFILE_REVISION_COMPARE_AND_SWAP");
    const revision = Number(previous?.revision ?? 0) + 1;
    // The head change invalidates old claims through the canonical revision
    // trigger. Read the new dependency cut only AFTER that mutation.
    const provisional = { ...base, revision };
    const before = await revisions(ctx, dependencyKeys, c, true);
    const headKey = "r4:profile:" + registration.workId + ":" + principal(ctx);
    const dependencies = before.map(d => ({ key: d.key, revision: d.revision + (d.key === headKey ? 1 : 0) }));
    const ref = { owner: "S3", id: "r4-profile:" + id, version: "r4-profile-v1", contentDigest: hash({ ...provisional, dependencies }) };
    const body: R4Profile = { ...provisional, ref, dependencies };
    await c.query("INSERT INTO finnor_os.r4_profiles(id,tenant_id,principal_id,work_id,revision,body,digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
      [id, ctx.auth.tenantId, principal(ctx), registration.workId, revision, stable(body), hash(body)]);
    await c.query("INSERT INTO finnor_os.r4_profile_heads(tenant_id,principal_id,work_id,profile_id,revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,principal_id,work_id) DO UPDATE SET profile_id=excluded.profile_id,revision=excluded.revision",
      [ctx.auth.tenantId, principal(ctx), registration.workId, id, revision]);
    return body;
  });
  return { profileId: result.id, profileRef: result.ref, workId: result.workId, workRevision: result.workInputId,
    qualification: result.qualification, graphTruthEstablished: false, fieldIdentified: false,
    protectedAdmission: null, executionAuthorityGranted: false };
}

export async function submit(ctx: PeMutationContext, value: unknown) {
  const request = SubmitSchema.parse(value), p = await profile(ctx, request.envelope_inputs.profileId);
  if (stable(request.problem_ref) !== stable(p.ref) || stable(request.domain_profile_ref) !== stable(p.ref) ||
      request.existing_work_revision !== p.workInputId || stable(request.budget_grant_ref) !== stable(p.ownerBinding.S5.allocationRef))
    throw Error("R4_EXACT_PROFILE_WORK_GRANT_BINDING_REQUIRED");
  await currentOwners(ctx, p);
  const id = randomUUID();
  return tx(ctx, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["r4:submit:" + ctx.auth.tenantId + ":" + principal(ctx) + ":" + request.idempotencyKey]);
    const replay = (await c.query("SELECT id,request_digest,status FROM finnor_os.r4_runs WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
      [ctx.auth.tenantId, principal(ctx), request.idempotencyKey])).rows[0];
    if (replay) {
      if (replay.request_digest !== hash(request)) throw Error("R4_IDEMPOTENCY_REQUEST_CONFLICT");
      return { runId: replay.id, status: replay.status, replayed: true, workId: p.workId };
    }
    await currentLocal(ctx, p, c, true);
    const s4 = p.ownerBinding.S4, s5 = p.ownerBinding.S5;
    const deadline = Math.min(Date.now() + 3600000, Date.parse(s4.validUntil), Date.parse(s5.validUntil));
    await c.query("INSERT INTO finnor_os.r4_episodes(tenant_id,principal_id,owner_episode,policy_digest,grant_digest,deadline_at,max_native,owner_expansions_used,max_owner_expansions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(tenant_id,principal_id,owner_episode) DO NOTHING",
      [ctx.auth.tenantId, principal(ctx), s4.episodeId, s4.policyRef.contentDigest, s5.allocationRef.contentDigest, new Date(deadline).toISOString(), Math.min(64, s5.capacity), s4.initialOwnerExpansions, s4.maxOwnerExpansions]);
    const episode = (await c.query("SELECT id,deadline_at,policy_digest FROM finnor_os.r4_episodes WHERE tenant_id=$1 AND principal_id=$2 AND owner_episode=$3 AND grant_digest=$4 FOR SHARE",
      [ctx.auth.tenantId, principal(ctx), s4.episodeId, s5.allocationRef.contentDigest])).rows[0];
    if (!episode || new Date(episode.deadline_at).getTime() <= Date.now() || episode.policy_digest !== s4.policyRef.contentDigest)
      throw Error("R4_ORIGINAL_EPISODE_CANNOT_BE_RENEWED");
    await c.query("INSERT INTO finnor_os.r4_runs(id,tenant_id,principal_id,profile_id,episode_id,work_id,request,request_digest,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)",
      [id, ctx.auth.tenantId, principal(ctx), p.id, episode.id, p.workId, stable(request), hash(request), request.idempotencyKey]);
    for (const d of p.dependencies)
      await c.query("INSERT INTO finnor_os.r4_dependencies(tenant_id,principal_id,run_id,key,revision) VALUES($1,$2,$3,$4,$5)",
        [ctx.auth.tenantId, principal(ctx), id, d.key, d.revision]);
    await artifact(ctx, id, "INPUT", { problem: p.problem, profileRef: p.ref, originalEpisode: episode.id, originalDeadline: episode.deadline_at }, c);
    await append(ctx, id, "PROPOSED", { profileRef: p.ref, originalEpisode: episode.id, deadline: episode.deadline_at,
      admission: null, executionAuthorityGranted: false, noFreshEnvelopePerMask: true }, c);
    await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,priority,protocol_version,retry_safety,max_attempts) VALUES($1,'run_identification_plan_v1',$2::jsonb,$3,'interactive',0,1,'locally_idempotent',1)",
      [ctx.auth.tenantId, stable({ tenantId: ctx.auth.tenantId, principalId: principal(ctx), runId: id, generation: 1 }), "r4:" + id + ":1"]);
    return { schema: "finnor.r4.run-response.v1", runId: id, workId: p.workId, status: "INCOMPLETE",
      queueStatus: "QUEUED", artifact_ref: null, incumbent_ref: null,
      unresolved_claim_refs: ["INDEPENDENT_CHECK_PENDING"], resource_receipt_refs: [], originalDeadline: episode.deadline_at };
  });
}

async function reconcile(ctx: PeMutationContext, run: R4RunRow) {
  await tx(ctx, async c => {
    const rows = (await c.query("SELECT a.*,j.status job_status FROM finnor_os.r4_attempts a JOIN finnor_os.jobs j ON j.id=(a.body->>'jobId')::uuid WHERE a.tenant_id=$1 AND a.principal_id=$2 AND a.run_id=$3 AND a.status IN('INTENT','SUBMITTED') ORDER BY a.created_at",
      [ctx.auth.tenantId, principal(ctx), run.id])).rows;
    for (const row of rows) {
      if (row.job_status === "running") continue;
      let absent = false;
      if (row.body.pid) {
        try { process.kill(row.body.pid, 0); } catch (e) { absent = (e as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      const body = { ...row.body, reconciliation: "DEAD_OR_ABANDONED_QUEUE_DELIVERY",
        terminationObserved: absent, physicalOutcome: "UNKNOWN", costsRetained: true, refundGranted: false, physicalRetryGranted: false };
      await c.query("UPDATE finnor_os.r4_attempts SET status='UNKNOWN',body=$4::jsonb,digest=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
        [ctx.auth.tenantId, principal(ctx), row.id, stable(body), hash(body)]);
      await append(ctx, run.id, "UNKNOWN_RESPONSIBILITY", { attemptId: row.id, ...body }, c);
      await c.query("UPDATE finnor_os.r4_runs SET status='UNKNOWN',failure='R4_ABANDONED_NATIVE_ATTEMPT_NO_RETRY',updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND status='RUNNING'",
        [ctx.auth.tenantId, principal(ctx), run.id]);
    }
  });
}

export async function read(ctx: PeMutationContext, id: string, historical = false) {
  let run = await runRow(ctx, id);
  const p = await profile(ctx, run.profile_id);
  await authorize(ctx, p.root, [{ type: "work", id: p.workId }]);
  await reconcile(ctx, run);
  run = await runRow(ctx, id);
  if (historical) {
    const records = await tx(ctx, async c => ({
      artifacts: (await c.query("SELECT id,kind,body,digest FROM finnor_os.r4_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3 ORDER BY created_at,id", [ctx.auth.tenantId, principal(ctx), id])).rows,
      history: (await c.query("SELECT id,kind,body,digest,created_at FROM finnor_os.r4_history WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3 ORDER BY created_at,id", [ctx.auth.tenantId, principal(ctx), id])).rows,
    }), true);
    return { runId: id, workId: p.workId, status: run.status, historical: true, currentUseGranted: false, records, costs: await costs(ctx, id) };
  }
  if (!["INVALIDATED", "CANCELLED"].includes(run.status)) {
    try { await currentOwners(ctx, p); }
    catch {
      await invalidate(ctx, run, "R4_CURRENT_WORK_OWNER_SOURCE_METHOD_OR_SCHEMA_UNPASSED");
      run = await runRow(ctx, id);
    }
  }
  const current = !["INVALIDATED", "CANCELLED", "UNKNOWN"].includes(run.status);
  const checked = current && run.head_id ? await readArtifact(ctx, run.head_id) : null;
  const accepted = run.status === "COMPLETE" ? checked : null;
  const incumbent = checked?.plan.selected && run.status === "INCOMPLETE" ? checked : null;
  const checkedRef = checked ? { owner: "R4", id: run.head_id, version: "r4-artifact-v1", contentDigest: hash(checked) } : null;
  const resourceCosts = await costs(ctx, id);
  return { schema: "finnor.r4.read.v1", runId: id, workId: p.workId, workRevision: p.workInputId, status: run.status,
    artifact: accepted, artifact_ref: accepted ? checkedRef : null,
    incumbent, incumbent_ref: incumbent ? checkedRef : null,
    checkedReport_ref: checkedRef, unresolved_claim_refs: checked ? checked.gaps : [run.failure ?? "INDEPENDENT_CHECK_PENDING"],
    resource_receipt_refs: resourceCosts.attempts.map(a => ({ owner: "R4", id: a.id, version: "r4-native-receipt-v1", contentDigest: a.receiptDigest })),
    reason: run.failure, costs: resourceCosts, provisional: run.status !== "COMPLETE",
    admission: null, executionAuthorityGranted: false, attributionGranted: false };
}

export async function cancel(ctx: PeMutationContext, id: string) {
  const run = await runRow(ctx, id), p = await profile(ctx, run.profile_id);
  await authorize(ctx, p.root, [{ type: "work", id: p.workId }]);
  await tx(ctx, async c => {
    const locked = await runRow(ctx, id, c, true);
    if (["CANCELLED", "INVALIDATED"].includes(locked.status)) return;
    await c.query("UPDATE finnor_os.r4_runs SET status='CANCELLED',generation=generation+1,failure='R4_CANCELLED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [ctx.auth.tenantId, principal(ctx), id]);
    await append(ctx, id, "CANCEL_REQUESTED", { originalEpisode: run.episode_id, computeReleased: false,
      releaseCondition: "PHYSICAL_TERMINATION_ONLY", acquisitionsRetained: true, s6ObligationsRetained: true }, c);
  });
  return { runId: id, status: "CANCELLED", costs: await costs(ctx, id), computeRelease: "AWAIT_PHYSICAL_TERMINATION" };
}

export async function consume(ctx: PeMutationContext, id: string, disposition: "PROPOSE" | "DECLINE" | "WAIT") {
  const run = await runRow(ctx, id), p = await profile(ctx, run.profile_id);
  const current = await read(ctx, id);
  if (current.status !== "COMPLETE" || !current.artifact) return retainFallback(ctx, p, run, current.reason ?? current.status);
  await currentOwners(ctx, p);
  const scientific = await scientificConsumers(ctx, p, current.artifact.plan, current.artifact.claims.checkerRef);
  await append(ctx, id, "S4_PROPOSAL_INTENT", { disposition, originalEpisode: run.episode_id,
    utilityRef: p.ownerBinding.S4.utilityRef, admission: null });
  const decision = await decideOwner(ctx, p, run, current.artifact.plan, disposition, scientific.S2.ref);
  await currentOwners(ctx, p);
  const ref = await artifact(ctx, id, "CONSUMER", { scientific, decision });
  await append(ctx, id, "OWNER_CONSUMER_OBSERVED", { ref, disposition, executionAuthorityGranted: false });
  return { ref, scientific, decision, executionAuthorityGranted: false, reservationGranted: false, attributionGranted: false };
}

/** Exact existing Work, with principal-specific discovery, never a global list. */
export async function readWork(ctx: PeMutationContext, value: unknown) {
  const input = WorkReadSchema.parse(value);
  await workCut(ctx, input.root, input.workId);
  const head = await tx(ctx, async c => (await c.query(
    "SELECT profile_id FROM finnor_os.r4_profile_heads WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3",
    [ctx.auth.tenantId, principal(ctx), input.workId])).rows[0], true);
  const empty = { schema: "finnor.r4.work-view.v1", workId: input.workId, root: input.root,
    profile: null, run: null, reason: "NO_CURRENT_OWNER_REGISTERED_IDENTIFICATION_PROFILE",
    executionAuthorityGranted: false, attributionGranted: false };
  if (!head) return empty;
  const p = await profile(ctx, head.profile_id);
  if (stable(p.root) !== stable(input.root)) return empty;
  const latest = await tx(ctx, async c => (await c.query(
    "SELECT id FROM finnor_os.r4_runs WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND profile_id=$4 ORDER BY created_at DESC,id DESC LIMIT 1",
    [ctx.auth.tenantId, principal(ctx), p.workId, p.id])).rows[0], true);
  let result: Awaited<ReturnType<typeof read>> | null = null;
  if (latest) result = await read(ctx, latest.id);
  try { await currentOwners(ctx, p); }
  catch { return { ...empty, reason: "CURRENT_OWNER_WORK_SOURCE_OR_METHOD_REVALIDATION_UNPASSED" }; }
  return {
    ...empty, reason: result?.reason ?? null, profile: profileView(p),
    run: result ? { id: result.runId, status: result.status, workRevision: result.workRevision,
      artifactRef: result.artifact_ref, plan: result.artifact ? planView(result.artifact.plan) : null,
      gaps: result.unresolved_claim_refs, costs: result.costs, provisional: result.provisional,
      currentUseGranted: result.status === "COMPLETE" && result.artifact !== null } : null,
  };
}
