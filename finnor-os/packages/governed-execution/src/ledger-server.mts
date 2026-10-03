import { createServer } from 'node:http';
import { ExperienceLedger, LedgerFault } from './ledger.js';
const configPath=process.env.FINNOR_S6_LEDGER_CONFIG;
if(!configPath)throw new Error('MISSING_EXTERNAL_LEDGER_CONFIG');
const ledger=await ExperienceLedger.open(configPath,process.env.FINNOR_S6_LEDGER_RELEASE_ROOT??'');
// Port is an ordinary transport setting; authority is independently release-bound.
const {readFile}=await import('node:fs/promises');
const config=JSON.parse(await readFile(configPath,'utf8'));
const broker=config.dispatchConfigPath?await (await import('./dispatch-broker.js')).GovernedDispatchBroker.open(ledger,config.dispatchConfigPath,process.env.FINNOR_S6_DISPATCH_RELEASE_ROOT??''):null;
const server=createServer(async(req,res)=>{
 try{
  const header=req.headers.authorization;const owner=ledger.authenticate(typeof header==='string'&&header.startsWith('Bearer ')?header.slice(7):'');
  const path=new URL(req.url??'/', 'http://127.0.0.1').pathname;
  let answer:unknown;
  if(req.method==='GET'&&path==='/health')answer=await ledger.health(owner);
  else if(req.method==='GET'&&path.startsWith('/events/'))answer=await ledger.read(owner,decodeURIComponent(path.slice(8)));
  else if(req.method==='GET'&&path.startsWith('/references/'))answer=await ledger.readReference(owner,decodeURIComponent(path.slice(12)));
  else if(req.method==='GET'&&path.startsWith('/execution-handoff/'))answer=await ledger.readExecutionHandoff(owner,decodeURIComponent(path.slice(19)));
  else if(req.method==='POST'&&['/append','/references','/verify-request','/dispatch','/reconcile','/takeover'].includes(path)){
   let length=0;const chunks:Buffer[]=[];for await(const raw of req){const chunk=Buffer.from(raw);length+=chunk.length;if(length>8*1024*1024)throw new LedgerFault(413,'REQUEST_BYTE_LIMIT');chunks.push(chunk);}
   let input:unknown;try{input=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new LedgerFault(400,'INVALID_JSON');}
   if(path==='/takeover'){if(!broker)throw new LedgerFault(503,'PROTECTED_DISPATCH_UNADMITTED');answer=await broker.takeover(owner,input);}
   else if(path==='/dispatch'||path==='/reconcile'){if(!broker)throw new LedgerFault(503,'PROTECTED_DISPATCH_UNADMITTED');answer=await broker.execute(owner,input,path==='/reconcile');}
   else answer=path==='/append'?await ledger.append(owner,input):path==='/references'?await ledger.registerReference(owner,input):await ledger.verifyRequest(owner,input);
  }else throw new LedgerFault(404,'NOT_FOUND');
  res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(answer));
 }catch(error){const known=error instanceof LedgerFault;res.writeHead(known?error.status:503,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:known?error.code:'LEDGER_UNAVAILABLE'}));}
});
server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxConnections=256;
await new Promise<void>(done=>server.listen(config.port??0,'127.0.0.1',done));
console.log(JSON.stringify({status:'READY',port:(server.address() as any).port,domain:config.policy.domain,qualification:'Protection requires independently admitted OS/key/monotonic-state substrate'}));
let closing=false;for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{if(closing)return;closing=true;server.close(()=>{void ledger.close().then(()=>process.exit(0),()=>process.exit(1));});});
