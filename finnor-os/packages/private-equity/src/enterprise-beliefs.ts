import type { BeliefClaim, BeliefDecisionContext, BeliefView, BeliefViewPin, BeliefViewPinValidation } from "@finnor/shared-types";
import { canExerciseAuthorityBatch, canExerciseAuthorityTx, employeeAuthoritySnapshot, employeeAuthoritySnapshotTx } from "@finnor/authority";
import pg, { type PoolClient } from "pg";
import { channel } from "node:diagnostics_channel";
import { LedgerFault } from "../../governed-execution/src/protocol";
import { withTenantTransaction } from "@finnor/db";
import {
  beliefOwnerRef,
  boundBeliefView,
  createBeliefView,
  prepareS1ExperienceEvent,
} from "../../epistemic-runtime/src/belief-view";
import { epistemicHash } from "../../epistemic-runtime/src/source-precedence";
import { loadPrivateEquityWorldState } from "./world-state";
import { PeDomainError, type PeMutationContext, type PeWorldRootRef, type PeWorldState } from "./types";
import {enqueueNativeBelief,enqueueNativeReferences,enqueueNativePreparedEvents,nativeReference} from './native-experience-transport';
import {sharedWithinResolution} from './resolution-memo';

export type WorldReadAuthorization = { revision: number; evaluatedAt: string };
export async function authorizeBeliefResources(ctx: PeMutationContext, resources: Array<{ type: string; id: string }>, client?: PoolClient): Promise<WorldReadAuthorization> {
  // The authenticated runtime supplies ctx. A service-name prefix or claimed
  // role is insufficient; the existing authority owner must resolve the actor.
  try {
    const lock = client ? (await client.query('SHOW transaction_read_only')).rows[0]?.transaction_read_only !== 'on' : false;
    const snapshot = client ? await employeeAuthoritySnapshotTx(ctx.auth, client, lock) : await employeeAuthoritySnapshot(ctx.auth);
    // Reject query policies containing any active deny before grouping. The
    // verifier applies one grant to a whole list; homogeneous resource groups
    // then reduce repeated I/O without hiding a narrower deny. Requiring a grant
    // for each entire group is conservative for disjoint scoped allow grants.
    await authorizeBeliefCandidateCut(ctx, client);
    const unique = [...new Map(resources.map(resource => [`${resource.type}:${resource.id}`, resource])).values()];
    const groups = new Map<string, Array<{ type: string; id: string }>>();
    for (const resource of unique) groups.set(resource.type, [...(groups.get(resource.type) ?? []), resource]);
    const grouped = [...groups.values()];
    for (let offset = 0; offset < grouped.length; offset += 16) {
      const allowed: boolean[] = [];
      if (client) {
        for (const group of grouped.slice(offset, offset + 16)) allowed.push(await canExerciseAuthorityTx(ctx.auth,
          { operation: "query", capability: "query:pe_world_state", resources: group, risk: "low" }, client, lock));
      } else allowed.push(...await canExerciseAuthorityBatch(ctx.auth, grouped.slice(offset, offset + 16).map(group =>
        ({ operation: "query", capability: "query:pe_world_state", resources: group, risk: "low" }))));
      if (allowed.some(value => !value)) throw new Error("Unavailable");
    }
    await authorizeBeliefCandidateCut(ctx, client);
    const after = client ? await employeeAuthoritySnapshotTx(ctx.auth, client, lock) : await employeeAuthoritySnapshot(ctx.auth);
    if (after.revision !== snapshot.revision) throw new Error("Rights changed");
    return { revision: after.revision, evaluatedAt: new Date().toISOString() };
  } catch {
    // Denied, foreign, absent and revoked resources have one policy-safe result.
    throw new PeDomainError("PE_ENTITY_NOT_FOUND", "PE world root was not found in the authenticated tenant");
  }
}

/** A tenant-wide scan cannot safely quantify omission outside a resource-denied
 * subset. Reject this query class based on policy alone, before reading facts.
 * This is conservative S1 query eligibility, not a replacement authorizer. */
export async function authorizeBeliefCandidateCut(ctx: PeMutationContext, client?: PoolClient): Promise<void> {
  const read = (c: PoolClient) => c.query<{ restricted: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM finnor_os.employee_role_assignments a
       JOIN finnor_os.employee_roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.active
       JOIN finnor_os.role_authority_grants g ON g.tenant_id=a.tenant_id AND g.role_id=a.role_id
       WHERE a.tenant_id=$1 AND a.employee_id=$2 AND a.active AND a.effective_from<=clock_timestamp()
         AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
         AND g.effect='deny' AND (g.capability='*' OR g.capability LIKE 'query:%')) AS restricted`,
    [ctx.auth.tenantId, ctx.auth.employeeId ?? ctx.auth.userId]);
  const result = client ? await read(client) : await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true }, (_db, c) => read(c));
  if (result.rows[0]?.restricted) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "PE world root was not found in the authenticated tenant");
}

/** Recheck current provider permissions in a fresh transaction after the world
 * snapshot. Revocation changes access, including access to historical records. */
export async function authorizeBeliefSourceScopes(ctx: PeMutationContext, root: PeWorldRootRef, evidenceSourceIds: string[], client?: PoolClient): Promise<void> {
  const read = (c: PoolClient) => c.query<{ revoked: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM finnor_os.integration_source_scopes s
       WHERE s.tenant_id=$1 AND (NOT s.enabled OR NOT s.effective_permissions @> s.required_permissions)
         AND ((s.root_binding_type=$2 AND s.root_binding_id=$3::uuid) OR EXISTS (
           SELECT 1 FROM finnor_os.external_ref_observations o WHERE o.tenant_id=s.tenant_id AND o.source_scope_id=s.id AND o.evidence_source_id=ANY($4::uuid[])
         ))) AS revoked`, [ctx.auth.tenantId, root.entityType, root.entityId, evidenceSourceIds]);
  const result = client ? await read(client) : await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true }, (_db, c) => read(c));
  if (result.rows[0]?.revoked) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "PE world root was not found in the authenticated tenant");
}

export interface AuthorizedOwnerSnapshot {
  entityType: string; entityId: string; version: number; owner: string;
  snapshotHash: string; recordedAt: string; snapshot: Record<string, unknown>;
  snapshotJson?: string;
}
const date = (value: unknown) => value instanceof Date ? value.toISOString() : typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const string = (value: unknown) => typeof value === "string" ? value : null;

/** Adapter over exact authorized owner snapshots from the same world transaction.
 * It never treats current-only auxiliary projections as historical evidence. */
export function worldBeliefView(ctx: PeMutationContext, world: PeWorldState, records: AuthorizedOwnerSnapshot[], authorization: WorldReadAuthorization, evidenceOwner?: string): BeliefView {
  const refById = new Map(records.map(r => [r.entityId, beliefOwnerRef(r.owner, r.entityType, r.entityId,
    `canonical:${r.entityType}:${r.entityId}:${r.version}`, r.snapshotHash)]));
  if (world.evidence.length && !evidenceOwner) throw new PeDomainError("PE_HISTORY_OWNER_UNAVAILABLE", "Canonical semantic owner could not be resolved");
  const sourceRefs = new Map(world.evidence.map(e => [String(e.versionId), beliefOwnerRef(evidenceOwner!, "evidence_source_version", String(e.versionId),
    String(e.versionId), epistemicHash({ content: e.contentHash, snapshot: e.snapshotHash }))]));
  const claims: BeliefClaim[] = records.map(r => {
    const ref = refById.get(r.entityId)!; const value = r.snapshot;
    const evidenceVersion = string(value.evidenceVersionId);
    const series = string(value.metricSeriesId);
    const parents = [...(series && refById.get(series) ? [refById.get(series)!] : []), ...(evidenceVersion && sourceRefs.get(evidenceVersion) ? [sourceRefs.get(evidenceVersion)!] : [])];
    const dependencies = [...(series ? [refById.get(series)?.revisionId ?? `unavailable-series:${series}`] : []),
      ...(evidenceVersion ? [sourceRefs.get(evidenceVersion)?.revisionId ?? `unavailable-evidence-version:${evidenceVersion}`] : [])];
    const kind: BeliefClaim["kind"] = r.entityType === "pe_assumption" ? "ASSUMPTION" : r.entityType === "pe_thesis" ? "MODEL_CONDITIONAL"
      : ["pe_metric_observation", "pe_benchmark_observation", "pe_outcome"].includes(r.entityType) ? "OBSERVED_RECORD" : "CANONICAL_ASSERTION";
    return { id: ref.revisionId, ownerRef: ref, kind, value, exactSnapshotJson: r.snapshotJson,
      validFrom: date(value.validFrom) ?? date(value.periodStart), validTo: date(value.validTo) ?? date(value.periodEnd), knowledgeAt: r.recordedAt,
      provenance: [ref, ...parents], dependencyRefs: dependencies,
      uncertainty: { representation: "QUALIFIED_RECORD", calibratedProbability: false,
        reasons: ["OWNER_RECORD_INTEGRITY_IS_NOT_BUSINESS_TRUTH", "NESTED_JSON_NUMERIC_COMPUTATIONS_UNCERTIFIED", ...(kind === "ASSUMPTION" || kind === "MODEL_CONDITIONAL" ? ["NOT_AN_OBSERVED_FACT"] : []),
          ...(dependencies.some(x => x.startsWith("unavailable-")) ? ["PROVENANCE_DEPENDENCY_UNAVAILABLE"] : [])] }, horizon: kind === "ASSUMPTION" || kind === "MODEL_CONDITIONAL" ? "H1" : "H0" };
  });
  for (const evidence of world.evidence) {
    const ref = sourceRefs.get(String(evidence.versionId))!;
    claims.push({ id: `evidence:${ref.revisionId}`, ownerRef: ref, kind: "SOURCE_ASSERTION", value: { assertions: evidence.exactAssertions, sourceType: evidence.sourceType },
      exactSnapshotJson: String(evidence.exactSnapshotJson),
      validFrom: date(evidence.asOf), validTo: null, knowledgeAt: date(evidence.knowledgeAt ?? evidence.retrievedAt) ?? world.knowledgeAt, provenance: [ref], dependencyRefs: [],
      uncertainty: { representation: "QUALIFIED_RECORD", calibratedProbability: false, reasons: ["SOURCE_ASSERTION_NOT_CANONICAL_TRUTH", "SOURCE_INDEPENDENCE_UNESTABLISHED"] }, horizon: "H0" });
  }
  const canonicalStatus = world.temporalCompleteness.status === "complete" ? "COMPLETE"
    : world.temporalCompleteness.status === "unavailable_before_baseline" ? "UNAVAILABLE_BEFORE_BASELINE" : "PARTIAL";
  const providerComplete = world.providerEvidenceCompleteness.status === "complete";
  const truncated = world.temporalCompleteness.reasons.some(r => /bound|exceeded|truncat/i.test(r));
  const dependencyRefs = [...records.map(r => `${r.owner}:${refById.get(r.entityId)!.revisionId}:${r.snapshotHash}`),
    ...world.evidence.map(e => `evidence:${e.versionId}:${e.contentHash}:${e.snapshotHash}`),
    // Coverage identity includes all persisted descriptor fields and semantic
    // freshness state, but request-clock/age observations are not revisions.
    `provider-coverage:${epistemicHash(world.sourceCoverage.map(({ asOf: _asOf, freshness, ...descriptor }) => {
      const { ageMs: _ageMs, ...stableFreshness } = freshness as Record<string, unknown>;
      return { ...descriptor, freshness: stableFreshness };
    }))}`, `canonical-coverage:${epistemicHash(world.temporalCompleteness)}`];
  return createBeliefView({ tenantId: ctx.auth.tenantId, principalId: ctx.auth.employeeId ?? ctx.auth.userId,
    root: world.root, validAt: world.validAt, knowledgeAt: world.knowledgeAt, rightsRevision: authorization.revision, rightsEvaluatedAt: authorization.evaluatedAt,
    claims, dependencyRefs, sourceCuts: [{ owner: "canonical_postgres", knownThrough: world.knowledgeAt, consistency: "POSTGRES_REPEATABLE_READ", atomicAcrossProviders: false, lagMs: null },
      ...world.sourceCoverage.map(source => ({ owner: "permissioned_provider_observations", knownThrough: string(source.latestProviderAt) ?? world.knowledgeAt,
        consistency: "PROVIDER_RECORDED_CUT" as const, atomicAcrossProviders: false as const, lagMs: null }))],
    coverage: { canonicalStatus, status: canonicalStatus === "COMPLETE" && providerComplete ? "COMPLETE" : canonicalStatus === "UNAVAILABLE_BEFORE_BASELINE" ? canonicalStatus : "PARTIAL",
      absenceClaimsPermitted: false, truncated, omittedScope: ["UNVERSIONED_AUXILIARY_PROJECTIONS", ...(!providerComplete ? ["PROVIDER_COVERAGE_NOT_ESTABLISHED"] : [])],
      reasons: [...world.temporalCompleteness.reasons, ...world.providerEvidenceCompleteness.reasons] } });
}

export async function loadEnterpriseBeliefView(ctx: PeMutationContext, input: {
  root: PeWorldRootRef; validAt?: string; knowledgeAt?: string; decisionContext?: BeliefDecisionContext; maxClaims?: number;
}, options?: { omitAuxiliaryTasks?: true; client?: PoolClient; recordExperience?: false }): Promise<BeliefView> {
  const world = await loadPrivateEquityWorldState(ctx, input.root, { validAt: input.validAt, knowledgeAt: input.knowledgeAt,
    omitAuxiliaryTasks: options?.omitAuxiliaryTasks }, options?.client);
  if (!world.beliefView) throw new Error("S1 world integration did not emit BeliefView");
  let phase: "BOUND_VIEW" | "NATIVE_ENQUEUE" = "BOUND_VIEW";
  try {
    const view = boundBeliefView(world.beliefView, input.maxClaims ?? 1000, input.decisionContext);
    phase = "NATIVE_ENQUEUE";
    if (options?.recordExperience !== false) await enqueueNativeBelief(ctx, view, world);
    return view;
  } catch (cause) {
    try {
      // Closed diagnostic labels only, never exception text, stacks, scope or preimages.
      const ledgerCodes = new Set([
        "JSON_COMPLEXITY_LIMIT", "NON_CANONICAL_JSON", "REFERENCE_DIGEST_ENCODING_UNSUPPORTED",
        "NATIVE_OWNER_EVENT_SCOPE_INVALID", "NATIVE_OWNER_PREIMAGE_MISMATCH", "NATIVE_OWNER_REFERENCE_CONFLICT",
        "NATIVE_SNAPSHOT_PREIMAGE_UNAVAILABLE", "OWNER_ORIGIN_STORAGE_BINDING_INVALID",
        "OWNER_ORIGIN_EVENT_IDENTITY_INVALID", "OWNER_ORIGIN_EVENT_SCOPE_INVALID", "OWNER_ORIGIN_KEY_REVOKED_OR_UNAVAILABLE",
        "OWNER_ORIGIN_REFERENCE_BOUND", "OWNER_ORIGIN_REFERENCE_INVALID", "OWNER_ORIGIN_RIGHTS_INVALID",
        "OWNER_ORIGIN_SCOPE_INVALID", "OWNER_ORIGIN_SEAL_INVALID", "OWNER_ORIGIN_SIGNATURE_INVALID",
        "OWNER_ORIGIN_SIGNER_MISMATCH", "OWNER_ORIGIN_SIGNER_UNAVAILABLE",
        "OWNER_TRANSPORT_AMBIGUOUS_IDENTITY", "OWNER_TRANSPORT_BUDGET_INVALID", "OWNER_TRANSPORT_BYTE_BOUND",
        "OWNER_TRANSPORT_CONFIGURATION_EXPIRED", "OWNER_TRANSPORT_CONFIGURATION_SIGNATURE_INVALID",
        "OWNER_TRANSPORT_CREDENTIAL_NOT_ATTENUATED", "OWNER_TRANSPORT_DIGEST_INVALID", "OWNER_TRANSPORT_ENDPOINT_UNSUPPORTED",
        "OWNER_TRANSPORT_FIELD_SET_INVALID", "OWNER_TRANSPORT_IDENTITY_IMMUTABLE", "OWNER_TRANSPORT_KEY_TYPE_INVALID",
        "OWNER_TRANSPORT_LIST_INVALID", "OWNER_TRANSPORT_OBJECT_INVALID", "OWNER_TRANSPORT_ORIGIN_KEY_INVALID",
        "OWNER_TRANSPORT_POLICY_UNSUPPORTED", "OWNER_TRANSPORT_PRINCIPAL_UNAVAILABLE", "OWNER_TRANSPORT_PRIVATE_FILE_UNSAFE",
        "OWNER_TRANSPORT_PURPOSE_INVALID", "OWNER_TRANSPORT_RIGHTS_AMBIGUOUS", "OWNER_TRANSPORT_ROOT_UNAVAILABLE",
        "OWNER_TRANSPORT_SCOPE_INVALID", "OWNER_TRANSPORT_SIGNATURE_ENCODING_INVALID", "OWNER_TRANSPORT_SIGNER_UNBOUND",
        "OWNER_TRANSPORT_TEXT_INVALID", "OWNER_TRANSPORT_TIME_INVALID", "OWNER_TRANSPORT_UNRESOLVED_BACKLOG_LIMIT",
      ]);
      const viewCodes = new Map([
        ["Invalid S1 view cut", "S1_VIEW_CUT_INVALID"],
        ["S1 permitted view exceeds the 8 MiB serialization envelope", "S1_VIEW_BYTE_ENVELOPE_EXCEEDED"],
        ["S1 claim limit must be 1..1000", "S1_CLAIM_LIMIT_INVALID"],
        ["Unsupported S1 decision context", "S1_DECISION_CONTEXT_UNSUPPORTED"],
        ["Invalid S1 decision requirement", "S1_DECISION_REQUIREMENT_INVALID"],
        ["Unsupported decimal representation", "S1_DECIMAL_REPRESENTATION_UNSUPPORTED"],
      ]);
      const sqlStates = new Set(["08006", "22P02", "23503", "23505", "23514", "40001", "40P01", "42501", "42601", "42703", "42P01", "53300", "57014", "57P01"]);
      const causeClass = cause instanceof LedgerFault ? "LEDGER_FAULT" : cause instanceof pg.DatabaseError ? "DATABASE_ERROR"
        : cause instanceof PeDomainError ? "PE_DOMAIN_ERROR" : cause instanceof TypeError ? "TYPE_ERROR"
        : cause instanceof RangeError ? "RANGE_ERROR" : cause instanceof SyntaxError ? "SYNTAX_ERROR" : cause instanceof Error ? "ERROR" : "NON_ERROR";
      const knownCode = cause instanceof LedgerFault ? ledgerCodes.has(cause.code) ? cause.code : null
        : cause instanceof pg.DatabaseError ? cause.code && sqlStates.has(cause.code) ? cause.code : null
        : cause instanceof Error ? viewCodes.get(cause.message) ?? null : null;
      const diagnostic = { phase, causeClass, knownCode };
      channel("finnor.s1.belief-load-failure.v1").publish({
        schema: "finnor.s1.belief-load-failure.v1", ...diagnostic, causeHash: epistemicHash(diagnostic), publisherPid: process.pid,
      });
    } catch { /* Optional diagnostics cannot replace the original private refusal. */ }
    throw new PeDomainError("PE_INVALID_BELIEF_CONTEXT", "S1 decision context or permitted serialization envelope is unsupported");
  }
}

/** Reconstruct the original cut while the owner authorizes every source under
 * current rights. A digest alone is insufficient when its closure is unavailable. */
export function assertEnterpriseBeliefViewPinSourceVisibility(ctx: PeMutationContext, pin: BeliefViewPin): Promise<void> {
  return sharedWithinResolution(ctx, "belief-view-pin-source-visibility", pin, async () => {
    const unavailable = () => new PeDomainError("PE_ENTITY_NOT_FOUND", "PE world root was not found in the authenticated tenant");
    if (pin.tenantId !== ctx.auth.tenantId || !Number.isSafeInteger(pin.rightsRevision) || pin.rightsRevision < 1 ||
      !Number.isFinite(Date.parse(pin.validAt)) || !Number.isFinite(Date.parse(pin.knowledgeAt)) ||
      !/^[a-f0-9]{64}$/.test(pin.dependencyDigest) || typeof pin.interpretationVersion !== "string" || !pin.interpretationVersion) throw unavailable();
    const view = await loadEnterpriseBeliefView(ctx, { root: pin.root as PeWorldRootRef, validAt: pin.validAt, knowledgeAt: pin.knowledgeAt },
      { omitAuxiliaryTasks: true });
    // Prior rights/interpretation identify the immutable witness, not today's grant.
    const dependencyDigest = epistemicHash({ dependencyRefs: view.experience.event.dependencyRefs, rightsRevision: pin.rightsRevision,
      interpretation: pin.interpretationVersion, coverage: view.coverage, sourceCuts: view.sourceCuts.map(({ knownThrough: _knownThrough, ...cut }) => cut) });
    if (view.coverage.canonicalStatus !== "COMPLETE" || view.coverage.truncated || dependencyDigest !== pin.dependencyDigest) throw unavailable();
  });
}

/** Current-use validation is separate from immutable historical reconstruction.
 * No source/rights/interpretation witness is accepted merely because it is pinned. */
export async function validateBeliefViewPin(ctx: PeMutationContext, pin: BeliefViewPin, client?: PoolClient,
  options?: { recordExperience?: false }): Promise<BeliefViewPinValidation> {
  if (pin.tenantId !== ctx.auth.tenantId || pin.principalId !== (ctx.auth.employeeId ?? ctx.auth.userId)) return { status: "UNAVAILABLE", reason: "PERMITTED_VIEW_UNAVAILABLE", executionAuthorityGranted: false };
  if (!Number.isSafeInteger(pin.rightsRevision) || pin.rightsRevision < 1 || !Number.isFinite(Date.parse(pin.knowledgeAt)) || !/^[a-f0-9]{64}$/.test(pin.dependencyDigest))
    return { status: "UNAVAILABLE", reason: "INVALID_PIN_WITNESS", executionAuthorityGranted: false };
  try {
    const view = await loadEnterpriseBeliefView(ctx, { root: pin.root as PeWorldRootRef, validAt: pin.validAt }, { client, ...options });
    if (Date.parse(pin.knowledgeAt) > Date.parse(view.knowledgeAt)) return { status: "UNAVAILABLE", reason: "INVALID_PIN_WITNESS", executionAuthorityGranted: false };
    const invalidated = async(reason: string) => {
      if (options?.recordExperience === false) return { status: "INVALIDATED" as const, reason, executionAuthorityGranted: false as const };
      const invalidation = { priorDependencyDigest: pin.dependencyDigest, currentDependencyDigest: view.dependencyDigest, pinWitnessDigest: epistemicHash(pin), reason };
      const { eventId: _viewEventId, ...body } = view.experience.event;
      const event = prepareS1ExperienceEvent({ ...body, type: "BELIEF_INVALIDATION", invalidation,
        dependencyRefs: [...body.dependencyRefs, `pin-witness:${invalidation.pinWitnessDigest}`] });
      await enqueueNativeReferences(ctx,[nativeReference('S1',`pin-witness:${invalidation.pinWitnessDigest}`,pin,'s1-pin-witness-v1')],[view.rights.ref]);
      await enqueueNativePreparedEvents(ctx,'S1',[event]);
      return { status: "INVALIDATED" as const, reason, executionAuthorityGranted: false as const, experience: { ...view.experience, event } };
    };
    if (view.dependencyDigest !== pin.dependencyDigest || view.rights.revision !== pin.rightsRevision || view.interpretationVersion !== pin.interpretationVersion)
      return invalidated("SOURCE_RIGHTS_COVERAGE_OR_INTERPRETATION_CHANGED");
    if (view.coverage.canonicalStatus !== "COMPLETE" || view.coverage.truncated) return invalidated("PERMITTED_COVERAGE_INCOMPLETE");
    return { status: "CURRENT", reason: "CURRENT_PERMITTED_DEPENDENCIES_MATCH", executionAuthorityGranted: false };
  } catch { return { status: "UNAVAILABLE", reason: "PERMITTED_VIEW_UNAVAILABLE", executionAuthorityGranted: false }; }
}
