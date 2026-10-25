/** Separate counterparty process. The product receives its public descriptor,
 * scoped credential and permitted request, not this administrator's records.
 * This synthetic custodian is not an independently sealed domain-test split. */
import {createServer as createHttpServer,type RequestListener} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {generateKeyPairSync,sign,createHash,timingSafeEqual} from 'node:crypto';
import {writeFile,open,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PrimaryRequestSchema} from '@finnor/shared-types';
const directory=process.argv[2];if(!directory||!directory.startsWith('/'))throw Error('OWNED_DIRECTORY_REQUIRED');
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const signed=(body:any)=>({body,signature:sign(null,Buffer.from(canonical(body)),privateKey).toString('base64')});
const profiles=new Map<string,any>(),requests=new Map<string,any>(),calls:any[]=[];
const durable=async()=>{const file=await open(join(directory,'source-ledger.json'),'w',0o600);try{await file.writeFile(JSON.stringify({requests:[...requests],calls}));await file.sync();}finally{await file.close();}};
const handler:RequestListener=async(req,res)=>{
 res.setHeader('content-type','application/json');
 try{
  const url=new URL(req.url??'/','http://127.0.0.1'),credential=String(req.headers.authorization??'').replace(/^Bearer /,''),profile=[...profiles.values()].find(p=>{
   const a=Buffer.from(p.credential),b=Buffer.from(credential);return a.length===b.length&&timingSafeEqual(a,b);
  });
  if(!profile){res.writeHead(403);res.end('{"code":"SOURCE_SCOPE_DENIED"}');return;}
  let record:any;
  if(req.method==='POST'&&url.pathname==='/primary/requests'){
   let bytes='';for await(const chunk of req){bytes+=chunk;if(Buffer.byteLength(bytes)>262144)throw Error('SOURCE_REQUEST_BOUND');}
   const q=PrimaryRequestSchema.parse(JSON.parse(bytes));
   if(q.sourceProfileRef.id!==profile.public.profileId||q.legalEntityId!==profile.public.legalEntityId||q.purpose!==profile.public.purpose||q.accountOrParticipantIds.some(id=>!profile.public.accountOrParticipantIds.includes(id))||q.fieldNames.some(id=>!profile.public.authoritativeFields.includes(id))){res.writeHead(403);res.end('{"code":"SOURCE_REQUEST_SCOPE_DENIED"}');return;}
   const old=requests.get(q.requestId);if(old&&hash(old.request)!==hash(q)){res.writeHead(409);res.end('{"code":"SOURCE_REQUEST_ID_CONFLICT"}');return;}
   record=old??{request:q,profileId:profile.public.profileId,acceptedAt:new Date().toISOString(),rawPages:null};
   requests.set(q.requestId,record);calls.push({operation:'ACQUIRE',requestId:q.requestId,requestDigest:hash(q),sourceProfileId:profile.public.profileId,duplicate:!!old,at:new Date().toISOString()});
   await durable();process.send?.({type:'accepted',requestId:q.requestId});
   if(profile.delayMs)await new Promise(yes=>setTimeout(yes,profile.delayMs));
  }else if(req.method==='GET'&&/^\/primary\/requests\/[a-f0-9-]{36}(?:\/status)?$/.test(url.pathname)){
   const id=url.pathname.split('/')[3]!;record=requests.get(id);
   calls.push({operation:url.pathname.endsWith('/status')?'STATUS':'READ_RESULT',requestId:id,sourceProfileId:profile.public.profileId,cursor:url.searchParams.get('cursor'),at:new Date().toISOString()});await durable();
   if(!record){res.writeHead(404);res.end('{"code":"REQUEST_NOT_FOUND"}');return;}
   if(record.profileId!==profile.public.profileId){res.writeHead(403);res.end('{"code":"SOURCE_SCOPE_DENIED"}');return;}
  }else{res.writeHead(404);res.end('{}');return;}
  const q=record.request,p=profile.public;
  const cost={receiptId:'provider:'+q.requestId,pricebookDigest:p.price.pricebookRef.contentDigest,microUsd:'300',possibleAdditionalMicroUsd:profile.paymentUnknown?'500':'0',final:!profile.paymentUnknown};
  if(url.pathname.endsWith('/status')){
   res.end(JSON.stringify(signed({schema:'finnor.primary-request-status.v1',requestId:q.requestId,requestDigest:hash(q),issuer:p.issuer,system:p.system,channelId:p.channelId,legalEntityId:p.legalEntityId,checkedAt:new Date().toISOString(),outcome:'ACKNOWLEDGED',resultAvailable:true,providerCost:cost})));return;
  }
  if(!record.rawPages){
   const observedAt=new Date().toISOString(),records=profile.records.map((r:any)=>({...r,
    fields:Object.fromEntries(Object.entries(r.fields).filter(([field])=>q.fieldNames.includes(field))),
    witnessFields:Object.fromEntries(Object.entries(r.witnessFields).filter(([field])=>q.fieldNames.includes(field))),
   }));
   const revenue=q.fieldNames.includes('revenue'),totalPages=profile.totalPages??1,size=Math.ceil(records.length/totalPages)||1;
   record.rawPages=Array.from({length:totalPages},(_,i)=>{
    const body={schema:'finnor.primary-response.v1',requestId:q.requestId,requestDigest:hash(q),issuer:p.issuer,system:p.system,legalEntityId:q.legalEntityId,channelId:p.channelId,
     respondentId:p.respondentId,respondentRole:p.respondentRole,respondentKnowledge:p.respondentKnowledge,sourceClass:p.sourceClass,sourceControl:p.sourceControl,
     sourceRevision:profile.sourceRevision??'ledger-v1',observedAt,status:profile.status??'OBSERVED',populationId:q.populationId,populationRevision:q.populationRevision,observedMembers:q.requiredMembers,
     coverage:{historyStart:q.periodStart,historyEnd:q.periodEnd,completeForMembers:q.requiredMembers,availableRecordKinds:profile.recordKinds,completePopulation:!revenue&&!profile.partial,
      nextCursor:i===totalPages-1?null:'page-'+(i+2),pageId:'page-'+(i+1),totalPages,missingReasons:revenue?['ANNUAL_PERFORMANCE_AND_REMAINDER_UNOBSERVED']:profile.missingReasons??[],measurementDesignRef:profile.measurementDesignRef??null},
     records:records.slice(i*size,(i+1)*size),providerCost:cost,suspiciousReasons:profile.suspiciousReasons??[]};
    if(profile.mutation==='wrong-entity')body.records=body.records.map((r:any)=>({...r,legalEntityId:profile.foreignEntity}));
    if(profile.mutation==='wrong-units')body.records=body.records.map((r:any)=>({...r,units:'cents'}));
    if(profile.mutation==='wrong-basis')body.records=body.records.map((r:any)=>({...r,basisDigest:'f'.repeat(64)}));
    if(profile.mutation==='wrong-request')body.requestDigest='f'.repeat(64);
    const response=signed(body);if(profile.mutation==='wrong-signature')response.signature=Buffer.alloc(64).toString('base64');return response;
   });await durable();
  }
  let page=Math.max(0,Number((url.searchParams.get('cursor')??'page-1').replace('page-',''))-1);
  if(profile.replayFirstPageOnce&&page===1&&!record.replayedFirstPage){page=0;record.replayedFirstPage=true;await durable();}
  const response=record.rawPages[page];
  if(!response){res.writeHead(404);res.end('{}');return;}res.end(JSON.stringify(response));
 }catch{if(!res.headersSent)res.writeHead(422);res.end('{"code":"CONTROLLED_SOURCE_REQUEST_REFUSED"}');}
};
const tls=process.argv[3]==='tls';
if(tls&&process.env.NODE_ENV!=='test')throw Error('DISPOSABLE_TLS_SOURCE_REQUIRED');
const server=tls?createHttpsServer({key:await readFile(join(directory,'source-tls.key')),cert:await readFile(join(directory,'source-tls.crt'))},handler):createHttpServer(handler);
await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();if(!address||typeof address==='string')throw Error('OWNED_SOURCE_PORT_REQUIRED');
const descriptor={origin:(tls?'https:':'http:')+'//127.0.0.1:'+address.port,publicKey:publicKey.export({format:'pem',type:'spki'}).toString(),pid:process.pid};
await writeFile(join(directory,'public-descriptor.json'),JSON.stringify(descriptor),{mode:0o600});process.send?.({type:'ready',...descriptor});
process.on('message',async(message:any)=>{
 if(message.type==='configure'){for(const p of message.profiles)profiles.set(p.public.profileId,p);await durable();process.send?.({type:'configured',id:message.id});}
 if(message.type==='inspect')process.send?.({type:'inspected',id:message.id,calls,requests:[...requests.values()].map(r=>({request:r.request,acceptedAt:r.acceptedAt}))});
 if(message.type==='settle'){const p=profiles.get(message.profileId);if(p)p.paymentUnknown=false;process.send?.({type:'settled',id:message.id});}
 if(message.type==='stop'){server.closeAllConnections();server.close(()=>process.exit(0));}
});
