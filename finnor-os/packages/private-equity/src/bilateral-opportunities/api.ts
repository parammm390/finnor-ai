import { z } from "zod";
import { receiveWork, reconcileWorkStatus } from "@finnor/db";
import {
  BilateralAdvanceSchema, BilateralGovernanceSchema, BilateralIntakeSchema, EvidenceRootSchema,
  SignedBilateralReplySchema, VReferenceSchema, type BilateralIntake,
} from "@finnor/shared-types";
import { PeDomainError, type PeMutationContext } from "../types";
import { reserveFixedPrimaryBudget } from "../allocation-store";
import { relationshipLock } from "../../../authority/src/relationship-policy";
import { assertDevelopment, bindingsForIntake, ownerBindings, putGovernance } from "./governance";
import { acceptParticipantEvent } from "./observations";
import {
  actor, authorize, candidates, canonical, costs, currentActor, currentArtifact, enqueue, event,
  exactWork, hash, newId, programme, programmeRef, reference, revisions, revokeGovernance,
  rightsBinding, tx, unavailable, type Programme,
} from "./store";

const rooted = z.object({ root: EvidenceRootSchema }).strict();
const identified = z.object({ programmeId: z.string().uuid() }).strict();
export const BilateralOperationSchemas = {
  "bilateral-context": rooted,
  "bilateral-open-work": rooted.extend({
    instruction: z.string().min(1).max(2000), idempotencyKey: z.string().min(1).max(200),
    investigation: z.object({ threadId: z.string().uuid(), expectedRevision: z.number().int().nonnegative() }).strict().optional(),
  }).strict(),
  "bilateral-reserve-budget": rooted.extend({
    resourceRefs: z.array(VReferenceSchema).length(2), maximumMicroUsd: z.string().regex(/^[1-9]\d{0,95}$/),
    maximumCpuMicros: z.string().regex(/^[1-9]\d{0,95}$/), idempotencyKey: z.string().min(1).max(200),
    validUntil: z.string().datetime({ offset: true }),
  }).strict(),
  "bilateral-governance-put": rooted.extend({ body: BilateralGovernanceSchema, expectedRef: VReferenceSchema.nullable() }).strict(),
  "bilateral-governance-revoke": rooted.extend({ ref: VReferenceSchema, reason: z.string().min(1).max(1000) }).strict(),
  "bilateral-submit": BilateralIntakeSchema,
  "bilateral-read": identified,
  "bilateral-advance": BilateralAdvanceSchema,
  "bilateral-cancel": identified,
  "bilateral-observe": identified.extend({ event: SignedBilateralReplySchema }).strict(),
  "bilateral-handoff": z.object({ artifactRef: VReferenceSchema }).strict(),
} as const;
export const BILATERAL_OPERATIONS = [
  "bilateral-context", "bilateral-open-work", "bilateral-reserve-budget", "bilateral-governance-put",
  "bilateral-governance-revoke", "bilateral-submit", "bilateral-read", "bilateral-advance", "bilateral-cancel",
  "bilateral-observe", "bilateral-handoff",
] as const;

export async function submitBilateral(ctx: PeMutationContext, value: unknown) {
  const intake = BilateralIntakeSchema.parse(value);
  assertDevelopment(intake.mode);
  await authorize(ctx, intake.root, intake.workId);
  if (new Set(intake.underwritingGapAssertions.map(a => a.assertionId)).size !== intake.underwritingGapAssertions.length)
    throw Error("BILATERAL_DUPLICATE_REGISTERED_UNDERWRITING_GAP");
  await bindingsForIntake(ctx, intake);
  const digest = hash(intake);
  const accepted = await tx(ctx, async c => {
    await relationshipLock(c, ctx.auth.tenantId);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["s5-portfolio:" + ctx.auth.tenantId]);
    await currentActor(ctx, c);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,72))",
      [ctx.auth.tenantId + ":" + actor(ctx) + ":" + intake.idempotencyKey]);
    const prior = (await c.query<Programme>(`SELECT * FROM finnor_os.v1_programmes
      WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`,
    [ctx.auth.tenantId, actor(ctx), intake.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.intake_digest !== digest) throw Error("BILATERAL_ORIGINAL_IDEMPOTENCY_CONFLICT");
      return { programmeId: prior.id, workId: prior.work_id, ref: programmeRef(prior), status: prior.status, replayed: true };
    }
    const work = (await c.query(`SELECT i.id::text,to_jsonb(i) body,w.status FROM finnor_os.work_inputs i
      JOIN finnor_os.works w ON w.tenant_id=i.tenant_id AND w.id=i.work_id
      WHERE i.tenant_id=$1 AND i.work_id=$2 ORDER BY i.created_at DESC,i.id DESC LIMIT 1`,
    [ctx.auth.tenantId, intake.workId])).rows[0];
    if (!work || work.id !== intake.expectedWorkInputId || ["completed", "failed", "cancelled"].includes(work.status))
      throw Error("BILATERAL_CURRENT_NONTERMINAL_WORK_INPUT_REQUIRED");
    const id = newId();
    await c.query(`INSERT INTO finnor_os.v1_programmes(tenant_id,principal_id,id,work_id,work_input_id,
      work_input_digest,root,intake,intake_digest,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
    [ctx.auth.tenantId, actor(ctx), id, intake.workId, work.id, hash(work.body), canonical(intake.root),
      canonical(intake), digest, intake.idempotencyKey]);
    const p = await programme(ctx, id, c);
    await ownerBindings(ctx, p, c);
    await event(ctx, p, "S4", "ORIGINAL_BILATERAL_PROGRAMME_ACCEPTED", {
      workId: p.work_id, workInputId: p.work_input_id, intakeDigest: digest,
      eligibleUniverseFrozenAtSubmit: false, frozenCutPendingActualSourceRead: true,
      originalMandateRef: intake.mandateRef, originalGrantRef: intake.budgetGrantRef,
      liveContactPermission: false, domainAdmission: null,
    }, c);
    await enqueue(ctx, p, c);
    return { programmeId: id, workId: p.work_id, ref: programmeRef(p), status: p.status, replayed: false };
  });
  await reconcileWorkStatus(ctx.auth.tenantId, intake.workId);
  return accepted;
}

export async function readBilateral(ctx: PeMutationContext, id: string) {
  const p = await programme(ctx, id);
  await authorize(ctx, p.root, p.work_id);
  const b = await bindingsForIntake(ctx, p.intake).catch(() => { throw unavailable(); });
  const list = await candidates(ctx, p), artifacts = [];
  for (const candidate of list.filter(co => co.disposition === "QUALIFIED" && co.artifact_id)) {
    const a = await tx(ctx, async c => (await c.query("SELECT body FROM finnor_os.v1_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [ctx.auth.tenantId, actor(ctx), candidate.artifact_id])).rows[0]?.body, true);
    if (!a) continue;
    try { artifacts.push((await currentArtifact(ctx, reference("V1", a.artifactId, 1, a))).artifact); }
    catch { candidate.disposition = "INVALIDATED"; candidate.reason = "CURRENT_ARTIFACT_PERMISSION_OR_DEPENDENCY_UNPASSED"; }
  }
  const keys = [...(p.frozen_manifest?.dependencies ?? []), ...Object.values(p.frozen_manifest?.candidateDependencies ?? {}).flat()].map(d => d.key);
  return {
    programmeId: p.id, root: p.root, ref: programmeRef(p), workId: p.work_id, workRevision: p.work_input_id,
    status: p.invalidated ? "BLOCKED" : p.status, reason: p.invalidated ? "V1_OWNER_DEPENDENCY_CHANGED" : p.reason,
    candidates: list, artifacts, principalArtifactRef: artifacts.find(a => a.artifactId === p.principal_artifact_id)
      ? reference("V1", p.principal_artifact_id!, 1, artifacts.find(a => a.artifactId === p.principal_artifact_id)) : null,
    frozenCut: p.frozen_manifest ? { knowledgeCut: p.frozen_manifest.knowledgeCut, baselinePipelineDigest: p.frozen_manifest.baselinePipelineDigest,
      eligibleCompanyIds: p.frozen_manifest.eligibleCompanyIds, universeDefinition: p.frozen_manifest.universeDefinition } : null,
    advanceBindings: {
      mandateRef: p.intake.mandateRef, authorityProfileRef: p.intake.authorityProfileRef,
      domainProfileRef: p.intake.domainProfileRef, budgetGrantRef: p.intake.budgetGrantRef,
      evidenceRevisionVector: (await revisions(ctx, keys)).map(d => ({ key: d.key, revision: d.revision })),
    },
    originalDeadline: b.mandate.deadline, nextObligationRefs: p.next_obligations,
    requiredApprovalRefs: p.required_approvals, costReceipts: await costs(ctx, p),
    approvalPackets: await tx(ctx, async c => (await c.query(`SELECT id,kind,body FROM finnor_os.v1_events
      WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3
      AND kind IN('CURRENT_ACTIVITY_OWNER_PACKET_REQUIRED','EXACT_NEW_TERMS_AUTHORITY_REQUIRED') ORDER BY id LIMIT 64`,
    [p.tenant_id, actor(ctx), p.id])).rows, true),
    qualification: { engineering: "DEVELOPMENT", domain: "NOT_QUALIFIED", S8: "NOT_ADMITTED", live: "NOT_AUTHORIZED", causalGain: "NOT_ESTABLISHED" },
  };
}

export async function handleBilateralOperation(ctx: PeMutationContext, operation: string, value: unknown): Promise<{ status: number; body: unknown }> {
  try {
    if (operation === "bilateral-context") {
      const input = rooted.parse(value); await authorize(ctx, input.root); const rights = await rightsBinding(ctx, input.root);
      const rows = await tx(ctx, async c => (await c.query(`SELECT v.* FROM finnor_os.primary_governance_versions v
        JOIN finnor_os.primary_governance_heads h USING(tenant_id,id,revision)
        WHERE v.tenant_id=$1 AND v.issuer_id=$2 AND h.state='CURRENT'
        AND v.schema_name=ANY($3::text[]) ORDER BY v.created_at LIMIT 129`,
      [ctx.auth.tenantId, actor(ctx), ["finnor.bilateral-mandate.v1", "finnor.bilateral-authority.v1",
        "finnor.bilateral-source-profile.v1", "finnor.bilateral-domain.v1", "finnor.bilateral-grant.v1", "finnor.relationship-policy.v1"]])).rows, true);
      if (rows.length > 128) throw Error("BILATERAL_OWNER_REGISTRY_BOUND");
      return { status: 200, body: { root: input.root, ...rights, profiles: rows.map(r =>
        ({ ref: reference(r.semantic_owner, r.id, r.revision, r.body), body: r.body })), liveActivation: "BLOCKED_EXTERNAL" } };
    }
    if (operation === "bilateral-open-work") {
      const input = BilateralOperationSchemas[operation].parse(value); await authorize(ctx, input.root);
      const work = await receiveWork({ tenantId: ctx.auth.tenantId, userId: actor(ctx), instruction: input.instruction,
        channel: "console", idempotencyKey: "v1:" + actor(ctx) + ":" + (input.investigation?.threadId ?? "standalone") + ":" + input.idempotencyKey,
        activeContext: { ...input.root, entityRefs: [input.root], ...(input.investigation ? { employeeThreadId: input.investigation.threadId } : {}) },
        employeeThreadContext: input.investigation, requireExactIntake: true,
        entityAttachments: [{ ...input.root, source: "V1:accepted-sourcing-work" }],
        authorityContext: { principalId: actor(ctx), producer: "V1_DEVELOPMENT_NOT_LIVE_AUTHORITY" } });
      return { status: 201, body: { workId: work.workId, workInputId: work.workInputId } };
    }
    if (operation === "bilateral-reserve-budget") {
      const input = BilateralOperationSchemas[operation].parse(value); await authorize(ctx, input.root); assertDevelopment();
      return { status: 201, body: await reserveFixedPrimaryBudget(ctx, { ...input, activityClass: "BILATERAL_RESEARCH_AND_CONTACT" }) };
    }
    if (operation === "bilateral-governance-put") {
      const input = BilateralOperationSchemas[operation].parse(value); await authorize(ctx, input.root);
      return { status: 201, body: { ref: await putGovernance(ctx, input.body, input.expectedRef),
        qualification: "AUTHENTICATED_DEVELOPMENT_OWNER_RECORD_NOT_LIVE_LEGAL_OR_DOMAIN_ADMISSION" } };
    }
    if (operation === "bilateral-governance-revoke") {
      const input = BilateralOperationSchemas[operation].parse(value); await authorize(ctx, input.root);
      return { status: 200, body: await revokeGovernance(ctx, input.ref, input.reason) };
    }
    if (operation === "bilateral-submit") return { status: 202, body: await submitBilateral(ctx, value) };
    if (operation === "bilateral-read") return { status: 200, body: await readBilateral(ctx, identified.parse(value).programmeId) };
    if (operation === "bilateral-handoff") {
      const input = BilateralOperationSchemas[operation].parse(value), { artifact: a } = await currentArtifact(ctx, input.artifactRef);
      return { status: 200, body: { artifactRef: input.artifactRef, opportunityId: a.opportunityId,
        root: { entityType: "pe_opportunity", entityId: a.opportunityId }, workId: a.workRef, expectedWorkInputId: a.workRevision,
        predecessorRef: input.artifactRef, assertions: a.remainingUnderwritingGaps,
        indicationBindingStatus: a.indicationBindingStatus, acquisitionPermissionGranted: false,
        requiredOwnerPackets: ["V2_MANDATE", "V2_SOURCE_PROFILES", "V2_CONSENTS", "V2_SEMANTICS", "V2_ORIGINAL_S5_RESERVATION"] } };
    }
    if (operation === "bilateral-observe") {
      const input = BilateralOperationSchemas[operation].parse(value), p = await programme(ctx, input.programmeId);
      await authorize(ctx, p.root, p.work_id); const b = await ownerBindings(ctx, p, undefined, true);
      return { status: 201, body: await acceptParticipantEvent(ctx, p, b, input.event) };
    }
    if (operation === "bilateral-cancel") {
      const input = identified.parse(value), p = await programme(ctx, input.programmeId); await authorize(ctx, p.root, p.work_id);
      await tx(ctx, async c => {
        await relationshipLock(c, p.tenant_id);
        const current = await programme(ctx, p.id, c, true);
        if (current.cancellation_requested_at) return;
        await c.query(`UPDATE finnor_os.v1_programmes SET cancellation_requested_at=clock_timestamp(),
          status='RECONCILING',reason='CANCELLATION_REQUESTED_RESPONSIBILITY_RETAINED',revision=revision+1,
          updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`, [p.tenant_id, actor(ctx), p.id]);
        await c.query(`UPDATE finnor_os.work_programme_occupations SET status='STOPPED',revision=revision+1
          WHERE tenant_id=$1 AND owner='V1_HANDOFF' AND programme_id IN
          (SELECT id FROM finnor_os.v1_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3)`,
        [p.tenant_id, actor(ctx), p.id]);
        await c.query("SELECT finnor_os.p4_touch_source($1,'bilateral-artifact:'||id::text) FROM finnor_os.v1_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
          [p.tenant_id, actor(ctx), p.id]);
        await event(ctx, p, "S6", "CANCELLATION_REQUESTED", { releaseGranted: false, unknownLiabilitiesRetained: true }, c);
        await enqueue(ctx, await programme(ctx, p.id, c), c);
      });
      await reconcileWorkStatus(p.tenant_id, p.work_id);
      return { status: 202, body: { programmeId: p.id, status: "RECONCILING", releaseGranted: false } };
    }
    if (operation === "bilateral-advance") {
      const input = BilateralAdvanceSchema.parse(value), p = await programme(ctx, input.programmeRef.id);
      await authorize(ctx, p.root, p.work_id);
      await tx(ctx, async c => {
        await relationshipLock(c, p.tenant_id);
        const current = await programme(ctx, p.id, c, true); await exactWork(ctx, current, c);
        if (current.revision !== input.expectedRevision || hash(programmeRef(current)) !== hash(input.programmeRef))
          throw Error("BILATERAL_ADVANCE_ORIGINAL_REVISION_CONFLICT");
        if (["mandateRef", "authorityProfileRef", "domainProfileRef", "budgetGrantRef"].some(key =>
          hash(current.intake[key as keyof BilateralIntake]) !== hash(input[key as keyof typeof input])))
          throw Error("BILATERAL_ADVANCE_OWNER_BINDING_CHANGED");
        const keys = [...(current.frozen_manifest?.dependencies ?? []), ...Object.values(current.frozen_manifest?.candidateDependencies ?? {}).flat()].map(d => d.key);
        const vector = (await revisions(ctx, keys, c, true)).map(d => ({ key: d.key, revision: d.revision }));
        if (new Set(input.evidenceRevisionVector.map(d => d.key)).size !== input.evidenceRevisionVector.length ||
          hash(input.evidenceRevisionVector.slice().sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) !== hash(vector))
          throw Error("BILATERAL_ADVANCE_EVIDENCE_VECTOR_CHANGED");
        const b = await ownerBindings(ctx, current, c);
        if (["COMPLETE", "STOPPED", "FAILED"].includes(current.status)) throw Error("BILATERAL_TERMINAL_PROGRAMME_REQUIRES_EXACT_NEW_AUTHORITY");
        await c.query("UPDATE finnor_os.v1_programmes SET revision=revision+1,status='PROGRESS',reason=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
          [p.tenant_id, actor(ctx), p.id]);
        const updated = await programme(ctx, p.id, c);
        await event(ctx, updated, "P7", "EXACT_LINKED_ADVANCE", {
          triggerRef: input.triggerRef, originalGrantRef: p.intake.budgetGrantRef, originalDeadline: b.mandate.deadline, grantReset: false,
        }, c);
        await enqueue(ctx, updated, c);
      });
      return { status: 202, body: await readBilateral(ctx, p.id) };
    }
    return { status: 404, body: { code: "NOT_FOUND" } };
  } catch (error) {
    if (error instanceof PeDomainError && error.code === "PE_ENTITY_NOT_FOUND")
      return { status: 404, body: { code: "PE_ENTITY_NOT_FOUND", error: "Bilateral evidence is unavailable in the authenticated scope" } };
    if (error instanceof z.ZodError) return { status: 400, body: { code: "BILATERAL_SCHEMA_INVALID", error: "An exact bounded bilateral request is required" } };
    return { status: 422, body: { code: "BILATERAL_OWNER_PREDICATE_UNPASSED",
      predicate: String((error as Error).message).match(/^[A-Z][A-Z0-9_:]{0,159}$/)?.[0] ?? "BILATERAL_OWNER_PREDICATE_UNPASSED" } };
  }
}
