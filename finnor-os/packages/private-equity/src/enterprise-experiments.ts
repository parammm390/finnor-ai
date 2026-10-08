import type { ControlObservationInstrument, ControlProblem, ExperimentDesignBundle, ExperimentProtocol, ExperimentRealization, InterventionModel } from "@finnor/shared-types";
import { assertExperimentProtocol, assertInterventionModel, controlObservationToken, designExperiments, epistemicHash, immutableControl, parseExperimentDesignRequest, prepareExperimentCollectionHandoff, prepareS2ExperienceEvent, projectExperimentRealization, resumeExperimentRealization, validateControlObservationInstruments } from "@finnor/epistemic-runtime";
import { loadEnterpriseBeliefView, validateBeliefViewPin } from "./enterprise-beliefs";
import { PeDomainError, type PeMutationContext, type PeWorldRootRef } from "./types";
import {enqueueNativeReferences,enqueueNativePreparedEvents,nativeReference} from './native-experience-transport';

const protocolReference=(protocol:ExperimentProtocol)=>{const {id,contentDigest,experience,...content}=protocol;return {owner:'S2',id,version:protocol.version,contentDigest,content};};
async function deliverPrepared(ctx:PeMutationContext,protocol:ExperimentProtocol,events:readonly any[]){await enqueueNativeReferences(ctx,[protocolReference(protocol)],[protocol.beliefBinding.rightsRef]);await enqueueNativePreparedEvents(ctx,'S2',events);}

const principal = (ctx: PeMutationContext) => ctx.auth.employeeId ?? ctx.auth.userId;
export async function designEnterpriseExperiments(ctx: PeMutationContext, input: { root: PeWorldRootRef; request: unknown }): Promise<ExperimentDesignBundle> {
  const request = parseExperimentDesignRequest(input.request);
  const view = await loadEnterpriseBeliefView(ctx, { root: input.root });
  const bundle = designExperiments({ beliefView: view, request });
  const current = await validateBeliefViewPin(ctx, view.pin);
  if (current.status !== "CURRENT") throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Permitted S2 context is unavailable");
  const requestDigest=epistemicHash(request);
  await enqueueNativeReferences(ctx,[nativeReference('S2',requestDigest,request,'s2-design-request-v1'),nativeReference('S2',`request:${requestDigest}`,request,'s2-design-request-v1'),nativeReference('S2',bundle.compute.id,bundle.compute,'model-compute-v1'),...bundle.designs.flatMap(d=>d.protocol?[protocolReference(d.protocol)]:[])],[view.rights.ref]);
  await enqueueNativePreparedEvents(ctx,'S2',bundle.experience);
  return bundle;
}
export async function validateEnterpriseExperiment(ctx: PeMutationContext, value: unknown): Promise<{
  status: "CURRENT" | "INVALIDATED" | "UNAVAILABLE"; reason: string; executionAuthorityGranted: false;
  checkedScope: "S1_DEPENDENCIES_AND_LOCAL_PROTOCOL_ONLY"; downstreamAdmission: "BLOCKED_EXTERNAL";
  unverifiedDependencies: ExperimentProtocol["dependencies"]; experience: ReturnType<typeof prepareS2ExperienceEvent> | null;
}> {
  assertExperimentProtocol(value); const protocol = value;
  const base = { executionAuthorityGranted: false as const, checkedScope: "S1_DEPENDENCIES_AND_LOCAL_PROTOCOL_ONLY" as const, downstreamAdmission: "BLOCKED_EXTERNAL" as const };
  if (protocol.tenantId !== ctx.auth.tenantId || protocol.principalId !== principal(ctx)) return { ...base, status: "UNAVAILABLE", reason: "PERMITTED_CONTEXT_UNAVAILABLE", unverifiedDependencies: [], experience: null };
  const now = new Date().toISOString();
  const invalid = async(reason: string) => {const result={ ...base, status: "INVALIDATED" as const, reason, unverifiedDependencies: protocol.dependencies,
    experience: prepareS2ExperienceEvent({ schema: "finnor.s2.experience.v1", episodeId: protocol.episodeId, semanticOwner: "S2", type: "INVALIDATION", tenantId: protocol.tenantId, principalId: protocol.principalId,
      rightsRef: protocol.beliefBinding.rightsRef, preparedParentRefs: [protocol.experience.event.eventId], causalParents: [], revisionRef: protocol.id, contentDigest: protocol.contentDigest, validAt: now, knowledgeAt: now,
      dependencyRefs: [protocol.beliefBinding.dependencyDigest, protocol.requestDigest], freshnessRef: protocol.beliefBinding.dependencyDigest, uncertainty: "MODEL_CONDITIONAL_NO_FIELD_CALIBRATION", horizon: "H1",
      provenanceRefs: protocol.dependencies, modelComputeRef: null, detail: { reason, checkedScope: base.checkedScope } }) };await deliverPrepared(ctx,protocol,[result.experience]);return result;};
  if (Date.parse(protocol.validUntil) <= Date.parse(now) || Date.parse(protocol.candidate.timing.endAt) <= Date.parse(now)) return invalid("PROTOCOL_EXPIRED");
  if (Date.parse(protocol.knowledgeAt) > Date.parse(now) || Date.parse(protocol.beliefBinding.pin.knowledgeAt) > Date.parse(protocol.knowledgeAt)
    || Date.parse(now) - Date.parse(protocol.beliefBinding.pin.knowledgeAt) > protocol.beliefBinding.maxAgeMs) return invalid("BELIEF_FRESHNESS_OR_KNOWLEDGE_INVALID");
  const pin = await validateBeliefViewPin(ctx, protocol.beliefBinding.pin);
  if (pin.status !== "CURRENT") return invalid(pin.reason);
  return { ...base, status: "CURRENT", reason: "CURRENT_PERMITTED_S1_ONLY_NOT_MANDATE_MODEL_ALLOCATION_OR_EXECUTION_ADMISSION", unverifiedDependencies: protocol.dependencies, experience: null };
}
export async function projectEnterpriseExperiment(ctx: PeMutationContext, input: { protocol: unknown; events: readonly unknown[]; prior?: ExperimentRealization }): Promise<{ realization: ExperimentRealization; handoff: ReturnType<typeof prepareExperimentCollectionHandoff>; validation: Awaited<ReturnType<typeof validateEnterpriseExperiment>> }> {
  const validation = await validateEnterpriseExperiment(ctx, input.protocol);
  if (validation.status !== "CURRENT") throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Permitted S2 context is unavailable");
  assertExperimentProtocol(input.protocol); const actor = { tenantId: ctx.auth.tenantId, principalId: principal(ctx) };
  const realization = input.prior ? resumeExperimentRealization(input.protocol, input.prior, input.events, actor) : projectExperimentRealization(input.protocol, input.events, actor);
  const final = await validateEnterpriseExperiment(ctx, input.protocol);
  if (final.status !== "CURRENT") throw new PeDomainError("PE_ENTITY_NOT_FOUND", "Permitted S2 context is unavailable");
  const {id,contentDigest,...body}=realization;
  await enqueueNativeReferences(ctx,[{owner:'S2',id,version:'s2-realization-v1',contentDigest,content:body},...realization.history.map(e=>nativeReference('S2',e.id,e,'s2-received-telemetry-v1'))],[input.protocol.beliefBinding.rightsRef]);
  await deliverPrepared(ctx,input.protocol,realization.experience);
  return { realization, handoff: prepareExperimentCollectionHandoff(input.protocol, realization, actor), validation: final };
}

/** S2-owned temporal coarsening of one actual permitted S1 measurement.
 * No IID law, calibrated sensor error, effect settlement or protected receipt.
 * A source revision still requires a linked S4 replan before branch use. */
export async function projectEnterpriseControlObservation(ctx: PeMutationContext, input: {
  instrument: ControlObservationInstrument; problem: ControlProblem; model: InterventionModel;
  periodStart: string; periodEnd: string; availablePeriod: number;
}) {
  const {instrument,model}=input, unavailable=()=>new PeDomainError("PE_ENTITY_NOT_FOUND","Permitted temporal S2 measurement is unavailable");
  assertInterventionModel(model); validateControlObservationInstruments([instrument],input.problem,model);
  if(model.tenantId!==ctx.auth.tenantId||model.principalId!==principal(ctx)||!Number.isFinite(Date.parse(input.periodStart))||!Number.isFinite(Date.parse(input.periodEnd))||Date.parse(input.periodStart)>=Date.parse(input.periodEnd)||Date.parse(input.periodEnd)>Date.now())throw unavailable();
  const variable=model.request.stateVariables.find(v=>v.id===instrument.variableId)!;
  const view=await loadEnterpriseBeliefView(ctx,{root:variable.root as PeWorldRootRef});
  if(view.coverage.canonicalStatus!=="COMPLETE"||view.coverage.truncated)throw unavailable();
  const series=view.claims.find(c=>c.ownerRef.entityType==='pe_metric_series'&&c.ownerRef.id===variable.seriesId);
  const selected=view.claims.filter(c=>c.kind==='OBSERVED_RECORD'&&c.ownerRef.entityType==='pe_metric_observation'&&c.value.metricSeriesId===variable.seriesId&&Date.parse(String(c.value.periodStart))===Date.parse(input.periodStart)&&Date.parse(String(c.value.periodEnd))===Date.parse(input.periodEnd));
  const claim=selected[0];
  if(!series||series.value.unit!==variable.unit||series.value.subjectId!==variable.root.entityId||series.value.subjectType!==variable.root.entityType||selected.length!==1||!claim||claim.value.valueType!=='number'||claim.value.valueNumeric===null||!Number.isFinite(Number(claim.value.valueNumeric))||Math.abs(Number(claim.value.valueNumeric))>1e9||Date.parse(claim.knowledgeAt)>Date.parse(view.knowledgeAt)||claim.uncertainty.reasons.includes('PROVENANCE_DEPENDENCY_UNAVAILABLE')||view.contradictions.some(c=>c.claimRefs.includes(claim.ownerRef.revisionId)))throw unavailable();
  const token=controlObservationToken(instrument,{id:'measured',mechanismId:'measured',supported:true,history:[{states:{[variable.id]:Number(claim.value.valueNumeric)},exposures:{}}]});
  if(token===null||(await validateBeliefViewPin(ctx,view.pin)).status!=="CURRENT")throw unavailable();
  const body={schema:'finnor.s2.temporal-control-realization.v1' as const,tenantId:ctx.auth.tenantId,principalId:principal(ctx),instrumentRef:instrument.sourceRef,instrumentId:instrument.id,modelMetadataRef:model.ref,knowledgeAt:claim.knowledgeAt,periodStart:input.periodStart,periodEnd:input.periodEnd,availablePeriod:input.availablePeriod,token,source:{root:variable.root,seriesRef:series.ownerRef,claimRef:claim.ownerRef,dependencyDigest:view.dependencyDigest,rightsRef:view.rights.ref},qualification:'PERMITTED_S1_MEASUREMENT_SUPPLIED_COARSENING_UNVERIFIED_SENSOR_ERROR' as const,protectedReceipt:null};
  const digest=epistemicHash(body),ref={owner:'S2',id:`temporal-realization:${digest}`,version:'s2-temporal-control-v1',contentDigest:digest};
  await enqueueNativeReferences(ctx,[{...ref,content:body}],[view.rights.ref]);return immutableControl({...body,ref});
}
