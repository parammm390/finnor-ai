/** Disposable transport of the actual compiled API; no production bypass. */
import {strict as assert} from 'node:assert';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {readFile,writeFile,appendFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
export async function startBuiltR1Api(repo:string,evidence:string,options?:{runtime?:'test'|'production';unsetDevBypass?:boolean}){
 await (await import('node:fs/promises')).mkdir(evidence,{recursive:true});
 const directory=join(repo,'finnor-os/apps/api'),buildId=(await readFile(join(directory,'.next/BUILD_ID'),'utf8')).trim();assert(buildId);
 const files:Array<{path:string;sha256:string;bytes:number}>=[];
 async function scan(relative:string){for(const e of await readdir(join(directory,relative),{withFileTypes:true})){const path=relative+'/'+e.name;if(e.isDirectory()){if(e.name!=='cache')await scan(path);}else if(/\.(?:js|json)$/.test(e.name)||e.name==='BUILD_ID'){const b=await readFile(join(directory,path));files.push({path,sha256:createHash('sha256').update(b).digest('hex'),bytes:b.length});}}}
 await scan('.next');files.sort((a,b)=>a.path.localeCompare(b.path));
 const probe=createServer();await new Promise<void>((yes,no)=>{probe.once('error',no);probe.listen(0,'127.0.0.1',yes);});const a=probe.address();assert(a&&typeof a!=='string');await new Promise<void>(yes=>probe.close(()=>yes()));
 const base='http://127.0.0.1:'+a.port,logPath=join(evidence,'built-api.log');await writeFile(logPath,'');let writes=Promise.resolve(),stdout='',stderr='';
 const command=['--import=tsx',join(repo,'finnor-os/node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(a.port)];
 const childEnvironment={...process.env,NODE_ENV:options?.runtime??'test',NEXT_TELEMETRY_DISABLED:'1'};
 if(options?.unsetDevBypass)delete childEnvironment.AUTH_DEV_BYPASS;
 const child=spawn(process.execPath,command,{cwd:directory,env:childEnvironment,stdio:['ignore','pipe','pipe']});
 child.stdout!.on('data',b=>{stdout+=b;writes=writes.then(()=>appendFile(logPath,b));});child.stderr!.on('data',b=>{stderr+=b;writes=writes.then(()=>appendFile(logPath,b));});
 const exited=new Promise<void>(yes=>child.once('exit',()=>yes()));
 const receipt={schema:'finnor.r1.built-api-runtime.v1',buildId,files,node:process.execPath,nodeVersion:process.version,pid:child.pid,command,cwd:directory,environmentNames:Object.keys(childEnvironment).sort(),runtimeEnvironment:childEnvironment.NODE_ENV,profile:options?.runtime==='production'?'ACTUAL_PRODUCTION_CONFIGURATION_REFUSAL_ONLY':'ORDINARY_DISPOSABLE_WITH_ACTUAL_COMPILED_API; PRODUCTION_GUARDS_RETAINED',linuxImageProof:false};
 const close=async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await Promise.race([exited,new Promise(yes=>setTimeout(yes,3000))]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}await writes;await writeFile(join(evidence,'built-api-process.json'),JSON.stringify({...receipt,exitCode:child.exitCode,signal:child.signalCode},null,2)+'\n');};
 try{const start=performance.now();while(!stdout.includes('Ready in')&&performance.now()-start<30000&&child.exitCode===null)await new Promise(yes=>setTimeout(yes,50));assert(stdout.includes('Ready in'),'Actual built API did not start: '+stderr);await writeFile(join(evidence,'built-api-source.json'),JSON.stringify(receipt,null,2)+'\n');return {base,close,log:()=>({stdout,stderr})};}catch(error){await close();throw error;}
}
