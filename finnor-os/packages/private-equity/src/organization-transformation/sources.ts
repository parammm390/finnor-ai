import type { PoolClient } from "pg";
import { canExerciseWorkforceAuthorityTx } from "@finnor/authority";
import type { TenantContext } from "@finnor/shared-types";
import { organizationDigest } from "./compiler";
import type { OrganizationReference, OrganizationTransformationInput } from "./contracts";
import { organizationSource } from "./native-contracts";
import { orgActor, orgAuthority, orgEvidence, orgFail, orgTx, principal, rawDigest } from "./store";

/** Ordinary authenticated business input, not an employment action, an S2
 * assignment, a causal finding or permission to operate the proposed graph. */
export async function registerOrganizationSource(ctx: TenantContext, value: unknown) {
  const input = organizationSource.parse(value);
  return orgTx(ctx, async c => {
    await orgActor(ctx, c);
    await orgAuthority(ctx, c, input.workId, input.kind !== "OPERATING_OBSERVATION");
    const record = { schema: "finnor.organization-authenticated-source.v1", ...input,
      tenantId: ctx.tenantId, authenticatedPrincipalId: principal(ctx),
      instructionEligible: false, evidenceTruthEstablished: false, protectedAdmission: false };
    const old = (await c.query(`SELECT v.content FROM finnor_os.evidence_sources s
      JOIN finnor_os.evidence_source_versions v ON v.tenant_id=s.tenant_id AND v.source_id=s.id
      WHERE s.tenant_id=$1 AND s.source_key=$2 ORDER BY v.version_number DESC LIMIT 1`,
      [ctx.tenantId, "organization:" + input.workId + ":source:" + principal(ctx) + ":" + input.idempotencyKey])).rows[0];
    if (old && organizationDigest(JSON.parse(old.content)) !== organizationDigest(record)) orgFail("W5_SOURCE_IDEMPOTENCY_CONFLICT");
    const source = await orgEvidence(ctx, input.workId, "source:" + principal(ctx) + ":" + input.idempotencyKey, record, c);
    return { ...source, semanticReplay: !!old, qualification: "AUTHENTICATED_DECLARATION_NOT_FIELD_TRUTH" };
  });
}
export async function readOrganizationEvidenceTx(ctx: TenantContext, ref: OrganizationReference, c: PoolClient) {
  if (ref.owner !== "S1" || !/^[0-9a-f-]{36}$/i.test(ref.id)) orgFail("W5_CURRENT_S1_EVIDENCE_REQUIRED");
  const row = (await c.query(`SELECT v.id,v.source_id,v.content,v.content_hash,v.version_number,v.as_of,v.created_at,s.metadata,
    (SELECT max(n.version_number) FROM finnor_os.evidence_source_versions n
      WHERE n.tenant_id=v.tenant_id AND n.source_id=v.source_id) latest
    FROM finnor_os.evidence_source_versions v JOIN finnor_os.evidence_sources s
      ON s.tenant_id=v.tenant_id AND s.id=v.source_id
    WHERE v.tenant_id=$1 AND v.id=$2 AND v.scope='tenant' FOR SHARE OF v,s`,
    [ctx.tenantId, ref.id])).rows[0];
  if (!row || row.content_hash !== ref.contentDigest || rawDigest(row.content) !== ref.contentDigest ||
      String(row.version_number) !== ref.version || row.version_number !== row.latest || row.metadata?.revoked === true)
    orgFail("W5_S1_SOURCE_PREIMAGE_OR_CURRENTNESS_CHANGED");
  const workId = row.metadata?.workId;
  if (typeof workId !== "string" || !await canExerciseWorkforceAuthorityTx(ctx, { operation: "query", capability: "query:work",
    workId, resource: { type: "work", id: workId }, risk: "low" }, c)) orgFail("W5_CURRENT_SOURCE_READ_AUTHORITY_REQUIRED", 403);
  const record = JSON.parse(row.content);
  if (record.schema === "finnor.organization-authenticated-source.v1") {
    if (record.tenantId !== ctx.tenantId || record.workId !== workId ||
        record.authenticatedPrincipalId !== row.metadata.authenticatedPrincipal ||
        Date.parse(record.observedAt) > Date.now() || Date.parse(record.validUntil) <= Date.now())
      orgFail("W5_AUTHENTICATED_SOURCE_INTERVAL_OR_ISSUER_CHANGED");
    const author = (await c.query("SELECT status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 FOR SHARE",
      [ctx.tenantId, record.authenticatedPrincipalId])).rows[0];
    if (author?.status !== "active") orgFail("W5_CURRENT_SOURCE_ISSUER_REQUIRED");
  }
  return { ...row, record };
}
export async function resolveOrganizationSourcesTx(ctx: TenantContext, input: OrganizationTransformationInput, c: PoolClient) {
  const slice = await readOrganizationEvidenceTx(ctx, input.organization.ref, c);
  const { ref: _r, sourceRefs: _sources, ...organization } = input.organization;
  if (slice.record.schema !== "finnor.organization-authenticated-source.v1" ||
      slice.record.kind !== "ORGANIZATION_SLICE" || slice.record.sourceClass !== input.sourceClass ||
      organizationDigest(slice.record.body) !== organizationDigest({ companyId: input.companyId, ...organization }))
    orgFail("W5_ORIGINAL_ORGANIZATION_NOT_AN_ACTUAL_S1_SLICE");
  const mandate = await readOrganizationEvidenceTx(ctx, input.mandate.ref, c), { ref: _m, ...terms } = input.mandate;
  if (mandate.record.kind !== "MANDATE" || mandate.record.authenticatedPrincipalId !== input.principalId ||
      organizationDigest(mandate.record.body) !== organizationDigest({ companyId: input.companyId, ...terms }))
    orgFail("W5_EXACT_AUTHENTICATED_MANDATE_REQUIRED");
  const refs = [...input.organization.sourceRefs, ...input.organization.observations.flatMap(o => o.evidenceRefs),
    ...input.organization.obligations.flatMap(o => o.dependencyRefs).filter(r => r.owner === "S1")];
  if (refs.length > 2048) orgFail("W5_CURRENT_SOURCE_POPULATION_BOUND");
  for (const ref of new Map(refs.map(r => [organizationDigest(r), r])).values()) await readOrganizationEvidenceTx(ctx, ref, c);
  const principals = [...new Set(input.organization.roles.map(r => r.principalId))];
  const actors = (await c.query(`SELECT u.id,u.status,p.actor_kind,p.version FROM finnor_os.users u
    LEFT JOIN finnor_os.employee_actor_profiles p ON p.tenant_id=u.tenant_id AND p.principal_id=u.id
    WHERE u.tenant_id=$1 AND u.id=ANY($2::uuid[]) FOR SHARE OF u`, [ctx.tenantId, principals])).rows;
  if (actors.length !== principals.length) orgFail("W5_CANONICAL_ROLE_POPULATION_REQUIRED");
  for (const role of input.organization.roles) {
    const actor = actors.find(a => a.id === role.principalId);
    const kinds = role.kind === "DIGITAL" ? ["AGENT", "SERVICE"] : ["HUMAN"];
    if (!actor || actor.status !== "active" || !kinds.includes(actor.actor_kind)) orgFail("W5_CANONICAL_ROLE_KIND_OR_CURRENTNESS_CHANGED");
  }
  const evaluator = (await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' FOR SHARE",
    [ctx.tenantId, input.mandate.evaluatorPrincipalId])).rows[0];
  if (!evaluator || principals.includes(input.mandate.evaluatorPrincipalId)) orgFail("W5_INDEPENDENT_CURRENT_EVALUATOR_REQUIRED");
  return { slice, mandate, actors };
}
