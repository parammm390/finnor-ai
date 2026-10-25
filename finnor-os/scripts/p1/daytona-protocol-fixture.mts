/** SDK HTTP lifecycle fixture. It executes the uploaded trusted supervisor and
 * module in real processes, but provides NO hosted-VM isolation qualification.
 * Financial expected values remain in daytona-e2e, never in this provider. */
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {userInfo} from 'node:os';
import {join} from 'node:path';
let registeredWorker:ChildProcess|undefined,interruptedPid:number|undefined;
let snapshot:()=>unknown=()=>null;
export const registerDaytonaFixtureWorker=(child:ChildProcess)=>{registeredWorker=child;};
export const wasDaytonaFixtureInterruption=(pid:number|undefined)=>pid!==undefined&&pid===interruptedPid;
export const daytonaFixtureSnapshot=()=>snapshot();

export async function daytonaProtocolFixture(evidence:string){
 const snapshotId=randomUUID(),image='finnor-protocol/node@sha256:'+'1'.repeat(64),boxes=new Map<string,any>(),calls:Array<Record<string,unknown>>=[];
 const children=new Set<ChildProcess>();let origin='';
 let workerParentPid:number|undefined;
 let lostCommandAcknowledgement:Record<string,string>|null=null;
 const interrupt=process.env.FINNOR_DAYTONA_PROTOCOL_KILL==='1';
 snapshot=()=>({interruptedPid,sandboxes:[...boxes.values()].map(b=>({id:b.id,name:b.name,state:b.state,commands:b.commands}))});
 const profile={snapshotId,image,target:'local-protocol',user:userInfo().username,nodeBinary:process.execPath,nodeDigest:createHash('sha256').update(await readFile(process.execPath)).digest('hex')};
 const emit=(res:ServerResponse,status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 const missing=(res:ServerResponse)=>emit(res,404,{message:'Not found'});
 async function body(req:IncomingMessage){const bytes:Buffer[]=[];let size=0;for await(const raw of req){const b=Buffer.from(raw);if((size+=b.length)>2400000)throw Error('FIXTURE_REQUEST_BOUND');bytes.push(b);}return Buffer.concat(bytes);}
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url!,origin),method=req.method!,parts=url.pathname.split('/').filter(Boolean);
  calls.push({method,path:url.pathname});
  try{
   if(req.headers.authorization!=='Bearer protocol-fixture-key')return emit(res,401,{message:'Fixture auth required'});
   if(parts.join('/')==='fixture/worker'&&method==='POST'&&interrupt){
    const input=JSON.parse((await body(req)).toString());
    if(input.parentPid!==workerParentPid||!Number.isSafeInteger(input.pid)||input.pid<2||input.pid===process.pid)throw Error('FIXTURE_EXACT_WORKER_PARENT_REQUIRED');
    registeredWorker={pid:input.pid,kill:signal=>{process.kill(input.pid,signal);return true;}} as ChildProcess;
    return emit(res,200,{registeredPid:input.pid});
   }
   if(parts.includes('events')){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': lifecycle fixture\n\n');return;}
   if(parts[0]==='api'&&parts[1]==='snapshots'&&parts[2]===snapshotId)return emit(res,200,{id:snapshotId,name:'pinned-node',imageName:image,state:'active',general:false,size:1,cpu:1,gpu:0,mem:1,disk:2,entrypoint:[],sourceSandboxId:null});
   if(parts[0]==='api'&&parts[1]==='sandbox'){
    if(method==='POST'&&parts.length===2){const input=JSON.parse((await body(req)).toString());
     if([...boxes.values()].some(b=>b.name===input.name))return emit(res,409,{message:'Duplicate stable name'});
     if(input.snapshot!==snapshotId||input.user!==profile.user||input.public!==false||input.networkBlockAll!==true||Object.keys(input.env??{}).length||input.secrets?.length||input.volumes?.length)throw Error('FIXTURE_PRIVATE_RUNTIME_CONTRACT');
     const id=randomUUID(),box={id,...input,organizationId:randomUUID(),snapshot:snapshotId,state:'started',memory:1,cpu:1,disk:2,toolboxProxyUrl:origin+'/toolbox',commands:[],sessions:new Set(),directory:'/tmp/'+input.name};boxes.set(id,box);return emit(res,201,dto(box));
    }
    const box=[...boxes.values()].find(b=>b.id===parts[2]||b.name===parts[2]);if(!box)return missing(res);
    if(method==='DELETE'){box.state='destroyed';await rm(box.directory,{recursive:true,force:true});return emit(res,200,dto(box));}
    return emit(res,200,dto(box));
   }
   if(parts[0]==='toolbox'){
    const box=boxes.get(parts[1]!);if(!box||box.state==='destroyed')return missing(res);
    const path='/'+parts.slice(2).join('/');
    if(path==='/files/info'){
     const target=url.searchParams.get('path');if(target!==box.directory)throw Error('FIXTURE_UPLOAD_SCOPE');
     try{await readFile(join(box.directory,'envelope.json'));}catch{return missing(res);}
     return emit(res,200,{name:box.name,isDir:true,size:0,permissions:'700',mode:'drwx------',owner:profile.user,group:profile.user,modTime:'',modifiedAt:new Date().toISOString()});
    }
    if(path==='/files/folder'&&method==='POST'){const target=url.searchParams.get('path')!;if(target!==box.directory)throw Error('FIXTURE_UPLOAD_SCOPE');await mkdir(target,{mode:0o700});return emit(res,200,{});}
    if(path==='/files/bulk-upload'){
     const bytes=await body(req),form=await new Request(origin,{method:'POST',headers:{'content-type':String(req.headers['content-type'])},body:bytes}).formData();
     for(let i=0;form.has(`files[${i}].path`);i++){
      const target=String(form.get(`files[${i}].path`)),file=form.get(`files[${i}].file`) as File;
      if(!['bootstrap.mjs','envelope.json'].some(name=>target===join(box.directory,name))||!file?.arrayBuffer)throw Error('FIXTURE_UPLOAD_SCOPE');
      await writeFile(target,Buffer.from(await file.arrayBuffer()),{mode:0o600});
     }return emit(res,200,{});
    }
    if(path==='/files/download'){
     const target=url.searchParams.get('path');if(target!==join(box.directory,'result.json'))throw Error('FIXTURE_DOWNLOAD_SCOPE');
     const bytes=await readFile(target);res.writeHead(200,{'content-type':'application/octet-stream'});res.end(bytes);return;
    }
    if(path==='/files/bulk-download'){
     const request=JSON.parse((await body(req)).toString()),target=join(box.directory,'result.json');if(JSON.stringify(request.paths)!==JSON.stringify([target]))throw Error('FIXTURE_DOWNLOAD_SCOPE');
     const bytes=await readFile(target),boundary='finnor-sdk-fixture';res.writeHead(200,{'content-type':'multipart/form-data; boundary='+boundary});
     res.end(Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${target}"\r\nContent-Type: application/octet-stream\r\nContent-Length: ${bytes.length}\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]));return;
    }
    if(path==='/process/session'&&method==='POST'){const input=JSON.parse((await body(req)).toString());box.sessions.add(input.sessionId);return emit(res,200,{});}
    if(parts[2]==='process'&&parts[3]==='session'){
     const session=parts[4];if(!box.sessions.has(session))return missing(res);
     if(parts[5]==='exec'&&method==='POST'){
      const input=JSON.parse((await body(req)).toString()),args=String(input.command).split(' ');
      if(args[0]!=='/usr/bin/env'||args[1]!=='-i'||args[7]!==profile.nodeBinary||args[8]!==join(box.directory,'bootstrap.mjs')||args[9]!==box.directory||args.length!==10)throw Error('FIXTURE_EXECUTION_SCOPE');
      const command={id:randomUUID(),command:input.command,exitCode:undefined as number|undefined};box.commands.push(command);
      const child=spawn(args[0]!,args.slice(1),{env:{},stdio:['ignore','pipe','pipe']});children.add(child);
      let diagnostic='';child.stderr!.on('data',b=>{if(diagnostic.length<1000)diagnostic+=String(b);});child.stdout!.on('data',()=>undefined);
      child.once('close',code=>{command.exitCode=code??1;box.diagnostic=diagnostic;children.delete(child);});
      if(process.env.FINNOR_DAYTONA_PROTOCOL_LOST_ACK==='1'&&!lostCommandAcknowledgement){lostCommandAcknowledgement={sandboxId:box.id,commandId:command.id};res.destroy();return;}
      emit(res,200,{cmdId:command.id});
      if(interrupt&&!interruptedPid){if(!registeredWorker?.pid)throw Error('FIXTURE_ORIGINAL_WORKER_PID_REQUIRED');interruptedPid=registeredWorker.pid;registeredWorker.kill('SIGKILL');}
      return;
     }
     if(parts[5]==='command'){const command=box.commands.find((c:any)=>c.id===parts[6]);return command?emit(res,200,command):missing(res);}
     return emit(res,200,{sessionId:session,commands:box.commands});
    }
   }
   return missing(res);
  }catch(error){calls.push({error:String((error as Error).message)});if(!res.headersSent)emit(res,500,{message:String((error as Error).message)});else res.destroy();}
 });
 function dto(box:any){const {commands,sessions,directory,diagnostic,...record}=box;return record;}
 await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();if(!address||typeof address==='string')throw Error('FIXTURE_LISTEN');origin='http://127.0.0.1:'+address.port;
 return {registerWorkerParent(pid:number){workerParentPid=pid;},environment:{FINNOR_P1_EXECUTOR:'daytona',FINNOR_DAYTONA_PROFILE:JSON.stringify(profile),DAYTONA_API_URL:origin+'/api',DAYTONA_API_KEY:'protocol-fixture-key',FINNOR_DAYTONA_PROTOCOL_FIXTURE:'1'},async close(){
  for(const child of children)child.kill('SIGKILL');
  server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));
  const records=[...boxes.values()].map(b=>({id:b.id,name:b.name,state:b.state,commands:b.commands,diagnostic:b.diagnostic??null}));
  await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'daytona-protocol.json'),JSON.stringify({schema:'finnor.daytona-sdk-http-fixture.v1',qualification:'REAL_SDK_HTTP_AND_NATIVE_PROCESSES_NOT_HOSTED_VM_ISOLATION',profile,calls,sandboxes:records,interruptedPid:interruptedPid??null,lostCommandAcknowledgement},null,2));
  for(const box of boxes.values())await rm(box.directory,{recursive:true,force:true});
 }};
}
