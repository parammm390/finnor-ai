/** S4's checked fresh-role handoff. It retains current governed-profile bindings,
 * never copies a demonstration's authority or renews its original resources. */
import { z } from "zod";
import type { ApplicationActionModel, ExperimentRef, LearnedApplicationOperation, ScopedApplicationIdentity } from "@finnor/shared-types";
import type { PoolClient } from "pg";
import type { PeMutationContext } from "../types";
import { principal, tx } from "../evidence-execution/store";
import { applicationArtifact, assertProfileTarget, type ApplicationSessionRow, type NativeApplicationProfile } from "./store";
import { sameX2Ref, x2Digest, x2Fault, x2Ref } from "./contracts";
import {
  ApplicationExecuteSchema, ApplicationFreshAuthorityBodySchema as AuthoritySchema,
  ApplicationFreshRoleBindingSchema as BindingSchema, type ApplicationFreshAuthority as FreshAuthority,
} from "./native-contracts";

const uuid = z.string().uuid();
const GrantSchema = z.object({
  profileId: uuid, tenantId: uuid, principalId: uuid, accountId: uuid,
  principalRef: z.object({ type: z.enum(["employee", "team", "location", "tenant"]), id: uuid }).strict(),
  revision: z.number().int().nonnegative().safe(), restrictions: z.record(z.unknown()),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

function profileIdentity(restrictions: Record<string, unknown>) {
  const config = restrictions.applicationSemantics;
  if (!config || typeof config !== "object" || Array.isArray(config)) x2Fault("X2_FRESH_PROFILE_IDENTITY_UNAVAILABLE");
  const body = config as Record<string, unknown>;
  return Object.fromEntries([
    "sourceContract", "protectionDomain", "origin", "application", "account", "actingPrincipal", "role",
    "entrypoint", "documentationPaths", "contextPath", "recordPathTemplate", "requestPathTemplate", "discoverySurface",
  ].filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]]));
}

export async function prepareFreshApplicationAuthority(ctx: PeMutationContext, parent: ApplicationSessionRow,
  model: ApplicationActionModel, profiles: NativeApplicationProfile[], input: {
    sessionId: string; workId: string; workInputDigest: string; target: ScopedApplicationIdentity;
  }): Promise<{ ref: ExperimentRef; body: FreshAuthority }> {
  if (!parent.model_ref || !parent.check_ref || !sameX2Ref(parent.model_ref, model.ref)
    || profiles.length !== parent.profile_ids.length
    || new Set(profiles.map((item) => item.profile.id)).size !== profiles.length) x2Fault("X2_FRESH_ORIGINAL_MODEL_AND_PROFILES_REQUIRED");
  const bindings = new Map<string, z.infer<typeof BindingSchema>>();
  for (const operation of model.operations) {
    const old = GrantSchema.parse(await applicationArtifact(ctx, operation.authorization.grantRef));
    const current = profiles.find((item) => item.profile.id === old.profileId);
    if (!current || !parent.profile_ids.includes(old.profileId)) x2Fault("X2_FRESH_ORIGINAL_ROLE_PROFILE_REQUIRED");
    const now = GrantSchema.parse(current.grantBody);
    if (old.tenantId !== ctx.auth.tenantId || now.tenantId !== old.tenantId
      || old.principalId !== principal(ctx) || now.principalId !== old.principalId
      || now.accountId !== old.accountId || x2Digest(now.principalRef) !== x2Digest(old.principalRef)
      || operation.authorization.role !== current.profile.role
      || x2Digest(profileIdentity(old.restrictions)) !== x2Digest(profileIdentity(now.restrictions))
      || Date.parse(current.profile.validUntil) < Date.parse(parent.parent.deadlineAt)) {
      x2Fault("X2_FRESH_PRINCIPAL_ACCOUNT_ROLE_OR_TRANSPORT_CHANGE_UNADMITTED");
    }
    assertProfileTarget(current, input.target);
    const prior = bindings.get(current.profile.role);
    if (prior && (prior.profileId !== current.profile.id || !sameX2Ref(prior.originalGrantRef, operation.authorization.grantRef))) {
      x2Fault("X2_FRESH_ROLE_PROFILE_AMBIGUITY");
    }
    bindings.set(current.profile.role, BindingSchema.parse({
      profileId: current.profile.id, role: current.profile.role, applicationAccountId: current.applicationAccountId,
      originalGrantRef: operation.authorization.grantRef, currentGrantRef: current.profile.grantRef,
      privateProfileBindingDigest: current.bindingDigest,
      operationIds: [...(prior?.operationIds ?? []), operation.id],
    }));
  }
  const body = AuthoritySchema.parse({
    schema: "finnor.s4.application-fresh-authority.v1", ...input,
    parentId: parent.id, tenantId: ctx.auth.tenantId, principalId: principal(ctx),
    originalParentRef: parent.original_parent_ref, modelRef: parent.model_ref, checkRef: parent.check_ref,
    rightsRef: parent.parent.rightsRevision, deadlineAt: parent.parent.deadlineAt,
    bindings: [...bindings.values()], protectionDomain: "DISPOSABLE_TEST_AUTHORITY",
    protectedAdmission: false, executionAuthorityGranted: false,
  });
  return { body, ref: x2Ref("S4", "application-fresh-authority", body) };
}

export async function currentFreshApplicationAuthority(ctx: PeMutationContext, row: ApplicationSessionRow, client?: PoolClient) {
  const read = async (c: PoolClient) => {
    const records = (await c.query<{ ref: ExperimentRef }>(
      "SELECT body->'detail'->'freshAuthorityRef' ref FROM finnor_os.application_semantics_events"
      + " WHERE tenant_id=$1 AND principal_id=$2 AND session_id=$3 AND kind='FRESH_ASSIGNMENT_CONSUMES_FROZEN_MODEL' LIMIT 2",
      [ctx.auth.tenantId, principal(ctx), row.id])).rows;
    if (records.length !== 1 || !records[0]!.ref) x2Fault("X2_RETAINED_FRESH_AUTHORITY_REQUIRED");
    const body = AuthoritySchema.parse(await applicationArtifact(ctx, records[0]!.ref, c));
    if (row.id === row.parent_id || body.sessionId !== row.id || body.parentId !== row.parent_id
      || body.tenantId !== row.tenant_id || body.principalId !== row.principal_id || body.workId !== row.work_id
      || body.workInputDigest !== row.work_input_digest || body.deadlineAt !== row.parent.deadlineAt
      || body.target.id !== ApplicationExecuteSchema.parse(row.request).targetId
      || body.rightsRef !== row.parent.rightsRevision || !sameX2Ref(body.originalParentRef, row.original_parent_ref)
      || !row.model_ref || !sameX2Ref(body.modelRef, row.model_ref) || !row.check_ref || !sameX2Ref(body.checkRef, row.check_ref)
      || body.bindings.some((binding) => !row.profile_ids.includes(binding.profileId))
      || new Set(body.bindings.map((binding) => binding.role)).size !== body.bindings.length) x2Fault("X2_FRESH_AUTHORITY_CANONICAL_SCOPE_SUBSTITUTION");
    return body;
  };
  return client ? read(client) : tx(ctx, read, true);
}

export async function assertFreshApplicationProfile(ctx: PeMutationContext, row: ApplicationSessionRow,
  profile: NativeApplicationProfile, operation?: LearnedApplicationOperation) {
  const authority = await currentFreshApplicationAuthority(ctx, row);
  const binding = authority.bindings.find((item) => item.profileId === profile.profile.id);
  if (!binding || binding.role !== profile.profile.role || binding.applicationAccountId !== profile.applicationAccountId
    || binding.privateProfileBindingDigest !== profile.bindingDigest
    || !sameX2Ref(binding.currentGrantRef, profile.profile.grantRef)
    || operation && (!binding.operationIds.includes(operation.id) || binding.role !== operation.authorization.role
      || !sameX2Ref(binding.originalGrantRef, operation.authorization.grantRef))) x2Fault("X2_CURRENT_FRESH_ROLE_AUTHORITY_CHANGED");
  assertProfileTarget(profile, authority.target);
  return authority;
}
