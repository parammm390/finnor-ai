import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { PeMutationContext } from "../types";
import { persistEconomicRecord, listStoredWorkCompute,listStoredWorkPreparationCompute } from "../economic-store";
import { sha, tx, principal } from "../evidence-execution/store";

type Scope = { sourceAttempt: (grantId: string) => Promise<void>;
  checkerAttempt: () => Promise<void> };
const scope = new AsyncLocalStorage<Scope>();
const physicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const computePhases = ["COMPILE", "PUBLICATION", "UPDATE_RECOGNITION", "PREPARATION", "RECOVERY"] as const;
export const withInstitutionMeter = <T>(input: Scope, run: () => Promise<T>) => scope.run(input, run);
export const recordInstitutionSourceAttempt = async (grantId: string) => { await scope.getStore()?.sourceAttempt(grantId); };
export const recordInstitutionCheckerAttempt = async () => { await scope.getStore()?.checkerAttempt(); };

/** Immutable S7 compute attribution uses physical delivery identities. Prices,
 * aggregate peak memory and human supervision remain unknown when unobserved. */
export async function persistInstitutionCompute(ctx: PeMutationContext, input: {
  requestId: string; workId: string; episodeId: string; jobId: string; deliveryAttemptId: string;
  parentReservation: { owner: string; id: string; version: string; contentDigest: string } | null;
  rightsRevision: string; startedAt: string; elapsedMs: number; status: string;
  phase: typeof computePhases[number]; observedAcquisitionAttempts: number; observedCheckerAttempts: number;
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
  const seen = new Set<string>(), gaps: string[] = [], phases = new Map<string, { deliveries: number; attributedElapsedMs: number }>();
  const refs: Array<{ owner: "S7"; id: string; version: string; contentDigest: string }> = [];
  let attributedElapsedMs = 0, sampledProcessRssBytes = 0, rssSamples = 0;
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
  if(preparationIdentities.size)phases.set('AUTHENTICATED_WORK_PREPARATION',{
    deliveries:preparationIdentities.size,attributedElapsedMs:preparationElapsedMs});
  if (meterGaps.length > 1024) gaps.push("X1_COMPUTE_METER_GAP_HISTORY_BOUND");
  return { basis: "EXISTING_S7_IMMUTABLE_PHYSICAL_DELIVERY_RECORDS", recordRefs: refs,
    registeredDeliveryPhases: seen.size, apiInvocations:apiIdentities.size,
    attributedElapsedMs:attributedElapsedMs+apiElapsedMs+preparationElapsedMs, phases: Object.fromEntries(phases),
    preparationAllocation:{basis:'ALL_OWNED_WORK_PREPARATION_ONCE_TO_ITS_ORIGINAL_WORK_EPISODE',
      originalEpisodeId:compilerEpisodeId,parentReservation:originalParent,
      recordRefs:preparationHistory.records.map(record=>record.ref),
      originalMeasurementsRewritten:false,resourceConsumptionClaimed:false,
      monetaryConversion:'UNKNOWN_REQUIRES_NATIVE_PRICES'},
    sampledProcessRssBytes: rssSamples ? sampledProcessRssBytes : null,
    aggregatePeakMemoryBytes: null, monetaryCost: null, humanSeconds: null,
    coverage: "REGISTERED_NATIVE_COMPUTE_ONLY_OTHER_COSTS_UNKNOWN",
    status: "PARTIAL", gaps, meterGapEvents: meterGaps.slice(0, 1024),
    originalEpisodeIds: episodeIds, fullCostOrCapacityEstablished: false };
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
  return persistEconomicRecord(ctx,{kind:'COMPUTE',rightsRef:`authority:${ctx.auth.tenantId}:${input.rightsRevision}`,
    idempotencyKey:'x1-api-compute:'+invocationId,semanticRequestDigest:sha(['x1-api-compute-v1',invocationId,input]),
    validAt:input.startedAt,horizon:'H0',uncertainty:'Measured API work; prices, meter-writer, aggregate memory and human supervision incomplete',
    dependencies:input.parentReservation?[input.parentReservation]:[],payload:{schema:'finnor.x1.api-compute.v1',
      ...input,invocationId,phase:'AUTHENTICATED_API',process:{pid:process.pid,node:process.version,
        rssBytesAtObservation:process.memoryUsage().rss},money:null,humanSeconds:null,aggregatePeakMemoryBytes:null,
      meterWriterLatency:'UNOBSERVED_REQUIRES_EXTERNAL_LIFECYCLE_COLLECTOR',
      businessWorkCredit:0,costAllocation:'ONCE_PER_PHYSICAL_API_INVOCATION_UNDER_ORIGINAL_WORK_PARENT',
      qualification:'COMPUTE_ATTRIBUTION_NOT_FINANCIAL_VALUE_OR_CAPACITY_PROOF'}});
}
