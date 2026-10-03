import type { BeliefClaim, BeliefDecisionContext, BeliefView, BeliefViewPin, BeliefViewPinValidation } from "@finnor/shared-types";
import { canExerciseAuthority, employeeAuthoritySnapshot } from "@finnor/authority";
import { withTenantTransaction } from "@finnor/db";
import { beliefOwnerRef, boundBeliefView, createBeliefView, epistemicHash, prepareS1ExperienceEvent } from "@finnor/epistemic-runtime";
import { loadPrivateEquityWorldState } from "./world-state";
import { PeDomainError, type PeMutationContext, type PeWorldRootRef, type PeWorldState } from "./types";
import {enqueueNativeBelief,enqueueNativeReferences,enqueueNativePreparedEvents,nativeReference} from './native-experience-transport';

export type WorldReadAuthorization = { revision: number; evaluatedAt: string };
export async function authorizeBeliefResources(ctx: PeMutationContext, resources: Array<{ type: string; id: string }>): Promise<WorldReadAuthorization> {
  // The authenticated runtime supplies ctx. A service-name prefix or claimed
  // role is insufficient; the existing authority owner must resolve the actor.
  try {
    const snapshot = await employeeAuthoritySnapshot(ctx.auth);
    // Reject query policies containing any active deny before grouping. The
    // verifier applies one grant to a whole list; homogeneous resource groups
    // then reduce repeated I/O without hiding a narrower deny. Requiring a grant
    // for each entire group is conservative for disjoint scoped allow grants.
    await authorizeBeliefCandidateCut(ctx);
    const unique = [...new Map(resources.map(resource => [`${resource.type}:${resource.id}`, resource])).values()];
    const groups = new Map<string, Array<{ type: string; id: string }>>();
    for (const resource of unique) groups.set(resource.type, [...(groups.get(resource.type) ?? []), resource]);
    const grouped = [...groups.values()];
    for (let offset = 0; offset < grouped.length; offset += 16) {
      const allowed = await Promise.all(grouped.slice(offset, offset + 16).map(group => canExerciseAuthority(ctx.auth,
        { operation: "query", capability: "query:pe_world_state", resources: group, risk: "low" })));
      if (allowed.some(value => !value)) throw new Error("Unavailable");
    }
    await authorizeBeliefCandidateCut(ctx);
    const after = await employeeAuthoritySnapshot(ctx.auth);
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
export async function authorizeBeliefCandidateCut(ctx: PeMutationContext): Promise<void> {
  const result = await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true }, (_db, client) => client.query<{ restricted: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM finnor_os.employee_role_assignments a
       JOIN finnor_os.employee_roles r ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.active
       JOIN finnor_os.role_authority_grants g ON g.tenant_id=a.tenant_id AND g.role_id=a.role_id
       WHERE a.tenant_id=$1 AND a.employee_id=$2 AND a.active AND a.effective_from<=clock_timestamp()
         AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
         AND g.effect='deny' AND (g.capability='*' OR g.capability LIKE 'query:%')) AS restricted`,
    [ctx.auth.tenantId, ctx.auth.employeeId ?? ctx.auth.userId]));
  if (result.rows[0]?.restricted) throw new PeDomainError("PE_ENTITY_NOT_FOUND", "PE world root was not found in the authenticated tenant");
}

/** Recheck current provider permissions in a fresh transaction after the world
 * snapshot. Revocation changes access, including access to historical records. */
export async function authorizeBeliefSourceScopes(ctx: PeMutationContext, root: PeWorldRootRef, evidenceSourceIds: string[]): Promise<void> {
  const result = await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true }, (_db, client) => client.query<{ revoked: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM finnor_os.integration_source_scopes s
       WHERE s.tenant_id=$1 AND (NOT s.enabled OR NOT s.effective_permissions @> s.required_permissions)
         AND ((s.root_binding_type=$2 AND s.root_binding_id=$3::uuid) OR EXISTS (
           SELECT 1 FROM finnor_os.external_ref_observations o WHERE o.tenant_id=s.tenant_id AND o.source_scope_id=s.id AND o.evidence_source_id=ANY($4::uuid[])
         ))) AS revoked`, [ctx.auth.tenantId, root.entityType, root.entityId, evidenceSourceIds]));
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
}): Promise<BeliefView> {
  const world = await loadPrivateEquityWorldState(ctx, input.root, { validAt: input.validAt, knowledgeAt: input.knowledgeAt });
  if (!world.beliefView) throw new Error("S1 world integration did not emit BeliefView");
  try { const view=boundBeliefView(world.beliefView, input.maxClaims ?? 1000, input.decisionContext);await enqueueNativeBelief(ctx,view,world);return view; }
  catch { throw new PeDomainError("PE_INVALID_BELIEF_CONTEXT", "S1 decision context or permitted serialization envelope is unsupported"); }
}

/** Current-use validation is separate from immutable historical reconstruction.
 * No source/rights/interpretation witness is accepted merely because it is pinned. */
export async function validateBeliefViewPin(ctx: PeMutationContext, pin: BeliefViewPin): Promise<BeliefViewPinValidation> {
  if (pin.tenantId !== ctx.auth.tenantId || pin.principalId !== (ctx.auth.employeeId ?? ctx.auth.userId)) return { status: "UNAVAILABLE", reason: "PERMITTED_VIEW_UNAVAILABLE", executionAuthorityGranted: false };
  if (!Number.isSafeInteger(pin.rightsRevision) || pin.rightsRevision < 1 || !Number.isFinite(Date.parse(pin.knowledgeAt)) || !/^[a-f0-9]{64}$/.test(pin.dependencyDigest))
    return { status: "UNAVAILABLE", reason: "INVALID_PIN_WITNESS", executionAuthorityGranted: false };
  try {
    const view = await loadEnterpriseBeliefView(ctx, { root: pin.root as PeWorldRootRef, validAt: pin.validAt });
    if (Date.parse(pin.knowledgeAt) > Date.parse(view.knowledgeAt)) return { status: "UNAVAILABLE", reason: "INVALID_PIN_WITNESS", executionAuthorityGranted: false };
    const invalidated = async(reason: string) => {
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
