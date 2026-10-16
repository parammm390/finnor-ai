import { createPublicKey, randomUUID, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import methodPaths from "./method-files.json";
import { decodeCapitalPublication, encodeCapitalPublication } from "./publication-storage";
import { withTenantTransaction, type Db } from "@finnor/db";
import { createEvidenceSourceTx, appendEvidenceVersionTx } from "@finnor/memory";
import type { PoolClient } from "pg";
import type { CapitalFormationView } from "@finnor/shared-types";
import { authorizeBeliefResources } from "../enterprise-beliefs";
import { resolveDecisionWork, principal } from "../decision-slice/adapters";
import { readAllocationSnapshotTx } from "../allocation-store";
import { persistEconomicRecordTx } from "../economic-store";
import { assertDependencies, revisions } from "../evidence-execution/store";
import type { PeMutationContext } from "../types";
import {
  CapitalFormationError, FinancingMandateSchema, SignedAuthoritySchema, IssuerSchema, InstrumentProfileSchema,
  SignedEventSchema, IntegerSchema, canonicalCapital, capitalDigest, type FinancingMandate, type AuthorityProfile, type Issuer,
  type InstrumentProfile, type SignedEvent, type FinancingPackage, type VerifiedCapitalCommitment, type Terms,
} from "./contracts";

export const CAPITAL_CHECKER_PATH = fileURLToPath(new URL("./independent-checker.mjs", import.meta.url));
const root = new URL("../../../../../", import.meta.url);
export async function currentCapitalMethod() {
  const files = await Promise.all(methodPaths.map(async path => ({ path, sha256: capitalDigest(await readFile(new URL(path, root))) })));
  return { files, digest: capitalDigest({ files, node: process.version, platform: process.platform, arch: process.arch }),
    checkerDigest: files.find(f => f.path.endsWith("independent-checker.mjs"))!.sha256,
    lockDigest: capitalDigest(files.filter(f => f.path.endsWith("package-lock.json"))) };
}
// Native workers bind source at module load. Installed API bundles additionally
// compare against their literal build-time capture, never an environment override.
const loadedMethod = currentCapitalMethod();
void loadedMethod.catch(() => undefined);
export async function capitalMethod() {
  const [current, loaded] = await Promise.all([currentCapitalMethod(), loadedMethod]);
  const buildDigest = process.env.FINNOR_V4_BUILD_SOURCE_FILES_DIGEST;
  if (loaded.digest !== current.digest || buildDigest && buildDigest !== capitalDigest(current.files)) {
    throw new CapitalFormationError("INSTALLED_V4_METHOD_CHANGED", "Rebuild and restart the installed runtime after the changed method is verified", 503);
  }
  return loaded;
}
export interface CapitalProgrammeRow {
  tenant_id: string; principal_id: string; programme_id: string; status: CapitalFormationView["status"];
  revision: number; rights_revision: number; request_digest: string; idempotency_key: string;
  contacts_spent: number; steps_spent: number; human_seconds_spent: number; cost_ceiling_micro_usd: string; cost_unknown: boolean;
  deadline_at: Date; waiting_until: Date; current_publication_id: string | null;
  active_claim_token: string | null; active_claim_fence: string | null; failure: Record<string, unknown> | null;
  body: FinancingMandate; signed_authority: ReturnType<typeof SignedAuthoritySchema.parse>;
}
export interface CapitalOwnerSnapshot {
  knowledgeAt: string; mandate: FinancingMandate; authority: ReturnType<typeof SignedAuthoritySchema.parse>;
  programmeStopped: boolean;
  programmeActivityBlocked: boolean;
  approval: { issuerId: string; signature: string; body: Record<string, unknown> };
  issuers: Issuer[]; profiles: InstrumentProfile[]; events: SignedEvent[];
  resources: Awaited<ReturnType<typeof readAllocationSnapshotTx>>["resources"];
  outstanding: Awaited<ReturnType<typeof readAllocationSnapshotTx>>["outstanding"];
  draws: Array<{ effectId: string; obligationId: string; allocationRef: unknown; commitmentIdentity: string;
    providerEntityId: string; termsDigest: string; amountMinor: string; sourceArtifactDigest: string;
    currentArtifactDigest: string; exactOwnerBinding: boolean; state: string }>;
  eventReferences: Array<{ evidenceVersionId: string; sourceId: string; integrityDigest: string }>;
  ownerDigest: string;
}
export interface CapitalCheck {
  schema: "finnor.v4.independent-check.v1"; inputDigest: string; resultDigest: string;
  result: FinancingPackage; supportedDomain: string; excludedInterpretations: string[]; checkedAt: string; checkerDigest: string;
}
export interface CapitalPublication {
  schema: "finnor.v4.capital-publication.v1"; package: FinancingPackage;
  artifacts: VerifiedCapitalCommitment[]; check: CapitalCheck; sourceEventRefs: CapitalOwnerSnapshot["eventReferences"];
  continuingObligations: Array<{ commitmentId: string; termsDigest: string; terms: Terms }>;
  knowledgeAt: string; ownerDigest: string; codeDigest: string; economicNoticeRequired: true;
}
export const capitalUnavailable = () => new CapitalFormationError("CAPITAL_SCOPE_UNAVAILABLE", "Capital programme is unavailable in this scope", 404);
export async function capitalTx<T>(ctx: PeMutationContext, fn: (c: PoolClient, db: Db) => Promise<T>): Promise<T> {
  return withTenantTransaction(ctx.auth.tenantId, { userId: principal(ctx) }, async (db, c) => {
    await c.query("SELECT set_config('app.capital_reader_scope','CAPITAL_FORMATION',true)");
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`s5-portfolio:${ctx.auth.tenantId}`]);
    const actor = (await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' AND role='owner' FOR SHARE",
      [ctx.auth.tenantId, principal(ctx)])).rows[0];
    if (!actor || ctx.auth.role !== "owner" || principal(ctx) !== ctx.auth.userId) throw capitalUnavailable();
    return fn(c, db);
  });
}
export async function capitalProgramme(ctx: PeMutationContext, id: string, c: PoolClient, lock = true): Promise<CapitalProgrammeRow> {
  const row = (await c.query<CapitalProgrammeRow>(`SELECT p.*,m.body,m.signed_authority FROM finnor_os.v4_programmes p
    JOIN finnor_os.s4_financing_mandates m USING(tenant_id,principal_id,programme_id)
    WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.programme_id=$3${lock ? " FOR UPDATE OF p" : ""}`,
  [ctx.auth.tenantId, principal(ctx), id])).rows[0];
  if (!row) throw capitalUnavailable();
  row.body = FinancingMandateSchema.parse(row.body); row.signed_authority = SignedAuthoritySchema.parse(row.signed_authority);
  return row;
}
export async function authorizeCapitalWork(ctx: PeMutationContext, mandate: FinancingMandate, current = true) {
  if (mandate.tenantId !== ctx.auth.tenantId || mandate.principalId !== principal(ctx)) throw capitalUnavailable();
  await authorizeBeliefResources(ctx, [{ type: "work", id: mandate.workId }, { type: mandate.root.entityType, id: mandate.root.entityId }]);
  if (current) {
    const work = await resolveDecisionWork(ctx, mandate.workId);
    if (work.inputId !== mandate.workInputId || work.inputDigest !== mandate.workInputDigest) throw new CapitalFormationError("WORK_INPUT_REVISED");
  }
}
export async function lockCapitalWork(ctx: PeMutationContext, mandate: FinancingMandate, rightsRevision: number, c: PoolClient, requireCurrent = true) {
  const work = (await c.query<{ status: string; principal_id: string }>(
    "SELECT status,coalesce(current_owner_id,created_by)::text principal_id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    [ctx.auth.tenantId, mandate.workId])).rows[0];
  if (!work || work.principal_id !== principal(ctx)) throw capitalUnavailable();
  if (!requireCurrent) return;
  const rights = (await c.query<{ revision: number }>("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1 FOR SHARE", [ctx.auth.tenantId])).rows[0];
  const latest = (await c.query<{ id: string }>(
    "SELECT id::text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE",
    [ctx.auth.tenantId, mandate.workId])).rows[0];
  if (!rights || rights.revision !== rightsRevision || latest?.id !== mandate.workInputId || ["cancelled", "failed", "completed"].includes(work.status)) throw new CapitalFormationError("CURRENT_WORK_OR_AUTHORITY_REVISED");
  await assertDependencies(ctx, mandate.sourceRevisionVector.map(d => ({ ...d, nodeIds: [], digest: null })), c, true);
}
async function enrolledRecords(ctx: PeMutationContext, c: PoolClient) {
  const read = async (table: "s1_capital_issuers" | "v4_instrument_profiles", bound: number) => {
    const rows = (await c.query<{ body: unknown; content_digest: string; revision: number; content: string; content_hash: string }>(
      `SELECT r.body,r.content_digest,r.revision,v.content,v.content_hash FROM finnor_os.${table} r
       JOIN finnor_os.evidence_source_versions v ON v.id=r.source_evidence_version_id AND v.tenant_id=r.tenant_id
       WHERE r.tenant_id=$1 AND r.principal_id=$2 ORDER BY r.content_digest LIMIT $3 FOR SHARE OF r`,
      [ctx.auth.tenantId, principal(ctx), bound + 1])).rows;
    if (rows.length > bound) throw new CapitalFormationError("ENROLMENT_BOUND_EXCEEDED", undefined, 413);
    for (const row of rows) if (capitalDigest(row.body) !== row.content_digest || capitalDigest(row.content) !== row.content_hash
      || row.content_hash !== row.content_digest || (row.body as { revision: number }).revision !== row.revision) throw new CapitalFormationError("INDEPENDENT_ENROLMENT_PREIMAGE_CHANGED");
    return rows.map(r => r.body);
  };
  return { issuers: (await read("s1_capital_issuers", 256)).map(r => IssuerSchema.parse(r)),
    profiles: (await read("v4_instrument_profiles", 3)).map(r => InstrumentProfileSchema.parse(r)) };
}
export const loadCapitalEnrolments = enrolledRecords;
export async function capitalApproval(ctx: PeMutationContext, mandate: FinancingMandate, authority: AuthorityProfile, rightsRevision: number, c: PoolClient) {
  const row = (await c.query<{ evidence: Record<string, unknown>; authority_revision: number }>(`SELECT evidence,authority_revision
    FROM finnor_os.authority_decisions WHERE tenant_id=$1 AND id=$2 AND work_id=$3
    AND employee_id=$4 AND operation='approval' AND capability='capital:financing-mandate'
    AND resource_type='financing_programme' AND resource_id=$5 AND outcome='allowed' FOR SHARE`,
  [ctx.auth.tenantId, mandate.approvalDecisionId, mandate.workId, principal(ctx), mandate.programmeId])).rows[0];
  const approval = row?.evidence.capitalApproval as CapitalOwnerSnapshot["approval"] | undefined;
  if (!row || row.authority_revision !== rightsRevision || !approval || approval.body?.mandateDigest !== capitalDigest(mandate)
    || approval.body?.authorityDigest !== capitalDigest(authority)) throw new CapitalFormationError("EXACT_S4_MANDATE_APPROVAL_REQUIRED");
  return approval;
}
export async function originalCapitalEvents(ctx: PeMutationContext, programmeId: string, c: PoolClient) {
  const rows = (await c.query<{ evidence_version_id: string; source_id: string; integrity_digest: string; content_hash: string; content: string }>(
    `SELECT e.evidence_version_id::text,e.source_id::text,e.integrity_digest,v.content_hash,v.content FROM finnor_os.v4_source_events e
     JOIN finnor_os.evidence_source_versions v ON v.id=e.evidence_version_id AND v.tenant_id=e.tenant_id
     WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.programme_id=$3 ORDER BY e.created_at,e.event_id LIMIT 513`,
    [ctx.auth.tenantId, principal(ctx), programmeId])).rows;
  if (rows.length > 512) throw new CapitalFormationError("AUTHENTICATED_EVENT_BOUND_EXCEEDED", undefined, 413);
  return { events: rows.map(r => {
    if (capitalDigest(r.content) !== r.content_hash || r.content_hash !== r.integrity_digest) throw new CapitalFormationError("ORIGINAL_SOURCE_BYTES_CHANGED");
    return SignedEventSchema.parse(JSON.parse(r.content));
  }), references: rows.map(r => ({ evidenceVersionId: r.evidence_version_id, sourceId: r.source_id, integrityDigest: r.integrity_digest })) };
}
export async function currentCapitalDraws(ctx: PeMutationContext, m: FinancingMandate, c: PoolClient): Promise<CapitalOwnerSnapshot["draws"]> {
  const rows = (await c.query<{ body: Record<string, any>; status: string; reservation_status: string; revocation_reason: string | null; effect: Record<string, any>; effect_digest: string }>(
    `SELECT o.body,e.status,e.effect,e.semantic_hash effect_digest,r.status reservation_status,r.revocation_reason
     FROM finnor_os.s6_obligation_origins o JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id
     JOIN finnor_os.s5_consumptions co ON co.tenant_id=o.tenant_id AND co.consumption_id=o.consumption_id
     JOIN finnor_os.s5_reservations r ON r.tenant_id=co.tenant_id AND r.reservation_id=co.reservation_id
     WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.body->'financingBinding'->>'programmeId'=$3 LIMIT 257 FOR SHARE OF r`,
    [ctx.auth.tenantId, principal(ctx), m.programmeId])).rows;
  if (rows.length > 256) throw new CapitalFormationError("ORIGINAL_DRAW_OBLIGATION_BOUND_EXCEEDED", undefined, 413);
  return rows.map(row => {
    const b = row.body, binding = b.financingBinding, { ref, ...original } = b;
    const exact = ref?.owner === "S6" && ref.contentDigest === capitalDigest(original)
      && b.tenantId === ctx.auth.tenantId && b.principalId === principal(ctx)
      && row.effect_digest === b.effectRef?.semanticHash && binding.mandateDigest === capitalDigest(m)
      && binding.schema === "finnor.s6.financing-binding.v1" && row.effect.operation?.name === "financing_draw"
      && row.effect.operation?.class === "external_side_effect" && row.effect.operation?.external === true
      && binding.amount?.currency === m.requirement.currency && binding.amount?.minorUnits === m.requirement.minorUnits
      && binding.amount?.legalEntityId === m.legalEntityId
      && row.effect.delta?.values?.financingBinding && capitalDigest(row.effect.delta.values.financingBinding) === capitalDigest(binding);
    return { effectId: b.effectRef.id, obligationId: ref.id, allocationRef: b.allocationRef,
      commitmentIdentity: binding.commitmentIdentity, providerEntityId: binding.providerEntityId, termsDigest: binding.termsDigest,
      amountMinor: binding.amount.amountMinor, sourceArtifactDigest: binding.commitmentRef.contentDigest,
      currentArtifactDigest: binding.commitmentRef.contentDigest, exactOwnerBinding: !!exact,
      state: ["compiled", "authorized", "cancelled"].includes(row.status) ? "DEFINITELY_NOT_DISPATCHED" : "POSSIBLE_DELIVERY" };
  });
}
export async function capitalOwnerSnapshot(ctx: PeMutationContext, q: CapitalProgrammeRow, c: PoolClient): Promise<CapitalOwnerSnapshot> {
  await lockCapitalWork(ctx, q.body, q.rights_revision, c);
  const { issuers, profiles } = await enrolledRecords(ctx, c), { events, references } = await originalCapitalEvents(ctx, q.programme_id, c),
    capacity = await readAllocationSnapshotTx(ctx, c), draws = await currentCapitalDraws(ctx, q.body, c),
    approval = await capitalApproval(ctx, q.body, q.signed_authority.body, q.rights_revision, c),
    knowledgeAt = (await c.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.toISOString();
  const body = { mandate: q.body, authority: q.signed_authority, approval, programmeStopped: ["STOPPED", "FAILED"].includes(q.status),
    programmeActivityBlocked: q.status === "BLOCKED" || q.cost_unknown,
    issuers, profiles, events, resources: capacity.resources, outstanding: capacity.outstanding, draws };
  return { ...body, knowledgeAt, eventReferences: references, ownerDigest: capitalDigest(body) };
}
export async function checkCapitalSnapshot(snapshot: CapitalOwnerSnapshot): Promise<CapitalCheck> {
  const method = await capitalMethod();
  for (const profile of snapshot.profiles) if (snapshot.mandate.domainProfileIds.includes(profile.id)
    && profile.independentCheckerDigest !== method.checkerDigest) throw new CapitalFormationError("PROFILE_CHECKER_BINDING_CHANGED", undefined, 503);
  const { eventReferences: _references, ownerDigest: _digest, ...input } = snapshot;
  const bytes = canonicalCapital(input);
  if (Buffer.byteLength(bytes) > 8 * 1024 * 1024) throw new CapitalFormationError("CHECKER_INPUT_BOUND_EXCEEDED", undefined, 413);
  const answer = await new Promise<CapitalCheck>((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=128", CAPITAL_CHECKER_PATH], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, NODE_ENV: "production" } });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new CapitalFormationError("INDEPENDENT_CHECKER_DEADLINE", undefined, 503)); }, 10000);
    const chunks: Buffer[] = []; let count = 0;
    child.stdout.on("data", (chunk: Buffer) => { count += chunk.length; if (count > 1024 * 1024) child.kill("SIGKILL"); else chunks.push(chunk); });
    child.stderr.resume(); child.on("error", reject); child.stdin.on("error", () => undefined);
    child.on("close", code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString()) as CapitalCheck & { failure?: string };
        if (code !== 0 || result.failure) reject(new CapitalFormationError(result.failure ?? "INDEPENDENT_CHECKER_REJECTED", undefined, 422));
        else resolve(result);
      } catch { reject(new CapitalFormationError("INDEPENDENT_CHECKER_RESULT_UNAVAILABLE", undefined, 503)); }
    }); child.stdin.end(bytes);
  });
  if (answer.schema !== "finnor.v4.independent-check.v1" || answer.checkerDigest !== method.checkerDigest
    || answer.inputDigest !== capitalDigest(input) || answer.resultDigest !== capitalDigest(answer.result)) throw new CapitalFormationError("INDEPENDENT_CHECKER_PREIMAGE_MISMATCH", undefined, 503);
  return answer;
}
export async function recordCapitalEvidence(ctx: PeMutationContext, c: PoolClient, db: Db, mandate: FinancingMandate,
  key: string, kind: string, value: Record<string, unknown>) {
  const source = await createEvidenceSourceTx(db, ctx.auth.tenantId, { sourceKey: "v4:" + key, sourceType: kind, title: "Capital formation " + kind,
    metadata: { capitalPrivateScope: { principalId: principal(ctx), workId: mandate.workId, programmeId: mandate.programmeId } } });
  const stored = await appendEvidenceVersionTx(db, ctx.auth.tenantId, source.id, { content: canonicalCapital(value), snapshot: value,
    entityRefs: [{ type: mandate.root.entityType, id: mandate.root.entityId }, { type: "work", id: mandate.workId }] });
  return { ...stored, sourceId: source.id };
}
const purposes: Record<SignedEvent["body"]["kind"], Issuer["purposes"][number]> = {
  IDENTITY_CONFIRMED: "IDENTITY", INDICATION: "PROVIDER", OFFER: "PROVIDER", COUNTERPROPOSAL: "PROVIDER", COMMITMENT_EXECUTED: "PROVIDER",
  REFUSAL: "PROVIDER", PROFESSIONAL_DETERMINATION: "PROFESSIONAL", CONDITION_OBSERVED: "CONDITION", WITHDRAWAL: "PROVIDER", CORRECTION: "PROVIDER", FUNDING_OBSERVATION: "SETTLEMENT",
};
export function verifyCapitalSource(event: SignedEvent, issuers: Issuer[], m: FinancingMandate, profiles: InstrumentProfile[]) {
  const b = event.body, issuer = issuers.find(i => i.id === b.issuerId && i.revision === b.issuerRevision),
    profile = profiles.find(p => m.domainProfileIds.includes(p.id) && p.instrument === b.instrument);
  if (!issuer || !profile || issuer.revoked || !issuer.independentOfProducer || !issuer.purposes.includes(purposes[b.kind])
    || !issuer.instruments.includes(b.instrument) || b.tenantId !== m.tenantId || b.programmeId !== m.programmeId
    || !m.providerIds.includes(b.providerEntityId) || Date.parse(b.observedAt) > Date.now()
    || Date.parse(b.observedAt) < Date.parse(issuer.validFrom) || Date.parse(b.observedAt) >= Date.parse(issuer.validUntil)) throw new CapitalFormationError("ISSUER_EVENT_SCOPE_OR_VALIDITY");
  const key = createPublicKey(issuer.publicKey), signature = Buffer.from(event.signature, "base64");
  if (key.asymmetricKeyType !== "ed25519" || signature.length !== 64 || signature.toString("base64") !== event.signature
    || !verify(null, Buffer.from(canonicalCapital(b)), key, signature)) throw new CapitalFormationError("ISSUER_EVENT_AUTHENTICATION");
  if (b.kind === "PROFESSIONAL_DETERMINATION" && !profile.professionalIssuerIds.includes(issuer.id)
    || b.kind === "IDENTITY_CONFIRMED" && !profile.identityIssuerIds.includes(issuer.id)
    || b.kind === "FUNDING_OBSERVATION" && !profile.settlementIssuerIds.includes(issuer.id)) throw new CapitalFormationError("ISSUER_ROLE_OR_PROFILE_SCOPE");
  if (purposes[b.kind] === "PROVIDER" && (issuer.legalEntityId !== b.providerEntityId || issuer.actorId !== b.representativeId)) throw new CapitalFormationError("PROVIDER_LEGAL_ENTITY_OR_REPRESENTATIVE_SUBSTITUTION");
  if (b.terms && (capitalDigest(b.terms) !== b.termsDigest || b.terms.programmeId !== m.programmeId
    || b.terms.providerEntityId !== b.providerEntityId || b.terms.representativeId !== b.representativeId
    || b.terms.instrument !== b.instrument || b.terms.commitmentIdentity !== b.commitmentIdentity)) throw new CapitalFormationError("ISSUER_EXACT_TERMS_SUBSTITUTION");
  if (b.kind === "PROFESSIONAL_DETERMINATION" && !b.determination || b.kind === "IDENTITY_CONFIRMED" && !b.identity
    || b.kind === "FUNDING_OBSERVATION" && !b.funding || b.kind === "CONDITION_OBSERVED" && !b.condition
    || ["INDICATION", "OFFER", "COUNTERPROPOSAL", "COMMITMENT_EXECUTED", "CORRECTION"].includes(b.kind) && !b.terms) throw new CapitalFormationError("SOURCE_EVENT_MATERIAL_CONTENT_MISSING");
  return issuer;
}
export async function appendCapitalSourceTx(ctx: PeMutationContext, q: CapitalProgrammeRow, event: SignedEvent, c: PoolClient, db: Db): Promise<boolean> {
  const appended = await appendCapitalSourceWithEnrolmentsTx(ctx, q, event, c, db, await enrolledRecords(ctx, c));
  if (appended && event.body.operationId) await reconcileCapitalOperationCostsTx(ctx, q, event.body.operationId, c);
  return appended;
}
async function appendCapitalSourceWithEnrolmentsTx(ctx: PeMutationContext, q: CapitalProgrammeRow, event: SignedEvent, c: PoolClient, db: Db,
  enrolled: Awaited<ReturnType<typeof enrolledRecords>>): Promise<boolean> {
  const digest = capitalDigest(event), existing = (await c.query<{ integrity_digest: string; programme_id: string }>(
    "SELECT integrity_digest,programme_id::text FROM finnor_os.v4_source_events WHERE tenant_id=$1 AND issuer_id=$2 AND event_id=$3",
    [ctx.auth.tenantId, event.body.issuerId, event.body.eventId])).rows[0];
  if (existing) { if (existing.integrity_digest !== digest || existing.programme_id !== q.programme_id) throw new CapitalFormationError("SOURCE_EVENT_IDENTITY_REPLAY_CONFLICT"); return false; }
  verifyCapitalSource(event, enrolled.issuers, q.body, enrolled.profiles);
  if (event.body.operationId) {
    await c.query("SELECT set_config('app.capital_original_programme_id',$1,true)", [q.programme_id]);
    const op = (await c.query<{ request_hash: string; provider_id: string }>(
      `SELECT o.request_hash,d.payload->'request'->>'providerEntityId' provider_id FROM finnor_os.external_operations o
       JOIN finnor_os.domain_actions d ON d.tenant_id=o.tenant_id AND d.id=o.domain_action_id
       WHERE o.tenant_id=$1 AND o.id=$2 AND d.work_id=$3 AND d.payload->'request'->>'programmeId'=$4`,
      [ctx.auth.tenantId, event.body.operationId, q.body.workId, q.programme_id])).rows[0];
    if (!op || op.request_hash !== event.body.operationRequestDigest || op.provider_id !== event.body.providerEntityId) throw new CapitalFormationError("ORIGINAL_PROVIDER_OPERATION_SUBSTITUTION");
  } else if (event.body.operationRequestDigest !== null) throw new CapitalFormationError("UNBOUND_PROVIDER_OPERATION_DIGEST");
  if (event.body.kind === "FUNDING_OBSERVATION") {
    const draws = await currentCapitalDraws(ctx, q.body, c);
    if (!draws.some(d => d.effectId === event.body.funding?.originalDrawEffectId && d.exactOwnerBinding
      && d.providerEntityId === event.body.providerEntityId && d.termsDigest === event.body.termsDigest)) throw new CapitalFormationError("ORIGINAL_FINANCING_OBLIGATION_REQUIRED");
  }
  const count = (await c.query<{ n: number }>("SELECT count(*)::int n FROM finnor_os.v4_source_events WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
    [ctx.auth.tenantId, principal(ctx), q.programme_id])).rows[0]!.n;
  if (count >= 512) throw new CapitalFormationError("AUTHENTICATED_EVENT_BOUND_EXCEEDED", undefined, 413);
  const stored = await recordCapitalEvidence(ctx, c, db, q.body, `source:${event.body.issuerId}:${event.body.eventId}`, "authenticated_source_event", event as unknown as Record<string, unknown>);
  await c.query("INSERT INTO finnor_os.v4_source_events(tenant_id,principal_id,programme_id,issuer_id,event_id,source_sequence,integrity_digest,evidence_version_id,source_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [ctx.auth.tenantId, principal(ctx), q.programme_id, event.body.issuerId, event.body.eventId, event.body.sequence, digest, stored.versionId, stored.sourceId]);
  return true;
}
/** A physical response shares one current locked enrolment cut. Verification
 * remains internal and every event still traverses the ordinary source port. */
export async function appendCapitalSourceBatchTx(ctx: PeMutationContext, q: CapitalProgrammeRow, events: SignedEvent[], c: PoolClient, db: Db) {
  const enrolled = await enrolledRecords(ctx, c);
  let appended = false;
  for (const event of events) appended = await appendCapitalSourceWithEnrolmentsTx(ctx, q, event, c, db, enrolled) || appended;
  return { appended, enrolled };
}
function operationCostFacts(events: SignedEvent[]) {
  const groups = new Map<string, SignedEvent[]>();
  for (const event of events) if (event.body.operationId) {
    const group = groups.get(event.body.operationId) ?? []; group.push(event); groups.set(event.body.operationId, group);
  }
  return new Map([...groups].map(([operationId, group]) => {
    const receipts = new Map<string, { issuerId: string; receiptId: string; microUSD: string; final: boolean }>(),
      finalAmounts = new Map<string, string>();
    let conflictingFinalReceipt = false;
    for (const event of group) {
      const receipt = { issuerId: event.body.issuerId, ...event.body.cost }, key = `${receipt.issuerId}:${receipt.receiptId}`, prior = receipts.get(key);
      if (receipt.final) {
        const final = finalAmounts.get(key);
        if (final !== undefined && final !== receipt.microUSD) conflictingFinalReceipt = true;
        finalAmounts.set(key, receipt.microUSD);
      }
      if (!prior || BigInt(receipt.microUSD) > BigInt(prior.microUSD)) receipts.set(key, receipt);
      else if (receipt.microUSD === prior.microUSD && receipt.final) receipts.set(key, { ...prior, final: true });
    }
    const costs = [...receipts.values()];
    return [operationId, { costs, conflictingFinalReceipt,
      costsFinal: !conflictingFinalReceipt && group.some(e => purposes[e.body.kind] === "PROVIDER") && costs.every(r => r.final),
      observedAt: group.at(-1)!.body.observedAt }];
  }));
}
/** Retained original receipt facts update the existing episode charge, including
 * late receipts through the ordinary source port. This is not a cost ledger. */
export async function reconcileCapitalOperationCostsTx(ctx: PeMutationContext, q: CapitalProgrammeRow, operationId: string, c: PoolClient) {
  const actions = (await c.query<{ id: string; execution_state: string; original_ceiling: string }>(`SELECT o.id::text,o.execution_state,
    d.payload->>'operationCostCeilingMicroUSD' original_ceiling FROM finnor_os.domain_actions d
    JOIN finnor_os.external_operations o ON o.tenant_id=d.tenant_id AND o.domain_action_id=d.id
    WHERE d.tenant_id=$1 AND d.initiated_by=$2 AND d.work_id=$3
      AND d.action_type='capital_provider_request' AND d.payload->'request'->>'programmeId'=$4 LIMIT 1001`,
  [ctx.auth.tenantId, principal(ctx), q.body.workId, q.programme_id])).rows;
  if (actions.length > 1000) throw new CapitalFormationError("ORIGINAL_OPERATION_BOUND_EXCEEDED", undefined, 413);
  const action = actions.find(a => a.id === operationId);
  if (!action) throw new CapitalFormationError("ORIGINAL_PROVIDER_OPERATION_SUBSTITUTION");
  const originalCeiling = IntegerSchema.parse(action.original_ceiling),
    retained = await originalCapitalEvents(ctx, q.programme_id, c), allFacts = operationCostFacts(retained.events),
    facts = allFacts.get(operationId)!;
  const { costs, conflictingFinalReceipt, costsFinal } = facts, total = costs.reduce((sum, r) => sum + BigInt(r.microUSD), 0n),
    excess = total > BigInt(originalCeiling) ? total - BigInt(originalCeiling) : 0n,
    receiptDigest = capitalDigest({ costs, conflictingFinalReceipt });
  const prior = (await c.query<{ body: { excessCostMicroUSD: string; receiptDigest?: string } }>(`SELECT body FROM finnor_os.v4_transitions
    WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 AND kind='INDEPENDENT_PROVIDER_OPERATION_OBSERVED'
      AND body->>'operationId'=$4 ORDER BY created_at DESC,id DESC LIMIT 1`,
  [ctx.auth.tenantId, principal(ctx), q.programme_id, operationId])).rows[0];
  const additional = excess > BigInt(prior?.body.excessCostMicroUSD ?? "0") ? excess - BigInt(prior?.body.excessCostMicroUSD ?? "0") : 0n,
    current = await capitalProgramme(ctx, q.programme_id, c), charged = BigInt(current.cost_ceiling_micro_usd) + additional,
    overrun = excess > 0n || charged > BigInt(q.body.maxCostMicroUSD),
    programmeCostUnknown = actions.some(a => { const state = allFacts.get(a.id);
      return state ? !state.costsFinal : !["claimed", "known_failed"].includes(a.execution_state); }),
    preserveOverrun = current.failure?.code === "PROVIDER_COST_CEILING_EXCEEDED";
  if (additional || current.cost_unknown !== programmeCostUnknown || overrun && !preserveOverrun) await c.query(`UPDATE finnor_os.v4_programmes SET
    cost_ceiling_micro_usd=cost_ceiling_micro_usd+$4::numeric,cost_unknown=$5,
    status=CASE WHEN status IN('STOPPED','FAILED','COMPLETE') THEN status WHEN $6 THEN 'BLOCKED' ELSE 'RECONCILING' END,
    failure=$7::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3`,
  [ctx.auth.tenantId, principal(ctx), q.programme_id, additional.toString(), programmeCostUnknown, overrun || preserveOverrun,
    overrun || preserveOverrun || programmeCostUnknown ? canonicalCapital({ code: overrun || preserveOverrun ? "PROVIDER_COST_CEILING_EXCEEDED" : "PROVIDER_COST_REMAINS_UNRESOLVED",
      exactReceiptsRetained: true, originalGrantNotReplenished: true }) : current.failure?.code === "PROVIDER_COST_REMAINS_UNRESOLVED" ? null : canonicalCapital(current.failure)]);
  if (prior?.body.receiptDigest !== receiptDigest) {
    const receiptEvidenceVersionIds = retained.events.flatMap((event, index) => event.body.operationId === operationId
      ? [retained.references[index]!.evidenceVersionId] : []);
    const notice = { operationId, receiptEvidenceVersionIds, receiptCount: costs.length, receiptDigest,
      originalCostCeilingMicroUSD: originalCeiling, authenticatedCostMicroUSD: total.toString(),
      excessCostMicroUSD: excess.toString(), costFinal: costsFinal, ceilingExceeded: overrun, conflictingFinalReceipt,
      originalGrantNotReplenished: true, financingOrFundingInferredFromDelivery: false };
    await capitalTransition(ctx, q.programme_id, "INDEPENDENT_PROVIDER_OPERATION_OBSERVED", notice, c);
    await persistEconomicRecordTx(ctx, { kind: "SOURCE", rightsRef: "capital-work:" + q.body.workId,
      idempotencyKey: `v4-operation-cost:${operationId}:${receiptDigest}`, validAt: facts.observedAt,
      horizon: "H0", uncertainty: "ORIGINAL_SIGNED_RECEIPT_SOURCE_NOT_FINANCIAL_BILLING_OR_OWNER_WEALTH",
      payload: { schema: "finnor.v4.operation-cost-source.v1", programmeId: q.programme_id, ...notice,
        originalDeadlineAt: q.deadline_at.toISOString(), profit: null, ownerWealthChange: null, principalCreditedAsProfit: false,
        fullPhysicalAndHumanCostQualification: "UNMETERED_OUTSIDE_ORIGINAL_PROVIDER_RECEIPTS" },
    }, c);
  }
  return { costsFinal, overrun };
}
export async function capitalTransition(ctx: PeMutationContext, id: string, kind: string, body: Record<string, unknown>, c: PoolClient) {
  await c.query("INSERT INTO finnor_os.v4_transitions(tenant_id,principal_id,programme_id,kind,body) VALUES($1,$2,$3,$4,$5::jsonb)",
    [ctx.auth.tenantId, principal(ctx), id, kind, canonicalCapital(body)]);
}
export async function enqueueCapitalJob(ctx: PeMutationContext, id: string, revision: number, c: PoolClient) {
  await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,priority,protocol_version,retry_safety)
    VALUES($1,'run_capital_formation_v1',$2::jsonb,$3,'interactive',0,1,'durably_effect_guarded') ON CONFLICT(idempotency_key) DO NOTHING`,
  [ctx.auth.tenantId, canonicalCapital({ tenantId: ctx.auth.tenantId, principalId: principal(ctx), programmeId: id, revision }), `v4:${id}:${revision}`]);
}
export async function enqueueCapitalMonitor(ctx: PeMutationContext, q: CapitalProgrammeRow, c: PoolClient) {
  await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,priority,protocol_version,retry_safety,run_at)
    VALUES($1,'run_capital_formation_v1',$2::jsonb,$3,'interactive',0,1,'durably_effect_guarded',$4) ON CONFLICT(idempotency_key) DO NOTHING`,
  [ctx.auth.tenantId, canonicalCapital({ tenantId: ctx.auth.tenantId, principalId: principal(ctx), programmeId: q.programme_id, revision: q.revision, monitor: true }),
    `v4:monitor:${q.programme_id}:${q.waiting_until.toISOString()}`, q.waiting_until]);
}
export async function readCapitalPublicationTx(ctx: PeMutationContext, q: CapitalProgrammeRow, c: PoolClient): Promise<CapitalPublication | null> {
  if (!q.current_publication_id) return null;
  const row = (await c.query<{ content_digest: string; content_hash: string; content: string }>(
    `SELECT p.content_digest,v.content_hash,v.content FROM finnor_os.v4_publications p
     JOIN finnor_os.evidence_source_versions v ON v.id=p.evidence_version_id AND v.tenant_id=p.tenant_id
     WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.publication_id=$3`,
    [ctx.auth.tenantId, principal(ctx), q.current_publication_id])).rows[0];
  if (!row || capitalDigest(row.content) !== row.content_hash) throw new CapitalFormationError("CAPITAL_PUBLICATION_BYTES_CHANGED");
  const publication = decodeCapitalPublication(row.content, row.content_digest) as unknown as CapitalPublication;
  if (publication.schema !== "finnor.v4.capital-publication.v1" || publication.check.resultDigest !== capitalDigest(publication.package)
    || publication.check.resultDigest !== capitalDigest(publication.check.result)
    || publication.package.programmeId !== q.programme_id || !Array.isArray(publication.artifacts)
    || publication.artifacts.some(a => a.envelope.content_digest !== capitalDigest({ ...a,
      envelope: { ...a.envelope, content_digest: "" } }))) throw new CapitalFormationError("CAPITAL_PUBLICATION_DERIVED_PREIMAGE_MISMATCH");
  return publication;
}
export async function publishCapitalTx(ctx: PeMutationContext, q: CapitalProgrammeRow, snapshot: CapitalOwnerSnapshot, check: CapitalCheck, c: PoolClient, db: Db) {
  const method = await capitalMethod(), artifacts: VerifiedCapitalCommitment[] = [],
    humanReceipts = (await c.query<{ body: { receiptId: string; evidenceVersionId: string } }>("SELECT body FROM finnor_os.v4_transitions WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 AND kind='METERED_HUMAN_INTERVENTION' ORDER BY created_at,id LIMIT 65",
      [ctx.auth.tenantId, principal(ctx), q.programme_id])).rows.map(r => r.body);
  if (humanReceipts.length > 64) throw new CapitalFormationError("HUMAN_RECEIPT_BOUND_EXCEEDED", undefined, 413);
  for (const classification of check.result.commitments.filter(item => item.verified)) {
    const original = snapshot.events.filter(e => e.body.termsDigest === classification.termsDigest && e.body.terms).at(-1)!,
      terms = original.body.terms!, sourceEvents = snapshot.events.filter(e => classification.eventIds.includes(`${e.body.issuerId}:${e.body.eventId}`)
        && e.body.providerEntityId === terms.providerEntityId && e.body.instrument === terms.instrument && e.body.commitmentIdentity === terms.commitmentIdentity);
    const profile = snapshot.profiles.find(p => p.id === classification.profileId);
    if (!profile || !q.body.domainProfileIds.includes(profile.id) || profile.instrument !== terms.instrument || profile.revoked
      || Date.parse(profile.validUntil) <= Date.now() || !profile.permittedRootTypes.includes(q.body.root.entityType)) {
      throw new CapitalFormationError("INDEPENDENT_SELECTED_PROFILE_BINDING_CHANGED");
    }
    const checkRef = { assertionDigest: classification.termsDigest!, sourceEventIds: classification.eventIds, checkerDigest: check.checkerDigest,
      result: "PASS" as const, supportedDomain: check.supportedDomain, excludedInterpretations: check.excludedInterpretations };
    const artifact: VerifiedCapitalCommitment = {
      commitmentId: classification.commitmentId, state: classification.state, terms,
      envelope: {
        artifact_id: "", artifact_kind: "VerifiedCapitalCommitment", schema_revision: "finnor.v-artifact.v1", content_digest: "",
        tenant_ref: q.tenant_id, work_ref: q.body.workId, work_revision: q.body.workInputDigest, producer_digest: method.digest,
        dependency_lock_digest: method.lockDigest, admission_ref: null,
        baseline_manifest_ref: "v4-baseline:517003a4396bc8101a90be4b425ee01de9446740", domain_profile_ref: profile.id,
        mandate_ref: capitalDigest(q.body), authority_profile_ref: capitalDigest(q.signed_authority.body), budget_grant_ref: q.body.budgetGrantRef,
        source_refs: sourceEvents.map(e => ({ evidenceVersionId: snapshot.eventReferences[snapshot.events.indexOf(e)]!.evidenceVersionId,
          issuerId: e.body.issuerId, recordId: e.body.sourceRecord, channel: "INDEPENDENT_SIGNED_PROVIDER_EVENT",
          assertion: e.body.kind, authorityScope: e.body.instrument, timestamp: e.body.observedAt, revision: e.body.sequence, integrityDigest: capitalDigest(e) })),
        source_revision_vector: q.body.sourceRevisionVector, rights_revision: q.rights_revision,
        effective_time: terms.availableFrom, knowledge_time: snapshot.knowledgeAt, observation_time: original.body.observedAt,
        accepted_claims: ["AUTHENTICATED_ISSUER", "ACT_SPECIFIC_IDENTITY", "EXACT_EXECUTED_TERMS", "PROFESSIONAL_OPERATIVE_STATUS", classification.state],
        unresolved_claims: [...classification.unsatisfiedConditions, ...classification.unresolvedClaims], contradiction_refs: check.result.conflicts,
        independent_check_refs: [checkRef], effect_obligation_refs: snapshot.draws.filter(d => d.commitmentIdentity === terms.commitmentIdentity).map(d => d.obligationId),
        external_event_refs: classification.eventIds, cost_receipts: sourceEvents.map(e => ({ issuerId: e.body.issuerId, ...e.body.cost })),
        human_intervention_receipts: humanReceipts.map(r => r.evidenceVersionId), invalidation_dependencies: q.body.sourceRevisionVector.map(d => d.key), lifecycle_events: classification.eventIds,
      },
      programme_and_financing_mandate_refs: { programmeId: q.programme_id, mandateDigest: capitalDigest(q.body) },
      provider_entity_and_authorized_representative: { entityId: terms.providerEntityId, representativeId: terms.representativeId, identityEventId: classification.identityEventId! },
      instrument_profile_and_offering_authority: { profileId: profile.id, authorityDigest: capitalDigest(q.signed_authority.body) },
      executed_commitment_terms_digest: classification.termsDigest!,
      amount_currency_timing_and_allocation: { faceAmount: terms.amount, eligibleUndrawnMinor: classification.eligibleUndrawnMinor,
        reservedAllocationMinor: snapshot.draws.filter(d => d.commitmentIdentity === terms.commitmentIdentity).reduce((s, d) => s + BigInt(d.amountMinor), 0n).toString() },
      pricing_fees_security_covenants_and_guarantees: { fixedRate: terms.fixedRate, rateConvention: terms.rateConvention, fees: terms.fees,
        security: terms.security, covenants: terms.covenants, guarantees: terms.guarantees, crossDefaults: terms.crossDefaults, ownership: terms.ownership, materialObligations: terms.materialObligations },
      conditions_and_satisfaction_evidence: { conditions: terms.conditions, unsatisfiedIds: classification.unsatisfiedConditions,
        eventIds: sourceEvents.filter(e => e.body.kind === "CONDITION_OBSERVED").map(e => `${e.body.issuerId}:${e.body.eventId}`) },
      professional_legal_status_and_issuer_confirmation: { determinationEventId: classification.determinationEventId!, executionEventId: classification.executionEventId! },
      shared_capacity_and_reservation_refs: { resourceIds: terms.capacityResourceIds, allocationRefs: snapshot.draws.filter(d => d.commitmentIdentity === terms.commitmentIdentity).map(d => d.allocationRef as any) },
      effectiveness_expiry_and_withdrawal_rules: { availableFrom: terms.availableFrom, drawDeadline: terms.drawDeadline, expiresAt: terms.expiresAt, withdrawalRules: terms.withdrawalRules },
      independent_checks_and_current_state: checkRef,
      funding_obligation_and_observation_refs: { obligationIds: snapshot.draws.filter(d => d.commitmentIdentity === terms.commitmentIdentity).map(d => d.obligationId),
        observationEventIds: sourceEvents.filter(e => e.body.kind === "FUNDING_OBSERVATION").map(e => `${e.body.issuerId}:${e.body.eventId}`), receivedMinor: classification.fundingReceivedMinor, unknownMinor: classification.fundingUnknownMinor },
    };
    artifact.envelope.artifact_id = "verified-capital-commitment:" + capitalDigest({ ...artifact, envelope: { ...artifact.envelope, artifact_id: "", content_digest: "" } });
    artifact.envelope.content_digest = capitalDigest(artifact); artifacts.push(artifact);
  }
  const publication: CapitalPublication = {
    schema: "finnor.v4.capital-publication.v1", package: check.result, artifacts, check, sourceEventRefs: snapshot.eventReferences,
    continuingObligations: check.result.commitments.flatMap(item => {
      const terms = snapshot.events.filter(e => e.body.termsDigest === item.termsDigest && e.body.terms).at(-1)?.body.terms;
      return terms ? [{ commitmentId: item.commitmentId, termsDigest: item.termsDigest!, terms }] : [];
    }), knowledgeAt: snapshot.knowledgeAt, ownerDigest: snapshot.ownerDigest, codeDigest: method.digest, economicNoticeRequired: true,
  };
  await lockCapitalWork(ctx, q.body, q.rights_revision, c);
  const now = Date.now();
  if (now >= q.deadline_at.getTime() && !["STOPPED", "RECONCILING"].includes(q.status)) throw new CapitalFormationError("ORIGINAL_EPISODE_DEADLINE_EXHAUSTED");
  const publicationDigest = capitalDigest(publication);
  const stored = await recordCapitalEvidence(ctx, c, db, q.body, "publication:" + q.programme_id, "checked_financing_package",
    encodeCapitalPublication(publication as unknown as Record<string, unknown>)), id = randomUUID();
  await c.query("INSERT INTO finnor_os.v4_publications(publication_id,tenant_id,principal_id,programme_id,revision,content_digest,check_input_digest,code_digest,owner_snapshot_digest,evidence_version_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [id, ctx.auth.tenantId, principal(ctx), q.programme_id, q.revision, publicationDigest, check.inputDigest, method.digest, snapshot.ownerDigest, stored.versionId]);
  const status = ["STOPPED", "FAILED", "COMPLETE", "BLOCKED"].includes(q.status) ? q.status : q.cost_unknown || check.result.dispatchedUnknownMinor !== "0" ? "RECONCILING"
    : check.result.readiness === "FUNDING_RECEIVED" ? "COMPLETE" : "WAITING";
  await c.query("UPDATE finnor_os.v4_programmes SET current_publication_id=$4,status=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3",
    [ctx.auth.tenantId, principal(ctx), q.programme_id, id, status]);
  await capitalTransition(ctx, q.programme_id, "INDEPENDENT_PUBLICATION", { publicationId: id, contentDigest: publicationDigest, readiness: check.result.readiness,
    conditionalMinor: check.result.conditionalCommittedMinor, fundingReceivedMinor: check.result.fundingReceivedMinor, unknownMinor: check.result.dispatchedUnknownMinor,
    sourceEventCount: snapshot.events.length, executionAuthorityGranted: false }, c);
  return { publication, digest: publicationDigest, evidenceVersionId: stored.versionId };
}
