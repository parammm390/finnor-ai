/** Trusted finite compiler child. It inherits no database, provider or oracle
 * credentials. Data has no executable instruction/import/IO capability. */
import {compileApplication,parseBusinessSpecification,applicationCanonical,ApplicationFault} from './compiler';
import {runApplicationProgram} from './program';
import {checkBuiltApplication} from './checker';
const start=performance.now(),cpu=process.cpuUsage();
process.once('message',(input:unknown)=>{
 try{
  const spec=parseBusinessSpecification(input),built=compileApplication(spec),check=checkBuiltApplication(spec,built,runApplicationProgram);
  if(performance.now()-start>30000)throw new ApplicationFault('BUILD_DEADLINE','Original child deadline exceeded');
  const message={ok:check.status==='PASS',built,check,resources:{wallMs:performance.now()-start,cpuMicros:Object.values(process.cpuUsage(cpu)).reduce((a,b)=>a+b,0),peakProcessRSSBytes:process.resourceUsage().maxRSS*1024,pid:process.pid}};
  if(Buffer.byteLength(applicationCanonical(message,8*1024*1024))>8*1024*1024)throw new ApplicationFault('BUILD_OUTPUT_BOUND','Bounded child output exceeded');
  process.send?.(message,()=>process.exit(0));
 }catch(error){
  process.send?.({ok:false,error:error instanceof ApplicationFault?error.code:'BUILD_CHILD_FAILED',resources:{wallMs:performance.now()-start,cpuMicros:Object.values(process.cpuUsage(cpu)).reduce((a,b)=>a+b,0),peakProcessRSSBytes:process.resourceUsage().maxRSS*1024,pid:process.pid}},()=>process.exit(1));
 }
});
