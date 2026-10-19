/** Fixed native data interpreter. No caller-selected code, paths, credentials,
 * endpoint, fixture implementation or mechanism labels cross IPC. */
import {generateDigitalFamily,analyzeDigitalObservations,selectDigitalExperiment} from '../../../epistemic-runtime/src/identification';
import {checkDigitalIdentification,checkDigitalInstrumentCertificate} from '../../../epistemic-runtime/src/identification-checker';
const started=performance.now(),cpu=process.cpuUsage();
process.once('message',(raw:any)=>{
 try{
  if(Buffer.byteLength(JSON.stringify(raw))>4*1024*1024||!raw||!Number.isFinite(raw.deadline)||raw.deadline<=Date.now())throw Error('X4_CHILD_INPUT_OR_DEADLINE');
  const deadline=Math.min(raw.deadline,Date.now()+30000);
  let result:unknown;
  if(raw.operation==='GENERATE')result=generateDigitalFamily(raw.domain,deadline);
  else if(raw.operation==='ANALYZE')result=analyzeDigitalObservations(raw.family,raw.observations);
  else if(raw.operation==='SELECT')result=selectDigitalExperiment(raw.family,raw.analysis,raw.domain,raw.used,deadline);
  else if(raw.operation==='NEXT'){
   const analysis=analyzeDigitalObservations(raw.family,raw.observations);
   result={analysis,selection:selectDigitalExperiment(raw.family,analysis,raw.domain,raw.observations.map((o:any)=>o.conditionId),deadline)};
  }
  else if(raw.operation==='CHECK')result=checkDigitalIdentification(raw.input,deadline);
  else if(raw.operation==='INSTRUMENT_CHECK')result=checkDigitalInstrumentCertificate(raw.certificate);
  else throw Error('X4_CHILD_OPERATION_UNSUPPORTED');
  const elapsed=process.cpuUsage(cpu),usage=process.resourceUsage();
  const response={ok:true,result,resources:{pid:process.pid,wallMs:performance.now()-started,cpuMicros:elapsed.user+elapsed.system,
   peakProcessRSSBytes:usage.maxRSS*1024,node:process.version,platform:process.platform,architecture:process.arch,heapLimitMiB:256,aggregatePeakMemory:null}};
  if(Buffer.byteLength(JSON.stringify(response))>4*1024*1024)throw Error('X4_CHILD_OUTPUT_BOUND');
  process.send?.(response,()=>process.exit(0));
 }catch(error){
  const message=error instanceof Error&&/^X4_[A-Z_]+$/.test(error.message)?error.message:'X4_CHILD_FAILURE';
  process.send?.({ok:false,error:message,resources:{pid:process.pid,wallMs:performance.now()-started,unknownCostPossible:true}},()=>process.exit(1));
 }
});
