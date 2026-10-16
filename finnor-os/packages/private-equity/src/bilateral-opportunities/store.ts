import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import type {
  BilateralIntake, BilateralSnapshot, PrimaryCostReceipt, PrimaryProgrammeStatus,
  QualifiedBilateralOpportunity, SignedBilateralSnapshot, VReference,
} from "@finnor/shared-types";
import { BilateralGrantSchema, SignedBilateralCheckSchema, SignedBilateralReplySchema } from "@finnor/shared-types";
import { verifySigned } from "../../../governed-execution/src/canonical";
import type { PeMutationContext, PeWorldRootRef } from "../types";
import {
  actor, authorize, canonical, currentActor, exactWork, hash, newId, ownerRecord,
  putOwnerRecord, reference, revokeGovernance, rightsBinding, tx, unavailable,
} from "../primary-diligence/store";
import { assertDependencies, codeIdentity, revisions, schemaIdentity } from "../evidence-execution/store";

export { actor, authorize, canonical, currentActor, exactWork, hash, newId, ownerRecord,
  putOwnerRecord, reference, revokeGovernance, rightsBinding, tx, unavailable, assertDependencies, revisions };
export type Dependency = { key: string; revision: number };
export interface FrozenManifest {
  knowledgeCut: string; snapshot: SignedBilateralSnapshot; snapshotRef: VReference;
  canonicalPipeline: Array<{ id: string; target: string; state: string; buyer: string | null }>;
  companyRefs: Record<string, VReference>; counterpartyRefs: Record<string, VReference>; buyerRef: VReference;
  dependencies: Dependency[]; candidateDependencies: Record<string, Dependency[]>;
  baselinePipelineDigest: string; producerDigest: string; lockDigest: string; schemaDigest: string;
  rightsRevision: number; eligibleCompanyIds: string[]; universeDefinition: string;
}
export interface Programme {
  id: string; tenant_id: string; principal_id: string; root: PeWorldRootRef;
  work_id: string; work_input_id: string; work_input_digest: string; intake: BilateralIntake;
  intake_digest: string; frozen_manifest: FrozenManifest | null; frozen_digest: string | null;
  revision: number; status: PrimaryProgrammeStatus; invalidated: boolean;
  cancellation_requested_at: Date | null; active_claim_token: string | null; active_claim_fence: number | null;
  principal_artifact_id: string | null; reason: string | null; next_obligations: VReference[]; required_approvals: VReference[];
}
export interface Candidate {
  id: string; company_id: string; counterparty_id: string; disposition: string; reason: string | null;
  current_terms_id: string | null; current_action_id: string | null; last_event_id: string | null;
  revision: number; artifact_id: string | null;
}
export const programmeRef = (p: Programme) => reference("V1", p.id, p.revision, {
  intakeDigest: p.intake_digest, frozenDigest: p.frozen_digest,
});
export async function programme(ctx: PeMutationContext, id: string, c?: PoolClient, lock = false): Promise<Programme> {
  const run = async (client: PoolClient) => {
    const p = (await client.query<Programme>(`SELECT * FROM finnor_os.v1_programmes
      WHERE tenant_id=$1 AND principal_id=$2 AND id=$3${lock ? " FOR UPDATE" : ""}`,
    [ctx.auth.tenantId, actor(ctx), id])).rows[0];
    if (!p) throw unavailable();
    if (hash(p.intake) !== p.intake_digest || p.frozen_manifest && hash(p.frozen_manifest) !== p.frozen_digest)
      throw Error("BILATERAL_FROZEN_PREIMAGE_CONFLICT");
    return p;
  };
  return c ? run(c) : tx(ctx, run, true);
}
export async function candidates(ctx: PeMutationContext, p: Programme, c?: PoolClient): Promise<Candidate[]> {
  const run = async (client: PoolClient) => {
    const rows = (await client.query<Candidate>(`SELECT * FROM finnor_os.v1_candidates
      WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 ORDER BY company_id LIMIT 65`,
    [ctx.auth.tenantId, actor(ctx), p.id])).rows;
    if (rows.length > 64) throw Error("BILATERAL_CANDIDATE_BOUND");
    return rows;
  };
  return c ? run(c) : tx(ctx, run, true);
}
export async function event(ctx: PeMutationContext, p: Pick<Programme, "id">, owner: string, kind: string, body: unknown, c?: PoolClient) {
  const run = async (client: PoolClient) => {
    const saved = await client.query(`INSERT INTO finnor_os.v1_events
    (tenant_id,principal_id,programme_id,semantic_owner,kind,body) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
    [ctx.auth.tenantId, actor(ctx), p.id, owner, kind, canonical(body)]);
    return saved;
  };
  return c ? run(c) : tx(ctx, run);
}
export async function enqueue(ctx: PeMutationContext, p: Programme, c: PoolClient, runAt = new Date()) {
  await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,priority,
    protocol_version,retry_safety,run_at) VALUES($1,'advance_bilateral_programme_v1',$2::jsonb,$3,
    'interactive',0,1,'reconcilable',$4) ON CONFLICT(idempotency_key) DO NOTHING`,
  [ctx.auth.tenantId, canonical({ tenantId: ctx.auth.tenantId, principalId: actor(ctx), programmeId: p.id, revision: p.revision }),
    "v1:" + p.id + ":" + p.revision, runAt]);
}
export async function assertClaim(ctx: PeMutationContext, p: Programme, e: { jobId: string; claimToken: string; claimFence: number }, c: PoolClient, recovery = false) {
  if (!recovery) await currentActor(ctx, c);
  else if ((await c.query("SELECT current_user AS role")).rows[0]?.role !== "finnor_worker")
    throw Error("S6_ACTUAL_RESPONSIBILITY_WORKER_REQUIRED");
  const claimed = (await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2
    AND status='running' AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp()
    AND payload->>'principalId'=$5 AND payload->>'programmeId'=$6 FOR SHARE`,
  [ctx.auth.tenantId, e.jobId, e.claimToken, e.claimFence, p.principal_id, p.id])).rows[0];
  if (!claimed || p.active_claim_token !== e.claimToken || Number(p.active_claim_fence) !== e.claimFence ||
    !recovery && (p.invalidated || p.cancellation_requested_at)) throw Error("BILATERAL_DURABLE_CLAIM_FENCED");
}
export async function methodIdentity(ctx?: PeMutationContext, c?: PoolClient) {
  const code = await codeIdentity(), spec = await readFile(new URL("./checker-spec.md", import.meta.url));
  return {
    producerDigest: code.digest, lockDigest: hash(await readFile(new URL("../../../../../package-lock.json", import.meta.url))),
    specificationDigest: hash(spec), schemaDigest: ctx ? await schemaIdentity(ctx,c) : null,
  };
}
export function companyRecord(p: Programme, companyId: string): BilateralSnapshot["companies"][number] {
  const record = p.frozen_manifest?.snapshot.body.companies.find(company => company.companyId === companyId);
  if (!record) throw Error("BILATERAL_FROZEN_COMPANY_RECORD_UNAVAILABLE");
  return record;
}
export const candidateDependencies = (p: Programme, companyId: string): Dependency[] => [
  ...(p.frozen_manifest?.dependencies ?? []), ...(p.frozen_manifest?.candidateDependencies[companyId] ?? []),
];
export async function costs(ctx: PeMutationContext, p: Programme): Promise<PrimaryCostReceipt[]> {
  const grant = BilateralGrantSchema.parse(await ownerRecord(ctx, p.intake.budgetGrantRef, undefined, true));
  return tx(ctx, async c => (await c.query(`SELECT * FROM finnor_os.s5_programme_charges
    WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 AND programme_owner='V1' ORDER BY created_at,charge_key`,
  [ctx.auth.tenantId, actor(ctx), p.id])).rows.map(row => row.receipt ?? {
    id: row.charge_key, owner: "S5", requestId: row.request_id, kind: row.kind, microUsd: row.actual_micro_usd,
    reservedMicroUsd: row.reserved_micro_usd, possibleAdditionalMicroUsd: row.possible_additional_micro_usd,
    cpuMicros: row.actual_cpu_micros, wallMs: 0, peakMemoryBytes: null, bytes: Number(row.bytes),
    humanSeconds: row.human_seconds, pricebookRef: grant.pricebook.ref, status: "UNKNOWN",
    reasons: ["ORIGINAL_CHARGE_RETAINED_PHYSICAL_OUTCOME_OR_FINAL_METER_UNKNOWN"],
  } as PrimaryCostReceipt), true);
}
/** This resolver is shared by the mounted read and the actual V2 submit boundary.
 * No legacy `qualified` state is accepted as a substitute for the artifact. */
export async function currentArtifact(ctx: PeMutationContext, ref: VReference, c?: PoolClient) {
  const run = async (client: PoolClient) => {
    const row = (await client.query<{ body: QualifiedBilateralOpportunity; digest: string; programme_id: string; candidate_id: string; opportunity_id: string }>(
      "SELECT body,digest,programme_id,candidate_id,opportunity_id FROM finnor_os.v1_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [ctx.auth.tenantId, actor(ctx), ref.id])).rows[0];
    if (!row) throw unavailable();
    const a = row.body, p = await programme(ctx, row.programme_id, client);
    await authorize(ctx, p.root, p.work_id, client);
    const { contentDigest, ...preimage } = a;
    if (hash(a) !== row.digest || hash(preimage) !== contentDigest || hash(reference("V1", a.artifactId, 1, a)) !== hash(ref))
      throw Error("BILATERAL_IMMUTABLE_ARTIFACT_PREIMAGE_CONFLICT");
    if (p.cancellation_requested_at || Date.now() >= Date.parse(a.validityAndExpiry.expiresAt))
      throw Error("BILATERAL_ARTIFACT_EXPIRED_OR_CANCELLED");
    const identity = await methodIdentity(ctx,client);
    if (a.producerDigest !== identity.producerDigest || a.dependencyLockDigest !== identity.lockDigest ||
      p.frozen_manifest?.schemaDigest !== identity.schemaDigest) throw Error("BILATERAL_ARTIFACT_METHOD_OR_SCHEMA_CHANGED");
    await assertDependencies(ctx, a.invalidationDependencies.map(d => ({ ...d, nodeIds: [], digest: null })), client);
    await exactWork(ctx, p, client);
    const { ownerBindings } = await import("./governance");
    const b = await ownerBindings(ctx, p, client, false, identity);
    const candidate = (await client.query(`SELECT c.id,c.company_id,c.counterparty_id,c.disposition,c.artifact_id,c.current_terms_id
      FROM finnor_os.v1_terms t JOIN finnor_os.v1_candidates c
      ON c.tenant_id=t.tenant_id AND c.principal_id=t.principal_id AND c.id=t.candidate_id
      WHERE t.tenant_id=$1 AND t.principal_id=$2 AND t.id=$3`,
    [ctx.auth.tenantId, actor(ctx), a.communicatedTermsRevision.id])).rows[0];
    // The artifact's own dependency vector remains authoritative, including a
    // corrected sibling. Its immutable opportunity identity never changes.
    if (!candidate || candidate.current_terms_id !== a.communicatedTermsRevision.id ||
      candidate.artifact_id !== a.artifactId || candidate.disposition !== "QUALIFIED")
      throw Error("BILATERAL_CURRENT_CANDIDATE_QUALIFICATION_CHANGED");
    const checkRef = a.independentCheckRefs.find(r => r.owner === "S8" && /^[a-f0-9-]{36}$/i.test(r.id));
    const saved = checkRef ? (await client.query(`SELECT body,signature,digest FROM finnor_os.v1_claim_checks
      WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 AND candidate_id=$4 AND id=$5`,
    [ctx.auth.tenantId, actor(ctx), p.id, candidate.id, checkRef.id])).rows[0] : null;
    if (!saved) throw Error("S8_INDEPENDENT_ACCEPTANCE_CUSTODY_REQUIRED");
    const signed = SignedBilateralCheckSchema.parse({ body: saved.body, signature: saved.signature }), check = signed.body;
    if (!verifySigned(check, signed.signature, b.domain.checker.publicKeyPem) || hash(signed) !== saved.digest ||
      hash(reference("S8", check.id, 1, signed)) !== hash(checkRef) || check.result !== "ACCEPT" ||
      check.reasons.length || !Object.values(check.conjuncts).every(Boolean) ||
      hash(check.checkerIdentity) !== hash(b.domain.checker.identity) ||
      check.specificationDigest !== b.domain.checker.specificationDigest ||
      check.tenantId !== p.tenant_id || check.principalId !== p.principal_id ||
      check.programmeId !== p.id || check.candidateId !== candidate.id ||
      check.workId !== p.work_id || check.workInputId !== p.work_input_id ||
      check.sourceDigest !== p.frozen_digest || check.dependencyDigest !== hash(candidateDependencies(p, candidate.company_id)) ||
      check.rightsRevision !== a.rightsRevision || a.rightsRevision !== b.rights.rightsRevision ||
      hash(check.termsRef) !== hash(a.communicatedTermsRevision) || hash(a.terms) !== check.termsRef.contentDigest ||
      a.validityAndExpiry.expiresAt !== check.expiresAt || a.effectiveTime !== check.checkedAt ||
      ["mandateRef", "authorityProfileRef", "domainProfileRef"].some(key =>
        hash(check[key as "mandateRef"]) !== hash(a[key as "mandateRef"])))
      throw Error("S8_EXACT_SIGNED_ACCEPTANCE_AND_ARTIFACT_BINDING_REQUIRED");
    const interest = (await client.query(`SELECT body,digest FROM finnor_os.s1_bilateral_observations
      WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 AND id=$4 AND kind='PARTICIPANT_EVENT'`,
    [p.tenant_id, p.principal_id, p.id, a.confirmedInterestStatementAndSource.source.id])).rows[0];
    const original = interest ? SignedBilateralReplySchema.parse(interest.body) : null;
    const company = companyRecord(p, candidate.company_id);
    const canonicalOpportunity = (await client.query(`SELECT target_organization_id,buyer_entity_id,state
      FROM finnor_os.pe_opportunities WHERE tenant_id=$1 AND id=$2`, [p.tenant_id, a.opportunityId])).rows[0];
    if (!original || interest.digest !== hash(original) ||
      !verifySigned(original.body, original.signature, company.participantPublicKeyPem) ||
      hash(original.body) !== hash(a.confirmedInterestStatementAndSource.participantEvent) ||
      a.confirmedInterestStatementAndSource.statement !== original.body.statement ||
      hash(reference("S1", a.confirmedInterestStatementAndSource.source.id, 1, original)) !== hash(a.confirmedInterestStatementAndSource.source) ||
      a.opportunityId !== row.opportunity_id || candidate.id !== row.candidate_id ||
      a.workRef !== p.work_id || a.workRevision !== p.work_input_id || a.tenantRef !== p.tenant_id ||
      hash(a.companyRef) !== hash(p.frozen_manifest?.companyRefs[candidate.company_id]) ||
      hash(a.counterpartyRef) !== hash(p.frozen_manifest?.counterpartyRefs[candidate.company_id]) ||
      hash(a.buyerEntityRef) !== hash(p.frozen_manifest?.buyerRef) ||
      hash(a.remainingUnderwritingGaps) !== hash(p.intake.underwritingGapAssertions.filter(g => g.semantics.legalEntityId === candidate.company_id)) ||
      canonicalOpportunity?.target_organization_id !== candidate.company_id ||
      canonicalOpportunity?.buyer_entity_id !== b.mandate.buyerEntityId ||
      !["qualified", "promoted"].includes(canonicalOpportunity?.state))
      throw Error("S1_ORIGINAL_INTEREST_CANONICAL_OPPORTUNITY_OR_GAP_LINEAGE_CHANGED");
    return { artifact: a, programme: p };
  };
  return c ? run(c) : tx(ctx, run);
}
