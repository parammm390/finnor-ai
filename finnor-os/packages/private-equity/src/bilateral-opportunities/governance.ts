import type { PoolClient } from "pg";
import {
  BilateralAuthoritySchema, BilateralDomainSchema, BilateralGovernanceSchema, BilateralGrantSchema,
  BilateralMandateSchema, BilateralSourceProfileSchema, RelationshipPolicySchema,
  type BilateralGovernance, type BilateralIntake, type VReference,
} from "@finnor/shared-types";
import type { PeMutationContext } from "../types";
import { actor, assertDependencies, currentActor, exactWork, hash, methodIdentity, ownerRecord, putOwnerRecord, rightsBinding, tx, type Programme } from "./store";

const owners = {
  "finnor.bilateral-mandate.v1": "S4", "finnor.bilateral-authority.v1": "S6",
  "finnor.relationship-policy.v1": "S6", "finnor.bilateral-source-profile.v1": "S1",
  "finnor.bilateral-domain.v1": "S8", "finnor.bilateral-grant.v1": "S5",
} as const;
export function assertDevelopment(mode = "ordinary_disposable") {
  if (mode !== "ordinary_disposable" || process.env.NODE_ENV === "production" ||
    process.env.FINNOR_V1_PROFILE !== "ordinary_disposable") throw Error("BILATERAL_LIVE_LEGAL_SOURCE_INTERFACE_AND_S8_ADMISSION_REQUIRED");
}
export async function putGovernance(ctx: PeMutationContext, value: unknown, expectedRef: VReference | null) {
  const body = BilateralGovernanceSchema.parse(value);
  await currentActor(ctx); assertDevelopment();
  if (body.environment !== "DEVELOPMENT" || body.issuingPrincipalId !== actor(ctx))
    throw Error("BILATERAL_AUTHENTICATED_ORIGINAL_ISSUER_REQUIRED");
  const id = "profileId" in body ? body.profileId : body.grantId;
  return putOwnerRecord(ctx, body, { id, revision: body.revision, owner: owners[body.schema] }, expectedRef);
}
export async function bindingsForIntake(ctx: PeMutationContext, intake: BilateralIntake, c?: PoolClient, retained = false) {
  const read = async <T extends BilateralGovernance>(ref: VReference, schema: { parse(v: unknown): T }) => {
    const body = schema.parse(await ownerRecord(ctx, ref, c, retained));
    if (body.environment !== "DEVELOPMENT" || owners[body.schema] !== ref.owner) throw Error("BILATERAL_OWNER_OR_DOMAIN_MISMATCH");
    if (!retained && (Date.now() < Date.parse("validFrom" in body ? body.validFrom : "1970-01-01") ||
      Date.now() >= Date.parse(body.expiresAt))) throw Error("BILATERAL_ORIGINAL_OWNER_PROFILE_EXPIRED");
    return body;
  };
  const mandate = await read(intake.mandateRef, BilateralMandateSchema);
  const authority = await read(intake.authorityProfileRef, BilateralAuthoritySchema);
  const domain = await read(intake.domainProfileRef, BilateralDomainSchema);
  const source = await read(intake.sourceProfileRef, BilateralSourceProfileSchema);
  const policy = await read(intake.relationshipPolicyRef, RelationshipPolicySchema);
  const grant = await read(intake.budgetGrantRef, BilateralGrantSchema);
  if (hash(mandate.authorityProfileRef) !== hash(intake.authorityProfileRef) ||
    hash(mandate.sourceProfileRef) !== hash(intake.sourceProfileRef) ||
    hash(mandate.domainProfileRef) !== hash(intake.domainProfileRef) ||
    hash(mandate.relationshipPolicyRef) !== hash(intake.relationshipPolicyRef) ||
    hash(authority.relationshipPolicyRef) !== hash(intake.relationshipPolicyRef) ||
    mandate.buyerEntityId !== policy.firmEntityId || mandate.programmeGrammar !== domain.grammar ||
    grant.issuingPrincipalId !== actor(ctx) || grant.mandateId !== mandate.profileId ||
    grant.legalEntityId !== mandate.buyerEntityId ||
    intake.eligibleCompanyIds.length > mandate.maximumCompanies ||
    new Set(intake.eligibleCompanyIds).size !== intake.eligibleCompanyIds.length ||
    authority.professionalRequirements.length ||
    !authority.activities.some(a => a.activity === "RESEARCH" && a.actorIds.includes(actor(ctx))) ||
    !authority.legalEntityIds.includes(mandate.buyerEntityId) ||
    intake.underwritingGapAssertions.some(a => !mandate.permittedFullDiligenceGapIds.includes(a.assertionId) ||
      !intake.eligibleCompanyIds.includes(a.semantics.legalEntityId)))
    throw Error(authority.professionalRequirements.length ? "BILATERAL_DESIGNATED_PROFESSIONAL_ATTESTATION_REQUIRED" : "BILATERAL_ORIGINAL_SCOPE_BINDING_MISMATCH");
  assertDevelopment(intake.mode);
  const rights = retained
    ? { rightsRef: source.rightsRef, rightsRevision: Number(source.rightsRef.revision), pin: null }
    : await rightsBinding(ctx, intake.root,c);
  if (!retained && (hash(source.rightsRef) !== hash(rights.rightsRef) ||
    Date.now() >= Math.min(Date.parse(mandate.deadline), Date.parse(grant.originalProgrammeDeadline), Date.parse(source.retentionUntil))))
    throw Error("BILATERAL_ORIGINAL_RIGHTS_OR_DEADLINE_EXHAUSTED");
  return { mandate, authority, domain, source, policy, grant, rights, retained };
}
export type OwnerBindings = Awaited<ReturnType<typeof bindingsForIntake>>;
export async function ownerBindings(ctx: PeMutationContext, p: Programme, c?: PoolClient, retained = false,
  validatedIdentity?: Awaited<ReturnType<typeof methodIdentity>>): Promise<OwnerBindings> {
  const run = async (client: PoolClient) => {
    if (!retained) await currentActor(ctx, client);
    else {
      const custody = (await client.query("SELECT current_user AS role")).rows[0]?.role;
      if (!["finnor_app", "finnor_worker"].includes(custody) || p.principal_id !== actor(ctx))
        throw Error("S6_ORIGINAL_RETENTION_CUSTODY_REQUIRED");
    }
    const bindings = await bindingsForIntake(ctx, p.intake, client, retained);
    const reservation = (await client.query(`SELECT o.body,s.status,s.revocation_reason,p.problem,p.certificate
      FROM finnor_os.s5_reservation_origins o JOIN finnor_os.s5_reservations s USING(tenant_id,reservation_id)
      JOIN finnor_os.s5_proposals p ON p.tenant_id=s.tenant_id AND p.content_digest=s.allocation_digest
      WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.reservation_id=$3`,
    [ctx.auth.tenantId, actor(ctx), bindings.grant.reservationRef.id])).rows[0];
    if (!reservation || hash(reservation.body.ref.contentDigest) !== hash(bindings.grant.reservationRef.contentDigest) ||
      hash(reservation.problem.root) !== hash(p.root) || reservation.problem.schema !== "finnor.s5.fixed-programme-problem.v1" ||
      !retained && (reservation.status === "RELEASED" || reservation.revocation_reason ||
        Date.now() >= Date.parse(reservation.certificate.validUntil)))
      throw Error("BILATERAL_ORIGINAL_S5_ROOT_RESERVATION_UNAVAILABLE");
    if (!retained) {
      if (p.frozen_manifest) {
        const identity = validatedIdentity ?? await methodIdentity(ctx,client);
        if (identity.producerDigest !== p.frozen_manifest.producerDigest || identity.lockDigest !== p.frozen_manifest.lockDigest ||
          identity.schemaDigest !== p.frozen_manifest.schemaDigest) throw Error("BILATERAL_CURRENT_METHOD_OR_SCHEMA_CHANGED");
      }
      await exactWork(ctx, p, client);
      await assertDependencies(ctx, (p.frozen_manifest?.dependencies ?? []).map(d => ({ ...d, nodeIds: [], digest: null })), client);
      if (p.invalidated || p.cancellation_requested_at) throw Error("BILATERAL_CURRENT_INPUT_PERMISSION_FENCED");
    }
    return bindings;
  };
  return c ? run(c) : tx(ctx, run);
}
