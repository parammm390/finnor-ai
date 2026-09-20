import type {
  AutonomyGateResult,
  BusinessEffectOperationClass,
  BusinessEffectSet,
  DomainAction,
  OutcomeAutonomyReadiness,
  OutcomePackId,
  OutcomePackGrantScope,
  OutcomeTrustMetrics,
  TenantContext,
} from "@finnor/shared-types";
import {
  MAX_HIGH_EGRESS_ROWS,
  actionLog,
  authorityStates,
  autonomyEvaluations,
  autonomyGrants,
  businessEffects,
  compensationCases,
  domainActions,
  integrationOperations,
  outcomePackCertifications,
  outcomePackRuns,
  outcomeShadowProposals,
  reconciliationCases,
  tenantIntegrations,
  tenantOutcomePackSettings,
  withTenant,
} from "@finnor/db";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { OUTCOME_PACK_DEFINITIONS, outcomePackFingerprint } from "./outcome-packs";

const RISK = { low: 0, medium: 1, high: 2 } as const;
const LIVE_CERTIFICATION_STATUSES = new Set(["LIVE_TEST_PASS"]);

type AuthorityBoundaryDecision = { outcome: "allowed" | "denied" | "approval_required"; authorityRevision: number; reasonCode: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function resourcesAllow(scopeValue: unknown, effect: BusinessEffectSet): boolean {
  if (!Array.isArray(scopeValue) || scopeValue.length === 0) return false;
  const scopes = scopeValue.map(record);
  return effect.targets.every((target) => scopes.some((scope) => {
    if (scope.type !== "*" && scope.type !== target.type) return false;
    const ids = Array.isArray(scope.ids) ? scope.ids.filter((id): id is string => typeof id === "string") : null;
    return !ids || ids.includes(target.id);
  }));
}

function providersAllow(scopeValue: unknown, effect: BusinessEffectSet): boolean {
  const governedBindings = effect.bindings.filter((binding) => binding.provider || binding.applicationAccountId);
  if (governedBindings.length === 0) return true;
  if (!Array.isArray(scopeValue) || scopeValue.length === 0) return false;
  const scopes = scopeValue.map(record);
  return governedBindings.every((binding) => scopes.some((scope) => {
    const providerMatches = scope.provider === "*" || scope.provider === binding.provider;
    const accountMatches = scope.applicationAccountId === undefined || scope.applicationAccountId === binding.applicationAccountId;
    return providerMatches && accountMatches;
  }));
}

function principalAllows(principal: string, action: DomainAction): boolean {
  const actual = action.initiatedBy ? `employee:${action.initiatedBy}` : "system:orchestration";
  return principal === "*" || principal === actual || principal === action.initiatedBy;
}

function materialAmbiguity(effect: BusinessEffectSet): string[] {
  const reasons: string[] = [];
  if (effect.targets.length === 0) reasons.push("NO_MATERIAL_TARGET");
  if (effect.targets.some((target) => !target.id || /^(?:unknown|ambiguous|unresolved|placeholder)$/i.test(target.id))) reasons.push("MATERIAL_TARGET_AMBIGUOUS");
  if (effect.operation.external && !effect.bindings.some((binding) => binding.provider || binding.applicationAccountId)) reasons.push("EXTERNAL_BINDING_AMBIGUOUS");
  if (effect.preconditions.length === 0 && effect.targets.length > 0) reasons.push("MATERIAL_PRECONDITIONS_MISSING");
  return reasons;
}

async function persistEvaluation(params: {
  tenantId: string;
  run: typeof outcomePackRuns.$inferSelect;
  action: DomainAction;
  effect: BusinessEffectSet;
  result: AutonomyGateResult;
  authority: AuthorityBoundaryDecision;
  sourceHealth: unknown[];
}): Promise<void> {
  await withTenant(params.tenantId, (db) => db.insert(autonomyEvaluations).values({
    tenantId: params.tenantId,
    outcomePackRunId: params.run.id,
    workId: params.run.workId,
    domainActionId: params.action.id,
    businessEffectId: params.effect.id,
    grantId: params.result.grantId,
    mode: params.run.mode,
    outcome: params.result.outcome === "not_pack_work" ? "blocked" : params.result.outcome,
    eligible: params.result.eligible,
    reasonCodes: params.result.reasonCodes,
    authorityRevision: params.authority.authorityRevision,
    policyVersion: params.effect.authority.policyVersion,
    certificationFingerprint: params.run.certificationFingerprint,
    sourceHealthSnapshot: params.sourceHealth,
    scopeSnapshot: {
      operationClass: params.effect.operation.class,
      risk: params.effect.authority.risk,
      amountUsd: params.effect.exposure?.currency === "USD" ? params.effect.exposure.amount : null,
      targets: params.effect.targets.map((target) => ({ kind: target.kind, type: target.type, id: target.id })),
      bindings: params.effect.bindings.map((binding) => ({ provider: binding.provider ?? null, applicationAccountId: binding.applicationAccountId ?? null })),
      semanticHash: params.effect.semanticHash,
    },
  }));
}

function result(params: {
  eligible: boolean;
  outcome: AutonomyGateResult["outcome"];
  reasons: string[];
  run?: typeof outcomePackRuns.$inferSelect | null;
  grantId?: string | null;
}): AutonomyGateResult {
  return {
    eligible: params.eligible,
    outcome: params.outcome,
    reasonCodes: [...new Set(params.reasons)],
    grantId: params.grantId ?? null,
    packId: params.run?.packId as OutcomePackId ?? null,
    packVersion: params.run?.packVersion ?? null,
    mode: params.run?.mode ?? null,
    certificationFingerprint: params.run?.certificationFingerprint ?? null,
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * Deterministic approval-waiver gate for one already-compiled EffectSet. Authority
 * is evaluated first and remains final; this function can only add restrictions.
 */
export async function evaluateEffectAutonomy(params: {
  action: DomainAction;
  effect: BusinessEffectSet;
  authority: AuthorityBoundaryDecision;
}): Promise<AutonomyGateResult> {
  const workId = params.action.workId;
  if (!workId) return result({ eligible: false, outcome: "not_pack_work", reasons: ["NOT_OUTCOME_PACK_WORK"] });
  const state = await withTenant(params.action.tenantId, async (db) => {
    const [run] = await db.select().from(outcomePackRuns).where(and(eq(outcomePackRuns.tenantId, params.action.tenantId), eq(outcomePackRuns.workId, workId))).limit(1);
    if (!run) return { run: null, setting: null, authorityRevision: null, integrations: [], grants: [], certifications: [], openReconciliation: [] };
    const definition = OUTCOME_PACK_DEFINITIONS[run.packId as OutcomePackId];
    const requiredCapabilities = definition?.requiredCapabilities.map((item) => item.capability) ?? [];
    const [setting] = await db.select().from(tenantOutcomePackSettings).where(and(eq(tenantOutcomePackSettings.tenantId, params.action.tenantId), eq(tenantOutcomePackSettings.packId, run.packId))).limit(1);
    const [authority] = await db.select().from(authorityStates).where(eq(authorityStates.tenantId, params.action.tenantId)).limit(1);
    const integrations = requiredCapabilities.length === 0 ? [] : await db.select().from(tenantIntegrations).where(and(eq(tenantIntegrations.tenantId, params.action.tenantId), inArray(tenantIntegrations.capability, requiredCapabilities as Array<typeof tenantIntegrations.$inferSelect.capability>)));
    const grants = await db.select().from(autonomyGrants).where(and(eq(autonomyGrants.tenantId, params.action.tenantId), eq(autonomyGrants.packId, run.packId), eq(autonomyGrants.packVersion, run.packVersion))).orderBy(desc(autonomyGrants.createdAt));
    const certifications = await db.select().from(outcomePackCertifications).where(and(eq(outcomePackCertifications.tenantId, params.action.tenantId), eq(outcomePackCertifications.packId, run.packId), eq(outcomePackCertifications.packVersion, run.packVersion), eq(outcomePackCertifications.fingerprint, run.certificationFingerprint))).orderBy(desc(outcomePackCertifications.certifiedAt));
    const openReconciliation = await db.select().from(reconciliationCases).where(and(
      eq(reconciliationCases.tenantId, params.action.tenantId),
      eq(reconciliationCases.status, "open"),
      inArray(reconciliationCases.caseType, ["external_drift", "mapping_ambiguous", "stale_source", "auth_failure"]),
    ));
    return { run, setting: setting ?? null, authorityRevision: authority?.revision ?? 1, integrations, grants, certifications, openReconciliation };
  });
  if (!state.run) return result({ eligible: false, outcome: "not_pack_work", reasons: ["NOT_OUTCOME_PACK_WORK"] });
  const definition = OUTCOME_PACK_DEFINITIONS[state.run.packId as OutcomePackId];
  const sourceHealth = state.integrations.map((integration) => ({
    capability: integration.capability,
    integrationId: integration.id,
    binding: integration.binding,
    mode: integration.mode,
    health: integration.health,
    syncStatus: integration.syncStatus,
    freshnessState: integration.freshnessState,
    reconciliationStatus: integration.reconciliationStatus,
    sourceLagMs: integration.sourceLagMs,
    unresolvedConflicts: integration.unresolvedConflicts,
  }));
  if (!definition) {
    const denied = result({ eligible: false, outcome: "blocked", reasons: ["PACK_DEFINITION_MISSING"], run: state.run });
    await persistEvaluation({ tenantId: params.action.tenantId, run: state.run, action: params.action, effect: params.effect, result: denied, authority: params.authority, sourceHealth });
    return denied;
  }
  if (state.run.mode === "shadow") {
    const shadow = result({ eligible: false, outcome: "shadow_only", reasons: ["SHADOW_ZERO_EFFECT_BOUNDARY"], run: state.run });
    await persistEvaluation({ tenantId: params.action.tenantId, run: state.run, action: params.action, effect: params.effect, result: shadow, authority: params.authority, sourceHealth });
    return shadow;
  }
  if (state.run.mode === "approval") {
    const approval = result({ eligible: false, outcome: "approval_required", reasons: ["PACK_APPROVAL_MODE"], run: state.run });
    await persistEvaluation({ tenantId: params.action.tenantId, run: state.run, action: params.action, effect: params.effect, result: approval, authority: params.authority, sourceHealth });
    return approval;
  }

  const reasons: string[] = [];
  const now = new Date();
  if (state.run.status !== "active") reasons.push("PACK_RUN_NOT_ACTIVE");
  if (state.setting && !state.setting.enabled) reasons.push("PACK_DISABLED_BY_OPERATOR");
  const currentFingerprint = outcomePackFingerprint(definition);
  if (state.run.certificationFingerprint !== currentFingerprint) reasons.push("IMPLEMENTATION_FINGERPRINT_CHANGED");
  if (!definition.allowedEffectClasses.includes(params.effect.operation.class)) reasons.push("EFFECT_CLASS_OUTSIDE_PACK");
  if (definition.permanentlyApprovalRequiredEffectClasses.includes(params.effect.operation.class)) reasons.push("PERMANENT_APPROVAL_BOUNDARY");
  if (params.effect.approval.required) reasons.push("CURRENT_POLICY_REQUIRES_APPROVAL");
  if (params.authority.outcome === "denied") reasons.push(`AUTHORITY_DENIED:${params.authority.reasonCode}`);
  if (params.authority.outcome === "approval_required") reasons.push(`AUTHORITY_REQUIRES_APPROVAL:${params.authority.reasonCode}`);
  reasons.push(...materialAmbiguity(params.effect));
  if (state.openReconciliation.length > 0) reasons.push("MATERIAL_RECONCILIATION_OPEN");

  for (const requirement of definition.requiredCapabilities.filter((item) => item.required)) {
    const integration = state.integrations.find((item) => item.capability === requirement.capability);
    if (!integration) { reasons.push(`CAPABILITY_NOT_CONFIGURED:${requirement.capability}`); continue; }
    if (!integration.outcomePacks.includes(definition.id)) reasons.push(`CAPABILITY_NOT_BOUND_TO_PACK:${requirement.capability}`);
    if (!requirement.acceptedModes.includes(integration.mode)) reasons.push(`CAPABILITY_MODE_NOT_CERTIFIABLE:${requirement.capability}`);
    if (integration.health !== "ok" || integration.syncStatus !== "synced" || integration.freshnessState !== "fresh" || integration.reconciliationStatus !== "healthy" || integration.unresolvedConflicts > 0) {
      reasons.push(`CAPABILITY_TRUTH_UNHEALTHY:${requirement.capability}`);
    }
    if (requirement.maxSourceLagMs !== null && (integration.sourceLagMs === null || integration.sourceLagMs > requirement.maxSourceLagMs)) reasons.push(`CAPABILITY_SOURCE_STALE:${requirement.capability}`);
  }

  const certification = state.certifications.find((row) =>
    LIVE_CERTIFICATION_STATUSES.has(row.status)
    && (row.level === "live_provider" || row.level === "production")
    && row.validUntil > now
    && !row.suspendedAt
    && row.criticalViolations === 0,
  );
  if (!certification) reasons.push("CURRENT_LIVE_CERTIFICATION_MISSING");

  const candidateGrants = state.grants.filter((grant) => grant.status === "active" && grant.validFrom <= now && grant.expiresAt > now && grant.reviewAfter >= now);
  const grant = candidateGrants.find((candidate) => {
    if (candidate.certificationFingerprint !== currentFingerprint || candidate.authorityRevision !== state.authorityRevision) return false;
    if (!candidate.effectClasses.includes(params.effect.operation.class)) return false;
    if (!principalAllows(candidate.principal, params.action)) return false;
    if (!resourcesAllow(candidate.resourceScope, params.effect) || !providersAllow(candidate.providerScope, params.effect)) return false;
    if (RISK[params.effect.authority.risk] > RISK[candidate.maxRisk]) return false;
    if (candidate.policyVersion !== null && candidate.policyVersion !== params.effect.authority.policyVersion) return false;
    const amount = params.effect.exposure?.currency === "USD" ? params.effect.exposure.amount : null;
    if (amount !== null && (candidate.maxAmountUsd === null || amount > Number(candidate.maxAmountUsd))) return false;
    return true;
  });
  if (!grant) reasons.push("EXACT_ACTIVE_GRANT_MISSING");

  const allowed = reasons.length === 0 && Boolean(grant && certification) && params.authority.outcome === "allowed";
  const gate = result({ eligible: allowed, outcome: allowed ? "autopilot_allowed" : reasons.some((reason) => reason.startsWith("AUTHORITY_REQUIRES_APPROVAL") || reason === "CURRENT_POLICY_REQUIRES_APPROVAL" || reason === "PERMANENT_APPROVAL_BOUNDARY") ? "approval_required" : "blocked", reasons: allowed ? ["ALL_AUTOPILOT_GATES_PASSED"] : reasons, run: state.run, grantId: grant?.id });
  await persistEvaluation({ tenantId: params.action.tenantId, run: state.run, action: params.action, effect: params.effect, result: gate, authority: params.authority, sourceHealth });
  return gate;
}

/** Persist a hypothetical effect and make the real action/effect non-executable. */
export async function recordShadowEffect(params: { action: DomainAction; effect: BusinessEffectSet }): Promise<void> {
  if (!params.action.workId) throw new Error("Shadow effect must belong to Work");
  await withTenant(params.action.tenantId, async (db) => {
    const [run] = await db.select().from(outcomePackRuns).where(and(eq(outcomePackRuns.tenantId, params.action.tenantId), eq(outcomePackRuns.workId, params.action.workId!))).limit(1);
    if (!run || run.mode !== "shadow") throw new Error("Shadow effect refused outside an active shadow pack run");
    await db.insert(outcomeShadowProposals).values({
      tenantId: params.action.tenantId,
      outcomePackRunId: run.id,
      workId: run.workId,
      domainActionId: params.action.id,
      businessEffectId: params.effect.id,
      semanticHash: params.effect.semanticHash,
      hypotheticalEffect: { ...params.effect, mode: "shadow" },
      expectedOutcome: params.effect.expected.state ?? undefined,
    }).onConflictDoNothing({ target: outcomeShadowProposals.domainActionId });
    await db.update(businessEffects).set({ status: "cancelled", verification: { state: "not_started", basis: "Shadow mode: hypothetical only; no consequential mutation was authorized.", checkedAt: new Date().toISOString() } })
      .where(and(eq(businessEffects.tenantId, params.action.tenantId), eq(businessEffects.id, params.effect.id), eq(businessEffects.status, "compiled")));
    await db.update(domainActions).set({ status: "completed", executionStartedAt: null })
      .where(and(eq(domainActions.tenantId, params.action.tenantId), eq(domainActions.id, params.action.id), eq(domainActions.status, "draft")));
    await db.update(outcomePackRuns).set({ status: "shadow_recorded", updatedAt: new Date() })
      .where(and(eq(outcomePackRuns.tenantId, params.action.tenantId), eq(outcomePackRuns.id, run.id)));
    await db.insert(actionLog).values({
      tenantId: params.action.tenantId,
      domainActionId: params.action.id,
      step: "shadow_proposed",
      input: { packId: run.packId, mode: "shadow" },
      output: { businessEffectId: params.effect.id, semanticHash: params.effect.semanticHash, consequentialMutation: false },
    });
  });
}

/** Explicit, explainable readiness derived from canonical outcome/effect history. */
export async function evaluateOutcomeAutonomyReadiness(tenantId: string, packId: OutcomePackId): Promise<OutcomeAutonomyReadiness> {
  const definition = OUTCOME_PACK_DEFINITIONS[packId];
  const fingerprint = outcomePackFingerprint(definition);
  const rows = await withTenant(tenantId, async (db) => {
    const runsPlus = await db.select().from(outcomePackRuns).where(and(eq(outcomePackRuns.tenantId, tenantId), eq(outcomePackRuns.packId, packId), eq(outcomePackRuns.packVersion, definition.version))).orderBy(desc(outcomePackRuns.createdAt), desc(outcomePackRuns.id)).limit(MAX_HIGH_EGRESS_ROWS + 1);
    const runs = runsPlus.slice(0, MAX_HIGH_EGRESS_ROWS);
    const workIds = runs.map((run) => run.workId);
    const actionsPlus = workIds.length === 0 ? [] : await db.select().from(domainActions).where(and(eq(domainActions.tenantId, tenantId), inArray(domainActions.workId, workIds))).orderBy(desc(domainActions.createdAt), desc(domainActions.id)).limit(MAX_HIGH_EGRESS_ROWS + 1);
    const actions = actionsPlus.slice(0, MAX_HIGH_EGRESS_ROWS);
    const actionIds = actions.map((action) => action.id);
    const effectsPlus = actionIds.length === 0 ? [] : await db.select().from(businessEffects).where(and(eq(businessEffects.tenantId, tenantId), inArray(businessEffects.domainActionId, actionIds))).orderBy(desc(businessEffects.createdAt), desc(businessEffects.id)).limit(MAX_HIGH_EGRESS_ROWS + 1);
    const effects = effectsPlus.slice(0, MAX_HIGH_EGRESS_ROWS);
    const effectIds = effects.map((effect) => effect.id);
    const evaluationsPlus = await db.select().from(autonomyEvaluations).where(and(eq(autonomyEvaluations.tenantId, tenantId), inArray(autonomyEvaluations.outcomePackRunId, runs.length ? runs.map((run) => run.id) : ["00000000-0000-0000-0000-000000000000"]))).orderBy(desc(autonomyEvaluations.evaluatedAt), desc(autonomyEvaluations.id)).limit(MAX_HIGH_EGRESS_ROWS + 1);
    const evaluations = evaluationsPlus.slice(0, MAX_HIGH_EGRESS_ROWS);
    const certificationsPlus = await db.select().from(outcomePackCertifications).where(and(eq(outcomePackCertifications.tenantId, tenantId), eq(outcomePackCertifications.packId, packId), eq(outcomePackCertifications.fingerprint, fingerprint))).orderBy(desc(outcomePackCertifications.certifiedAt), desc(outcomePackCertifications.id)).limit(MAX_HIGH_EGRESS_ROWS + 1);
    const certifications = certificationsPlus.slice(0, MAX_HIGH_EGRESS_ROWS);
    const compensationsPlus = effectIds.length === 0 ? [] : await db.select().from(compensationCases).where(and(eq(compensationCases.tenantId, tenantId), or(inArray(compensationCases.businessEffectId, effectIds), inArray(compensationCases.compensationEffectId, effectIds)))).orderBy(desc(compensationCases.createdAt), desc(compensationCases.id)).limit(MAX_HIGH_EGRESS_ROWS + 1);
    const compensations = compensationsPlus.slice(0, MAX_HIGH_EGRESS_ROWS);
    const reconciliationsPlus = effectIds.length === 0 ? [] : await db.select().from(reconciliationCases).where(and(eq(reconciliationCases.tenantId, tenantId), inArray(reconciliationCases.businessEffectId, effectIds))).orderBy(desc(reconciliationCases.createdAt), desc(reconciliationCases.id)).limit(MAX_HIGH_EGRESS_ROWS + 1);
    const reconciliations = reconciliationsPlus.slice(0, MAX_HIGH_EGRESS_ROWS);
    const operationRowsPlus = effectIds.length === 0 ? [] : await db.select({ businessEffectId: integrationOperations.businessEffectId, operationKey: integrationOperations.operationKey }).from(integrationOperations).where(and(eq(integrationOperations.tenantId, tenantId), inArray(integrationOperations.businessEffectId, effectIds))).orderBy(desc(integrationOperations.createdAt), desc(integrationOperations.id)).limit(MAX_HIGH_EGRESS_ROWS + 1);
    const operationRows = operationRowsPlus.slice(0, MAX_HIGH_EGRESS_ROWS);
    return {
      runs, actions, effects, evaluations, certifications, compensations, reconciliations, operationRows,
      truncated: [runsPlus, actionsPlus, effectsPlus, evaluationsPlus, certificationsPlus, compensationsPlus, reconciliationsPlus, operationRowsPlus].some((rows) => rows.length > MAX_HIGH_EGRESS_ROWS),
    };
  });
  const totalRuns = rows.runs.filter((run) => ["completed", "failed", "blocked", "cancelled"].includes(run.status)).length;
  const verifiedRunRows = rows.runs.filter((run) => run.status === "completed" && record(run.finalVerification).state === "verified");
  const verifiedRuns = verifiedRunRows.length;
  const verifiedEffectActionIds = new Set(rows.effects.filter((effect) => effect.status === "verified").map((effect) => effect.domainActionId));
  const verifiedEffectWorkIds = new Set(rows.actions.filter((action) => verifiedEffectActionIds.has(action.id) && action.workId).map((action) => action.workId!));
  const verifiedRunsWithEffects = verifiedRunRows.filter((run) => verifiedEffectWorkIds.has(run.workId)).length;
  const divergentEffects = rows.effects.filter((effect) => ["divergent", "reconciliation_required"].includes(effect.status)).length;
  const rejectedActions = rows.actions.filter((action) => action.status === "rejected").length;
  const uncertainOutcomes = rows.effects.filter((effect) => ["unverified", "reconciliation_required"].includes(effect.status)).length;
  const operationIdentities = new Set<string>();
  let duplicateConsequentialEffects = 0;
  for (const operation of rows.operationRows) {
    const key = `${operation.businessEffectId}:${operation.operationKey}`;
    if (operationIdentities.has(key)) duplicateConsequentialEffects += 1;
    operationIdentities.add(key);
  }
  const policyOrAuthorityViolations = rows.evaluations.filter((evaluation) => evaluation.reasonCodes.some((code) => code.startsWith("AUTHORITY_DENIED") || code === "CURRENT_POLICY_REQUIRES_APPROVAL") && evaluation.outcome === "autopilot_allowed").length;
  const resolvedReconciliation = rows.reconciliations.filter((row) => row.status === "resolved").length;
  const metrics: OutcomeTrustMetrics = {
    totalRuns,
    verifiedRuns,
    verificationCoverage: totalRuns === 0 ? 0 : rows.runs.filter((run) => run.finalVerification !== null).length / totalRuns,
    verifiedEffectCoverage: verifiedRuns === 0 ? 0 : verifiedRunsWithEffects / verifiedRuns,
    verifiedSuccessRate: totalRuns === 0 ? 0 : verifiedRuns / totalRuns,
    divergentEffects,
    divergenceRate: rows.effects.length === 0 ? 0 : divergentEffects / rows.effects.length,
    rejectedActions,
    humanRejectionRate: rows.actions.length === 0 ? 0 : rejectedActions / rows.actions.length,
    uncertainOutcomes,
    duplicateConsequentialEffects,
    policyOrAuthorityViolations,
    compensationCount: rows.compensations.length,
    manualEscalations: rows.runs.filter((run) => run.status === "blocked").length,
    recoveryRate: rows.reconciliations.length === 0 ? 1 : resolvedReconciliation / rows.reconciliations.length,
  };
  const currentLiveCertification = rows.certifications.some((certification) => certification.status === "LIVE_TEST_PASS" && (certification.level === "live_provider" || certification.level === "production") && certification.validUntil > new Date() && certification.criticalViolations === 0 && !certification.suspendedAt);
  const gates: OutcomeAutonomyReadiness["gates"] = [
    { code: "BOUNDED_EVIDENCE_READ", passed: !rows.truncated, observed: rows.truncated, required: false },
    { code: "MIN_VERIFIED_SAMPLE", passed: verifiedRuns >= 20, observed: verifiedRuns, required: 20 },
    { code: "FULL_VERIFICATION_COVERAGE", passed: metrics.verificationCoverage === 1, observed: metrics.verificationCoverage, required: 1 },
    { code: "FULL_VERIFIED_EFFECT_COVERAGE", passed: metrics.verifiedEffectCoverage === 1, observed: metrics.verifiedEffectCoverage, required: 1 },
    { code: "VERIFIED_SUCCESS_RATE", passed: metrics.verifiedSuccessRate >= 0.95, observed: metrics.verifiedSuccessRate, required: 0.95 },
    { code: "DIVERGENCE_RATE", passed: metrics.divergenceRate <= 0.01, observed: metrics.divergenceRate, required: 0.01 },
    { code: "ZERO_UNCERTAIN_OUTCOMES", passed: uncertainOutcomes === 0, observed: uncertainOutcomes, required: 0 },
    { code: "ZERO_DUPLICATE_EFFECTS", passed: duplicateConsequentialEffects === 0, observed: duplicateConsequentialEffects, required: 0 },
    { code: "ZERO_POLICY_AUTHORITY_VIOLATIONS", passed: policyOrAuthorityViolations === 0, observed: policyOrAuthorityViolations, required: 0 },
    { code: "RECOVERY_QUALITY", passed: metrics.recoveryRate >= 0.99, observed: metrics.recoveryRate, required: 0.99 },
    { code: "CURRENT_LIVE_CERTIFICATION", passed: currentLiveCertification, observed: currentLiveCertification, required: true },
  ];
  const eligible = gates.every((gate) => gate.passed);
  const hasApprovalCertification = rows.certifications.some((certification) => certification.status === "LOCAL_PASS" || certification.status === "SANDBOX_PASS" || certification.status === "LIVE_TEST_PASS");
  return {
    state: eligible ? "AUTOPILOT_ELIGIBLE" : hasApprovalCertification ? "APPROVAL_CERTIFIED" : totalRuns > 0 ? "SHADOW_ELIGIBLE" : "UNCERTIFIED",
    eligible,
    gates,
    metrics,
    evaluatedAt: new Date().toISOString(),
  };
}

export async function createAutonomyGrant(params: {
  ctx: TenantContext;
  packId: OutcomePackId;
  packVersion: number;
  scope: OutcomePackGrantScope;
  reason: string;
}): Promise<{ id: string }> {
  const actorId = params.ctx.employeeId ?? (/^[0-9a-f-]{36}$/i.test(params.ctx.userId) ? params.ctx.userId : null);
  if (!actorId) throw new Error("A canonical employee is required to create an autonomy grant");
  const definition = OUTCOME_PACK_DEFINITIONS[params.packId];
  if (params.packVersion !== definition.version) throw new Error("Grant pack version is not current");
  if (params.scope.certificationFingerprint !== outcomePackFingerprint(definition)) throw new Error("Grant certification fingerprint is not current");
  if (params.scope.effectClasses.some((effectClass) => definition.permanentlyApprovalRequiredEffectClasses.includes(effectClass))) {
    throw new Error("Grant includes an effect class that remains permanently approval-required");
  }
  const readiness = await evaluateOutcomeAutonomyReadiness(params.ctx.tenantId, params.packId);
  if (!readiness.eligible) throw new Error(`Autonomy is not eligible: ${readiness.gates.filter((gate) => !gate.passed).map((gate) => gate.code).join(", ")}`);
  const [row] = await withTenant(params.ctx.tenantId, (db) => db.insert(autonomyGrants).values({
    tenantId: params.ctx.tenantId,
    packId: params.packId,
    packVersion: params.packVersion,
    effectClasses: params.scope.effectClasses,
    resourceScope: params.scope.resources,
    principal: params.scope.principal,
    providerScope: params.scope.providers,
    maxAmountUsd: params.scope.maxAmountUsd === null ? null : params.scope.maxAmountUsd.toFixed(2),
    maxRisk: params.scope.maxRisk,
    policyVersion: params.scope.policyVersion,
    authorityRevision: params.scope.authorityRevision,
    certificationFingerprint: params.scope.certificationFingerprint,
    validFrom: new Date(params.scope.validFrom),
    expiresAt: new Date(params.scope.expiresAt),
    reviewAfter: new Date(params.scope.reviewAfter),
    createdBy: actorId,
    reason: params.reason,
  }).returning({ id: autonomyGrants.id }));
  if (!row) throw new Error("Autonomy grant was not persisted");
  return row;
}

export async function revokeAutonomyGrant(params: { tenantId: string; grantId: string; actorId: string; reason: string }): Promise<boolean> {
  const [row] = await withTenant(params.tenantId, (db) => db.update(autonomyGrants).set({ status: "revoked", revokedBy: params.actorId, revokedAt: new Date(), reason: params.reason, updatedAt: new Date() }).where(and(eq(autonomyGrants.tenantId, params.tenantId), eq(autonomyGrants.id, params.grantId), inArray(autonomyGrants.status, ["active", "suspended"]))).returning({ id: autonomyGrants.id }));
  return Boolean(row);
}

export async function setOutcomePackEnabled(params: { tenantId: string; packId: OutcomePackId; enabled: boolean; actorId: string; reason: string }): Promise<void> {
  await withTenant(params.tenantId, async (db) => {
    await db.insert(tenantOutcomePackSettings).values({ tenantId: params.tenantId, packId: params.packId, enabled: params.enabled, reason: params.reason, updatedBy: params.actorId })
      .onConflictDoUpdate({ target: [tenantOutcomePackSettings.tenantId, tenantOutcomePackSettings.packId], set: { enabled: params.enabled, reason: params.reason, updatedBy: params.actorId, revision: sql`${tenantOutcomePackSettings.revision}+1`, updatedAt: new Date() } });
    if (!params.enabled) {
      await db.update(autonomyGrants).set({ status: "suspended", reason: `pack_disabled:${params.reason}`, updatedAt: new Date() }).where(and(eq(autonomyGrants.tenantId, params.tenantId), eq(autonomyGrants.packId, params.packId), eq(autonomyGrants.status, "active")));
      await db.update(outcomePackRuns).set({ status: "paused", blockedReason: `Pack disabled by operator: ${params.reason}`, updatedAt: new Date() }).where(and(eq(outcomePackRuns.tenantId, params.tenantId), eq(outcomePackRuns.packId, params.packId), eq(outcomePackRuns.status, "active")));
    }
  });
}

/** Suspend grants immediately when current evidence falls below an explicit gate. */
export async function demoteAutonomyOnRegression(tenantId: string, packId: OutcomePackId): Promise<number> {
  const readiness = await evaluateOutcomeAutonomyReadiness(tenantId, packId);
  if (readiness.eligible) return 0;
  const rows = await withTenant(tenantId, (db) => db.update(autonomyGrants).set({ status: "suspended", reason: `readiness_regression:${readiness.gates.filter((gate) => !gate.passed).map((gate) => gate.code).join(",")}`, updatedAt: new Date() }).where(and(eq(autonomyGrants.tenantId, tenantId), eq(autonomyGrants.packId, packId), eq(autonomyGrants.status, "active"))).returning({ id: autonomyGrants.id }));
  return rows.length;
}

export async function demoteAutonomyForWorkRegression(tenantId: string, workId: string): Promise<number> {
  const [run] = await withTenant(tenantId, (db) => db.select({ packId: outcomePackRuns.packId }).from(outcomePackRuns).where(and(
    eq(outcomePackRuns.tenantId, tenantId),
    eq(outcomePackRuns.workId, workId),
  )).limit(1));
  return run ? demoteAutonomyOnRegression(tenantId, run.packId as OutcomePackId) : 0;
}
