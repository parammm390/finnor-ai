export interface R1AccountingAttempt {
 id:string;stage:string;status:string;body:unknown;digest:string;
}
export interface R1AccountingEvent {
 id:string;kind:string;body:unknown;digest:string;
}

function record(value:unknown):Record<string,unknown>{
 return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
}
function measured(value:unknown,integer=false):number|null{
 return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER&&(!integer||Number.isSafeInteger(value))?value:null;
}
function processMaxRss(physical:Record<string,unknown>):number|null{
 const bytes=measured(physical.maxRssBytes,true);
 if(bytes!==null)return bytes;
 const native=measured(physical.maxRssNative,true);
 if(native===null)return null;
 if(physical.platform==='darwin')return native;
 if(physical.platform==='linux')return measured(native*1024,true);
 return null;
}
function knownCpu(values:Array<number|null>):number|null{
 let total=0;
 for(const value of values){if(value!==null){total+=value;if(!Number.isSafeInteger(total))return null;}}
 return total;
}

/** Project existing canonical attempts, not a new ledger or charge. Parent
 * intervals and event copies are deliberately excluded from child subtotals. */
export function summarizeR1RetainedCosts(attempts:readonly R1AccountingAttempt[],events:readonly R1AccountingEvent[]){
 const ids=new Set<string>();
 const attemptUsage=attempts.map(attempt=>{
  if(ids.has(attempt.id))throw Error('R1_DUPLICATE_PHYSICAL_ACCOUNTING_ID');
  ids.add(attempt.id);
  const body=record(attempt.body),receipt=record(body.receipt);
  const physical=record(attempt.stage==='CHECK'?receipt.physical:body.physical);
  return {
   attemptId:attempt.id,stage:attempt.stage,status:attempt.status,receiptDigest:attempt.digest,
   elapsedMs:measured(attempt.stage==='CHECK'?receipt.elapsedMs:physical.elapsedMs),
   cpuUserMicros:measured(physical.cpuUserMicros,true),
   cpuSystemMicros:measured(physical.cpuSystemMicros,true),
   processMaxRssBytes:processMaxRss(physical),
   usd:null
  };
 });
 const user=knownCpu(attemptUsage.map(a=>a.cpuUserMicros)),system=knownCpu(attemptUsage.map(a=>a.cpuSystemMicros));
 const complete=attemptUsage.every(a=>a.cpuUserMicros!==null&&a.cpuSystemMicros!==null)&&user!==null&&system!==null;
 const references=(kind:string)=>events.filter(e=>e.kind===kind).map(e=>({id:e.id,digest:e.digest}));
 return {
  attempts:attempts.length,unknown:attempts.filter(a=>['INTENT','SUBMITTED','UNKNOWN'].includes(a.status)).length,usd:null,
  metering:{
   schema:'finnor.r1.retained-costs.v1' as const,
   accountingScope:'OBSERVED_DISTINCT_CHILD_USAGE_NOT_COMPLETE_EPISODE' as const,
   attemptUsage,
   observedChildCpuUserMicros:user,observedChildCpuSystemMicros:system,
   cpuCoverage:attemptUsage.length===0?'NO_OBSERVATIONS' as const:complete?'COMPLETE_RETAINED_CHILD_OBSERVATIONS' as const:'PARTIAL' as const,
   episodeElapsedMs:null,
   aggregateSimultaneousPeakBytes:null,
   humanSeconds:null,
   commonPreparationRefs:references('COMMON_PREPARATION_CHARGED'),
   ownerProjectionRefs:references('OWNER_PROJECTION_RETURNED'),
   missingMeters:[
    'COMPLETE_EPISODE_PROCESS_AND_SERVICE_COVERAGE',
    'SIMULTANEOUS_AGGREGATE_MEMORY',
    'HUMAN_WORK',
    'DOLLAR_PRICING_AND_PROVIDER_EXPORT',
    'BUILD_CACHE_STORAGE_COLLECTION_AND_REBUILD'
   ]
  }
 };
}
