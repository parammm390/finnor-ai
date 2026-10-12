import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { authorizeBeliefResources } from "../enterprise-beliefs";
import { principal, sha, stable, tx, unavailable } from "../evidence-execution/store";
import { DigitalInstitutionProfile } from "./contracts";
import { readInstitutionMandate } from "./source-authority";
import type { InstitutionResourceDemand } from "./resource-demand";
import type { OriginalInstitutionEvidence } from "./checker";
import { institutionOwnerCutDigest } from "./canonical-json";
import { installedInstitutionCompilerIdentity } from "../../../capability-evolution/src/institution-port";

export const loadInstitutionProfile = () => DigitalInstitutionProfile.parse(JSON.parse(readFileSync(
  fileURLToPath(new URL("../../../../../scope-frontier5/x1-institutional-programme-compiler/profile.json", import.meta.url)), "utf8")));
export type CompilerRequestRow = {
  id: string; tenant_id: string; principal_id: string; work_id: string; work_input_id: string;
  work_input_digest: string; episode_id: string; revision: number; parent_request_id: string | null;
  generation: number; status: string; grant_ids: string[]; request_digest: string;
  claim_token: string | null; claim_fence: number | null; admission_id: string | null;
  program_id: string | null; artifact_id: string | null; failure: string | null;
  input_manifest: { current: OriginalInstitutionEvidence["current"] } | null;
  programme_digest: string | null; intent_digest: string | null;
};
export type CompilerEpisodeRow = { id: string; tenant_id: string; principal_id: string; work_id: string;
  institution_id: string; original_deadline: Date; wall_deadline: Date; profile_digest: string;
  parent_reservation: { owner: string; id: string; version: string; contentDigest: string } | null;
  parent_demand: InstitutionResourceDemand | null; acquisition_calls: number; attempts: number; coordination_calls:number };

export async function authorizeInstitutionWork(ctx: PeMutationContext, workId: string, c?: PoolClient) {
  await authorizeBeliefResources(ctx, [{ type: "work", id: workId }]);
  const read = async (client: PoolClient) => {
    const row = (await client.query(`SELECT w.id FROM finnor_os.works w JOIN finnor_os.users u
      ON u.tenant_id=w.tenant_id AND u.id=w.created_by
      WHERE w.tenant_id=$1 AND w.id=$2 AND w.created_by=$3 AND u.status='active' AND u.role='owner'`,
    [ctx.auth.tenantId, workId, principal(ctx)])).rows[0];
    if (!row) throw unavailable();
  };
  return c ? read(c) : tx(ctx, read, true);
}
export async function compilerRow(ctx: PeMutationContext, id: string, c?: PoolClient, lock = false) {
  const read = async (client: PoolClient) => {
    const row = (await client.query<CompilerRequestRow>(`SELECT * FROM finnor_os.x1_compiler_requests
      WHERE tenant_id=$1 AND principal_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`,
    [ctx.auth.tenantId, principal(ctx), id])).rows[0];
    if (!row) throw unavailable();
    const fence=row.claim_fence===null?null:Number(row.claim_fence);
    if(fence!==null&&(!Number.isSafeInteger(fence)||fence<1))throw Error("X1_CLAIM_FENCE_INVALID");
    return {...row,claim_fence:fence};
  };
  return c ? read(c) : tx(ctx, read, true);
}
export async function compilerEpisode(ctx: PeMutationContext, id: string, c?: PoolClient, lock = false) {
  const read = async (client: PoolClient) => {
    const row = (await client.query<CompilerEpisodeRow>(`SELECT * FROM finnor_os.x1_compiler_episodes
      WHERE tenant_id=$1 AND principal_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`,
    [ctx.auth.tenantId, principal(ctx), id])).rows[0];
    if (!row) throw unavailable();
    return row;
  };
  return c ? read(c) : tx(ctx, read, true);
}
export async function compilerEvent(ctx: PeMutationContext, q: CompilerRequestRow, kind: string,
  body: unknown, c?: PoolClient) {
  const write = (client: PoolClient) => client.query(`INSERT INTO finnor_os.x1_compiler_events
    (tenant_id,principal_id,request_id,generation,kind,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
  [q.tenant_id, q.principal_id, q.id, q.generation, kind, stable(body)]);
  return c ? write(c) : tx(ctx, write);
}

/** A vanished physical delivery is uncertainty, not a failed business effect.
 * Only the exact retained claim/delivery and expired or quarantined queue owner
 * can move an orphaned RUNNING projection to UNKNOWN. No replay is scheduled. */
export async function reconcileInstitutionCompilerDelivery(ctx:PeMutationContext,q:CompilerRequestRow){
  if(q.status!=='RUNNING')return q;
  return tx(ctx,async c=>{
    await authorizeInstitutionWork(ctx,q.work_id,c);
    const current=await compilerRow(ctx,q.id,c,true);
    if(current.status!=='RUNNING'||!current.claim_token||current.claim_fence===null)return current;
    const delivery=(await c.query(`SELECT j.id job_id,j.status job_status,j.lease_expires_at,
      a.id delivery_attempt_id,a.claim_token,a.claim_fence,a.outcome,a.failure_kind
      FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id AND a.tenant_id=j.tenant_id
      WHERE j.tenant_id=$1 AND j.type='run_x1_institution_compiler_v1' AND j.protocol_version=1
        AND j.payload->>'requestId'=$2 AND j.payload->>'principalId'=$3
        AND (j.payload->>'generation')::integer=$4 AND a.claim_token=$5 AND a.claim_fence=$6
        AND ((j.status='quarantined' AND a.outcome='reconciliation_required')
          OR (j.status='running' AND j.claim_token=$5 AND j.claim_fence=$6
            AND j.lease_expires_at<=clock_timestamp()))
      ORDER BY a.started_at DESC LIMIT 1 FOR SHARE OF j,a`,
      [current.tenant_id,current.id,current.principal_id,current.generation,current.claim_token,current.claim_fence])).rows[0];
    if(!delivery)return current;
    const failure='X1_COMPILER_DELIVERY_OUTCOME_UNCERTAIN';
    await c.query(`UPDATE finnor_os.x1_compiler_requests SET status='UNKNOWN',failure=$4,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,[current.tenant_id,current.principal_id,current.id,failure]);
    await compilerEvent(ctx,current,'COMPILER_ORPHANED_DELIVERY_RETAINED_UNKNOWN',{
      delivery,originalEpisode:current.episode_id,originalWorkInputId:current.work_input_id,
      admissionId:current.admission_id,artifactId:current.artifact_id,programId:current.program_id,
      possibleAdmissionsOrEffectsRetained:true,automaticReplayScheduled:false,
      physicalCostCoverage:'INTERRUPTED_ATTEMPT_RETAINS_CHARGES_AND_UNOBSERVED_ELAPSED_COST_GAP',
    },c);
    await compilerEvent(ctx,current,'COMPILER_INTERRUPTED_DELIVERY_METER_GAP',{
      jobId:delivery.job_id,deliveryAttemptId:delivery.delivery_attempt_id,originalEpisode:current.episode_id,
      reason:'Process disappeared before final elapsed-compute attribution; original charge history is retained',
      elapsedMs:null,monetaryCost:null,possibleEffectsRetained:true,
    },c);
    return {...current,status:'UNKNOWN',failure};
  });
}
export async function enqueueInstitutionCompiler(ctx: PeMutationContext, q: CompilerRequestRow,
  stage: string, c?: PoolClient) {
  const write = (client: PoolClient) => client.query(`INSERT INTO finnor_os.jobs
    (tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety)
    VALUES($1,'run_x1_institution_compiler_v1',$2::jsonb,$3,'interactive',1,'reconcilable')
    ON CONFLICT(idempotency_key) DO NOTHING`, [q.tenant_id, stable({ tenantId: q.tenant_id,
      principalId: q.principal_id, requestId: q.id, generation: q.generation, stage }),
    `x1-compiler:${q.id}:${q.generation}:${stage}`]);
  return c ? write(c) : tx(ctx, write);
}

export async function submitInstitutionCompiler(ctx: PeMutationContext, input: {
  workId: string; workInputId: string; grantIds: string[]; idempotencyKey: string; parentRequestId?: string;
}, automatic?: { updateId: string; execution: Readonly<JobExecutionContext> }) {
  if (process.env.NODE_ENV === "production" || process.env.FINNOR_P4_PROFILE !== "ordinary_disposable")
    throw Error("X1_PROTECTED_INSTALLATION_AND_ADMISSION_UNAVAILABLE");
  await authorizeInstitutionWork(ctx, input.workId);
  const profile = loadInstitutionProfile(), mandate = await readInstitutionMandate(ctx, input.workId);
  if (!mandate.rules.length || new Set(input.grantIds).size !== input.grantIds.length
      || !input.grantIds.length || input.grantIds.length > profile.bounds.sourceInstances)
    throw Error("X1_SOURCE_OR_NORMATIVE_RESPONSIBILITY_REQUIRED");
  const request = { ...input, grantIds: [...input.grantIds].sort() }, requestDigest = sha(request);
  const deadline = mandate.rules.map(rule => rule.deadlineAt).sort()[0]!;
  if (!Number.isFinite(Date.parse(deadline)) || Date.now() >= Date.parse(deadline)) throw Error("X1_ORIGINAL_DEADLINE_EXPIRED");
  return tx(ctx, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5510))", [ctx.auth.tenantId]);
    await authorizeInstitutionWork(ctx, input.workId, c);
    const old = (await c.query<CompilerRequestRow>(`SELECT * FROM finnor_os.x1_compiler_requests
      WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`,
    [ctx.auth.tenantId, principal(ctx), input.idempotencyKey])).rows[0];
    if (old) {
      if (old.request_digest !== requestDigest) throw Error("X1_IDEMPOTENCY_INTENT_CONFLICT");
      return { requestId: old.id, workId: old.work_id, workRevision: old.work_input_id,
        revision: old.revision, status: old.status, replayed: true };
    }
    // This internal handoff is checked in the acceptance transaction. Reclaim
    // may adopt an already accepted key, but cannot start new work after a
    // cancellation or after losing its physical queue claim.
    let automaticEpisode: string | undefined;
    if (automatic) {
      const update = (await c.query<{ episode_id: string; state: string; prepared_request: unknown }>(`
        SELECT episode_id,state,prepared_request FROM finnor_os.x1_compiler_updates
        WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND id=$4 FOR UPDATE`,
      [ctx.auth.tenantId, principal(ctx), input.workId, automatic.updateId])).rows[0];
      if (!update || update.state !== "PREPARED" || sha(update.prepared_request) !== sha(input))
        throw Error("X1_P7_PREPARED_HANDOFF_CHANGED");
      const execution = automatic.execution;
      if (execution.tenantId !== ctx.auth.tenantId || execution.protocolVersion !== 1
          || execution.retrySafety !== "reconcilable"
          || !(await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2
            AND type='run_x1_institution_update_v1' AND protocol_version=1 AND status='running'
            AND payload->>'updateId'=$5 AND payload->>'principalId'=$6
            AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE`,
          [ctx.auth.tenantId, execution.jobId, execution.claimToken, execution.claimFence,
            automatic.updateId, principal(ctx)])).rows[0])
        throw Error("X1_P7_UPDATE_CLAIM_FENCED");
      automaticEpisode = update.episode_id;
    }
    const latest = (await c.query<CompilerRequestRow>(`SELECT * FROM finnor_os.x1_compiler_requests
      WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
    [ctx.auth.tenantId, principal(ctx), input.workId])).rows[0];
    if (automatic) {
      const currentWork = (await c.query<{ status: string }>(`SELECT status FROM finnor_os.works
        WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [ctx.auth.tenantId, input.workId])).rows[0];
      if (!currentWork || currentWork.status === "cancelled" || latest?.status === "CANCELLED")
        throw Error("X1_P7_AUTOMATIC_PARENT_CANCELLED");
      if (latest?.episode_id !== automaticEpisode) throw Error("X1_P7_ORIGINAL_EPISODE_CHANGED");
    }
    if ((latest?.id ?? undefined) !== input.parentRequestId) throw Error("X1_EXACT_PARENT_REVISION_REQUIRED");
    const active = (await c.query<{ n: number }>(`SELECT count(DISTINCT episode_id)::int n
      FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND status IN('QUEUED','RUNNING')`,
    [ctx.auth.tenantId])).rows[0]!.n;
    if (active >= profile.bounds.concurrentCompilerEpisodes && !latest) throw Error("X1_CONCURRENT_COMPILER_BOUND");
    if (latest && ["QUEUED", "RUNNING"].includes(latest.status)) throw Error("X1_PREVIOUS_REVISION_IN_PROGRESS");
    const work = (await c.query<{ id: string; body: unknown }>(`SELECT id::text,to_jsonb(w) body
      FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2
      ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE`, [ctx.auth.tenantId, input.workId])).rows[0];
    if (work?.id !== input.workInputId) throw Error("X1_EXACT_WORK_REVISION_CHANGED");
    const grants = await c.query(`SELECT id FROM finnor_os.x1_source_grants WHERE tenant_id=$1
      AND principal_id=$2 AND work_id=$3 AND id=ANY($4::uuid[]) AND institution_id=$5
      AND revoked_at IS NULL AND valid_from<=clock_timestamp() AND expires_at>clock_timestamp() FOR SHARE`,
    [ctx.auth.tenantId, principal(ctx), input.workId, request.grantIds, mandate.institutionId]);
    if (grants.rowCount !== request.grantIds.length) throw unavailable();
    let episode = (await c.query<CompilerEpisodeRow>(`SELECT * FROM finnor_os.x1_compiler_episodes
      WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 FOR UPDATE`,
    [ctx.auth.tenantId, principal(ctx), input.workId])).rows[0];
    if (!episode) {
      episode = (await c.query<CompilerEpisodeRow>(`INSERT INTO finnor_os.x1_compiler_episodes
        (tenant_id,principal_id,work_id,institution_id,original_deadline,wall_deadline,profile_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [ctx.auth.tenantId, principal(ctx), input.workId,
        mandate.institutionId, deadline, new Date(Math.min(Date.parse(deadline), Date.now() + profile.bounds.episodeWallSeconds * 1000)),
        sha(profile)])).rows[0]!;
    }
    if (episode.profile_digest !== sha(profile) || episode.institution_id !== mandate.institutionId
        || Date.now() >= episode.wall_deadline.getTime() || episode.attempts >= 4)
      throw Error("X1_ORIGINAL_EPISODE_UNAVAILABLE_OR_EXHAUSTED");
    const id = randomUUID();
    await c.query(`INSERT INTO finnor_os.x1_compiler_requests
      (id,tenant_id,principal_id,work_id,work_input_id,work_input_digest,episode_id,idempotency_key,
       request_digest,grant_ids,revision,parent_request_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`, [id, ctx.auth.tenantId,
      principal(ctx), input.workId, work.id, sha(work.body), episode.id, input.idempotencyKey,
      requestDigest, stable(request.grantIds), (latest?.revision ?? 0) + 1, latest?.id ?? null]);
    const q = await compilerRow(ctx, id, c);
    await compilerEvent(ctx, q, "AUTHENTICATED_COMPILER_ACCEPTED", { sourceGrantIds: q.grant_ids,
      originalEpisode: episode.id, originalDeadline: episode.original_deadline.toISOString(),
      parentRequest: q.parent_request_id, suppliedInstitutionMapping: false }, c);
    await enqueueInstitutionCompiler(ctx, q, "initial", c);
    return { requestId: q.id, workId: q.work_id, workRevision: q.work_input_id,
      revision: q.revision, status: q.status, replayed: false };
  });
}

export async function assertInstitutionCompilerCurrent(ctx: PeMutationContext, q: CompilerRequestRow,
  manifest?: OriginalInstitutionEvidence["current"],
  c?: PoolClient, lock = false) {
  await authorizeInstitutionWork(ctx, q.work_id, c);
  if(manifest){
    if(!manifest.canonicalOwners || institutionOwnerCutDigest(manifest.canonicalOwners)!==manifest.canonicalRevision)
      throw Error("X1_CANONICAL_OWNER_CUT_REQUIRED");
    if((await installedInstitutionCompilerIdentity()).ref.contentDigest!==manifest.methodRevision)
      throw Error("X1_INSTALLED_COMPILER_METHOD_CHANGED");
    if(manifest.operationRevision!==sha([manifest.rightsRevision,manifest.authorizedOperations]))
      throw Error("X1_OPERATION_REVISION_BINDING_CHANGED");
  }
  const read = async (client: PoolClient) => {
    if (lock) await client.query("SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE", [q.tenant_id, q.work_id]);
    const latest = (await client.query<{ id: string; body: unknown }>(`SELECT id::text,to_jsonb(w) body
      FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [q.tenant_id, q.work_id])).rows[0];
    if (latest?.id !== q.work_input_id || sha(latest.body) !== q.work_input_digest) throw Error("X1_EXACT_WORK_REVISION_CHANGED");
    const head = (await client.query<{ id: string }>(`SELECT id FROM finnor_os.x1_compiler_requests
      WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY revision DESC LIMIT 1`,
    [q.tenant_id, q.principal_id, q.work_id])).rows[0];
    if (head?.id !== q.id) throw Error("X1_COMPILER_REVISION_SUPERSEDED");
    const grants = (await client.query<{ source_id: string; revision: string }>(`SELECT g.source_id,g.revision
      FROM finnor_os.x1_source_grants g WHERE g.tenant_id=$1 AND g.principal_id=$2
      AND g.work_id=$3 AND g.id=ANY($4::uuid[]) AND g.revoked_at IS NULL
      AND g.valid_from<=clock_timestamp() AND g.expires_at>clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM finnor_os.x1_source_grants n WHERE n.tenant_id=g.tenant_id
        AND n.principal_id=g.principal_id AND n.work_id=g.work_id AND n.source_id=g.source_id AND n.version>g.version)
      ${lock ? "FOR SHARE OF g" : ""}`, [q.tenant_id, q.principal_id, q.work_id, q.grant_ids])).rows;
    if (grants.length !== q.grant_ids.length) throw Error("X1_SOURCE_GRANT_REVOKED_OR_SUPERSEDED");
    if (manifest) {
      await client.query("SELECT finnor_os.x1_assert_canonical_owner_cut($1::jsonb,$2)",
        [stable(manifest.canonicalOwners),lock]);
      if (grants.some(g => manifest.sourceRevisions[g.source_id] !== g.revision)) throw Error("X1_SOURCE_REVISION_CHANGED");
      const rights = (await client.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1", [q.tenant_id])).rows[0];
      const mandates = (await client.query<{ revision: string }>(`SELECT revision FROM finnor_os.x1_work_mandates
        WHERE tenant_id=$1 AND work_id=$2 AND principal_id=$3 AND revoked_at IS NULL
        AND valid_from<=clock_timestamp() AND expires_at>clock_timestamp()`, [q.tenant_id, q.work_id, q.principal_id])).rows;
      if (String(rights?.revision) !== manifest.rightsRevision) throw Error("X1_RIGHTS_REVISION_CHANGED");
      if (mandates.length !== 1 || mandates[0]!.revision !== manifest.mandateRevision) throw Error("X1_MANDATE_REVISION_CHANGED");
      for(const subject of manifest.sensitiveSubjects??[]){
        if(!subject.registrations.length||subject.registrations.length>200)throw Error("X1_SENSITIVE_SUBJECT_BOUND");
        const consent=await client.query<{registration_id:string}>(`SELECT b.registration_id
          FROM finnor_os.x1_subject_identity_bindings b JOIN finnor_os.x1_subject_consents co
            ON co.tenant_id=b.tenant_id AND co.subject_user_id=b.subject_user_id AND co.institution_id=b.institution_id
            AND co.source_class=$4 AND co.purpose=$5
          JOIN finnor_os.users u ON u.tenant_id=b.tenant_id AND u.id=b.subject_user_id
          WHERE b.tenant_id=$1 AND b.institution_id=$2 AND b.source_id=$3 AND b.registration_id=ANY($6::text[])
            AND b.revoked_at IS NULL AND b.valid_from<=clock_timestamp() AND b.expires_at>clock_timestamp()
            AND co.revoked_at IS NULL AND co.granted_at<=clock_timestamp() AND co.expires_at>clock_timestamp()
            AND u.status='active'${lock?" FOR SHARE OF b,co,u":""}`,
        [q.tenant_id,subject.institutionId,subject.sourceId,subject.sourceClass,subject.purpose,subject.registrations]);
        if(consent.rows.length!==subject.registrations.length)throw Error("X1_SENSITIVE_CONSENT_CHANGED");
      }
    }
  };
  return c ? read(c) : tx(ctx, read, true);
}
