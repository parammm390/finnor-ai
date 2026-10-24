import { randomUUID } from "node:crypto";
import { originOf, prepareInstitutionApplicationOrigin } from "../../../orchestration/src/project-z/z0-convergence/institution-origin";
import { returnInstitutionApplicationToOriginal } from "../../../orchestration/src/project-z/z0-convergence/institution-consumer";
import { projectInstitutionApplication } from "../../../orchestration/src/project-z/z0-convergence/projection";
import { transitionWorkTx } from "@finnor/db";
import type { ApplicationFreshAuthorityView, ExperimentRef } from "@finnor/shared-types";
import type { PeMutationContext } from "../types";
import { authorize, principal, schemaIdentity, tx, unavailable } from "../evidence-execution/store";
import type { OriginalApplicationParent } from "./ports";
import {
  ApplicationAcquireSchema, ApplicationExecuteSchema, ApplicationProjectionSchema,
  type ApplicationAcquireRequest,
} from "./native-contracts";
import { reserveApplicationParent, applicationParentCharges } from "./allocation";
import {
  applicationArtifact, applicationEvent, applicationSession, assertProfileTarget, currentApplicationWork,
  currentApplicationModel, enqueueApplicationSession, nativeApplicationProfile, pinnedApplicationCode,
  retainApplicationArtifact, type ApplicationSessionRow,
} from "./store";
import { x2Digest, x2Fault, x2Ref } from "./contracts";
import { currentFreshApplicationAuthority, prepareFreshApplicationAuthority } from "./fresh-authority";

const keyFor = (ctx: PeMutationContext, key: string) => `x2-acquire:${x2Digest([ctx.auth.tenantId, principal(ctx), key])}`;
async function workInput(ctx: PeMutationContext, workId: string) {
  return tx(ctx, async (c) => {
    const row = (await c.query<{ id: string; body: unknown }>(
      "SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
      [ctx.auth.tenantId, workId])).rows[0];
    if (!row) throw unavailable();
    return row;
  }, true);
}
/** Called by the actual S4 owner. Reservation and original session are one
 * portfolio-serialized transaction, so a retry cannot orphan or renew either. */
export async function registerNativeApplicationAcquisition(ctx: PeMutationContext, input: ApplicationAcquireRequest) {
  const parsed = ApplicationAcquireSchema.parse(input);
  const request = { ...parsed, deadlineAt: new Date(parsed.deadlineAt).toISOString() };
  if (ctx.auth.role !== "owner" || principal(ctx) !== ctx.auth.userId) throw unavailable();
  const rights = await authorize(ctx, request.root, [{ type: "work", id: request.workId }]);
  const requestDigest = x2Digest(request), key = keyFor(ctx, request.idempotencyKey);
  const prior = await tx(ctx, async (c) => (await c.query<{ id: string; request_digest: string }>(
    "SELECT id,request_digest FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
    [ctx.auth.tenantId, principal(ctx), request.idempotencyKey])).rows[0], true);
  if (prior) {
    if (prior.request_digest !== requestDigest) x2Fault("X2_ACQUISITION_IDEMPOTENCY_CONFLICT");
    return { sessionId: prior.id, status: (await applicationSession(ctx, prior.id)).status, semanticReplay: true };
  }
  const institutionalOrigin = await prepareInstitutionApplicationOrigin(ctx, request);
  if (new Set(request.profileIds).size !== request.profileIds.length || new Set(request.targets.map((target) => target.id)).size !== request.targets.length) {
    x2Fault("X2_ORIGINAL_DISTINCT_PROFILE_AND_TARGET_BINDINGS");
  }
  let profiles: Awaited<ReturnType<typeof nativeApplicationProfile>>[];
  try {
    profiles = await Promise.all(request.profileIds.map((id) => nativeApplicationProfile(ctx, id)));
  } catch (error) {
    // This refusal precedes every reservation and session write. Other failures
    // must not be translated into a claim that registration did not happen.
    if (error instanceof Error && "code" in error && error.code === "PE_ENTITY_NOT_FOUND") {
      x2Fault("X2_ACQUISITION_PROFILE_UNAVAILABLE", 404);
    }
    throw error;
  }
  for (const profile of profiles) for (const target of request.targets) assertProfileTarget(profile, target);
  const end = Date.parse(request.deadlineAt);
  if (end <= Date.now() || end > Date.now() + 3600000 || profiles.some((item) => Date.parse(item.profile.validUntil) < end)) {
    x2Fault("X2_ORIGINAL_AUTHORIZED_DEADLINE_REQUIRED");
  }
  const inputRow = await workInput(ctx, request.workId), code = await pinnedApplicationCode(), catalog = await schemaIdentity(ctx);
  if (institutionalOrigin && (institutionalOrigin.body.workInputId !== inputRow.id
    || institutionalOrigin.body.workInputDigest !== x2Digest(inputRow.body))) x2Fault("Z0_EXACT_ORIGINAL_X1_INPUT_REQUIRED");
  const sessionId = randomUUID(), validAfter = new Date().toISOString();
  const rightsRef = `S1:employee:${principal(ctx)}:revision:${rights.revision}`;
  const originalBody = { schema: "finnor.s4.application-original-parent.v1", sessionId,
    tenantId: ctx.auth.tenantId, principalId: principal(ctx), root: request.root, workId: request.workId,
    workInputId: inputRow.id, workInputDigest: x2Digest(inputRow.body), rightsRef,
    requestDigest, deadlineAt: request.deadlineAt, registeredResourceDemand: request.resourceDemand,
    institutionalOriginRef: institutionalOrigin?.ref ?? null,
    profileGrants: profiles.map((item) => item.profile.grantRef), sourceCut: code.digest, schemaDigest: catalog,
    dependencyLockDigest: code.lockDigest, runtimeDigest: code.runtimeDigest, validAfter,
    protectionDomain: "DISPOSABLE_TEST_AUTHORITY", protectedAdmission: false, executionAuthorityGranted: false };
  const originalRef = x2Ref("S4", "application-original-parent", originalBody);
  const preparationBody = { schema: "finnor.s4.application-acquisition-preparation.v1", originalParentRef: originalRef,
    tenantId: ctx.auth.tenantId, principalId: principal(ctx), workId: request.workId, root: request.root,
    rightsRef, requestDigest, targets: request.targets, sourceCut: code.digest, deadlineAt: request.deadlineAt,
    authorizedExploration: "CURRENT_DISPOSABLE_NATIVE_AND_EXTERNAL_PROFILE_REQUIRED", selectedBy: "S4",
    resourceOwner: "S5", effectOwner: "S6", executionAuthorityGranted: false };
  const preparationRef = x2Ref("S4", "application-acquisition-preparation", preparationBody);
  const baselineBody = { kind: "B_live", qualification: "EXACT_UNSEALED_DEVELOPMENT_SOURCE_AND_SCHEMA_CUT",
    sourceDigest: code.digest, schemaDigest: catalog, runtime: code.runtime, dependencyLockDigest: code.lockDigest,
    B_V: "UNAVAILABLE_NOT_ASSUMED", protectedAdmission: false };
  const authorityBody = { schema: "finnor.s1.application-work-authority-observation.v1",
    tenantId: ctx.auth.tenantId, principalId: principal(ctx), root: request.root, workId: request.workId,
    rightsRef, evaluatedAt: rights.evaluatedAt, profileGrantRefs: profiles.map((item) => item.profile.grantRef),
    qualification: "CURRENT_NATIVE_AUTHORIZATION_NOT_EXTERNAL_LEGAL_MEANING" };
  const grammarBody = { schema: "finnor.x2.bounded-operation-grammar.v1", scalar: "EXACT_SCOPED_DECIMAL_OR_IDENTITY",
    guard: "PRESENT_EQ_NEQ_IN_CONJUNCTION", assignment: "LITERAL_PARAMETER_OR_OBSERVED_FIELD",
    freshIdentity: "EVIDENCE_DERIVED_CURRENT_OBSERVATION_BINDING", bounds: { fields: 16, operations: 16, parameters: 8,
      interactions: 64, observations: 256, composition: 8, branches: 8, search: 64, unresolved: 1 },
    sourceCut: code.digest, externalUniversalProof: false };
  const runtimeBody = { schema: "finnor.x2.native-runtime-cut.v1", ...code.runtime, sourceCut: code.digest,
    schemaDigest: catalog, dependencyLockDigest: code.lockDigest, supportedAuthority: "DISPOSABLE_TEST_AUTHORITY" };
  const refs = {
    tenant: x2Ref("S1", "application-tenant-scope", { tenantId: ctx.auth.tenantId }),
    work: x2Ref("WORK", "application-work-input", { workId: request.workId, inputId: inputRow.id, digest: x2Digest(inputRow.body) }),
    baseline: x2Ref("S4", "application-baseline", baselineBody),
    authority: x2Ref("AUTHORITY", "application-work-authority-observation", authorityBody),
    producer: x2Ref("S4", "application-producer-cut", { sourceCut: code.digest }),
    grammar: x2Ref("S4", "application-operation-grammar", grammarBody),
    checker: x2Ref("S4", "application-independent-checker-cut", {
      sourceCut: code.digest, file: code.pins.find((pin) => pin.path.endsWith("/application-semantics/checker.ts"))!,
      expectationSource: "ORIGINAL_OWNER_RETAINED_OBSERVATIONS_NOT_LEARNER_INFERENCE" }),
    runtime: x2Ref("S4", "application-native-runtime-cut", runtimeBody),
  };
  const allocated = await reserveApplicationParent(ctx, {
    originalParentRef: originalRef, preparationRef, workId: request.workId, root: request.root, rightsRef,
    deadlineAt: request.deadlineAt, idempotencyKey: key, requestDigest, demand: request.resourceDemand,
    institutionalOrigin, institutionalRequest: request,
    onReserved: async (c, allocation) => {
      const currentRights = await authorize(ctx, request.root, [{ type: "work", id: request.workId }]);
      const latest = (await c.query<{ id: string; body: unknown }>(
        "SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
        [ctx.auth.tenantId, request.workId])).rows[0];
      if (currentRights.revision !== rights.revision || latest?.id !== inputRow.id
        || x2Digest(latest.body) !== x2Digest(inputRow.body) || end <= Date.now()) x2Fault("X2_ORIGINAL_PREPARATION_BECAME_STALE");
      const parent: OriginalApplicationParent = {
        originalParentRef: originalRef, tenantRef: refs.tenant, workRef: refs.work,
        institutionalProgramRef: institutionalOrigin?.body.institutionalProgramRef ?? null,
        ...(institutionalOrigin ? { institutionalOriginRef: institutionalOrigin.ref } : {}),
        authorityGrantRef: refs.authority, resourceGrantRef: allocation.reservation.ref,
        baselineManifestRef: refs.baseline, rightsRevision: rightsRef, deadlineAt: request.deadlineAt, validAfter,
        dependencyLockDigest: code.lockDigest, runtimeDigest: code.runtimeDigest, schemaDigest: catalog,
        dependencyPins: code.pins, producerRef: refs.producer, grammarRef: refs.grammar, checkerRef: refs.checker,
        runtimeRef: refs.runtime, costRefs: [allocation.rootConsumption.ref], humanWorkRefs: [],
      };
      await c.query("INSERT INTO finnor_os.application_semantics_sessions(id,tenant_id,principal_id,work_id,root,work_input_id,work_input_digest,parent_id,original_parent_ref,parent,profile_ids,request,request_digest,idempotency_key,rights_revision,allocation_ref,reservation_ref,root_consumption_ref,status,deadline_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$1,$8::jsonb,$9::jsonb,$10::uuid[],$11::jsonb,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,'QUEUED',$18)",
        [sessionId, ctx.auth.tenantId, principal(ctx), request.workId, JSON.stringify(request.root), inputRow.id,
          x2Digest(inputRow.body), JSON.stringify(originalRef), JSON.stringify(parent), request.profileIds,
          JSON.stringify(request), requestDigest, request.idempotencyKey, rights.revision, JSON.stringify(allocation.certificate.ref),
          JSON.stringify(allocation.reservation.ref), JSON.stringify(allocation.rootConsumption.ref), request.deadlineAt]);
      const row = await applicationSession(ctx, sessionId, c);
      const records: Array<[ExperimentRef, unknown]> = [
        [originalRef, originalBody], [preparationRef, preparationBody], [refs.baseline, baselineBody],
        [refs.authority, authorityBody], [refs.grammar, grammarBody], [refs.runtime, runtimeBody],
        [refs.tenant, { tenantId: ctx.auth.tenantId }],
        [refs.work, { workId: request.workId, inputId: inputRow.id, digest: x2Digest(inputRow.body) }],
        [refs.producer, { sourceCut: code.digest }],
        [refs.checker, { sourceCut: code.digest, file: code.pins.find((pin) => pin.path.endsWith("/application-semantics/checker.ts"))!,
          expectationSource: "ORIGINAL_OWNER_RETAINED_OBSERVATIONS_NOT_LEARNER_INFERENCE" }],
        ...profiles.map((item) => [item.profile.grantRef, item.grantBody] as [ExperimentRef, unknown]),
      ];
      for (const [ref, body] of records) await retainApplicationArtifact(ctx, ref, body, false, c, [rightsRef]);
      await applicationEvent(ctx, row, "S4_PREPARATION_AND_ORIGINAL_S5_RESERVATION", {
        preparationRef, allocationRef: allocation.certificate.ref, reservationRef: allocation.reservation.ref,
        originalDeadline: request.deadlineAt, noPhysicalDiscoveryBeforeReservation: true, billing: "UNKNOWN", labor: "UNKNOWN",
      }, c);
      await enqueueApplicationSession(ctx, row, "acquisition", c);
    },
  });
  const row = await tx(ctx, async (c) => (await c.query<{ id: string; status: string }>(
    "SELECT id,status FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND allocation_ref=$3::jsonb AND id=parent_id",
    [ctx.auth.tenantId, principal(ctx), JSON.stringify(allocated.certificate.ref)])).rows[0], true);
  if (!row) x2Fault("X2_ATOMIC_ORIGINAL_SESSION_AND_RESERVATION_REQUIRED");
  return { sessionId: row.id, status: row.status, originalParentRef: allocated.certificate.originalParentRef,
    allocationRef: allocated.certificate.ref, deadlineAt: allocated.certificate.deadlineAt, protectedAdmission: false };
}
export async function requestApplicationAcquisition(ctx: PeMutationContext, input: unknown) {
  const { prepareEnterpriseApplicationAcquisition } = await import("../enterprise-control");
  return prepareEnterpriseApplicationAcquisition(ctx, ApplicationAcquireSchema.parse(input));
}
export async function requestApplicationExecution(ctx: PeMutationContext, input: unknown) {
  const request = ApplicationExecuteSchema.parse(input);
  const parent = await applicationSession(ctx, request.sessionId);
  if (originOf(parent)) x2Fault("Z0_INSTITUTION_LEARNING_IS_NOT_FRESH_BUSINESS_AUTHORITY", 403);
  if (parent.id !== parent.parent_id || parent.status !== "MODEL_READY") x2Fault("X2_FROZEN_NATIVE_MODEL_REQUIRED_BEFORE_FRESH_OBJECTIVE");
  await currentApplicationWork(ctx, parent);
  await authorize(ctx, request.root, [{ type: "work", id: request.workId }]);
  const { model } = await currentApplicationModel(ctx, parent);
  if (!parent.profile_ids.includes(request.executionProfileId)
    || x2Digest(request.root) !== x2Digest(parent.root) || request.workId === parent.work_id) x2Fault("X2_FRESH_AUTHORIZED_WORK_AND_PROFILE_REQUIRED");
  if ((parent.request as ApplicationAcquireRequest).targets.some((target) => target.id === request.targetId)) x2Fault("X2_FRESH_RECORD_MUST_NOT_BE_A_DEMONSTRATION");
  const profiles = await Promise.all(parent.profile_ids.map((id) => nativeApplicationProfile(ctx, id)));
  const profile = profiles.find((item) => item.profile.id === request.executionProfileId)!;
  const observationTarget = { kind: "identity" as const, application: model.scope.application, account: model.scope.account,
    entity: profile.allowedEntities.length === 1 ? profile.allowedEntities[0]! : "", id: request.targetId };
  if (!observationTarget.entity) x2Fault("X2_EXACT_FRESH_TARGET_ENTITY_REQUIRED");
  assertProfileTarget(profile, observationTarget);
  const childInput = await workInput(ctx, request.workId);
  const digest = x2Digest(request), childId = randomUUID();
  const fresh = await prepareFreshApplicationAuthority(ctx, parent, model, profiles, {
    sessionId: childId, workId: request.workId, workInputDigest: x2Digest(childInput.body), target: observationTarget,
  });
  await tx(ctx, async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`s5-portfolio:${ctx.auth.tenantId}`]);
    const prior = (await c.query<{ id: string; request_digest: string }>(
      "SELECT id,request_digest FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
      [ctx.auth.tenantId, principal(ctx), request.idempotencyKey])).rows[0];
    if (prior) { if (prior.request_digest !== digest) x2Fault("X2_EXECUTION_IDEMPOTENCY_CONFLICT"); return; }
    await c.query("INSERT INTO finnor_os.application_semantics_sessions(id,tenant_id,principal_id,work_id,root,work_input_id,work_input_digest,parent_id,original_parent_ref,parent,profile_ids,request,request_digest,idempotency_key,rights_revision,allocation_ref,reservation_ref,root_consumption_ref,status,deadline_at,model_ref,check_ref) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9::jsonb,$10::jsonb,$11::uuid[],$12::jsonb,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,'QUEUED',$19,$20::jsonb,$21::jsonb)",
      [childId, ctx.auth.tenantId, principal(ctx), request.workId, JSON.stringify(parent.root), childInput.id, x2Digest(childInput.body),
        parent.id, JSON.stringify(parent.original_parent_ref), JSON.stringify(parent.parent), parent.profile_ids, JSON.stringify(request),
        digest, request.idempotencyKey, parent.rights_revision, JSON.stringify(parent.allocation_ref), JSON.stringify(parent.reservation_ref),
        JSON.stringify(parent.root_consumption_ref), parent.parent.deadlineAt, JSON.stringify(parent.model_ref), JSON.stringify(parent.check_ref)]);
    const child = await applicationSession(ctx, childId, c);
    await currentApplicationWork(ctx, child, c);
    for (const current of profiles) await retainApplicationArtifact(ctx, current.profile.grantRef, current.grantBody, false, c, [parent.parent.rightsRevision]);
    await retainApplicationArtifact(ctx, fresh.ref, fresh.body, false, c, [parent.parent.rightsRevision]);
    await applicationEvent(ctx, child, "FRESH_ASSIGNMENT_CONSUMES_FROZEN_MODEL", {
      modelRef: parent.model_ref, checkRef: parent.check_ref, originalParentRef: parent.original_parent_ref,
      originalDeadline: parent.parent.deadlineAt, newAllowance: false, freshTarget: observationTarget,
      freshAuthorityRef: fresh.ref,
    }, c);
    await enqueueApplicationSession(ctx, child, "fresh-execution", c);
  });
  const row = await tx(ctx, async (c) => (await c.query<{ id: string; status: string }>(
    "SELECT id,status FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3",
    [ctx.auth.tenantId, principal(ctx), request.idempotencyKey])).rows[0], true);
  if (!row) throw unavailable();
  return { sessionId: row.id, status: row.status, originalParentRef: parent.original_parent_ref,
    originalDeadline: parent.parent.deadlineAt, newAllowance: false };
}
export async function projectApplicationSemantics(ctx: PeMutationContext, input: unknown) {
  const request = ApplicationProjectionSchema.parse(input);
  await authorize(ctx, request.root, [{ type: "work", id: request.workId }]);
  const rows = await tx(ctx, async (c) => (await c.query<ApplicationSessionRow>(
    "SELECT * FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND root=$4::jsonb ORDER BY created_at DESC,id DESC LIMIT 17",
    [ctx.auth.tenantId, principal(ctx), request.workId, JSON.stringify(request.root)])).rows, true);
  if (rows.length > 16) x2Fault("X2_SESSION_PROJECTION_REQUIRES_PAGINATION");
  const sessions = [];
  for (const row of rows) {
    const { model, check } = row.model_ref && row.check_ref ? await currentApplicationModel(ctx, row) : { model: null, check: null };
    const composition = row.composition_ref ? await applicationArtifact<Record<string, unknown>>(ctx, row.composition_ref) : null;
    const authority = row.id !== row.parent_id ? await currentFreshApplicationAuthority(ctx, row) : null;
    const freshAuthority: ApplicationFreshAuthorityView | null = authority ? {
      schema: "finnor.x2.application-fresh-authority-view.v1",
      ref: x2Ref("S4", "application-fresh-authority", authority),
      sessionId: authority.sessionId, parentId: authority.parentId,
      tenantId: authority.tenantId, principalId: authority.principalId, workId: authority.workId,
      originalParentRef: authority.originalParentRef, modelRef: authority.modelRef, checkRef: authority.checkRef,
      rightsRef: authority.rightsRef, target: authority.target, deadlineAt: authority.deadlineAt,
      bindings: authority.bindings.map(({ profileId, role, applicationAccountId, originalGrantRef, currentGrantRef, operationIds }) =>
        ({ profileId, role, applicationAccountId, originalGrantRef, currentGrantRef, operationIds })),
      qualification: "AUTHENTICATED_CANONICAL_S4_PROJECTION_NOT_AN_AUTHORITY_GRANT",
      protectionDomain: "DISPOSABLE_TEST_AUTHORITY", protectedAdmission: false, executionAuthorityGranted: false,
    } : null;
    const effects = await tx(ctx, async (c) => (await c.query(
      "SELECT r.id request_id,r.status,r.possible_egress,r.observation_ref,o.body->'ref' obligation_ref,o.effect_id,e.status effect_status,e.verification,d.status action_status"
      + " FROM finnor_os.application_semantics_requests r JOIN finnor_os.s6_obligation_origins o ON o.tenant_id=r.tenant_id AND o.obligation_id=r.obligation_id"
      + " JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id"
      + " JOIN finnor_os.domain_actions d ON d.tenant_id=o.tenant_id AND d.id=o.domain_action_id"
      + " WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.session_id=$3 ORDER BY r.created_at,r.id LIMIT 65",
      [ctx.auth.tenantId, principal(ctx), row.id])).rows, true);
    if (effects.length > 64) x2Fault("X2_EFFECT_PROJECTION_REQUIRES_PAGINATION");
    sessions.push({ id: row.id, parentId: row.parent_id, status: row.status, reason: row.reason,
      generation: row.generation, deadlineAt: row.parent.deadlineAt, originalParentRef: row.original_parent_ref,
      model, check, freshAuthority, composition: composition && row.composition_ref ? { ...composition, ref: row.composition_ref } : null,
      effects, charges: await applicationParentCharges(ctx, row.allocation_ref), billing: "UNKNOWN",
      institutional: await projectInstitutionApplication(ctx, row),
      resourceReleaseGranted: false, protectedAdmission: false, cancelledAt: row.cancel_requested_at?.toISOString() ?? null });
  }
  return { schema: "finnor.x2.work-projection.v1", tenantId: ctx.auth.tenantId, principalId: principal(ctx),
    root: request.root, workId: request.workId, sessions };
}
export async function cancelApplicationSemantics(ctx: PeMutationContext, input: unknown) {
  const request = ApplicationProjectionSchema.parse(input);
  if (ctx.auth.role !== "owner" || principal(ctx) !== ctx.auth.userId) throw unavailable();
  await authorize(ctx, request.root, [{ type: "work", id: request.workId }]);
  return tx(ctx, async (c, db) => {
    const rows = (await c.query<ApplicationSessionRow>(
      "SELECT * FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND root=$4::jsonb"
      + " AND work_input_id=(SELECT id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1)"
      + " ORDER BY id FOR NO KEY UPDATE",
      [ctx.auth.tenantId, principal(ctx), request.workId, JSON.stringify(request.root)])).rows;
    for (const row of rows) await currentApplicationWork(ctx, row, c, true);
    for (const row of rows) {
      if (row.cancel_requested_at) continue;
      const updated = (await c.query<ApplicationSessionRow>(
        "UPDATE finnor_os.application_semantics_sessions SET cancel_requested_at=clock_timestamp(),status=CASE WHEN status IN ('COMPLETED','MODEL_READY','FAILED','STALE','BLOCKED') THEN status ELSE 'CANCELLED' END,generation=generation+1,claim_token=NULL,claim_fence=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *",
        [ctx.auth.tenantId, row.id])).rows[0]!;
      await applicationEvent(ctx, updated, "CANCELLED_POSSIBLE_EFFECTS_AND_ORIGINAL_OCCUPATION_RETAINED",
        { originalParentRef: row.original_parent_ref, externalRollbackClaimed: false }, c);
      await enqueueApplicationSession(ctx, updated, "cancellation-observation", c);
      await returnInstitutionApplicationToOriginal(ctx, updated, c);
    }
    const current = rows.find(row => !originOf(row));
    if (current) {
      const work = (await c.query<{ status: string }>("SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2",
        [ctx.auth.tenantId, request.workId])).rows[0]!;
      // Cancellation stops intent. It cannot rewrite completed business history.
      if (!["completed", "cancelled"].includes(work.status)) await transitionWorkTx(db, ctx.auth.tenantId,
        request.workId, "cancelled", "x2_application_cancelled", {
          schema: "finnor.x2.work-cancellation.v1", workInputId: current.work_input_id,
          sessions: rows.map(row => row.id), externalRollbackClaimed: false, resourceReleaseGranted: false,
        }, { expectedWorkInputId: current.work_input_id });
    }
    return { status: "CANCELLED", externalRollbackClaimed: false, resourceReleaseGranted: false, sessions: rows.map((row) => row.id) };
  });
}
export const APPLICATION_OPERATIONS = ["application-acquire", "application-execute", "application-projection", "application-cancel", "application-resume"] as const;
export const APPLICATION_OPERATION_SCHEMAS = {
  "application-acquire": ApplicationAcquireSchema,
  "application-execute": ApplicationExecuteSchema,
  "application-projection": ApplicationProjectionSchema,
  "application-cancel": ApplicationProjectionSchema,
  "application-resume": ApplicationProjectionSchema.extend({ sessionId: ApplicationExecuteSchema.shape.sessionId }).strict(),
} as const;
export async function handleApplicationOperation(ctx: PeMutationContext, operation: string, input: unknown) {
  if (operation === "application-acquire") return { body: await requestApplicationAcquisition(ctx, input), status: 202 };
  if (operation === "application-execute") return { body: await requestApplicationExecution(ctx, input), status: 202 };
  if (operation === "application-projection") return { body: await projectApplicationSemantics(ctx, input), status: 200 };
  if (operation === "application-cancel") return { body: await cancelApplicationSemantics(ctx, input), status: 200 };
  if (operation === "application-resume") {
    const request = APPLICATION_OPERATION_SCHEMAS["application-resume"].parse(input);
    const row = await applicationSession(ctx, request.sessionId);
    if (row.work_id !== request.workId || x2Digest(row.root) !== x2Digest(request.root)) x2Fault("X2_RESUME_CANONICAL_WORK_SCOPE");
    await currentApplicationWork(ctx, row, undefined, true);
    return tx(ctx, async (c) => {
      const current = await applicationSession(ctx, row.id, c, true);
      await c.query("UPDATE finnor_os.application_semantics_sessions SET generation=generation+1,claim_token=NULL,claim_fence=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [ctx.auth.tenantId, row.id]);
      const next = await applicationSession(ctx, row.id, c);
      await enqueueApplicationSession(ctx, next, "original-observation-and-continuation", c);
      return { body: { sessionId: next.id, status: current.status, generation: next.generation,
        originalDeadline: next.parent.deadlineAt, originalParentRef: next.original_parent_ref,
        newAllowance: false, replayPossibleEffect: false }, status: 202 };
    });
  }
  x2Fault("X2_OPERATION_UNSUPPORTED", 404);
}
