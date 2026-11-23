import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction, transactionDb, ingestIntegrationEventTx } from "@finnor/db";
import { canExerciseWorkforceAuthorityTx } from "@finnor/authority";
import { createEvidenceSourceTx, appendEvidenceVersionTx } from "@finnor/memory";
import type { TenantContext, ExperimentRef } from "@finnor/shared-types";
import { assertWorkforceBudgetTx, type WorkforceBudget } from "../workforce-allocation";
import { organizationDigest, organizationCanonical, parseOrganizationTransformation } from "./compiler";
import { checkOrganizationTransformation } from "./checker";
import { OrganizationTransformationError, type OrganizationTransformationInput,
  type OrganizationTransformationProgram, type LiveOrganizationObligation } from "./contracts";

export interface OrganizationRequestRow {
  tenant_id: string; id: string; principal_id: string; company_id: string; work_id: string; work_input_id: string;
  idempotency_key: string; request_digest: string; original_digest: string; original_input_digest: string; original: OrganizationTransformationInput;
  source_id: string; source_version_id: string; source_digest: string; budget: WorkforceBudget;
  rights_revision: string; original_deadline: Date; status: string; revision: number; generation: number;
  program: OrganizationTransformationProgram | null; program_digest: string | null; check_result: unknown;
  plan_revision_id: string | null; job_id: string | null; last_error: string | null;
}
export const principal = (ctx: TenantContext) => ctx.employeeId ?? ctx.userId;
export const rawDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export const orgTx = <T>(ctx: TenantContext, fn: (c: PoolClient) => Promise<T>) =>
  withTenantTransaction(ctx.tenantId, { userId: principal(ctx) }, async (_db, c) => fn(c));
export function orgFail(code: string, status = 409): never { throw new OrganizationTransformationError(code, status); }
export async function orgLock(ctx: TenantContext, c: PoolClient) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["s5-portfolio:" + ctx.tenantId]);
}
export async function orgActor(ctx: TenantContext, c: PoolClient, owner = false) {
  if (principal(ctx) !== ctx.userId) orgFail("W5_CANONICAL_PRINCIPAL_REQUIRED", 403);
  const row = (await c.query("SELECT id,role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",
    [ctx.tenantId, principal(ctx)])).rows[0];
  if (!row || owner && (row.role !== "owner" || ctx.role !== "owner")) orgFail("W5_CONTEXT_UNAVAILABLE", 404);
  return row;
}
export async function orgAuthority(ctx: TenantContext, c: PoolClient, workId: string, write: boolean) {
  await orgActor(ctx, c, write);
  if (!await canExerciseWorkforceAuthorityTx(ctx, { operation: write ? "action" : "query",
    capability: write ? "action:workforce_assign_contract" : "query:work", risk: "low",
    workId, resource: { type: "work", id: workId } }, c)) orgFail("W5_CURRENT_WORK_AUTHORITY_REQUIRED", 403);
}
export async function orgRow(ctx: TenantContext, id: string, c: PoolClient, lock = false) {
  const row = (await c.query<OrganizationRequestRow>("SELECT * FROM finnor_os.w5_requests WHERE tenant_id=$1 AND id=$2 AND principal_id=$3" +
    (lock ? " FOR UPDATE" : ""), [ctx.tenantId, id, principal(ctx)])).rows[0];
  if (!row) orgFail("W5_CONTEXT_UNAVAILABLE", 404);
  return row;
}
export async function orgEvidence(ctx: TenantContext, workId: string, key: string, value: unknown, c: PoolClient) {
  const db = transactionDb(c), content = organizationCanonical(value);
  const source = await createEvidenceSourceTx(db, ctx.tenantId, { sourceKey: "organization:" + workId + ":" + key,
    sourceType: "organization_authenticated_record", title: "Authenticated operating-organization record",
    metadata: { workId, authenticatedPrincipal: principal(ctx), instructionEligible: false,
      evidenceTrust: "untrusted_evidence", fieldTruthEstablished: false } });
  const version = await appendEvidenceVersionTx(db, ctx.tenantId, source.id, { content,
    snapshot: { workId, authenticatedPrincipal: principal(ctx), instructionEligible: false },
    entityRefs: [{ type: "work", id: workId }] });
  const row = (await c.query("SELECT version_number,content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2",
    [ctx.tenantId, version.versionId])).rows[0];
  if (!row || row.content_hash !== rawDigest(content)) orgFail("W5_S1_PREIMAGE_UNAVAILABLE");
  return { sourceId: source.id, ref: { owner: "S1", id: version.versionId,
    version: String(row.version_number), contentDigest: row.content_hash } as ExperimentRef };
}
export async function orgEvent(ctx: TenantContext, q: OrganizationRequestRow, kind: string, key: string, body: Record<string, unknown>, c: PoolClient) {
  const hash = organizationDigest(body);
  const old = (await c.query("SELECT body_digest,body FROM finnor_os.w5_events WHERE tenant_id=$1 AND request_id=$2 AND event_key=$3",
    [ctx.tenantId, q.id, key])).rows[0];
  if (old) {
    if (old.body_digest !== hash) orgFail("W5_IDEMPOTENCY_CONFLICT");
    return { replay: true, body: old.body };
  }
  const count = (await c.query("SELECT count(*)::int n FROM finnor_os.w5_events WHERE tenant_id=$1 AND request_id=$2",
    [ctx.tenantId, q.id])).rows[0]?.n;
  if (count >= 8192) orgFail("W5_ORIGINAL_EVENT_ENVELOPE_EXHAUSTED");
  await c.query("INSERT INTO finnor_os.w5_events(tenant_id,request_id,principal_id,event_key,kind,body_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
    [ctx.tenantId, q.id, q.principal_id, key, kind, hash, JSON.stringify(body)]);
  return { replay: false, body };
}
export async function orgCurrent(ctx: TenantContext, q: OrganizationRequestRow, c: PoolClient, write = true) {
  return orgOriginal(ctx, q, c, write, "FORWARD");
}
export async function orgRetained(ctx: TenantContext, q: OrganizationRequestRow, c: PoolClient) {
  return orgOriginal(ctx, q, c, true, "RECOVERY");
}
async function orgOriginal(ctx: TenantContext, q: OrganizationRequestRow, c: PoolClient, write: boolean,
  clearance: "FORWARD" | "RECOVERY") {
  await orgAuthority(ctx, c, q.work_id, write);
  const work = (await c.query(`SELECT w.created_by,w.status,i.instruction_text FROM finnor_os.works w
    JOIN finnor_os.work_inputs i ON i.tenant_id=w.tenant_id AND i.work_id=w.id AND i.id=$3
    WHERE w.tenant_id=$1 AND w.id=$2 FOR SHARE OF w,i`, [ctx.tenantId, q.work_id, q.work_input_id])).rows[0];
  if (!work || work.created_by !== q.principal_id || rawDigest(work.instruction_text) !== q.original_input_digest ||
      clearance === "FORWARD" && ["cancelled", "failed"].includes(work.status)) orgFail("W5_ORIGINAL_WORK_REVISION_CHANGED");
  const source = (await c.query(`SELECT v.content,v.content_hash,v.version_number,s.metadata,
    (SELECT max(n.version_number) FROM finnor_os.evidence_source_versions n WHERE n.tenant_id=v.tenant_id AND n.source_id=v.source_id) latest
    FROM finnor_os.evidence_source_versions v JOIN finnor_os.evidence_sources s ON s.tenant_id=v.tenant_id AND s.id=v.source_id
    WHERE v.tenant_id=$1 AND v.source_id=$2 AND v.id=$3 FOR SHARE OF v,s`,
    [ctx.tenantId, q.source_id, q.source_version_id])).rows[0];
  if (!source || source.content_hash !== q.source_digest || rawDigest(source.content) !== q.source_digest ||
      clearance === "FORWARD" && (source.version_number !== source.latest || source.metadata?.revoked === true))
    orgFail("W5_ORIGINAL_ORGANIZATION_SOURCE_CHANGED");
  if (organizationDigest(q.original) !== q.original_digest ||
      q.program && organizationDigest(q.program) !== q.program_digest) orgFail("W5_IMMUTABLE_PREIMAGE_CHANGED");
  if (clearance === "FORWARD") {
    if (write && Date.now() >= q.original_deadline.getTime()) orgFail("W5_ORIGINAL_DEADLINE_EXPIRED");
    await assertWorkforceBudgetTx({ auth: ctx }, c, q.budget);
  }
  const input = parseOrganizationTransformation(q.original);
  if (input.tenantId !== ctx.tenantId || input.principalId !== principal(ctx) ||
      input.workId !== q.work_id || input.workInputId !== q.work_input_id) orgFail("W5_ORIGINAL_SCOPE_CHANGED");
  return input;
}
export async function canonicalLiveOrganizationObligations(ctx: TenantContext, q: OrganizationRequestRow, c: PoolClient): Promise<LiveOrganizationObligation[]> {
  const { inspectOrganizationObligationPopulationTx } = await import("./population");
  const result = await inspectOrganizationObligationPopulationTx(ctx, q, c);
  if (result.status !== "READY") orgFail("W5_COMPLETE_CANONICAL_OBLIGATION_BRIDGE_REQUIRED");
  return result.obligations;
}
export async function orgPublish(ctx: TenantContext, q: OrganizationRequestRow, program: OrganizationTransformationProgram, c: PoolClient) {
  const original = await orgCurrent(ctx, q, c);
  return orgPublishChecked(ctx, q, program, original, c);
}
export async function orgPublishRecovery(ctx: TenantContext, q: OrganizationRequestRow,
  program: OrganizationTransformationProgram, c: PoolClient) {
  const original = await orgRetained(ctx, q, c);
  if (!q.program || !["CANCELLED", "ROLLED_BACK"].includes(program.status)
    || organizationCanonical(program.events.slice(0, q.program.events.length)) !== organizationCanonical(q.program.events)
    || program.events.slice(q.program.events.length).some(event => !["CANCEL", "ROLLBACK"].includes(event.kind)))
    orgFail("W5_RECOVERY_ONLY_HISTORY_REQUIRED");
  return orgPublishChecked(ctx, q, program, original, c);
}
async function orgPublishChecked(ctx: TenantContext, q: OrganizationRequestRow, program: OrganizationTransformationProgram,
  original: OrganizationTransformationInput, c: PoolClient) {
  const checked = checkOrganizationTransformation(original, program);
  if (checked.status !== "CHECKED") orgFail("W5_INDEPENDENT_INVARIANT_CHECK_REJECTED");
  if (program.revision <= q.revision) orgFail("W5_PUBLICATION_REVISION_FENCED");
  await c.query(`INSERT INTO finnor_os.w5_revisions(tenant_id,request_id,principal_id,revision,body,body_digest,check_result)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`, [ctx.tenantId, q.id, q.principal_id, program.revision,
    JSON.stringify(program), checked.programDigest, JSON.stringify(checked)]);
  await c.query(`UPDATE finnor_os.w5_requests SET program=$3::jsonb,program_digest=$4,check_result=$5::jsonb,
    revision=$6,status=$7,last_error=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND revision=$8`,
    [ctx.tenantId, q.id, JSON.stringify(program), checked.programDigest, JSON.stringify(checked), program.revision, program.status, q.revision]);
  await ingestIntegrationEventTx(transactionDb(c), { tenantId: ctx.tenantId, source: "W5", sourceEventId: q.id + ":" + program.revision,
    eventType: "organization.transformation.checked", workId: q.work_id, resource: { type: "work", id: q.work_id }, correlationId: q.id,
    payload: { requestId: q.id, revision: program.revision, status: program.status, originalWorkId: q.work_id,
      originalDeadline: program.originalDeadline, programDigest: checked.programDigest, fieldBenefitEstablished: false },
    trustClass: "trusted_runtime" });
}
export async function orgEnqueue(ctx: TenantContext, q: Pick<OrganizationRequestRow, "id" | "principal_id">,
  phase: "COMPILE" | "ADVANCE", key: string, c: PoolClient) {
  const id = randomUUID();
  const inserted = await c.query(`INSERT INTO finnor_os.jobs
    (id,tenant_id,type,payload,status,run_at,lane,protocol_version,max_attempts,idempotency_key)
    VALUES($1,$2,$3,$4::jsonb,'queued',clock_timestamp(),'interactive',1,4,$5)
    ON CONFLICT DO NOTHING RETURNING id`, [id, ctx.tenantId,
    phase === "COMPILE" ? "compile_organization_transformation_v1" : "advance_organization_transformation_v1",
    JSON.stringify({ tenantId: ctx.tenantId, principalId: q.principal_id, requestId: q.id, phase }),
    "w5:" + q.id + ":" + key]);
  return inserted.rows[0]?.id ?? null;
}
