/** Disposable protocol oracle for the existing ledger-integrity family.
 * This same-UID fixture is NOT a production nonrollbackable witness. */
import {createServer} from 'node:http';
import {readFile,writeFile,rename,open} from 'node:fs/promises';
import {createPrivateKey,sign,verify,createHash} from 'node:crypto';
import {dirname} from 'node:path';
const config=JSON.parse(await readFile(process.argv[2]!,'utf8'));
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort((a,b)=>a.localeCompare(b)).map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const key=createPrivateKey(await readFile(config.signerPath));
let head:{sequence:number;checkpointDigest:string|null};
try{head=JSON.parse(await readFile(config.headPath,'utf8'));}catch(e:any){if(e.code!=='ENOENT')throw e;head={sequence:0,checkpointDigest:null};}
let queue=Promise.resolve();
const persist=async()=>{const fd=await open(config.headPath+'.tmp','w',0o600);try{await fd.writeFile(canonical(head));await fd.sync();}finally{await fd.close();}await rename(config.headPath+'.tmp',config.headPath);const dir=await open(dirname(config.headPath),'r');try{await dir.sync();}finally{await dir.close();}};
const server=createServer((req,res)=>{queue=queue.then(async()=>{
 try{
  if(req.method!=='POST'||req.url!=='/commitment')throw Error('ROUTE');
  const chunks:Buffer[]=[];let size=0;for await(const raw of req){size+=raw.length;if(size>1024*1024)throw Error('BOUNDS');chunks.push(Buffer.from(raw));}
  const {signature,...body}=JSON.parse(Buffer.concat(chunks).toString());
  if(body.schema!=='finnor.s6.witness-request.v1'||body.ledgerId!==config.ledgerId||body.signerDigest!==config.signerDigest||typeof body.nonce!=='string'||body.nonce.length!==64||!verify(null,Buffer.from(canonical(body)),config.ledgerPublicKey,Buffer.from(signature,'base64')))throw Error('AUTHORITY');
  const mode=JSON.parse(await readFile(config.modePath,'utf8')).mode;
  if(mode==='UNAVAILABLE')throw Error('OUTAGE');
  const before={...head};
  if(body.operation==='ADVANCE'){
   if(hash(body.expectedHead)!==hash(head)||!Array.isArray(body.steps)||body.steps.length<1||body.steps.length>256)throw Error('COMPARE_AND_SWAP');
   let next={...head};for(const step of body.steps){
    if(Object.keys(step).sort().join(',')!=='checkpointDigest,previousCheckpoint,sequence'||step.sequence!==next.sequence+1||step.previousCheckpoint!==next.checkpointDigest||!/^[a-f0-9]{64}$/.test(step.checkpointDigest))throw Error('CHAIN');
    next={sequence:step.sequence,checkpointDigest:step.checkpointDigest};
   }head=next;await persist();
  }else if(body.operation!=='READ')throw Error('OPERATION');
  const answer={schema:'finnor.s6.witness-response.v1',ledgerId:config.ledgerId,signerDigest:config.signerDigest,operation:body.operation,nonce:mode==='NONCE_REPLAY'?'0'.repeat(64):body.nonce,...head,...(mode==='HEAD_FORK'?{checkpointDigest:'f'.repeat(64)}:{}),acknowledgedAt:new Date().toISOString()};
  const reply={...answer,signature:sign(null,Buffer.from(canonical(answer)),key).toString('base64')};
  const log=await open(config.transcriptPath,'a',0o600);try{await log.writeFile(canonical({request:body,before,response:reply,mode})+'\n');await log.sync();}finally{await log.close();}
  if(mode==='LOST_REPLY'&&body.operation==='ADVANCE'){await writeFile(config.modePath,JSON.stringify({mode:'NORMAL'}),{mode:0o600});req.socket.destroy();return;}
  res.writeHead(200,{'content-type':'application/json'});res.end(canonical(reply));
 }catch(e:any){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:String(e.message)}));}
},()=>undefined);});
await persist();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
console.log(JSON.stringify({status:'READY',port:(server.address() as any).port}));
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>server.close(()=>process.exit(0)));
