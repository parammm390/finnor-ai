import { randomUUID } from "node:crypto";
import { evaluateAuthority } from "@finnor/authority";
import { attachWorkEntity, receiveWork } from "@finnor/db";
import type { PeMutationContext } from "../types";
import { authorize, principal, revisions, sameRevisions, closingTx as tx } from "../owner-context";
import {requireAcquisitionClosingBasis} from '../acquisition/closing-context';
import {assertEvidenceRunTransactionCurrent} from '../evidence-execution/consumer';
import { compileClosingGraph, closingCanonical, closingDigest } from "./compiler";
import { ClosingError, ClosingIntakeSchema, ClosingOperationSchemas, ClosingProfileSchema } from "./contracts";
import { appendClosingObservation, appendClosingObservationTx, closingEvent, closingProgramme, closingProgrammesFor, enqueueClosing, readClosingProgramme, verifyClosingObservation } from "./store";
import { selectClosingPlan } from "./plan";
import type { ClosingProgrammeRow } from "./contracts";
import { validateClosingAdmission } from "../../../capability-evolution/src/closing-admission";
import { closingProviderContractDigest } from "../../../governed-execution/src/closing-provider";

export const CLOSING_OPERATIONS = ["submit", "read", "projection", "observe", "stop", "resume", "ports"] as const;
const Id = ClosingOperationSchemas.read;
export async function submitClosingProgramme(ctx: PeMutationContext, value: unknown) {
  const input = ClosingIntakeSchema.parse(value), spec = input.spec, digest = closingDigest(spec), intakeDigest = closingDigest(input);
  if (input.continuation && !input.workId) throw new ClosingError("CLOSING_CONTINUATION_WORK_ID_REQUIRED", 400);
  if (spec.tenantId !== ctx.auth.tenantId || input.expectedSpecDigest !== digest) throw new ClosingError("CLOSING_EXACT_REVIEWED_SPEC_REQUIRED", 409);
  await authorize(ctx, { entityType: "pe_deal", entityId: spec.transactionId }, input.workId ? [{ type: "work", id: input.workId }] : []);
  const existing = await tx(ctx, async c => (await c.query<ClosingProgrammeRow>("SELECT * FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3", [ctx.auth.tenantId, principal(ctx), input.idempotencyKey])).rows[0], true);
  if (existing && existing.intake_digest !== intakeDigest) throw new ClosingError("CLOSING_IDEMPOTENCY_CONFLICT", 409);
  if (existing?.plan_revision_id) return { ...(await readClosingProgramme(ctx, existing.id)), replayed: true };
  const acquisition=input.workId?await requireAcquisitionClosingBasis(ctx,{workId:input.workId,icCaseId:input.acquisitionIcCaseId,spec}):null;
  if(acquisition&&!input.continuation)throw new ClosingError("CLOSING_ORIGINAL_FULL_WORK_BINDING_REQUIRED",409);
  if (spec.environment === "DEVELOPMENT" && process.env.NODE_ENV === "production") throw new ClosingError("DEVELOPMENT_CLOSING_IS_NOT_PRODUCTION_AUTHORITY", 403);
  const profileRow = await tx(ctx, async c => (await c.query("SELECT * FROM finnor_os.pe_closing_profiles WHERE tenant_id=$1 AND id=$2", [ctx.auth.tenantId, spec.profileId])).rows[0], true);
  if (!profileRow || profileRow.status !== "ACTIVE" || new Date(profileRow.valid_until).getTime() <= Date.now()) throw new ClosingError("QUALIFIED_CLOSING_PROFILE_UNAVAILABLE");
  const profile = ClosingProfileSchema.parse(profileRow.body), { admission: _admission, ...preimage } = profile;
  if (closingDigest(preimage) !== profileRow.digest || profile.environment !== spec.environment) throw new ClosingError("CLOSING_PROFILE_BINDING_CHANGED");
  verifyClosingObservation(input.legalAcceptance, profile, {
    tenant_id: spec.tenantId, transaction_id: spec.transactionId, spec_digest: digest,
    approved_terms_revision: spec.approvedTermsRevision, spec,
  });
  if (input.legalAcceptance.kind !== "LEGAL_SPEC_ACCEPTANCE" || input.legalAcceptance.status !== "CONFIRMED"
      || input.legalAcceptance.professionalScope !== "closing-spec" || input.legalAcceptance.predicateDigest !== digest
      || input.legalAcceptance.claims.accepted !== true || input.legalAcceptance.claims.specDigest !== digest) {
    throw new ClosingError("INDEPENDENT_SIGNED_LEGAL_SPEC_ACCEPTANCE_REQUIRED", 403);
  }
  if (spec.environment !== "DEVELOPMENT" && !validateClosingAdmission(profile.admission, {
    profileDigest: profileRow.digest, checkerDigest: profile.checkerDigest, environment: spec.environment,
    apiRuntimeDigest: process.env.FINNOR_V3_API_RUNTIME_DIGEST ?? "",
    workerRuntimeDigest: process.env.FINNOR_V3_WORKER_RUNTIME_DIGEST ?? "",
    providerContractDigest: closingProviderContractDigest(),
  }, JSON.parse(process.env.FINNOR_S8_V3_ISSUER_PUBLIC_KEYS ?? "{}")).admitted) {
    throw new ClosingError("CLOSING_EXACT_S8_PROFILE_INTERFACE_AND_RUNTIME_ADMISSION_REQUIRED", 403);
  }
  const graph = compileClosingGraph(spec);
  const authority = await evaluateAuthority(ctx.auth, {
    operation: "durable_operation", capability: "private_equity:close_deal",
    resource: { type: "pe_deal", id: spec.transactionId }, risk: "high", workId: input.workId,
  });
  if (authority.outcome !== "allowed") throw new ClosingError("CLOSING_INTAKE_AUTHORITY_NOT_GRANTED", 403);
  const instruction = `Advance transaction ${spec.transactionId} under legally accepted ClosingSpec ${digest}; report verified close or the exact retained disposition.`;
  const { assertClosingWorkContinuationTx } = await import("../../../orchestration/src/objective-loop");
  const continuation = input.continuation;
  const validateContinuation = async (db: Parameters<typeof assertClosingWorkContinuationTx>[0]) => {
    try {
      return await assertClosingWorkContinuationTx(db, {
        tenantId: ctx.auth.tenantId, principalId: principal(ctx), workId: input.workId!,
        transactionId: spec.transactionId, specDigest: digest, binding: continuation!,
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("CLOSING_")) throw new ClosingError(error.message, 409);
      throw error;
    }
  };
  if (input.workId && !continuation) await tx(ctx, async c => {
    const original = (await c.query(`SELECT 1 FROM finnor_os.work_objective_loops l
      JOIN finnor_os.pe_closing_programmes q ON q.tenant_id=l.tenant_id AND q.work_id=l.work_id
      WHERE l.tenant_id=$1 AND l.work_id=$2 AND l.objective=
      'Advance transaction '||q.transaction_id||' under legally accepted ClosingSpec '||q.spec_digest||
      '; report verified close or the exact retained disposition.' LIMIT 1`, [ctx.auth.tenantId, input.workId])).rows[0];
    if (!original) throw new ClosingError("CLOSING_ORIGINAL_FULL_WORK_BINDING_REQUIRED", 409);
  });
  const intake = continuation
    ? await tx(ctx, async (_c, db) => validateContinuation(db))
    : await receiveWork({
    tenantId: ctx.auth.tenantId, userId: principal(ctx), workId: input.workId, instruction, channel: "console",
    idempotencyKey: `v3:${principal(ctx)}:${input.idempotencyKey}`,
    activeContext: { entityRefs: [{ entityType: "pe_deal", entityId: spec.transactionId }], specDigest: digest },
    authorityContext: { authorityDecisionId: authority.id, originalGrant: spec.originalGrant, noFinancialAuthorityFromIntake: true },
  });
  await attachWorkEntity(ctx.auth.tenantId, intake.workId, { entityType: "pe_deal", entityId: spec.transactionId, relationship: "target", source: "V3:legally-accepted-closing-spec" });
  let q = existing;
  if (!q) q = await tx(ctx, async (c, db) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`v3-intake:${ctx.auth.tenantId}:${spec.transactionId}`]);
    const replay = (await c.query<ClosingProgrammeRow>("SELECT * FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3", [ctx.auth.tenantId, principal(ctx), input.idempotencyKey])).rows[0];
    if (replay) {
      if (replay.intake_digest !== intakeDigest) throw new ClosingError("CLOSING_IDEMPOTENCY_CONFLICT", 409);
      return replay;
    }
    const terms = (await c.query("SELECT id,source_id,content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND source_id=$2 ORDER BY version_number DESC LIMIT 1", [ctx.auth.tenantId, input.acceptedTermsEvidence.sourceId])).rows[0];
    if (terms?.id !== input.acceptedTermsEvidence.versionId || terms.content_hash !== spec.approvedTermsDigest
        || spec.approvedTermsRevision !== terms.id) throw new ClosingError("CLOSING_CURRENT_APPROVED_TERMS_SOURCE_REQUIRED", 409);
    const work = (await c.query("SELECT id,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1", [ctx.auth.tenantId, intake.workId])).rows[0];
    if (work?.id !== intake.workInputId) throw new ClosingError("CLOSING_NATIVE_WORK_REVISION_CHANGED", 409);
    if (continuation) await validateContinuation(db);
    const predecessor = (await c.query("SELECT spec,work_id,status FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1 AND transaction_id=$2 ORDER BY created_at DESC LIMIT 1", [ctx.auth.tenantId, spec.transactionId])).rows[0];
    if (predecessor && (!["STOPPED", "FAILED", "REOPENED"].includes(predecessor.status)
        || predecessor.work_id !== intake.workId
        || closingCanonical(predecessor.spec.originalGrant) !== closingCanonical(spec.originalGrant))) {
      throw new ClosingError("CLOSING_CONTINUATION_REQUIRES_ORIGINAL_WORK_GRANT_AND_RETAINED_PREDECESSOR", 409);
    }
    const currentAuthority = (await c.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1 FOR SHARE", [ctx.auth.tenantId])).rows[0];
    if (Number(currentAuthority?.revision ?? 1) !== authority.authorityRevision) throw new ClosingError("CLOSING_INTAKE_AUTHORITY_CHANGED", 409);
    const keys = [...new Set([...spec.dependencyKeys, `evidence:${terms.source_id}`, "rights:tenant", `work-inputs:${intake.workId}`, ...spec.documents.map(d => `document:${d.documentId}`)])];
    const pins = await revisions(ctx, [...keys,...(acquisition?.dependencies.map(d=>d.key)??[])], c, true);
    if(acquisition&&!sameRevisions(acquisition.dependencies,pins))throw new ClosingError("ACQUISITION_CLOSING_SOURCE_CHANGED",409);
    if(acquisition?.acquisition)await assertEvidenceRunTransactionCurrent(c,ctx.auth.tenantId,acquisition.acquisition.runId);
    const originalLoop = (await c.query("SELECT deadline_at FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2", [ctx.auth.tenantId, intake.workId])).rows[0];
    const deadline = new Date(Math.min(Date.parse(spec.originalGrant.deadlineAt), originalLoop?.deadline_at?.getTime() ?? Infinity,acquisition?.validUntil?Date.parse(acquisition.validUntil):Infinity));
    const row = (await c.query<ClosingProgrammeRow>(
      "INSERT INTO finnor_os.pe_closing_programmes(id,tenant_id,transaction_id,principal_id,work_id,work_input_id,work_input_digest,profile_id,profile_digest,accepted_terms_source_id,accepted_terms_version_id,approved_terms_revision,spec,spec_digest,graph,dependency_pins,authority_revision,intake_authority_decision_id,original_deadline_at,idempotency_key,intake_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16::jsonb,$17,$18,$19,$20,$21) RETURNING *",
      [randomUUID(), ctx.auth.tenantId, spec.transactionId, principal(ctx), intake.workId, work.id, closingDigest(work.body),
        spec.profileId, profileRow.digest, input.acceptedTermsEvidence.sourceId,
        input.acceptedTermsEvidence.versionId, spec.approvedTermsRevision, closingCanonical(spec), digest,
        closingCanonical(graph), closingCanonical(pins.map(p => ({ key: p.key, revision: p.revision }))),
        authority.authorityRevision, authority.id, deadline, input.idempotencyKey, intakeDigest],
    )).rows[0]!;
    // Core intake and its independently signed acceptance commit together. Work
    // and Plan are recoverable canonical owner phases, not an imaginary atomic
    // transaction spanning those owners.
    await appendClosingObservationTx(ctx, row, input.legalAcceptance, profile, c, db, false, false);
    await closingEvent(ctx, row, "LEGAL_SPEC_INTAKE", { specDigest: digest, originalGrant: spec.originalGrant,
      workInputId: work.id, workContinuation: continuation ?? null, acquisitionApproval:acquisition?{...acquisition.selected,acquisition:acquisition.acquisition,validUntil:acquisition.validUntil,dependencies:acquisition.dependencies}:null, planPending: true, developmentDoesNotAdmit: true }, c, "legal-intake");
    await enqueueClosing(ctx, row, "intake-recovery", c, 15000);
    return row;
  });
  const parent = await tx(ctx, async c => (await c.query("SELECT id FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision DESC LIMIT 1", [ctx.auth.tenantId, q.work_id])).rows[0], true);
  try {
    const selected = await selectClosingPlan(ctx, spec, {
      programmeId: q.id, workId: q.work_id, inputId: q.work_input_id, inputDigest: q.work_input_digest,
      specDigest: digest, authorityRevision: q.authority_revision, parentRevisionId: parent?.id ?? null, instruction,
    });
    await tx(ctx, async c => {
      await c.query("UPDATE finnor_os.pe_closing_programmes SET plan_revision_id=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND plan_revision_id IS NULL", [q.tenant_id, q.id, selected.planRevisionId]);
      await closingEvent(ctx, q, "CANONICAL_PLAN_BOUND", { planRevisionId: selected.planRevisionId }, c, "initial-plan");
      await enqueueClosing(ctx, q, "initial", c);
    });
    return { programmeId: q.id, workId: q.work_id, workInputId: q.work_input_id, status: "PROPOSED", replayed: Boolean(existing) };
  } catch (error) {
    const reason = error instanceof ClosingError ? error.code : "CLOSING_NATIVE_PLAN_BOUNDARY_UNAVAILABLE";
    // Retain owner diagnostics without logging input text, SQL parameters or
    // document bytes. Stack frames identify the failing native boundary.
    const diagnostic = {
      errorType: error instanceof Error ? error.name : "UnknownError",
      frames: error instanceof Error ? (error.stack ?? "").split("\n")
        .filter(line => line.trim().startsWith("at ")).slice(0, 8) : [],
      schemaIssues: error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
        ? error.issues.map((issue: { code?: string; path?: unknown[] }) => ({ code: issue.code, path: issue.path })) : [],
    };
    await tx(ctx, async c => {
      await c.query("UPDATE finnor_os.pe_closing_programmes SET status='BLOCKED',reason=$3 WHERE tenant_id=$1 AND id=$2 AND plan_revision_id IS NULL", [q.tenant_id, q.id, reason]);
      await closingEvent(ctx, q, "NATIVE_PLAN_SELECTION_FAILED", { reason, diagnostic }, c);
    });
    return { programmeId: q.id, workId: q.work_id, workInputId: q.work_input_id, status: "BLOCKED", reason, replayed: Boolean(existing) };
  }
}

export async function handleClosingOperation(ctx: PeMutationContext, operation: string, body: unknown) {
  if (operation === "submit") return { status: 202, body: await submitClosingProgramme(ctx, body) };
  if (operation === "read") return { status: 200, body: await readClosingProgramme(ctx, Id.parse(body).programmeId) };
  if (operation === "projection") {
    const filter = ClosingOperationSchemas.projection.parse(body);
    return { status: 200, body: { programmes: await closingProgrammesFor(ctx, filter) } };
  }
  if (operation === "observe") {
    const request = ClosingOperationSchemas.observe.parse(body);
    return { status: 202, body: await appendClosingObservation(ctx, request.programmeId, request.observation, true) };
  }
  if (operation === "stop" || operation === "resume") {
    const q = await closingProgramme(ctx, Id.parse(body).programmeId);
    const authority = await evaluateAuthority(ctx.auth, { operation: "durable_operation", capability: "private_equity:close_deal", resource: { type: "pe_deal", id: q.transaction_id }, risk: "high", workId: q.work_id });
    if (authority.outcome !== "allowed") throw new ClosingError("CLOSING_CONTROL_AUTHORITY_NOT_GRANTED", 403);
    if (operation === "stop") {
      await tx(ctx, async c => {
        await c.query("UPDATE finnor_os.pe_closing_programmes SET stopped_at=clock_timestamp(),status=CASE WHEN status='CLOSED' THEN status ELSE 'STOPPED' END,generation=generation+1,reason='AUTHENTICATED_FUTURE_WORK_STOP',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND stopped_at IS NULL", [q.tenant_id, q.id]);
        await closingEvent(ctx, q, "FUTURE_WORK_STOPPED", { actor: principal(ctx), authorityDecisionId: authority.id, existingEffectsReservationsCostsAndDutiesRetained: true, compensationAuthorized: false }, c);
      });
      const { controlWorkObjective } = await import("@finnor/orchestration");
      await controlWorkObjective({ tenantId: q.tenant_id, workId: q.work_id, command: "interrupt", actorId: principal(ctx) });
      const stopped = await closingProgramme(ctx, q.id);
      await enqueueClosing(ctx, stopped, "retained-read-only-responsibility");
    } else {
      if (q.stopped_at || ["CLOSED", "REOPENED"].includes(q.status)) throw new ClosingError("CLOSING_NEW_AUTHENTIC_CONTINUATION_REQUIRED", 409);
      await enqueueClosing(ctx, q, `resume:${randomUUID()}`);
    }
    return { status: 202, body: await readClosingProgramme(ctx, q.id) };
  }
  if (operation === "ports") {
    ClosingOperationSchemas.ports.parse(body);
    return { status: 200, body: {
    schema: "finnor.v3.owner-ports.v1", controller: "V3", profileAdmissionOwner: "S8",
    nativeWork: true, exactFinancialEvidence: true, observationDoesNotGrantAuthority: true,
    currentQualifiedPrerequisites: { V1: null, V2: null }, protectedClosingAdmission: null,
    humanControl: "LEGAL_SPEC_AND_PROFESSIONAL_EVIDENCE_REQUIRE_REAL_SIGNED_QUALIFIED_ACTORS",
    externalOperationOwner: "S6", reservationOwner: "S5", currentValidityOwner: "P7_AND_PE",
    } };
  }
  throw new ClosingError("CLOSING_OPERATION_NOT_FOUND", 404);
}
