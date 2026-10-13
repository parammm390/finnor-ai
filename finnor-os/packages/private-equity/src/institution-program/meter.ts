import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PeMutationContext } from "../types";
import { persistEconomicRecord, listStoredWorkCompute,listStoredWorkPreparationCompute } from "../economic-store";
import { sha, tx, principal } from "../evidence-execution/store";
import {chargeInstitutionDemand} from '../allocation-store';

export type InstitutionPhysicalObservation={kind:'SOURCE'|'CHECKER';startedAt:string;elapsedMs:number;
  outcome:string;includedWithin:'COMPILE';[key:string]:unknown};
type Scope = { sourceAttempt: (grantId: string) => Promise<void>;
  physicalObservations:InstitutionPhysicalObservation[];
  checkerAttempt: () => Promise<void> };
const scope = new AsyncLocalStorage<Scope>();
const physicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const computePhases = ["COMPILE", "PUBLICATION", "UPDATE_RECOGNITION", "PREPARATION", "RECOVERY"] as const;
type ParentRef={owner:string;id:string;version:string;contentDigest:string};
export const withInstitutionMeter = <T>(input: Scope, run: () => Promise<T>) => scope.run(input, run);
export const recordInstitutionSourceAttempt = async (grantId: string) => { await scope.getStore()?.sourceAttempt(grantId); };
export const recordInstitutionCheckerAttempt = async () => { await scope.getStore()?.checkerAttempt(); };
export function recordInstitutionPhysicalObservation(observation:InstitutionPhysicalObservation){
  const active=scope.getStore();
  if(active){
    if(active.physicalObservations.length>=1024)throw Error('X1_PHYSICAL_OBSERVATION_BOUND');
    active.physicalObservations.push(observation);
  }else process.stderr.write(JSON.stringify({event:'X1_UNALLOCATED_DEVELOPMENT_PHYSICAL_OBSERVATION',
    observation:{...observation,grantId:undefined},privateParentAuthorityUnavailable:true})+'\n');
}

/** Immutable S7 compute attribution uses physical delivery identities. Prices,
 * aggregate peak memory and human supervision remain unknown when unobserved. */
export async function persistInstitutionCompute(ctx: PeMutationContext, input: {
  requestId: string; workId: string; episodeId: string; jobId: string; deliveryAttemptId: string;
  parentReservation: { owner: string; id: string; version: string; contentDigest: string } | null;
  rightsRevision: string; startedAt: string; elapsedMs: number; status: string;
  phase: typeof computePhases[number]; observedAcquisitionAttempts: number; observedCheckerAttempts: number;
  physicalObservations?:InstitutionPhysicalObservation[];
}) {
  if (!physicalUuid.test(input.deliveryAttemptId) || !physicalUuid.test(input.jobId)
      || !physicalUuid.test(input.requestId) || !computePhases.includes(input.phase)
      || !Number.isFinite(input.elapsedMs) || input.elapsedMs < 0)
    throw Error("X1_ACTUAL_PHYSICAL_COMPUTE_MEASUREMENT_REQUIRED");
  return persistEconomicRecord(ctx, { kind: "COMPUTE", rightsRef: `authority:${ctx.auth.tenantId}:${input.rightsRevision}`,
    idempotencyKey: `x1-compute:${input.deliveryAttemptId}:${input.phase}`,
    semanticRequestDigest: sha(["x1-physical-compute-v1", input.requestId, input.deliveryAttemptId, input.phase]),
    validAt: input.startedAt, horizon: "H0", uncertainty: "Observed physical work; money, aggregate memory and human cost incomplete",
    dependencies: input.parentReservation ? [input.parentReservation] : [],
    payload: { schema: "finnor.x1.native-compute.v1", ...input,
      process: { pid: process.pid, node: process.version, platform: process.platform, arch: process.arch,
        rssBytesAtObservation: process.memoryUsage().rss },
      money: null, moneyBasis: "ACTUAL_PRICE_UNAVAILABLE", humanSeconds: null,
      aggregatePeakMemoryBytes: null, modelCalls: [], costAllocation: "ONCE_PER_PHYSICAL_DELIVERY_UNDER_ORIGINAL_WORK_PARENT",
      meterWriterLatency:'UNOBSERVED_REQUIRES_EXTERNAL_LIFECYCLE_COLLECTOR',
      businessWorkCredit: 0, qualification: "COMPUTE_ATTRIBUTION_NOT_FINANCIAL_VALUE_OR_CAPACITY_PROOF" } });
}

export async function readInstitutionComputeCosts(ctx: PeMutationContext, workId: string, compilerEpisodeId: string) {
  const native = await tx(ctx, async c => (await c.query<{ id: string }>(`SELECT id::text
    FROM finnor_os.p1_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3`,
  [ctx.auth.tenantId, principal(ctx), workId])).rows[0], true);
  const episodeIds = [...new Set([compilerEpisodeId, ...(native ? [native.id] : [])])];
  const history = await listStoredWorkCompute(ctx, { workId, episodeIds, schema: "finnor.x1.native-compute.v1" });
  const apiHistory=await listStoredWorkCompute(ctx,{workId,episodeIds:[compilerEpisodeId],schema:'finnor.x1.api-compute.v1'});
  const preparationHistory=await listStoredWorkPreparationCompute(ctx,workId);
  const originalParent=await tx(ctx,async c=>(await c.query<{parent_reservation:unknown}>(`SELECT parent_reservation
    FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND id=$4`,
    [ctx.auth.tenantId,principal(ctx),workId,compilerEpisodeId])).rows[0]?.parent_reservation??null,true);
  const preparationAllocations=await tx(ctx,async c=>(await c.query<{record_id:string;payload:any}>(`
    SELECT record_id,body->'payload' payload FROM finnor_os.s7_economic_records
    WHERE tenant_id=$1 AND principal_id=$2 AND kind='COST'
      AND body->'payload'->>'schema'='finnor.x1.preparation-allocation.v1'
      AND body->'payload'->>'workId'=$3 AND body->'payload'->>'episodeId'=$4
    ORDER BY knowledge_at,record_id LIMIT 1025`,[ctx.auth.tenantId,principal(ctx),workId,compilerEpisodeId])).rows,true);
  const physicalCharges=await tx(ctx,async c=>(await c.query<{body:any}>(`SELECT body FROM finnor_os.s5_governed_resource_charges
    WHERE tenant_id=$1 AND principal_id=$2 AND reservation_id=$3 AND phase='PREPARATION' LIMIT 1025`,
    [ctx.auth.tenantId,principal(ctx),(originalParent as ParentRef|null)?.id??''])).rows.map(row=>row.body),true);
  const seen = new Set<string>(), gaps: string[] = [], phases = new Map<string, { deliveries: number; attributedElapsedMs: number }>();
  const refs: Array<{ owner: "S7"; id: string; version: string; contentDigest: string }> = [];
  let attributedElapsedMs = 0, sampledProcessRssBytes = 0, rssSamples = 0;
  const physicalObservations:InstitutionPhysicalObservation[]=[];
  for (const record of history.records) {
    const p = record.payload;
    refs.push(record.ref);
    if (record.kind !== "COMPUTE" || p.workId !== workId || !episodeIds.includes(String(p.episodeId))
        || !physicalUuid.test(String(p.deliveryAttemptId)) || !physicalUuid.test(String(p.jobId))
        || !physicalUuid.test(String(p.requestId)) || typeof p.phase !== "string"
        || !(computePhases as readonly string[]).includes(p.phase)
        || typeof p.elapsedMs !== "number" || !Number.isFinite(p.elapsedMs) || p.elapsedMs < 0) {
      gaps.push(`X1_COMPUTE_MEASUREMENT_INVALID:${record.ref.id}`); continue;
    }
    const identity = JSON.stringify([p.deliveryAttemptId, p.phase]);
    if (seen.has(identity)) { gaps.push(`X1_COMPUTE_DELIVERY_DUPLICATE:${record.ref.id}`); continue; }
    seen.add(identity); attributedElapsedMs += p.elapsedMs;
    if(p.physicalObservations!==undefined){
      if(p.phase!=='COMPILE'||!Array.isArray(p.physicalObservations)||p.physicalObservations.length>1024)
        gaps.push('X1_PHYSICAL_COMPONENT_OBSERVATIONS_INVALID:'+record.ref.id);
      else for(const observation of p.physicalObservations){
        if(!observation||!['SOURCE','CHECKER'].includes(observation.kind)
          ||observation.includedWithin!=='COMPILE'||typeof observation.elapsedMs!=='number'
          ||!Number.isFinite(observation.elapsedMs)||observation.elapsedMs<0)
          gaps.push('X1_PHYSICAL_COMPONENT_OBSERVATION_INVALID:'+record.ref.id);
        else physicalObservations.push(observation);
      }
    }
    const phase = phases.get(p.phase) ?? { deliveries: 0, attributedElapsedMs: 0 };
    phase.deliveries++; phase.attributedElapsedMs += p.elapsedMs; phases.set(p.phase, phase);
    const rss = (p.process as { rssBytesAtObservation?: unknown } | undefined)?.rssBytesAtObservation;
    if (typeof rss === "number" && Number.isSafeInteger(rss) && rss >= 0) {
      rssSamples++;
      sampledProcessRssBytes = Math.max(sampledProcessRssBytes, rss);
    }
  }
  const meterGaps = await tx(ctx, async c => (await c.query<{ kind: string; body: unknown }>(`
    SELECT e.kind,e.body FROM finnor_os.x1_compiler_events e
      JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=e.tenant_id AND r.id=e.request_id
      WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 AND r.episode_id=$4
        AND e.kind LIKE '%METER_GAP'
    UNION ALL
    SELECT e.kind,e.body FROM finnor_os.p1_events e
      JOIN finnor_os.p1_requests r ON r.tenant_id=e.tenant_id AND r.id=e.request_id
      WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 AND r.episode_id::text=ANY($5::text[])
        AND e.kind LIKE '%METER_GAP' LIMIT 1025`,
  [ctx.auth.tenantId, principal(ctx), workId, compilerEpisodeId, episodeIds])).rows, true);
  if (!history.complete) gaps.push(history.reason!);
  const apiIdentities=new Set<string>();let apiElapsedMs=0;
  for(const record of apiHistory.records){
    const p=record.payload;
    refs.push(record.ref);
    if(p.workId!==workId||p.episodeId!==compilerEpisodeId||!physicalUuid.test(String(p.invocationId))
      ||typeof p.elapsedMs!=='number'||!Number.isFinite(p.elapsedMs)||p.elapsedMs<0
      ||typeof p.operation!=='string'||!Number.isInteger(p.statusCode)||apiIdentities.has(String(p.invocationId))){
      gaps.push('X1_API_MEASUREMENT_INVALID:'+record.ref.id);continue;
    }
    apiIdentities.add(String(p.invocationId));apiElapsedMs+=p.elapsedMs;
  }
  if(!apiHistory.complete)gaps.push(apiHistory.reason!);
  if(apiIdentities.size)phases.set('AUTHENTICATED_API',{deliveries:apiIdentities.size,attributedElapsedMs:apiElapsedMs});
  const preparationIdentities=new Set<string>();let preparationElapsedMs=0;
  for(const record of preparationHistory.records){
    const p=record.payload;refs.push(record.ref);
    if(p.workId!==workId||p.episodeId!==null||p.parentReservation!==null
      ||p.phase!=='AUTHENTICATED_WORK_PREPARATION'||!physicalUuid.test(String(p.invocationId))
      ||typeof p.elapsedMs!=='number'||!Number.isFinite(p.elapsedMs)||p.elapsedMs<0
      ||typeof p.operation!=='string'||!Number.isInteger(p.statusCode)
      ||preparationIdentities.has(String(p.invocationId))){
      gaps.push('X1_WORK_PREPARATION_MEASUREMENT_INVALID:'+record.ref.id);continue;
    }
    preparationIdentities.add(String(p.invocationId));preparationElapsedMs+=p.elapsedMs;
  }
  if(!preparationHistory.complete)gaps.push(preparationHistory.reason!);
  const allocated=new Set<string>();
  for(const record of preparationHistory.records){
    const entries=preparationAllocations.filter(a=>a.payload.originalRecordRef?.id===record.ref.id);
    const entry=entries[0]?.payload;
    const actual=entry&&physicalCharges.filter(charge=>charge.physicalInvocationId===record.payload.invocationId
      &&charge.ref?.id===entry.resourceCharge?.id&&charge.units===1&&sha(charge.reservationRef)===sha(originalParent));
    if(entries.length!==1||!entry||sha(entry.parentReservation)!==sha(originalParent)
      ||entry.originalPayloadDigest!==sha(record.payload)||actual?.length!==1)
      gaps.push('X1_PREPARATION_ORIGINAL_PARENT_ALLOCATION_MISSING:'+record.ref.id);
    else allocated.add(record.ref.id);
  }
  if(preparationIdentities.size)phases.set('AUTHENTICATED_WORK_PREPARATION',{
    deliveries:preparationIdentities.size,attributedElapsedMs:preparationElapsedMs});
  if (meterGaps.length > 1024) gaps.push("X1_COMPUTE_METER_GAP_HISTORY_BOUND");
  const lifecycle=await listStoredWorkCompute(ctx,{workId,episodeIds:[compilerEpisodeId],schema:'finnor.x1.lifecycle-compute.v1'});
  const lifecycleCharges=await tx(ctx,async c=>(await c.query<{body:any}>(`SELECT body FROM finnor_os.s5_governed_resource_charges
    WHERE tenant_id=$1 AND principal_id=$2 AND reservation_id=$3 AND phase='LIFECYCLE' LIMIT 1025`,
    [ctx.auth.tenantId,principal(ctx),(originalParent as ParentRef|null)?.id??''])).rows.map(r=>r.body),true);
  const lifecycleIds=new Set<string>();
  for(const record of lifecycle.records){
    refs.push(record.ref);const p=record.payload;
    if(p.workId!==workId||p.episodeId!==compilerEpisodeId||sha(p.parentReservation)!==sha(originalParent)
      ||!physicalUuid.test(String(p.invocationId))||lifecycleIds.has(String(p.invocationId))
      ||typeof p.elapsedMs!=='number'||!Number.isFinite(p.elapsedMs)||p.elapsedMs<0
      ||lifecycleCharges.filter(charge=>charge.physicalInvocationId===p.invocationId
        &&charge.ref?.id===(p.resourceCharge as {ref?:{id?:string}}|undefined)?.ref?.id
        &&charge.units===1&&sha(charge.reservationRef)===sha(originalParent)).length!==1)
      gaps.push('X1_LIFECYCLE_MEASUREMENT_INVALID:'+record.ref.id);
    else lifecycleIds.add(String(p.invocationId));
  }
  if(!lifecycle.complete)gaps.push(lifecycle.reason!);
  const sources=physicalObservations.filter(o=>o.kind==='SOURCE'),checkers=physicalObservations.filter(o=>o.kind==='CHECKER');
  const bytes=(key:string)=>sources.reduce((total,o)=>total+(typeof o[key]==='number'&&Number.isSafeInteger(o[key])&&o[key]>=0?o[key]:0),0);
  return { basis: "EXISTING_S7_IMMUTABLE_PHYSICAL_DELIVERY_RECORDS", recordRefs: refs,
    registeredDeliveryPhases: seen.size, apiInvocations:apiIdentities.size,
    attributedElapsedMs:attributedElapsedMs+apiElapsedMs+preparationElapsedMs, phases: Object.fromEntries(phases),
    preparationAllocation:{basis:'ALL_OWNED_WORK_PREPARATION_ONCE_TO_ITS_ORIGINAL_WORK_EPISODE',
      originalEpisodeId:compilerEpisodeId,parentReservation:originalParent,
      recordRefs:preparationHistory.records.map(record=>record.ref),
      allocationRecordIds:preparationAllocations.map(record=>record.record_id),
      originalMeasurementsRewritten:false,resourceConsumptionClaimed:preparationHistory.records.length>0
        &&allocated.size===preparationHistory.records.length,
      monetaryConversion:'UNKNOWN_REQUIRES_NATIVE_PRICES'},
    sampledProcessRssBytes: rssSamples ? sampledProcessRssBytes : null,
    physicalComponents:{includedWithin:'COMPILE',additionalElapsedCredit:0,sourceObservations:sources.length,
      ownerReturnedBytes:sources.length?bytes('originalBytesRead'):null,ownerReusedBytes:sources.length?bytes('reusedBytes'):null,
      storageBytesSaved:null,networkBytesSaved:null,checkerObservations:checkers,
      rawObservationCount:physicalObservations.length},
    lifecycle:{recordRefs:lifecycle.records.map(r=>r.ref),invocations:lifecycleIds.size,
      containingIntervals:lifecycle.records.map(r=>r.payload),additionalElapsedCredit:0,
      allocation:'CONTAINING_INTERVALS_RETAIN_COMPONENTS_NEVER_ADD_WALL_TIME_TWICE'},
    aggregatePeakMemoryBytes: null, monetaryCost: null, humanSeconds: null,
    coverage: "REGISTERED_NATIVE_COMPUTE_ONLY_OTHER_COSTS_UNKNOWN",
    status: "PARTIAL", gaps, meterGapEvents: meterGaps.slice(0, 1024),
    originalEpisodeIds: episodeIds, fullCostOrCapacityEstablished: false };
}

/** Called by an existing trusted owner collector, never by candidate HTTP input.
 * A containing lifecycle receipt charges one actual invocation under the same
 * accepted parent; its elapsed interval is not added to component elapsed. */
export async function persistInstitutionLifecycleCompute(ctx:PeMutationContext,input:{workId:string;episodeId:string;
  parentReservation:ParentRef;rightsRevision:string;invocationId:string;startedAt:string;elapsedMs:number;
  operation:'SETUP'|'BUILD'|'INTEGRATION'|'VALIDATION'|'DIAGNOSTIC'|'REPLAY'|'LIVE_SLICE';
  status:string;receiptDigest:string;measurements:Record<string,unknown>}){
  if(!physicalUuid.test(input.workId)||!physicalUuid.test(input.episodeId)||!physicalUuid.test(input.invocationId)
    ||!Number.isFinite(input.elapsedMs)||input.elapsedMs<0||!Number.isFinite(Date.parse(input.startedAt))
    ||!/^[a-f0-9]{64}$/.test(input.receiptDigest)||JSON.stringify(input.measurements).length>65536)
    throw Error('X1_ACTUAL_LIFECYCLE_MEASUREMENT_REQUIRED');
  const episode=await tx(ctx,async c=>(await c.query<{parent_reservation:ParentRef|null}>(`SELECT parent_reservation
    FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND id=$4`,
    [ctx.auth.tenantId,principal(ctx),input.workId,input.episodeId])).rows[0],true);
  if(!episode?.parent_reservation||sha(episode.parent_reservation)!==sha(input.parentReservation))
    throw Error('X1_ORIGINAL_LIFECYCLE_PARENT_REQUIRED');
  const consumption=await chargeInstitutionDemand(ctx,input.parentReservation,{
    responsibilityIdentity:'x1-compiler-episode:'+input.episodeId,phase:'LIFECYCLE',ordinal:1,units:1,
    physicalInvocationId:input.invocationId});
  return persistEconomicRecord(ctx,{kind:'COMPUTE',rightsRef:`authority:${ctx.auth.tenantId}:${input.rightsRevision}`,
    idempotencyKey:'x1-lifecycle:'+input.invocationId,
    semanticRequestDigest:sha(['x1-lifecycle-v1',input]),validAt:input.startedAt,horizon:'H0',
    dependencies:[input.parentReservation,consumption.charge.ref],
    uncertainty:'Containing physical interval; monetary, human and aggregate memory costs remain unknown',
    payload:{schema:'finnor.x1.lifecycle-compute.v1',...input,phase:'LIFECYCLE',resourceCharge:consumption.charge,
      process:{pid:process.pid,node:process.version,rssBytesAtObservation:process.memoryUsage().rss},
      intervalAccounting:'CONTAINS_COMPONENTS_DO_NOT_SUM_WITH_API_COMPILER_CHECKER_INTERVALS',
      money:null,humanSeconds:null,aggregatePeakMemoryBytes:null,businessWorkCredit:0,
      qualification:'ACTUAL_RESOURCE_ATTRIBUTION_NOT_FINANCIAL_VALUE_OR_CAPACITY_PROOF'}});
}

/** Physical preparation is observable before an episode/reservation exists.
 * Work ownership is checked by the API and again by the economic owner reader. */
export async function persistInstitutionWorkPreparationCompute(ctx:PeMutationContext,input:{workId:string;
  rightsRevision:string;operation:string;statusCode:number;startedAt:string;elapsedMs:number}){
  const invocationId=randomUUID();
  if(!physicalUuid.test(input.workId)||input.operation.length>128||!Number.isInteger(input.statusCode)
    ||input.statusCode<100||input.statusCode>599||!Number.isFinite(input.elapsedMs)||input.elapsedMs<0)
    throw Error('X1_ACTUAL_WORK_PREPARATION_MEASUREMENT_REQUIRED');
  const work=await tx(ctx,async c=>(await c.query('SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 AND created_by=$3',
    [ctx.auth.tenantId,input.workId,principal(ctx)])).rows[0],true);
  if(!work)throw Error('X1_OWNED_WORK_PREPARATION_SCOPE_REQUIRED');
  return persistEconomicRecord(ctx,{kind:'COMPUTE',rightsRef:`authority:${ctx.auth.tenantId}:${input.rightsRevision}`,
    idempotencyKey:'x1-work-preparation:'+invocationId,
    semanticRequestDigest:sha(['x1-work-preparation-compute-v1',invocationId,input]),validAt:input.startedAt,
    horizon:'H0',uncertainty:'Observed owned Work API preparation; original parent not yet accepted, dollars/human/aggregate costs unknown',
    dependencies:[],payload:{schema:'finnor.x1.api-preparation-compute.v1',...input,invocationId,
      episodeId:null,parentReservation:null,phase:'AUTHENTICATED_WORK_PREPARATION',
      process:{pid:process.pid,node:process.version,rssBytesAtObservation:process.memoryUsage().rss},
      money:null,humanSeconds:null,aggregatePeakMemoryBytes:null,businessWorkCredit:0,
      meterWriterLatency:'UNOBSERVED_REQUIRES_EXTERNAL_LIFECYCLE_COLLECTOR',
      costAllocation:'ONCE_PER_PHYSICAL_OWNED_WORK_PREPARATION_INVOCATION',
      qualification:'COMPUTE_ATTRIBUTION_NOT_RESOURCE_CONSUMPTION_FINANCIAL_VALUE_OR_CAPACITY_PROOF'}});
}

/** Physical HTTP-owner work is distinct from a queue delivery. The caller never
 * supplies an invocation identity and cannot reset the original compiler parent. */
export async function persistInstitutionApiCompute(ctx:PeMutationContext,input:{workId:string;
  requestId:string;episodeId:string;parentReservation:{owner:string;id:string;version:string;contentDigest:string}|null;
  rightsRevision:string;operation:string;statusCode:number;startedAt:string;elapsedMs:number}){
  const invocationId=randomUUID();
  if(!physicalUuid.test(input.workId)||!physicalUuid.test(input.requestId)||!physicalUuid.test(input.episodeId)
    ||input.operation.length>128||!Number.isInteger(input.statusCode)||input.statusCode<100||input.statusCode>599
    ||!Number.isFinite(input.elapsedMs)||input.elapsedMs<0)throw Error('X1_ACTUAL_API_MEASUREMENT_REQUIRED');
  const consumption=input.parentReservation?await chargeInstitutionDemand(ctx,input.parentReservation,{
    responsibilityIdentity:'x1-compiler-episode:'+input.episodeId,phase:'CONTROL',ordinal:1,units:1,physicalInvocationId:invocationId}):null;
  const result=await persistEconomicRecord(ctx,{kind:'COMPUTE',rightsRef:`authority:${ctx.auth.tenantId}:${input.rightsRevision}`,
    idempotencyKey:'x1-api-compute:'+invocationId,semanticRequestDigest:sha(['x1-api-compute-v1',invocationId,input]),
    validAt:input.startedAt,horizon:'H0',uncertainty:'Measured API work; prices, meter-writer, aggregate memory and human supervision incomplete',
    dependencies:input.parentReservation?[input.parentReservation]:[],payload:{schema:'finnor.x1.api-compute.v1',
      ...input,invocationId,resourceCharge:consumption?.charge??null,phase:'AUTHENTICATED_API',process:{pid:process.pid,node:process.version,
        rssBytesAtObservation:process.memoryUsage().rss},money:null,humanSeconds:null,aggregatePeakMemoryBytes:null,
      meterWriterLatency:'UNOBSERVED_REQUIRES_EXTERNAL_LIFECYCLE_COLLECTOR',
      businessWorkCredit:0,costAllocation:'ONCE_PER_PHYSICAL_API_INVOCATION_UNDER_ORIGINAL_WORK_PARENT',
      qualification:'COMPUTE_ATTRIBUTION_NOT_FINANCIAL_VALUE_OR_CAPACITY_PROOF'}});
  if(!input.parentReservation){
    const parent=await tx(ctx,async c=>(await c.query<{parent_reservation:ParentRef|null}>(`SELECT parent_reservation
      FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
      [ctx.auth.tenantId,principal(ctx),input.episodeId])).rows[0]?.parent_reservation??null,true);
    if(parent)await allocateInstitutionPreparation(ctx,{...input,parentReservation:parent});
  }
  return result;
}

/** Immutable allocation of already measured control/setup work. S5 serializes
 * each physical UUID once; past null-parent S7 preimages are never rewritten. */
export async function allocateInstitutionPreparation(ctx:PeMutationContext,input:{workId:string;episodeId:string;
  parentReservation:ParentRef;rightsRevision:string}){
  const preparation=await listStoredWorkPreparationCompute(ctx,input.workId);
  const controls=await listStoredWorkCompute(ctx,{workId:input.workId,episodeIds:[input.episodeId],schema:'finnor.x1.api-compute.v1'});
  if(!preparation.complete||!controls.complete)throw Error('X1_PREPARATION_ALLOCATION_HISTORY_INCOMPLETE');
  for(const record of [...preparation.records,...controls.records.filter(r=>r.payload.parentReservation===null)]){
    const physicalInvocationId=String(record.payload.invocationId);
    if(!physicalUuid.test(physicalInvocationId))throw Error('X1_PREPARATION_PHYSICAL_IDENTITY_REQUIRED');
    const consumption=await chargeInstitutionDemand(ctx,input.parentReservation,{
      responsibilityIdentity:'x1-compiler-episode:'+input.episodeId,phase:'PREPARATION',ordinal:1,units:1,physicalInvocationId});
    await persistEconomicRecord(ctx,{kind:'COST',rightsRef:`authority:${ctx.auth.tenantId}:${input.rightsRevision}`,
      idempotencyKey:'x1-preparation-allocation:'+input.workId+':'+physicalInvocationId,
      semanticRequestDigest:sha(['x1-preparation-allocation-v1',record.ref,input.episodeId,input.parentReservation]),
      validAt:record.validAt,horizon:'H0',uncertainty:'Actual request-unit consumption; prices and human/aggregate costs unknown',
      dependencies:[record.ref,input.parentReservation,consumption.charge.ref],payload:{
        schema:'finnor.x1.preparation-allocation.v1',...input,physicalInvocationId,originalRecordRef:record.ref,
        originalPayloadDigest:sha(record.payload),resourceCharge:consumption.charge.ref,units:1,unit:'request',
        resourceConsumptionConfirmed:true,originalMeasurementRewritten:false,elapsedTimeCountedAgain:false,
        money:null,humanSeconds:null,aggregatePeakMemoryBytes:null,businessWorkCredit:0}});
  }
}
