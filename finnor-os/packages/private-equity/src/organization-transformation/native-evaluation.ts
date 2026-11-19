import { z } from "zod";
import type { TenantContext } from "@finnor/shared-types";
import { listStoredWorkComputeTx, persistEconomicRecordTx } from "../economic-store";
import { validateEnterpriseExperiment } from "../enterprise-experiments";
import { validateEnterpriseInterventionModel } from "../enterprise-interventions";
import type { OperatingObservation, OrganizationReference } from "./contracts";
import { organizationDigest } from "./compiler";
import { qualifyOperatingBenefit } from "./evaluation";
import { organizationEvaluation, organizationEvaluationQuery } from "./native-contracts";
import { inspectOrganizationDependenciesTx } from "./dependencies";
import { inspectOrganizationObligationPopulationTx } from "./population";
import { readOrganizationEvidenceTx } from "./sources";
import { readOrganizationRandomizedEvidenceTx } from "./trials";
import { orgActor, orgAuthority, orgEvent, orgFail, orgLock, orgRow, orgTx } from "./store";

const operatingObservation = z.object({
  schema: z.literal("finnor.organization-operating-observation.v1"), requestId: z.string().uuid(),
  workId: z.string().uuid(), processId: z.string().min(1).max(160),
  arm: z.enum(["ORIGINAL", "TRANSFORMED"]), assignmentId: z.string().min(1).max(160),
  useKey: z.string().min(1).max(240).nullable(), elapsedSeconds: z.number().int().nonnegative(),
  humanSeconds: z.number().int().nonnegative().nullable(), serviceRetained: z.boolean().nullable(),
}).strict();

/** Read the complete request-linked source population, not a caller's favorable
 * subset. A changed/revoked latest version stays an error rather than vanishing. */
export async function evaluateOrganizationOperation(ctx: TenantContext, value: unknown) {
  const input = organizationEvaluation.parse(value), requestDigest = organizationDigest(input);
  return orgTx(ctx, async c => {
    await orgLock(ctx, c);
    await orgActor(ctx, c, true);
    const q = await orgRow(ctx, input.requestId, c, true);
    await orgAuthority(ctx, c, q.work_id, false);
    const prior = (await c.query(`SELECT body,body_digest FROM finnor_os.w5_events
      WHERE tenant_id=$1 AND request_id=$2 AND event_key=$3`,
      [ctx.tenantId, q.id, "evaluation:" + input.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.body_digest !== organizationDigest(prior.body) || prior.body.requestDigest !== requestDigest)
        orgFail("W5_EVALUATION_IDEMPOTENCY_CONFLICT");
      return { ...prior.body.result, economicRecordRef: prior.body.economicRecordRef, semanticReplay: true };
    }
    if (!q.program) orgFail("W5_CHECKED_PROGRAM_REQUIRED");
    const dependencies = await inspectOrganizationDependenciesTx(ctx, q, c);
    const population = await inspectOrganizationObligationPopulationTx(ctx, q, c);
    const randomized = await readOrganizationRandomizedEvidenceTx(ctx, q, c);
    const works = [...new Set([...population.manifest.workIds, ...(randomized.trial?.body.units.map(u => u.workId) ?? [])])];
    await c.query("LOCK TABLE finnor_os.evidence_sources,finnor_os.evidence_source_versions IN SHARE MODE");
    const sources = (await c.query(`SELECT s.id source_id,v.id,v.version_number,v.content_hash,
      octet_length(v.content) bytes FROM finnor_os.evidence_sources s
      JOIN LATERAL(SELECT id,version_number,content_hash,content FROM finnor_os.evidence_source_versions latest
        WHERE latest.tenant_id=s.tenant_id AND latest.source_id=s.id ORDER BY version_number DESC LIMIT 1) v ON true
      WHERE s.tenant_id=$1 AND s.source_type='organization_authenticated_record'
        AND s.metadata->>'workId'=ANY($2::text[]) AND EXISTS(
          SELECT 1 FROM finnor_os.evidence_source_versions old WHERE old.tenant_id=s.tenant_id AND old.source_id=s.id
          AND old.content::jsonb->>'schema'='finnor.organization-authenticated-source.v1'
          AND old.content::jsonb->>'kind' IN('OPERATING_OBSERVATION','COST','ASSISTANCE')
          AND old.content::jsonb->'body'->>'requestId'=$3)
      ORDER BY s.id LIMIT 1025 FOR SHARE OF s`, [ctx.tenantId, works, q.id])).rows;
    if (sources.length > 1024 || sources.some(s => s.bytes > 2 * 1024 * 1024) ||
        sources.reduce((total, s) => total + Number(s.bytes), 0) > 8 * 1024 * 1024)
      orgFail("W5_COMPLETE_EVALUATION_SOURCE_POPULATION_BOUND");
    const uses = (await c.query(`SELECT use_key,work_id,process_id,source_ref FROM finnor_os.w5_process_uses
      WHERE tenant_id=$1 AND request_id=$2 ORDER BY created_at,use_key LIMIT 1025`,
      [ctx.tenantId, q.id])).rows;
    if (uses.length > 1024) orgFail("W5_COMPLETE_EVALUATION_USE_POPULATION_BOUND");
    const observations: OperatingObservation[] = [], sourceRefs: OrganizationReference[] = [];
    const rejectedSources: Array<{ ref: OrganizationReference; reason: string }> = [];
    const declaredCosts: OrganizationReference[] = [], declaredAssistance: OrganizationReference[] = [];
    let serviceUnknown = false, allSourcesField = q.original.sourceClass === "FIELD";
    for (const source of sources) {
      const ref = { owner: "S1", id: source.id as string, version: String(source.version_number),
        contentDigest: source.content_hash as string };
      const resolved = await readOrganizationEvidenceTx(ctx, ref, c), record = resolved.record;
      if (record.schema !== "finnor.organization-authenticated-source.v1" || record.body?.requestId !== q.id)
        orgFail("W5_ORIGINAL_EVALUATION_SOURCE_BINDING_CHANGED");
      sourceRefs.push(ref);
      allSourcesField = allSourcesField && record.sourceClass === "FIELD";
      if (record.kind === "COST") { declaredCosts.push(ref); continue; }
      if (record.kind === "ASSISTANCE") { declaredAssistance.push(ref); continue; }
      if (record.body?.schema === "finnor.organization-prospective-outcome.v1") {
        const observation = randomized.outcomes.find(o => organizationDigest(o.observationRef) === organizationDigest(ref));
        if (!observation || record.authenticatedPrincipalId !== q.original.mandate.evaluatorPrincipalId ||
            randomized.rejectedOutcomes.some(o => o.assignmentId === observation.assignmentId)) {
          rejectedSources.push({ ref, reason: "ORIGINAL_REGISTERED_INDEPENDENT_OUTCOME_REQUIRED" }); continue;
        }
        if (observation.serviceRetained === null) serviceUnknown = true;
        observations.push({ id: ref.id, arm: observation.arm, elapsedSeconds: observation.elapsedSeconds,
          costMinor: null, humanSeconds: observation.humanSeconds, serviceRetained: observation.serviceRetained === true,
          evidenceRef: ref, principalId: observation.evaluatorPrincipalId, assignmentId: observation.assignmentId });
        continue;
      }
      if (randomized.trial) {
        rejectedSources.push({ ref, reason: "REGISTERED_FIXED_FINAL_LOOK_REQUIRES_ITS_EXACT_PROSPECTIVE_OUTCOME" }); continue;
      }
      const parsed = operatingObservation.safeParse(record.body);
      if (!parsed.success || record.authenticatedPrincipalId !== q.original.mandate.evaluatorPrincipalId) {
        rejectedSources.push({ ref, reason: "INDEPENDENT_EXACT_OPERATING_OBSERVATION_REQUIRED" }); continue;
      }
      const observation = parsed.data;
      if (!works.includes(observation.workId) || !q.original.organization.processes.some(p => p.id === observation.processId) ||
          observation.elapsedSeconds > q.original.mandate.trial.outcomeRangeSeconds ||
          observation.arm === "TRANSFORMED" && !uses.some(use => use.use_key === observation.useKey &&
            use.work_id === observation.workId && use.process_id === observation.processId) ||
          observation.arm === "ORIGINAL" && observation.useKey !== null) {
        rejectedSources.push({ ref, reason: "ACTUAL_ORIGINAL_WORK_AND_TRANSFORMED_USE_BINDING_REQUIRED" }); continue;
      }
      if (observation.serviceRetained === null) serviceUnknown = true;
      observations.push({ id: ref.id, arm: observation.arm, elapsedSeconds: observation.elapsedSeconds,
        costMinor: null, humanSeconds: observation.humanSeconds, serviceRetained: observation.serviceRetained === true,
        evidenceRef: ref, principalId: record.authenticatedPrincipalId, assignmentId: observation.assignmentId });
    }
    const compute = await listStoredWorkComputeTx({ auth: ctx }, { workId: q.work_id,
      episodeIds: [q.id], schema: "finnor.organization-native-compute.v1" }, c);
    const meters = (await c.query(`SELECT body,body_digest FROM finnor_os.w5_events
      WHERE tenant_id=$1 AND request_id=$2 AND kind='S7_PHASE_METER' ORDER BY created_at,event_key LIMIT 1025`,
      [ctx.tenantId, q.id])).rows;
    if (meters.length > 1024) orgFail("W5_COMPLETE_EVALUATION_COMPUTE_POPULATION_BOUND");
    for (const meter of meters) if (meter.body_digest !== organizationDigest(meter.body))
      orgFail("W5_ORIGINAL_COMPUTE_EVENT_PREIMAGE_CHANGED");
    const expectedCompute = new Set(meters.map(m => organizationDigest(m.body.economicRecordRef)));
    const actualCompute = new Set(compute.records.map(record => organizationDigest(record.ref)));
    const computeComplete = compute.complete && expectedCompute.size === actualCompute.size &&
      [...expectedCompute].every(ref => actualCompute.has(ref)) && actualCompute.size > 0;
    const assignmentSource = q.original.mandate.trial.assignmentRef.owner === "S1"
      ? await readOrganizationEvidenceTx(ctx, q.original.mandate.trial.assignmentRef, c) : null;
    const trialBody = assignmentSource?.record.body;
    const s2 = trialBody?.schema === "finnor.organization-original-trial-context.v1" && trialBody.protocol
      ? await validateEnterpriseExperiment({ auth: ctx }, trialBody.protocol) : null;
    const s3 = trialBody?.schema === "finnor.organization-original-trial-context.v1" && trialBody.interventionModelRef
      ? await validateEnterpriseInterventionModel({ auth: ctx }, trialBody.interventionModelRef) : null;
    // Legacy S2/S3 context validation remains unadmitted. The additive W5
    // protocol has its own native assignment proof and fixed-final-look HT
    // estimator; the legacy conditional-arm mean is not its causal bound.
    const bounded = qualifyOperatingBenefit(q.original, { observations,
      assistance: declaredAssistance.map(ref => ref.id), completeCosts: false, assignmentVerified: randomized.assignmentVerified,
      sourceClass: allSourcesField ? "FIELD" : "CONTROLLED", migrationCostMinor: null, migrationHumanSeconds: null });
    const contextGaps = [
      ...(rejectedSources.length ? ["UNREGISTERED_OR_INVALID_OBSERVATION_SOURCES_PRESENT"] : []),
      ...(dependencies.status !== "CURRENT" ? ["ORIGINAL_EXECUTION_DEPENDENCIES_INVALIDATED"] : []),
      ...(population.status !== "READY" ? ["COMPLETE_CANONICAL_LIABILITIES_NOT_BRIDGED"] : []),
    ];
    const causal = randomized.effect && { ...randomized.effect,
      status: contextGaps.length ? "UNIDENTIFIED" as const : randomized.effect.status,
      gaps: [...new Set([...randomized.effect.gaps, ...contextGaps])],
      registeredMaterialMarginEstablished: !contextGaps.length && randomized.effect.registeredMaterialMarginEstablished };
    const causalIdentified = causal?.status === "REGISTERED_RANDOMIZED_TASK_ESTIMATE";
    const boundedGaps = randomized.trial ? bounded.gaps.filter(g => g !== "REGISTERED_MATERIAL_MARGIN_NOT_ESTABLISHED") : bounded.gaps;
    const gaps = [...new Set([...boundedGaps, ...randomized.gaps,
      ...(!randomized.assignmentVerified ? ["S2_NATIVE_ASSIGNMENT_NOT_VERIFIED"] : []),
      ...(!causalIdentified ? ["S3_INDEPENDENT_CAUSAL_EFFECT_NOT_IDENTIFIED"] : []),
      ...(causalIdentified && !causal!.registeredMaterialMarginEstablished ? ["REGISTERED_MATERIAL_MARGIN_NOT_ESTABLISHED"] : []),
      "BILLING_AND_PRICEBOOK_UNKNOWN",
      "HUMAN_SUPERVISION_AND_MIGRATION_TIME_UNKNOWN", "ASSISTANCE_COVERAGE_UNKNOWN",
      ...(!computeComplete ? ["S7_COMPLETE_NATIVE_COMPUTE_COVERAGE_UNAVAILABLE"] : []),
      ...(compute.records.some(record => record.payload.status === "UNKNOWN") ? ["INTERRUPTED_COMPUTE_COST_UNKNOWN"] : []),
      ...(serviceUnknown ? ["CRITICAL_SERVICE_OUTCOME_UNKNOWN"] : []),
      ...(rejectedSources.length ? ["INVALID_OR_NONINDEPENDENT_OBSERVATION_SOURCES_PRESENT"] : []),
      ...(dependencies.status !== "CURRENT" ? ["ORIGINAL_EXECUTION_DEPENDENCIES_INVALIDATED"] : []),
      ...(population.status !== "READY" ? ["COMPLETE_CANONICAL_LIABILITIES_NOT_BRIDGED"] : []),
      ...(!uses.length ? ["ACTUAL_TRANSFORMED_PROCESS_USE_UNOBSERVED"] : [])])];
    const result = {
      ...bounded, schema: "finnor.organization-native-operating-evaluation.v1", requestId: q.id,
      originalCount: causal?.originalCount ?? bounded.originalCount, transformedCount: causal?.transformedCount ?? bounded.transformedCount,
      improvementSeconds: randomized.trial ? causal?.estimateSeconds ?? null : null,
      lowerConfidenceBoundSeconds: randomized.trial ? causal?.lowerConfidenceBoundSeconds ?? null : null,
      bound: randomized.trial ? "BOUNDED_HT_HOEFFDING_FIXED_FINAL_LOOK" : "DESCRIPTIVE_UNADMITTED_NOT_A_CAUSAL_BOUND",
      originalWorkId: q.work_id, originalWorkInputId: q.work_input_id, originalDeadline: q.original.mandate.originalDeadline,
      originalBudgetRef: q.budget.ref, programRevision: q.revision, status: "UNIDENTIFIED", gaps,
      autonomous: false, autonomy: { status: "UNKNOWN", declaredAssistanceRefs: declaredAssistance, completeCoverage: false },
      sourceClass: allSourcesField ? "FIELD" : "CONTROLLED", sourceRefs, rejectedSources,
      observations, nativeUseKeys: uses.map(use => use.use_key), softwareAvailable: true,
      authenticatedSelfDecisionsObserved: q.program.claims.actualAdoption,
      actualNativeUseObserved: uses.length > 0, humanFieldAdoptionEstablished: false,
      causalContext: { originalAssignmentRef: q.original.mandate.trial.assignmentRef,
        s2: randomized.trial ? { status: randomized.assignmentVerified ? "CHECKED_NATIVE_ASSIGNMENT" : "UNVERIFIED",
          trialRef: randomized.trial.ref, originalRegisteredUnits: randomized.trial.body.units.length,
          assignments: randomized.assignments, nativeProvenanceGaps: randomized.nativeProvenanceGaps,
          scientificAdmission: false, executionAuthorityGranted: false } : s2 ? { status: s2.status, reason: s2.reason, checkedScope: s2.checkedScope,
          downstreamAdmission: s2.downstreamAdmission } : { status: "UNVERIFIED_TRIAL_INTENT_NOT_ASSIGNMENT" },
        s3: causal ?? (s3 ? { status: s3.status, reason: s3.reason, checkedScope: s3.checkedScope, modelRef: s3.modelRef }
          : { status: "INDEPENDENT_CAUSAL_COUNTERFACTUAL_UNIDENTIFIED" }),
        assignmentVerified: randomized.assignmentVerified, causalTaskEstimateIdentified: causalIdentified,
        registeredTaskElapsedMarginEstablished: causal?.registeredMaterialMarginEstablished === true &&
          !rejectedSources.length && dependencies.status === "CURRENT" && population.status === "READY",
        causalBenefitEstablished: false, taskElapsedEstimateIsFullCostOrWealthBenefit: false },
      fullCost: { status: "UNKNOWN", monetaryCostMinor: null, currency: null, migrationCostMinor: null,
        humanSupervisionSeconds: null, declaredCostRefs: declaredCosts, sourceDeclarationsAreInvoices: false,
        computeComplete, computeRecords: compute.records.map(record => ({ ref: record.ref, payload: record.payload })),
        computeGaps: ["DATABASE_CPU", "BILLING", "HUMAN_SUPERVISION", "FULL_MIGRATION_AND_SERVICE_ACCOUNTING"],
        savedSalariedTimeCashCreditMinor: 0 },
      originalPopulationDigest: population.populationDigest, originalLiabilitiesRetained: true,
      recommendedDisposition: observations.some(o => !o.serviceRetained) ? "REQUEST_LAWFUL_ROLLBACK" : "RETAIN_AND_REVISE_EVIDENCE",
      lawfulNextSteps: ["RETAIN", "REVISE", "REQUEST_LAWFUL_ROLLBACK"],
      executionAuthorityGranted: false, resourcesReleased: false, fieldBenefitEstablished: false,
      qualification: "NATIVE_SOURCE_ASSIGNMENT_AND_BOUNDED_TASK_ESTIMATE_NOT_SCIENTIFIC_FIELD_OR_FULL_COST_QUALIFICATION",
    };
    const economic = await persistEconomicRecordTx({ auth: ctx }, { kind: "ASSESSMENT", payload: result,
      rightsRef: q.budget.resources[0]!.rightsRef, idempotencyKey: "w5:" + q.id + ":evaluation:" + input.idempotencyKey,
      validAt: new Date().toISOString(), horizon: "H0", uncertainty: causalIdentified
        ? "REGISTERED_TASK_ESTIMATE_FULL_COST_UNKNOWN" : "CAUSAL_ASSIGNMENT_AND_FULL_COST_UNIDENTIFIED",
      dependencies: [q.budget.ref, ...sourceRefs, ...compute.records.map(record => record.ref)] }, c);
    await orgEvent(ctx, q, "OPERATING_EVALUATION", "evaluation:" + input.idempotencyKey,
      { requestDigest, result, economicRecordRef: economic.record.ref }, c);
    return { ...result, economicRecordRef: economic.record.ref, semanticReplay: false };
  });
}

export async function readOrganizationEvaluation(ctx: TenantContext, value: unknown) {
  const input = organizationEvaluationQuery.parse(value);
  return orgTx(ctx, async c => {
    await orgActor(ctx, c, true);
    const q = await orgRow(ctx, input.requestId, c);
    await orgAuthority(ctx, c, q.work_id, false);
    const latest = (await c.query(`SELECT body,body_digest FROM finnor_os.w5_events
      WHERE tenant_id=$1 AND request_id=$2 AND kind='OPERATING_EVALUATION'
      ORDER BY created_at DESC,event_key DESC LIMIT 1`, [ctx.tenantId, q.id])).rows[0];
    if (latest && latest.body_digest !== organizationDigest(latest.body)) orgFail("W5_EVALUATION_PREIMAGE_CHANGED");
    return { requestId: q.id, evaluation: latest?.body.result ?? null, economicRecordRef: latest?.body.economicRecordRef ?? null,
      currentness: "HISTORICAL_ASSESSMENT_NOT_AUTOMATICALLY_REQUALIFIED", executionAuthorityGranted: false,
      fieldBenefitEstablished: false };
  });
}
