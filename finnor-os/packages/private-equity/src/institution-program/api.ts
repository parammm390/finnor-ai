import { z } from "zod";
import type { PeMutationContext } from "../types";
import { tx, principal, sha } from "../evidence-execution/store";
import { safePredicate } from "../program-synthesis/store";
import { readInstitutionHarnessProgram } from "../program-synthesis/institution";
import { handleProgramOperation } from "../program-synthesis/api";
import { InstitutionProgram } from "./contracts";
import { INSTITUTION_COMPLETION_CONTRACTS } from "./completion-contracts";
import { readInstitutionComputeCosts } from "./meter";
import {releaseUntouchedInstitutionDemand} from "../allocation-store";
import { authorizeInstitutionWork, assertInstitutionCompilerCurrent, compilerRow, compilerEvent,
  compilerEpisode, enqueueInstitutionCompiler, submitInstitutionCompiler,reconcileInstitutionCompilerDelivery } from "./store";

export const INSTITUTION_OPERATIONS = ["institution-submit", "institution-revise", "institution-read",
  "institution-status", "institution-cancel", "institution-resume", "institution-witness", "institution-sources"] as const;
const id = z.object({ requestId: z.string().uuid() }).strict();
const submit = z.object({ workId: z.string().uuid(), workInputId: z.string().uuid(),
  grantIds: z.array(z.string().uuid()).min(1).max(16), idempotencyKey: z.string().min(1).max(160) }).strict();

export async function readInstitutionCompiler(ctx: PeMutationContext, requestId: string) {
  let q = await compilerRow(ctx, requestId);
  await authorizeInstitutionWork(ctx, q.work_id);
  q=await reconcileInstitutionCompilerDelivery(ctx,q);
  const episode = await compilerEpisode(ctx, q.episode_id);
  const costs = { parentReservation: episode.parent_reservation, originalDeadline: episode.original_deadline.toISOString(),
    wallDeadline: episode.wall_deadline.toISOString(), acquisitionCalls: episode.acquisition_calls,
    compilerAttempts: episode.attempts, monetaryCost: null, monetaryCostStatus: "UNKNOWN",
    coordinationCalls: episode.coordination_calls,
    physicalCompute: await readInstitutionComputeCosts(ctx, q.work_id, episode.id),
    aggregatePeakMemoryBytes: null, humanSeconds: null };
  if (["CANCELLED", "INVALIDATED"].includes(q.status)) return { requestId: q.id, workId: q.work_id,
    workRevision: q.work_input_id, revision: q.revision, status: q.status, artifact: null,
    programme: null, reason: q.failure, costs, exposureRetained: true };
  const artifact = q.artifact_id ? await tx(ctx, async c => (await c.query<{
    body: unknown; body_digest: string; input_manifest: any; candidate: unknown; check_result: unknown;
  }>(`SELECT body,body_digest,input_manifest,candidate,check_result FROM finnor_os.x1_compiler_artifacts
    WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND request_id=$4`,
  [q.tenant_id, q.principal_id, q.artifact_id, q.id])).rows[0], true) : null;
  try {
    await assertInstitutionCompilerCurrent(ctx, q, artifact?.input_manifest?.current);
    if (artifact && sha(artifact.body) !== artifact.body_digest) throw Error("X1_IMMUTABLE_ARTIFACT_DIGEST_MISMATCH");
  } catch (error) {
    const reason = safePredicate(error);
    await tx(ctx, async c => {
      const current = await compilerRow(ctx, q.id, c, true);
      if (current.status !== "CANCELLED") {
        await c.query(`UPDATE finnor_os.x1_compiler_requests SET status='INVALIDATED',failure=$4,
          generation=generation+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
        [q.tenant_id, q.principal_id, q.id, reason]);
        await compilerEvent(ctx, current, "CURRENT_PROJECTION_WITHDRAWN", { reason, priorArtifactId: q.artifact_id,
          priorProgramId: q.program_id, costsRetained: true, possibleEffectsRetained: true }, c);
      }
    });
    return { requestId: q.id, workId: q.work_id, workRevision: q.work_input_id, revision: q.revision,
      status: "INVALIDATED", reason, artifact: null, programme: null, costs, exposureRetained: true };
  }
  const programme = q.program_id ? await readInstitutionHarnessProgram(ctx, q.program_id) : null;
  if(programme&&["OBSERVED","PARTIAL","INVALIDATED"].includes(programme.status)&&programme.status!==q.status)
    await tx(ctx,async c=>{await c.query(`UPDATE finnor_os.x1_compiler_requests SET status=$4,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND generation=$5 AND status NOT IN('CANCELLED','INVALIDATED')`,
      [q.tenant_id,q.principal_id,q.id,programme.status,q.generation]);});
  return { requestId: q.id, workId: q.work_id, workRevision: q.work_input_id, revision: q.revision,
    status: programme?.status ?? q.status, artifact: artifact ? InstitutionProgram.parse(artifact.body) : null,
    check: artifact?.check_result ?? null, programme, reason: q.failure, costs,
    canResume: ["FAILED", "UNKNOWN", "PARTIAL", "WAITING"].includes(q.status),
    canRevise: !["QUEUED", "RUNNING"].includes(q.status),
    executionAuthorityGranted: false, protectedQualification: "UNAVAILABLE" };
}

export async function handleInstitutionOperation(ctx: PeMutationContext, operation: string, body: unknown) {
  try {
    if (operation === "institution-submit") return { status: 202, body: await submitInstitutionCompiler(ctx, submit.parse(body)) };
    if (operation === "institution-revise") {
      const parsed = submit.extend({ parentRequestId: z.string().uuid() }).strict().parse(body);
      return { status: 202, body: await submitInstitutionCompiler(ctx, parsed) };
    }
    if (operation === "institution-sources") {
      const { workId } = z.object({ workId: z.string().uuid() }).strict().parse(body);
      await authorizeInstitutionWork(ctx, workId);
      return { status: 200, body: await tx(ctx, async c => {
        const grants = (await c.query(`SELECT id::text,source_id,source_class,protocol,revision,expires_at
          FROM finnor_os.x1_source_grants g WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3
          AND revoked_at IS NULL AND valid_from<=clock_timestamp() AND expires_at>clock_timestamp()
          AND NOT EXISTS(SELECT 1 FROM finnor_os.x1_source_grants n WHERE n.tenant_id=g.tenant_id
            AND n.work_id=g.work_id AND n.principal_id=g.principal_id AND n.source_id=g.source_id AND n.version>g.version)
          ORDER BY source_id LIMIT 17`, [ctx.auth.tenantId, principal(ctx), workId])).rows;
        const work = (await c.query("SELECT id::text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
          [ctx.auth.tenantId, workId])).rows[0];
        const request = (await c.query("SELECT id::text,status,revision FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY revision DESC LIMIT 1",
          [ctx.auth.tenantId, principal(ctx), workId])).rows[0] ?? null;
        return { workId, workInputId: work?.id ?? null, grants, request,
          completionContracts:INSTITUTION_COMPLETION_CONTRACTS };
      }, true) };
    }
    const { requestId } = id.parse(body);let q = await compilerRow(ctx, requestId);
    await authorizeInstitutionWork(ctx, q.work_id);
    if(operation==='institution-resume')q=await reconcileInstitutionCompilerDelivery(ctx,q);
    if (["institution-read", "institution-status", "institution-witness"].includes(operation))
      return { status: 200, body: await readInstitutionCompiler(ctx, requestId) };
    if (operation === "institution-cancel") {
      const programme=q.program_id?await readInstitutionHarnessProgram(ctx,q.program_id):null;
      if(programme?.status==="OBSERVED")return {status:200,body:{requestId,status:"OBSERVED",exposureRetained:true}};
      await tx(ctx, async c => {
        const current = await compilerRow(ctx, q.id, c, true);
        if (!["OBSERVED", "CANCELLED"].includes(current.status)) {
          await c.query(`UPDATE finnor_os.x1_compiler_requests SET status='CANCELLED',generation=generation+1,
            updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`, [q.tenant_id, q.principal_id, q.id]);
          await compilerEvent(ctx, current, "CANCELLED_RECONCILIATION_RETAINED", {
            parentEpisode: q.episode_id, parentReservationRetained: true, possibleEffectsRetained: true }, c);
        }
      });
      if (q.program_id) await handleProgramOperation(ctx, "program-cancel", { programId: q.program_id });
      let exposureRetained=true;
      const parent=await compilerEpisode(ctx,q.episode_id);
      if(!parent.parent_reservation)exposureRetained=false;
      else if(!q.program_id){
        try{await releaseUntouchedInstitutionDemand(ctx,parent.parent_reservation);exposureRetained=false;}
        catch{ /* Consumed/possible use retains the original exposure. */ }
      }
      return { status: 200, body: { requestId, status: "CANCELLED", exposureRetained } };
    }
    if (operation === "institution-resume") {
      await assertInstitutionCompilerCurrent(ctx, q);
      const episode = await compilerEpisode(ctx, q.episode_id);
      if (Date.now() >= episode.wall_deadline.getTime()) throw Error("X1_ORIGINAL_EPISODE_EXPIRED");
      if (q.program_id) return handleProgramOperation(ctx, "program-resume", { programId: q.program_id });
      if (!["FAILED", "UNKNOWN"].includes(q.status)) throw Error("X1_COMPILER_NOT_RESUMABLE");
      await tx(ctx, async c => {
        const current = await compilerRow(ctx, q.id, c, true);
        if (!["FAILED", "UNKNOWN"].includes(current.status)) throw Error("X1_RESUME_STATE_CHANGED");
        await c.query("UPDATE finnor_os.x1_compiler_requests SET status='QUEUED' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
          [q.tenant_id, q.principal_id, q.id]);
        await enqueueInstitutionCompiler(ctx, current, `resume-${episode.attempts}`, c);
      });
      return { status: 202, body: { requestId, status: "QUEUED", originalParentRetained: true } };
    }
    return { status: 404, body: { code: "NOT_FOUND" } };
  } catch (error) {
    if (error instanceof z.ZodError) return { status: 400, body: { code: "X1_BOUNDED_REQUEST_REQUIRED" } };
    if ((error as any).code === "PE_ENTITY_NOT_FOUND" || (error as Error).message.includes("authenticated scope"))
      return { status: 404, body: { code: "PE_ENTITY_NOT_FOUND", error: "Institution responsibility is unavailable in the authenticated scope" } };
    return { status: 422, body: { code: "X1_PREDICATE_UNPASSED", predicate: safePredicate(error) } };
  }
}
