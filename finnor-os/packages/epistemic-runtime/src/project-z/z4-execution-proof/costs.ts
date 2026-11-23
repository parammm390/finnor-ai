import {z} from 'zod';
import {canonical,digestSchema,fail} from './contracts';
import type {NativeMeters} from './native';

export const COST_PHASES=['build','learning','native-install','setup','compile','prove','storage','invalidation','recovery','provider','human'] as const;
export const COST_DIMENSIONS=['cpuMicros','wallMs','usdMicros','humanMillis'] as const;
const amount=z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const amounts=z.object({cpuMicros:amount,wallMs:amount,usdMicros:amount,humanMillis:amount}).strict();
const binding=z.object({programDigest:digestSchema,requestDigest:digestSchema,sourceDigest:digestSchema,
 targetDigest:digestSchema,resourcesDigest:digestSchema,comparatorDigest:digestSchema,horizonDigest:digestSchema,
 ownerBindingDigest:digestSchema,permittedUseDigest:digestSchema,inputRevisionDigest:digestSchema,
 originalReservationDigest:digestSchema}).strict();
const receipt=z.object({id:digestSchema,arm:z.enum(['PROOF','FULL']),role:z.enum(['TOTAL','BREAKDOWN']),
 parentId:digestSchema.optional(),phase:z.enum([...COST_PHASES,'check']),covers:z.array(z.enum(COST_PHASES)),
 useId:digestSchema.optional(),attemptId:digestSchema,processScope:digestSchema,
 startMs:z.number().finite().nonnegative(),endMs:z.number().finite().nonnegative(),
 outcome:z.enum(['COMPLETE','FAILED','UNKNOWN']),binding,amounts}).strict();
const ledger=z.object({schema:z.literal('finnor.z4.full-cost.v1'),
 evidenceClass:z.enum(['PUBLIC_EQUIPMENT','INDEPENDENT_NATIVE_RECORDS']),binding,
 uses:z.array(z.object({useId:digestSchema,ownerReceipt:digestSchema,observedAt:z.number().finite().nonnegative()}).strict()).max(4096),
 receipts:z.array(receipt).max(65536)}).strict();
export type FullCostLedger=z.infer<typeof ledger>;

/** Actual root-process intervals are totals. Native substeps are breakdowns,
 * never additive substitutes for their enclosing measured process tree.
 * This validates records and computes arithmetic; it does not authenticate
 * owner receipts or perform independent operational/financial admission. */
export function fullCostCrossover(raw:unknown){
 const l=ledger.parse(raw),ids=new Set<string>(),uses=new Set<string>(),ownerReceipts=new Set<string>();
 for(const [index,u] of l.uses.entries()){
  if(uses.has(u.useId)||ownerReceipts.has(u.ownerReceipt))fail('Z4_COST_DUPLICATE_DEMAND');
  if(index&&u.observedAt<l.uses[index-1]!.observedAt)fail('Z4_COST_OBSERVED_USE_ORDER');
  uses.add(u.useId);ownerReceipts.add(u.ownerReceipt);
 }
 for(const r of l.receipts){
  if(ids.has(r.id))fail('Z4_COST_DUPLICATE_RECEIPT');ids.add(r.id);
  if(canonical(r.binding)!==canonical(l.binding))fail('Z4_COST_BINDING_MISMATCH');
  if(r.endMs<r.startMs||new Set(r.covers).size!==r.covers.length)fail('Z4_COST_INTERVAL_OR_COVERAGE');
  if(r.phase==='check'?!r.useId||!uses.has(r.useId):r.useId!==undefined)fail('Z4_COST_UNREGISTERED_DEMAND');
  if(r.role==='TOTAL'&&r.parentId!==undefined||r.role==='BREAKDOWN'&&!r.parentId)fail('Z4_COST_TOTAL_COMPONENT_SCOPE');
 }
 const totals=l.receipts.filter(r=>r.role==='TOTAL'),byId=new Map(l.receipts.map(r=>[r.id,r]));
 for(const r of l.receipts.filter(r=>r.role==='BREAKDOWN')){
  const parent=byId.get(r.parentId!);
  if(!parent||parent.role!=='TOTAL'||parent.arm!==r.arm||parent.useId!==r.useId||
   r.startMs<parent.startMs||r.endMs>parent.endMs)fail('Z4_COST_ORPHAN_COMPONENT');
 }
 const intervals=new Map<string,typeof totals>();
 for(const r of totals){
  const key=r.processScope,group=intervals.get(key)??[];group.push(r);intervals.set(key,group);
 }
 for(const group of intervals.values()){
  group.sort((a,b)=>a.startMs-b.startMs);
  for(let i=1;i<group.length;i++)if(group[i]!.startMs<group[i-1]!.endMs)fail('Z4_COST_OVERLAPPING_TOTALS');
 }
 const gaps:string[]=[];
 for(const arm of ['PROOF','FULL'] as const){
  const covered=new Set(totals.filter(r=>r.arm===arm&&r.phase!=='check').flatMap(r=>r.covers));
  for(const p of COST_PHASES)if(!covered.has(p))gaps.push(arm+':'+p+':UNMEASURED');
  for(const u of l.uses)if(!totals.some(r=>r.arm===arm&&r.phase==='check'&&r.useId===u.useId&&r.outcome==='COMPLETE'))
   gaps.push(arm+':'+u.useId+':MATCHED_COMPLETE_CHECK_MISSING');
 }
 const dimensions=Object.fromEntries(COST_DIMENSIONS.map(dimension=>{
  const sum=(rows:typeof totals)=>rows.reduce((n,r)=>{
   const total=n+(r.amounts[dimension]??0);
   if(!Number.isFinite(total)||total>Number.MAX_SAFE_INTEGER)fail('Z4_COST_TOTAL_BOUND');
   return total;
  },0);
  const complete=gaps.length===0&&totals.every(r=>r.amounts[dimension]!==null&&r.outcome!=='UNKNOWN');
  const proofRows=totals.filter(r=>r.arm==='PROOF'),fullRows=totals.filter(r=>r.arm==='FULL');
  const proofTotal=complete?sum(proofRows):null,fullTotal=complete?sum(fullRows):null;
  let firstFavorableObservedUse:number|null=null;
  if(complete&&l.uses.length){
   let p=sum(proofRows.filter(r=>r.phase!=='check')),f=sum(fullRows.filter(r=>r.phase!=='check'));
   for(const [index,use] of l.uses.entries()){
    p+=sum(proofRows.filter(r=>r.phase==='check'&&r.useId===use.useId));
    f+=sum(fullRows.filter(r=>r.phase==='check'&&r.useId===use.useId));
    if(firstFavorableObservedUse===null&&p<f)firstFavorableObservedUse=index+1;
   }
  }
  return [dimension,{knownProofSubtotal:sum(proofRows),knownFullSubtotal:sum(fullRows),proofTotal,fullTotal,
   ratio:l.uses.length&&proofTotal!==null&&proofTotal>0&&fullTotal!==null?fullTotal/proofTotal:null,
   firstFavorableObservedUse,complete}];
 }));
 return {schema:'finnor.z4.full-cost-comparison.v1',evidenceClass:l.evidenceClass,binding:l.binding,
  registeredUseCount:l.uses.length,eligibleReuseN:0,ownerReceiptsAuthenticated:false,
  unverifiedAdmissions:['original owner/use receipts','permitted use/currentness','equipped comparator','registered actual horizon','independent S7/S8 costs'],
  crossover:l.uses.length===0?'NOT_ESTABLISHED_NO_ELIGIBLE_DEMAND':
   'OBSERVED_RECORD_ARITHMETIC_ONLY_REQUIRES_INDEPENDENT_OWNER_AND_COST_ADMISSION',
  dimensions,gaps,failedAttempts:totals.filter(r=>r.outcome==='FAILED').map(r=>r.attemptId),
  prefixCostPolicy:'ALL_REGISTERED_HORIZON_FIXED_AND_FAILED_COSTS_CHARGED_AT_EVERY_OBSERVED_PREFIX',
  unknownAttempts:totals.filter(r=>r.outcome==='UNKNOWN').map(r=>r.attemptId),
  includedTotalReceipts:totals.map(r=>r.id),excludedBreakdownReceipts:l.receipts.filter(r=>r.role==='BREAKDOWN').map(r=>r.id),
  fullCostAccepted:false,operational100x:'NOT_ADJUDICATED_PRESERVE_EXISTING_FAILURE',
  financial100x:'NOT_RUN',protectedAdmission:'NOT_RUN'};
}

export interface ExecutionInterval {
 label:string;status:'COMPLETE'|'FAILED';startedAt:string;endedAt:string;wallMs:number;nodeCpuMicros:number;
 knownNativeChildCpuMicros:number;nativeChildCpuMicros:number|null;nativeMeasurements:number;unmeteredNativeFailures:number;
 processTreeCpuMicros:null;aggregatePeakRSSBytes:null;usd:null;humanSeconds:null;
 accountingScope:'NODE_INTERVAL_PLUS_NATIVE_BREAKDOWN_NOT_COMPLETE_PROCESS_TREE';
}
export interface MeasuredExecution<T>{value:T;interval:ExecutionInterval}
/** Parent CPU and scientific-child CPU remain distinct. Python supervisors,
 * import/startup, storage/recovery/install and human/provider costs are not
 * silently assigned zero. The enclosing controller supplies complete totals. */
export async function measureExecution<T>(label:string,run:(observe:(meters:NativeMeters|null)=>void)=>Promise<T>,
 retain:(interval:ExecutionInterval)=>Promise<void>):Promise<MeasuredExecution<T>>{
 const started=performance.now(),startedAt=new Date().toISOString(),cpu=process.cpuUsage(),observations:Array<NativeMeters|null>=[];
 let status:ExecutionInterval['status']='FAILED';
 let value:T;
 try{
  value=await run(m=>observations.push(m));status='COMPLETE';
 }catch(error){await finish();throw error;}
 return {value,interval:await finish()};
 async function finish(){
  const used=process.cpuUsage(cpu),interval:ExecutionInterval={label,status,startedAt,endedAt:new Date().toISOString(),wallMs:performance.now()-started,
   nodeCpuMicros:used.user+used.system,knownNativeChildCpuMicros:observations.reduce((n,m)=>n+(m?.cpuMicros??0),0),
   nativeChildCpuMicros:observations.some(m=>!m)?null:observations.reduce((n,m)=>n+(m?.cpuMicros??0),0),
   nativeMeasurements:observations.length,unmeteredNativeFailures:observations.filter(m=>!m).length,
   processTreeCpuMicros:null,aggregatePeakRSSBytes:null,usd:null,humanSeconds:null,
   accountingScope:'NODE_INTERVAL_PLUS_NATIVE_BREAKDOWN_NOT_COMPLETE_PROCESS_TREE'};
  await retain(interval);return interval;
 }
}
