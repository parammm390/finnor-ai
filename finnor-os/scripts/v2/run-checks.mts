/** Bounded final engineering checks, with every actual result retained. */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {verificationBudget} from './verification-budget.mts';
const repo=resolve(import.meta.dirname,'../../..'),backend=join(repo,'finnor-os');
const group=process.env.FINNOR_V2_CHECK_GROUP??'static';
const qualificationPlan=process.env.FINNOR_V2_QUALIFICATION==='1'?JSON.parse(await readFile(join(repo,'scope-v/v2-primary-reality-due-diligence/qualification-phase-plan.json'),'utf8')):null;
const budget=verificationBudget(Math.min(qualificationPlan?Date.parse(qualificationPlan.hardStop):Infinity,Date.now()+2400000));
if(!['static','build'].includes(group))throw Error('REGISTERED_CHECK_GROUP_REQUIRED');
const output=join(repo,'scope-v/v2-primary-reality-due-diligence/evidence','checks-'+group+'-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(output,{recursive:true});
type Check={id:string;command:string;args:string[];cwd:string;seconds:number};
const npm=(id:string,args:string[],cwd=repo,seconds=180):Check=>({id,command:'npm',args,cwd,seconds});
const checks:Check[]=group==='build'?[
 npm('root-build',['run','build'],repo,600),
 npm('api-build',['run','build','--workspace','@finnor/api'],backend,600),
]:[
 npm('backend-types',['run','typecheck'],backend),
 {id:'runner-checker-types',command:join(backend,'node_modules/.bin/tsc'),args:['-p',join(import.meta.dirname,'tsconfig.json'),'--noEmit'],cwd:backend,seconds:180},
 {id:'root-types',command:join(repo,'node_modules/.bin/tsc'),args:['--noEmit','--incremental','false'],cwd:repo,seconds:180},
 npm('lint',['run','lint']),
 ...['workspace:check','centropy:manifest:check','centropy:client:check','centropy:forms:check','release:truth','release:mutation-inventory'].map(id=>npm(id,['run',id])),
 npm('release:manifest',['run','release:manifest'],backend),
 npm('release:pe-domain-boundary',['run','release:pe-domain-boundary'],backend),
 {id:'relationship-contracts',command:join(backend,'node_modules/.bin/tsx'),args:['scripts/release/generate-scope4-relationship-contracts.ts','--check'],cwd:backend,seconds:180},
];
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const freeze={schema:'finnor.v2.check-freeze.v1',startedAt:new Date().toISOString(),group,checks,node:process.version,cleanInstall:false,
 lockDigests:{root:sha(await readFile(join(repo,'package-lock.json'))),backend:sha(await readFile(join(backend,'package-lock.json')))},
 controllerDigest:sha(await readFile(new URL(import.meta.url))),maximumPhaseWallSeconds:2400,effectiveDeadlineAt:new Date(budget.deadlineAt).toISOString(),qualificationPlan};
await writeFile(join(output,'pre-run-freeze.json'),JSON.stringify(freeze,null,2)+'\n');
const rows:any[]=[];
const save=()=>writeFile(join(output,'results.json'),JSON.stringify({...freeze,schema:'finnor.v2.final-checks.v1',finishedAt:new Date().toISOString(),status:rows.some(r=>r.status!=='PASS')?'INCOMPLETE_EVIDENCE':'PASS_ASSIGNED_ENGINEERING_CHECKS',results:rows,
 qualification:'No deployed-runtime, clean-install, Linux-image, blind-domain, S8, V1, live, field or economic qualification is inferred.'},null,2)+'\n');
for(const check of checks){
 if(budget.signal.aborted||Date.now()>=budget.deadlineAt){rows.push({...check,status:'NOT_RUN',reason:'REGISTERED_PHASE_BUDGET_EXHAUSTED'});await save();continue;}
 const began=Date.now();
 const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null;log:string;timedOut:boolean}>((yes)=>{
  let log='',timedOut=false,forceKill:NodeJS.Timeout|undefined;
  const child=spawn(check.command,check.args,{cwd:check.cwd,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  const append=(b:Buffer)=>{if(Buffer.byteLength(log)<1048576)log+=b.toString('utf8');};
  child.stdout.on('data',append);child.stderr.on('data',append);
  const kill=(signal:NodeJS.Signals)=>{if(process.platform==='win32')child.kill(signal);else if(child.pid)try{process.kill(-child.pid,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}};
  const stop=()=>{if(timedOut)return;timedOut=true;kill('SIGTERM');forceKill=setTimeout(()=>kill('SIGKILL'),5000);forceKill.unref();};
  const timer=setTimeout(stop,budget.remainingMs(check.seconds*1000));budget.signal.addEventListener('abort',stop,{once:true});
  child.once('error',()=>{clearTimeout(timer);clearTimeout(forceKill);budget.signal.removeEventListener('abort',stop);yes({code:null,signal:null,log:log+'\nREGISTERED_CHECK_COULD_NOT_START',timedOut});});
  child.once('close',(code,signal)=>{clearTimeout(timer);clearTimeout(forceKill);budget.signal.removeEventListener('abort',stop);yes({code,signal,log,timedOut:timedOut||Date.now()>=budget.deadlineAt});});
 });
 const sanitized=result.log.replace(/Bearer [^\s"]+/g,'Bearer [REDACTED]').replace(/postgres(?:ql)?:\/\/[^@\s]+@/g,'postgres://[REDACTED]@');
 await writeFile(join(output,check.id+'.log'),sanitized);
 rows.push({...check,status:result.code===0&&!result.timedOut?'PASS':'FAIL',exitCode:result.code,exitSignal:result.signal,timedOut:result.timedOut,elapsedMs:Date.now()-began,log:check.id+'.log'});
 console.log(JSON.stringify(rows.at(-1)));await save();
}
console.log(JSON.stringify({status:rows.every(r=>r.status==='PASS')?'PASS_ASSIGNED_ENGINEERING_CHECKS':'INCOMPLETE_EVIDENCE',evidence:output}));
budget.dispose();
process.exit(rows.every(r=>r.status==='PASS')?0:1);
