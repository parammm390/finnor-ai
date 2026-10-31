import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { withTenantTransaction, transactionDb } from "@finnor/db";
import { canExerciseWorkforceAuthorityTx as canExerciseAuthorityTx,
  readWorkforceAuthoritySourcesTx } from "@finnor/authority";
import { createEvidenceSourceTx, appendEvidenceVersionTx } from "@finnor/memory";
import type { AuthorityRequest, ExperimentRef, TenantContext } from "@finnor/shared-types";
import { parseWorkforceCompilerInput, workforceDigest, checkWorkforceExecutionProgram,
  workforceProgramGraph, type WorkforceCompilerInput, type WorkforceExecutionProgram, type WorkforceActor,
  type WorkforceTaskCreation } from "../../../workforce/src/execution-program/index";
import { readWorkforceCarvesTx, type WorkforceBudget } from "../../../private-equity/src/workforce-allocation";
import { readWorkforceCompensationTx, assertWorkforceCompensationCoverageTx } from "../../../private-equity/src/workforce-compensation";
import { nativeWorkforceOriginalSchema, nativeWorkforceActorSourceSchema, nativeWorkforceTaskCreationRecordSchema, WorkforceRuntimeError,
  type NativeWorkforceOriginal, type NativeWorkforceActorSource, type NativeWorkforceTaskCreationRecord } from "./contracts";
import { exactQuantity } from "../../../workforce/src/execution-program/exact";
import { pinWorkforceDependencies, readWorkforceInvalidations, workforceP7Closure } from "./dependencies";

export interface WorkforceProgramRow {
  tenant_id: string; id: string; principal_id: string; work_id: string; work_input_id: string;
  idempotency_key: string; request_digest: string; original_digest: string; original: NativeWorkforceOriginal;
  budget: WorkforceBudget; status: string; revision: number; program: WorkforceExecutionProgram | null;
  compile_result: unknown; job_id: string | null; claim_token: string | null; claim_fence: string | null; last_error: string | null;
}
export const principal = (ctx: TenantContext) => ctx.employeeId ?? ctx.userId;
export const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const reference = (owner: string, id: string, body: unknown, version = "1"): ExperimentRef =>
  ({ owner, id, version, contentDigest: workforceDigest(body) });
export function reject(code: string, status = 409, detail?: unknown): never {
  throw new WorkforceRuntimeError(code, status, detail);
}
export const rootContext = (row: Pick<WorkforceProgramRow, "tenant_id" | "principal_id">): TenantContext =>
  ({ tenantId: row.tenant_id, userId: row.principal_id, employeeId: row.principal_id, role: "owner" });
export const tx = <T>(ctx: TenantContext, fn: (c: PoolClient) => Promise<T>) =>
  withTenantTransaction(ctx.tenantId, { userId: principal(ctx) }, async (_db, c) => fn(c));
export async function portfolioLock(ctx: TenantContext, c: PoolClient) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["s5-portfolio:" + ctx.tenantId]);
}
export async function activePrincipal(ctx: TenantContext, c: PoolClient) {
  if (ctx.employeeId && ctx.employeeId !== ctx.userId) reject("WORKFORCE_CANONICAL_PRINCIPAL_REQUIRED", 403);
  const row = (await c.query("SELECT id,role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",
    [ctx.tenantId, principal(ctx)])).rows[0];
  if (!row) reject("WORKFORCE_CONTEXT_UNAVAILABLE", 404);
  return row;
}
export async function programRow(ctx: TenantContext, id: string, c: PoolClient, lock = false) {
  const row = (await c.query<WorkforceProgramRow>("SELECT * FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2 AND principal_id=$3" +
    (lock ? " FOR UPDATE" : ""), [ctx.tenantId, id, principal(ctx)])).rows[0];
  if (!row) reject("WORKFORCE_CONTEXT_UNAVAILABLE", 404);
  return row;
}
export async function originalWork(ctx: TenantContext, workId: string, inputId: string, c: PoolClient) {
  await activePrincipal(ctx, c);
  const row = (await c.query(`SELECT w.status,w.created_by,w.initial_instruction,i.instruction_text,i.created_by input_creator,i.id
    FROM finnor_os.works w JOIN finnor_os.work_inputs i ON i.tenant_id=w.tenant_id AND i.work_id=w.id
    WHERE w.tenant_id=$1 AND w.id=$2 AND i.id=$3 FOR SHARE OF w,i`, [ctx.tenantId, workId, inputId])).rows[0];
  if (!row || row.created_by !== principal(ctx) || row.input_creator !== principal(ctx) ||
      row.initial_instruction !== row.instruction_text ||
      !await canExerciseAuthorityTx(ctx, { operation: "query", capability: "query:work", workId,
        resource: { type: "work", id: workId }, risk: "low" }, c))
    reject("WORKFORCE_ORIGINAL_WORK_AUTHORITY_REQUIRED", 403);
  const original = nativeWorkforceOriginalSchema.parse(JSON.parse(row.instruction_text));
  return { original, digest: sha(row.instruction_text), status: row.status as string };
}
export async function event(ctx: TenantContext, q: WorkforceProgramRow, kind: string, key: string, body: Record<string, unknown>, c: PoolClient) {
  const digest = workforceDigest(body);
  const prior = (await c.query("SELECT request_digest,body FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2 AND event_id=$3",
    [ctx.tenantId, q.id, key])).rows[0];
  if (prior) {
    if (prior.request_digest !== digest) reject("WORKFORCE_EVENT_IDEMPOTENCY_CONFLICT");
    return prior.body as Record<string, unknown>;
  }
  const count = (await c.query(`SELECT count(*)::int count,COALESCE(sum(octet_length(body::text)),0)::text bytes
    FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2`, [ctx.tenantId, q.id])).rows[0];
  if (count.count >= 32768 || BigInt(count.bytes) + BigInt(Buffer.byteLength(JSON.stringify(body))) > 64n * 1024n * 1024n)
    reject("WORKFORCE_ORIGINAL_EVENT_ENVELOPE_EXHAUSTED");
  await c.query("INSERT INTO finnor_os.w2_events(tenant_id,program_id,principal_id,event_id,kind,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
    [ctx.tenantId, q.id, q.principal_id, key, kind, digest, JSON.stringify(body)]);
  return body;
}
export async function events(ctx: TenantContext, q: WorkforceProgramRow, c: PoolClient) {
  const rows = (await c.query<{ kind: string; event_id: string; body: Record<string, unknown> }>(`SELECT kind,event_id,body
    FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2 ORDER BY created_at,event_id LIMIT 32769`, [ctx.tenantId, q.id])).rows;
  if (rows.length > 32768) reject("WORKFORCE_EVENT_PROFILE_INCOMPLETE");
  return rows;
}
export function taskCreationObservation(record: NativeWorkforceTaskCreationRecord, ref: ExperimentRef): WorkforceTaskCreation {
  return { ref, kind: record.kind, parentAssignmentId: record.parentAssignmentId,
    parentTermsDigest: record.parentTermsDigest, actorId: record.actorId, recipientActorId: record.recipientActorId,
    assignmentId: record.assignmentId, at: record.at, task: record.task,
    criterion: { ref, id: record.criterion.id, checkerActorId: record.criterion.checkerActorId,
      evidenceCustodianActorId: record.criterion.evidenceCustodianActorId } };
}
export async function resolveNativeDefinitions(ctx: TenantContext, q: WorkforceProgramRow, c: PoolClient,
  all?: Awaited<ReturnType<typeof events>>) {
  const created: Array<{ observation: WorkforceTaskCreation; record: NativeWorkforceTaskCreationRecord }> = [];
  for (const creation of (all ?? await events(ctx, q, c)).filter(value => value.kind === "TASK_CREATION")) {
    const ref = (creation.body.observation as WorkforceTaskCreation)?.ref;
    if (!ref || ref.owner !== "S1") reject("WORKFORCE_TASK_CREATION_SOURCE_REQUIRED");
    const source = (await c.query(`SELECT v.content,v.content_hash,v.version_number,s.source_key
      FROM finnor_os.evidence_source_versions v JOIN finnor_os.evidence_sources s ON s.tenant_id=v.tenant_id AND s.id=v.source_id
      WHERE v.tenant_id=$1 AND v.id=$2`, [ctx.tenantId, ref.id])).rows[0];
    if (!source || source.source_key !== "workforce:" + q.id + ":" + creation.event_id ||
        source.content_hash !== ref.contentDigest || sha(source.content) !== ref.contentDigest ||
        String(source.version_number) !== ref.version)
      reject("WORKFORCE_TASK_CREATION_SOURCE_PREIMAGE_UNAVAILABLE");
    const record = nativeWorkforceTaskCreationRecordSchema.parse(JSON.parse(source.content));
    const observation = taskCreationObservation(record, ref);
    if (record.programmeId !== q.id || record.originalWorkId !== q.work_id ||
        record.originalMeaningDigest !== q.original_digest ||
        record.authenticatedPrincipalId !== creation.body.authenticatedPrincipal ||
        workforceDigest(observation) !== workforceDigest(creation.body.observation))
      reject("WORKFORCE_TASK_CREATION_ORIGINAL_BINDING_CHANGED");
    created.push({ record, observation });
  }
  return { created,
    tasks: [...q.original.outcome.tasks, ...created.map(value => value.record.task)],
    criteria: [...q.original.outcome.criteria, ...created.map(value => value.record.criterion)],
    operations: [...q.original.operations, ...created.map(value => ({
      taskId: value.record.task.id, computation: value.record.computation }))] };
}
export async function evidence(ctx: TenantContext, q: WorkforceProgramRow, key: string, body: Record<string, unknown>, c: PoolClient) {
  const db = transactionDb(c), content = JSON.stringify(body);
  const source = await createEvidenceSourceTx(db, ctx.tenantId, { sourceKey: "workforce:" + q.id + ":" + key,
    sourceType: "workforce_original_observation", title: "Authenticated workforce observation",
    metadata: { workId: q.work_id, programmeId: q.id, instructionEligible: false, evidenceTrust: "untrusted_evidence",
      sourceClass: q.original.sourceClass, qualification: "ORDINARY_NATIVE_RECORD_NOT_PROTECTED_ADMISSION" } });
  const version = await appendEvidenceVersionTx(db, ctx.tenantId, source.id, { content, snapshot: { workId: q.work_id,
    programmeId: q.id, kind: key, instructionEligible: false }, entityRefs: [{ type: "work", id: q.work_id }] });
  const row = (await c.query("SELECT version_number,content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2",
    [ctx.tenantId, version.versionId])).rows[0];
  if (!row) reject("WORKFORCE_S1_OBSERVATION_PREIMAGE_UNAVAILABLE");
  return { owner: "S1", id: version.versionId, version: String(row.version_number), contentDigest: row.content_hash } as ExperimentRef;
}
export interface ResolvedActor {
  sourceId: string; sourceRef: ExperimentRef; source: NativeWorkforceActorSource; actor: WorkforceActor; principalId: string;
}
export async function resolveActors(ctx: TenantContext, q: WorkforceProgramRow, c: PoolClient,
  onlyActorIds?: ReadonlySet<string>): Promise<ResolvedActor[]> {
  const rows = (await c.query(`SELECT s.id source_id,v.id,v.version_number,v.content_hash,v.snapshot
    FROM finnor_os.evidence_sources s JOIN LATERAL(SELECT * FROM finnor_os.evidence_source_versions v
      WHERE v.tenant_id=s.tenant_id AND v.source_id=s.id ORDER BY v.version_number DESC LIMIT 1) v ON true
    WHERE s.tenant_id=$1 AND s.id=ANY($2::uuid[]) ORDER BY s.id`,
  [ctx.tenantId, q.original.actorSourceIds])).rows;
  if (rows.length !== q.original.actorSourceIds.length || new Set(q.original.actorSourceIds).size !== rows.length)
    reject("WORKFORCE_CANONICAL_ACTOR_SOURCE_POPULATION_INCOMPLETE");
  const actors: ResolvedActor[] = [];
  const canonicalIds = new Set<string>();
  for (const row of rows) {
    const source = nativeWorkforceActorSourceSchema.parse(row.snapshot);
    if (canonicalIds.has(source.canonical.id)) reject("WORKFORCE_DUPLICATE_CANONICAL_ACTOR");
    canonicalIds.add(source.canonical.id);
    // Bootstrap already holds the complete canonical row fences and must
    // independently re-resolve all actors at publication. Every command still
    // resolves and authorizes its actual issuer now; no cross-command cache.
    if (onlyActorIds && !onlyActorIds.has(source.canonical.id)) continue;
    const sourceRef: ExperimentRef = { owner: "S1", id: row.id, version: String(row.version_number), contentDigest: row.content_hash };
    const user = (await c.query(`SELECT u.id,u.status,u.role,p.actor_kind,p.version,p.delegation_id,p.delegated_by,p.authority_assignment_id
      FROM finnor_os.users u LEFT JOIN finnor_os.employee_actor_profiles p ON p.tenant_id=u.tenant_id AND p.principal_id=u.id
      WHERE u.tenant_id=$1 AND u.id=$2 FOR SHARE OF u`, [ctx.tenantId, source.canonical.principalId])).rows[0];
    const actor = structuredClone(source.actor);
    actor.id = source.canonical.id; actor.tenantId = ctx.tenantId;
    const human = ["INTERNAL_HUMAN", "EXTERNAL_PROFESSIONAL", "PROVIDER"].includes(actor.kind);
    let current = !!user && user.status === "active" && !!user.actor_kind &&
      (human ? user.actor_kind === "HUMAN" : actor.kind === "MODEL_AGENT" ? user.actor_kind === "AGENT" : user.actor_kind === "SERVICE");
    if (source.canonical.kind === "USER") current &&= source.canonical.id === source.canonical.principalId;
    else {
      const contact = (await c.query("SELECT id FROM finnor_os.external_contacts WHERE tenant_id=$1 AND id=$2 AND active FOR SHARE",
        [ctx.tenantId, source.canonical.id])).rows[0];
      const enrollment = (await c.query(`SELECT b.id,b.proposal_digest,b.revision FROM finnor_os.w2_contact_bindings b
        WHERE b.tenant_id=$1 AND b.contact_id=$2 AND b.recipient_principal_id=$3
          AND b.status='CONFIRMED' AND b.valid_until>clock_timestamp()
          AND b.purpose=ANY($4::text[]) AND EXISTS(SELECT 1 FROM finnor_os.w2_contact_binding_events e
            WHERE e.tenant_id=b.tenant_id AND e.binding_id=b.id AND e.body->>'action'='CONFIRM'
              AND e.body->>'authenticatedPrincipal'=b.recipient_principal_id::text
              AND e.body->>'proposalDigest'=b.proposal_digest) FOR SHARE OF b`,
      [ctx.tenantId, source.canonical.id, source.canonical.principalId, q.original.outcome.ceiling.purposes])).rows[0];
      current &&= !!contact && !!enrollment && ["EXTERNAL_PROFESSIONAL", "PROVIDER"].includes(actor.kind);
      // Disappearance/revocation withdraws eligibility, never the historical
      // accountable root or its already accepted financial/labor obligations.
    }
    if (actor.kind === "MODEL_AGENT" && current) {
      const delegation = (await c.query(`SELECT d.id FROM finnor_os.delegations d
        JOIN finnor_os.employee_role_assignments a ON a.tenant_id=d.tenant_id AND a.id=$3
        JOIN finnor_os.users issuer ON issuer.tenant_id=d.tenant_id AND issuer.id=d.created_by AND issuer.status='active'
        WHERE d.tenant_id=$1 AND d.id=$2 AND d.status='accepted' AND d.target_type='employee' AND d.target_id=$4
          AND d.created_by=$5 AND a.employee_id=$4 AND a.active AND a.effective_from<=clock_timestamp()
          AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
          AND (d.completion_deadline IS NULL OR d.completion_deadline>clock_timestamp())`,
      [ctx.tenantId, user.delegation_id, user.authority_assignment_id, source.canonical.principalId, user.delegated_by])).rows[0];
      current &&= !!delegation;
    }
    actor.status = current ? source.actor.status : user?.status === "suspended" ? "REVOKED" : "UNKNOWN";
    actor.identityRef = reference("identity", source.canonical.kind.toLowerCase() + ":" + source.canonical.id,
      { tenantId: ctx.tenantId, canonical: source.canonical, status: user?.status ?? "UNKNOWN", actorKind: user?.actor_kind ?? "UNKNOWN",
        actorProfileVersion: user?.version ?? null, delegationId: user?.delegation_id ?? null });
    actor.capabilities = actor.capabilities.map(capability => ({ ...capability, evidenceRef: sourceRef }));
    if (actor.availability.kind === "OBSERVED") {
      actor.availability.ref = sourceRef;
      if (actor.availability.humanLimits.kind === "OBSERVED") actor.availability.humanLimits.ref = sourceRef;
    }
    actors.push({ sourceId: row.source_id, sourceRef, source, actor, principalId: source.canonical.principalId });
  }
  if (new Set(actors.map(a => a.actor.id)).size !== actors.length) reject("WORKFORCE_DUPLICATE_CANONICAL_ACTOR");
  const occupation = (await c.query("SELECT * FROM finnor_os.w2_actor_occupation($1::uuid[],$2::uuid)",
    [actors.map(a => a.actor.id), q.id])).rows;
  if (occupation.length > 4096) reject("WORKFORCE_SHARED_OCCUPATION_PROFILE_INCOMPLETE");
  for (const entry of actors) if (entry.actor.availability.kind === "OBSERVED") {
    const availability = entry.actor.availability;
    const holds = occupation.filter(h => h.actor_id === entry.actor.id);
    for (const slot of availability.slots) {
      const overlaps = holds.filter(h => new Date(h.slot_start).getTime() < Date.parse(slot.endAt) && new Date(h.slot_end).getTime() > Date.parse(slot.startAt));
      // Conservative whole agreement window: no unobserved free sub-window is
      // inferred. The native acceptance boundary also checks exact overlap.
      slot.committed = exactQuantity(slot.committed).add(exactQuantity(String(overlaps.length))).string();
    }
    if (availability.humanLimits.kind === "OBSERVED") {
      availability.humanLimits.alreadyCommittedSeconds = holds.reduce((total, h) => total.add(exactQuantity(h.effort_seconds)),
        exactQuantity(availability.humanLimits.alreadyCommittedSeconds)).string();
    }
  }
  return actors;
}

export async function resolveCanonicalInput(ctx: TenantContext, q: WorkforceProgramRow, c: PoolClient): Promise<WorkforceCompilerInput> {
  // S5 snapshot reads take this mutex. Hold it before any canonical row fence,
  // matching the completion writer's portfolio -> Work order.
  await portfolioLock(ctx, c);
  const current = await originalWork(ctx, q.work_id, q.work_input_id, c);
  if (current.digest !== q.original_digest || workforceDigest(current.original) !== workforceDigest(q.original))
    reject("WORKFORCE_ORIGINAL_MEANING_CHANGED");
  const actors = await resolveActors(ctx, q, c), all = await events(ctx, q, c);
  const definitions = await resolveNativeDefinitions(ctx, q, c, all);
  const now = new Date().toISOString();
  const criterion = q.original.outcome.criteria.map(value => ({ id: value.id, checkerActorId: value.checkerActorId,
    evidenceCustodianActorId: value.evidenceCustodianActorId,
    ref: reference("Work", q.work_input_id + ":criterion:" + value.id, value) }));
  const original = { ...q.original.outcome, criteria: criterion, workId: q.work_id, rootId: q.work_id,
    requesterActorId: q.principal_id, ref: reference("Work", q.work_input_id, { originalDigest: q.original_digest, workId: q.work_id }) };
  const grants: WorkforceCompilerInput["grants"] = [];
  const capabilities = [...new Set([original.ceiling, ...original.tasks.map(t => t.ceiling)].flatMap(v => v.capabilities))]
    .filter(capability => /^(query|action):[A-Za-z0-9:_-]+$/.test(capability));
  const requests: AuthorityRequest[] = [...new Set([...capabilities, "query:work"])].map(capability => ({
    operation: capability.startsWith("query:") ? "query" : "action", capability, workId: q.work_id,
    resource: { type: "work", id: q.work_id }, risk: "low" }));
  const authorities = await readWorkforceAuthoritySourcesTx(ctx,
    new Map(actors.filter(entry => entry.actor.status === "CURRENT").map(entry => [entry.principalId, requests])), c);
  for (const entry of actors) {
    if (entry.actor.status !== "CURRENT") continue;
    const authority = authorities.get(entry.principalId);
    if (!authority) { entry.actor.status = "UNKNOWN"; continue; }
    const allowed = new Map(authority.proofs.map(proof => [proof.request.capability, proof.allowed]));
    const admitted = capabilities.filter(capability => allowed.get(capability) === true);
    const ceiling = { ...original.ceiling, capabilities: admitted, effects: [],
      dataScopes: allowed.get("query:work") === true
        ? original.ceiling.dataScopes.filter(scope => scope === "work:self" || scope === "work:" + q.work_id) : [],
      validUntil: new Date(Math.min(Date.parse(original.ceiling.validUntil),
        authority.validUntil ? Date.parse(authority.validUntil) : Infinity)).toISOString() };
    grants.push({ actorId: entry.actor.id, tenantId: ctx.tenantId, ceiling, revoked: false,
      ref: reference("authority", "workforce:" + q.work_id + ":" + entry.principalId + ":" + authority.revision,
        { principalId: entry.principalId, workId: q.work_id, revision: authority.revision, ceiling }) });
  }
  const collect = <K extends keyof WorkforceCompilerInput>(kind: string): WorkforceCompilerInput[K] =>
    all.filter(e => e.kind === kind).map(e => e.body.observation) as WorkforceCompilerInput[K];
  const fundingRefs = all.filter(e => e.kind === "FUNDING").flatMap(e => e.body.refs as ExperimentRef[]);
  const funding = await readWorkforceCarvesTx({ auth: ctx }, c, q.budget, fundingRefs);
  const dependencyInvalidations = await readWorkforceInvalidations(ctx, q, actors, c);
  const compensation = q.budget.resources.some(resource => resource.resourceClass === "CASH")
    ? await readWorkforceCompensationTx({ auth: ctx }, c, q.budget) : { observations: [] };
  const labor = new Map<string, WorkforceCompilerInput["obligations"][number]>();
  const other: WorkforceCompilerInput["obligations"] = [];
  for (const observation of collect<"obligations">("OBLIGATION")) {
    if (observation.kind === "ACCEPTED_LABOR") labor.set(observation.assignmentId + "\0" + observation.rootId, observation);
    else other.push(observation);
  }
  const body = { schema: "finnor.workforce-compiler-input.v1", programId: q.id, tenantId: ctx.tenantId, principalId: q.principal_id,
    now, sourceClass: q.original.sourceClass, outcome: original, actors: actors.map(a => a.actor), grants, funding, dependencyInvalidations,
    historyAnchor: { revision: q.program?.revision ?? 0, commandsDigest: workforceDigest(q.program?.history ?? []) },
    dispositions: collect<"dispositions">("DISPOSITION"), deliveries: collect<"deliveries">("DELIVERY"),
    verifications: collect<"verifications">("VERIFICATION"), effects: collect<"effects">("EFFECT"),
    reconciliations: collect<"reconciliations">("RECONCILIATION"),
    obligations: [...other, ...labor.values(), ...compensation.observations],
    termChanges: collect<"termChanges">("TERM_CHANGE"), taskCreations: definitions.created.map(value => value.observation),
    commandAuthorities: collect<"commandAuthorities">("COMMAND_AUTHORITY") };
  return parseWorkforceCompilerInput({ ...body, snapshotRef: reference("S1", "workforce-snapshot:" + q.id, body) });
}

export async function publish(ctx: TenantContext, q: WorkforceProgramRow, program: WorkforceExecutionProgram, c: PoolClient) {
  const independentlyResolved = await resolveCanonicalInput(ctx, q, c);
  const check = checkWorkforceExecutionProgram(program, independentlyResolved);
  await assertWorkforceCompensationCoverageTx({ auth: ctx }, c, q.budget, program);
  if (!check.valid) {
    const before = q.program && checkWorkforceExecutionProgram(q.program, independentlyResolved);
    const recovery = new Set(["BLOCK", "RETURN", "DISPUTE", "EXPIRE", "CANCEL", "CONFIRM_CANCEL", "REASSIGN",
      "MARK_UNKNOWN_EFFECT", "RECONCILE", "REVOKE"]);
    const appended = program.history.slice(q.program?.revision ?? 0);
    const issueKey = (issue: typeof check.issues[number]) => JSON.stringify([issue.boundary, issue.code, issue.assignmentId, issue.detail]);
    const oldIssues = new Set(before ? before.issues.map(issueKey) : []);
    const affected = new Set(before ? before.affectedAssignmentIds : []);
    const globalIssue = before?.issues.some(issue => issue.assignmentId === null) ?? true;
    const unchanged = q.program && workforceDigest(q.program) === workforceDigest(program);
    if (!before || !appended.length && !unchanged || appended.some(command => !recovery.has(command.action.kind) &&
          (globalIssue || affected.has(command.assignmentId))) ||
        check.issues.some(issue => !oldIssues.has(issueKey(issue))))
      reject("WORKFORCE_INDEPENDENT_NATIVE_CHECK_REJECTED", 409, check);
    // Preserve an invalid current subgraph during non-widening recovery or
    // independently checked progress of an unaffected assignment. The invalid
    // check stays durable and cannot become a permit for an affected leaf.
  }
  const bindings = await resolveActors(ctx, q, c);
  const graph = workforceProgramGraph(program);
  const existing = (await c.query("SELECT revision FROM finnor_os.w2_program_revisions WHERE tenant_id=$1 AND program_id=$2 AND revision=$3",
    [ctx.tenantId, q.id, program.revision])).rows[0];
  if (!existing) await c.query(`INSERT INTO finnor_os.w2_program_revisions(tenant_id,program_id,principal_id,revision,program,check_result)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`, [ctx.tenantId, q.id, q.principal_id, program.revision, JSON.stringify(program), JSON.stringify(check)]);
  const heads = (await c.query(`SELECT assignment_id,body,task,actor_id,recipient_principal_id,checker_principal_id,
      principal_id,work_id,holds_capacity,state,revision,effort_seconds::text effort_seconds,
      (slot_start=(task->'slot'->>'startAt')::timestamptz AND slot_end=(task->'slot'->>'endAt')::timestamptz) exact_slot
    FROM finnor_os.w2_assignment_heads WHERE tenant_id=$1 AND program_id=$2 ORDER BY assignment_id LIMIT 8193 FOR SHARE`,
  [ctx.tenantId, q.id])).rows;
  if (heads.length > 8192 || heads.some(head => head.revision > program.revision))
    reject("WORKFORCE_COMPLETE_CURRENT_HEAD_FRONTIER_REQUIRED");
  const priorHeads = new Map(heads.map(head => [head.assignment_id, head]));
  for (const assignment of program.assignments) {
    const task = graph.tasks.find(t => t.id === assignment.taskId)!;
    const binding = bindings.find(b => b.actor.id === assignment.actorId);
    if (!binding) reject("WORKFORCE_CURRENT_RECIPIENT_BINDING_UNAVAILABLE");
    const criterion = graph.criteria.find(value => value.id === task.criterionId)!;
    const checker = bindings.find(value => value.actor.id === criterion.checkerActorId);
    if (!checker) reject("WORKFORCE_CURRENT_CHECKER_BINDING_UNAVAILABLE");
    const accepted = [...program.history].reverse().find(command => command.assignmentId === assignment.id && command.action.kind === "ACCEPT");
    const unreleasedLabor = accepted && ["INTERNAL_HUMAN", "EXTERNAL_PROFESSIONAL", "PROVIDER"].includes(binding.actor.kind) &&
      !independentlyResolved.obligations.some(observation => observation.assignmentId === assignment.id &&
        observation.rootId === assignment.rootId && observation.kind === "ACCEPTED_LABOR" &&
        observation.status !== "OPEN" && Date.parse(observation.at) >= Date.parse(accepted.at));
    const holds = Boolean(unreleasedLabor || ["ACCEPTED", "IN_PROGRESS", "BLOCKED", "DELIVERED", "VERIFIED", "RETURNED", "DISPUTED", "CANCEL_REQUESTED",
      "CANCELLED_WITH_RESIDUAL_EXPOSURE", "UNKNOWN_EFFECT"].includes(assignment.state.kind));
    const old = priorHeads.get(assignment.id);
    // A head's revision is its last actual change, not a second programme CAS.
    // Participant projections already use p.revision. Check every independent
    // canonical field, retain the row fence, and avoid rewriting unchanged
    // capacity/identity rows just because another leaf made progress.
    if (old && old.principal_id === q.principal_id && old.work_id === q.work_id &&
        old.actor_id === assignment.actorId && old.recipient_principal_id === binding.principalId &&
        old.checker_principal_id === checker.principalId && old.state === assignment.state.kind &&
        old.holds_capacity === holds && old.exact_slot === true &&
        exactQuantity(old.effort_seconds).compare(exactQuantity(task.effortSeconds)) === 0 &&
        workforceDigest(old.body) === workforceDigest(assignment) && workforceDigest(old.task) === workforceDigest(task)) continue;
    await c.query(`INSERT INTO finnor_os.w2_assignment_heads(tenant_id,program_id,assignment_id,principal_id,actor_id,
      recipient_principal_id,work_id,slot_start,slot_end,effort_seconds,holds_capacity,state,revision,body,task,checker_principal_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16)
      ON CONFLICT(tenant_id,program_id,assignment_id) DO UPDATE SET body=excluded.body,task=excluded.task,
      actor_id=excluded.actor_id,recipient_principal_id=excluded.recipient_principal_id,holds_capacity=excluded.holds_capacity,
      state=excluded.state,revision=excluded.revision,slot_start=excluded.slot_start,slot_end=excluded.slot_end,
      effort_seconds=excluded.effort_seconds,checker_principal_id=excluded.checker_principal_id`, [ctx.tenantId, q.id, assignment.id, q.principal_id,
      assignment.actorId, binding.principalId, q.work_id, task.slot.startAt, task.slot.endAt, task.effortSeconds,
      holds, assignment.state.kind, program.revision, JSON.stringify(assignment), JSON.stringify(task), checker.principalId]);
  }
  const allOriginalTasksClosed = graph.tasks.length > 0 &&
    graph.tasks.every(task => program.assignments.some(a => a.taskId === task.id && a.state.kind === "CLOSED" &&
      program.history.some(command => command.assignmentId === a.id && command.action.kind === "VERIFY"))) &&
    program.assignments.every(a => a.state.kind === "CLOSED");
  const unsettled = (await c.query(`SELECT count(*)::int count FROM finnor_os.s5_consumptions co
    JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
    WHERE co.tenant_id=$1 AND co.reservation_id=$2 AND st.status<>'RECONCILED'`,
    [ctx.tenantId, q.budget.reservationRef.id])).rows[0].count;
  const status = !check.valid ? "FENCED" : allOriginalTasksClosed ? unsettled ? "BLOCKED" : "CLOSED" :
    q.compile_result && (q.compile_result as { status?: string }).status === "PARTIAL" ? "PARTIAL" : "ACTIVE";
  await c.query(`UPDATE finnor_os.w2_programs SET program=$4::jsonb,revision=$5,status=$6,updated_at=clock_timestamp()
    WHERE tenant_id=$1 AND id=$2 AND principal_id=$3`, [ctx.tenantId, q.id, q.principal_id, JSON.stringify(program), program.revision, status]);
  await pinWorkforceDependencies(ctx, q, program, bindings, c, (kind, key, body) => event(ctx, q, kind, key, body, c));
  return { program, check, status };
}

/** Conservative native admission withdrawal, not a new responsibility command
 * or an authority grant. The caller owns the portfolio/programme row fence. */
export async function recordWorkforceCurrentnessTx(ctx: TenantContext, q: WorkforceProgramRow,
  canonical: WorkforceCompilerInput, check: ReturnType<typeof checkWorkforceExecutionProgram>, c: PoolClient) {
  if (!q.program || check.valid) return null;
  const issues = check.issues.map(issue => ({ code: issue.code, boundary: issue.boundary,
    assignmentId: issue.assignmentId })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const seeds = [...new Set(issues.flatMap(issue =>
    issue.assignmentId ? [issue.assignmentId] : q.program!.assignments.map(a => a.id)))].sort();
  const p7 = workforceP7Closure(q.program, seeds);
  const body = { schema: "finnor.workforce-currentness-revalidation.v1", programmeId: q.id,
    basisRevision: q.program.revision, issues, p7,
    invalidations: (canonical.dependencyInvalidations ?? []).map(value => ({
      ...value, assignmentIds: [...value.assignmentIds].sort() })),
    originalBudget: q.budget.ref, originalReservation: q.budget.reservationRef,
    originalPinsRefreshed: false, obligationsReleased: false, executionAuthorityGranted: false };
  await event(ctx, q, "CURRENTNESS_REVALIDATION", "currentness:" + workforceDigest(body), body, c);
  if (q.status !== "FENCED") {
    await c.query(`UPDATE finnor_os.w2_programs SET status='FENCED',updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND id=$2 AND principal_id=$3 AND revision=$4`,
    [ctx.tenantId, q.id, q.principal_id, q.revision]);
    q.status = "FENCED";
  }
  return p7;
}
