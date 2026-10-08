import { createServer } from 'node:http';
import type { ExtractedEffectEvaluation } from './internal-types';
import { remainingMs } from './budget';
import { hash, type Validation } from './contracts';

/** Isolated generated development handler. Never calls a live adapter or S6 dispatch. */
export async function executeEffectFixture(e:ExtractedEffectEvaluation,signal?:AbortSignal):Promise<Validation>{
  const input=e.request,records:Record<string,{entityId:string;fields:Record<string,string|null>;unit:string;currency:string|null;operation:string|null}>={
    C_01:{entityId:'C_01',fields:{credit_limit:'0',note:'retained'},unit:input.unit,currency:input.currency,operation:null},
    C_010:{entityId:'C_010',fields:{credit_limit:'0',note:'retained'},unit:input.unit,currency:input.currency,operation:null},
  };
  let posts=0,appliedEntity=input.entityId as string,appliedValue:string|null=input.operation==='CLEAR'?null:input.value;
  const server=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
    if(req.method==='POST'&&req.url==='/apply'){
      let bytes='';for await(const chunk of req){bytes+=chunk;if(Buffer.byteLength(bytes)>4096){res.writeHead(413);res.end('{}');return;}}
      const request=JSON.parse(bytes);
      if(hash(request)!==hash(input)){res.writeHead(400);res.end('{}');return;}
      posts++;
      appliedEntity=e.fixture==='WRONG_TARGET'?(input.entityId==='C_01'?'C_010':'C_01'):input.entityId;
      appliedValue=e.fixture==='WRONG_AMOUNT'?'200':input.operation==='CLEAR'||e.fixture==='CLEAR'?null:input.value;
      records[appliedEntity]!.fields[input.field]=appliedValue;
      records[appliedEntity]!.operation=e.fixture==='CLEAR'?'CLEAR':input.operation;
      // The deliberately uncertain response cannot authorize observation/settlement.
      res.end(JSON.stringify({accepted:true,outcome:e.fixture==='UNKNOWN'?'UNKNOWN':'ACKNOWLEDGED'}));return;
    }
    if(req.method==='GET'&&req.url?.startsWith('/observe/')){
      const id=decodeURIComponent(req.url.slice('/observe/'.length));
      if(!Object.hasOwn(records,id)){res.writeHead(404);res.end('{}');return;}
      res.end(JSON.stringify({record:records[id],operationObserved:e.fixture==='UNKNOWN'?null:input.idempotencyKey}));return;
    }
    res.writeHead(404);res.end('{}');
  });
  await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  try{
    const address=server.address();if(!address||typeof address==='string')throw Error('FIXTURE_LOOPBACK_UNAVAILABLE');
    const url=`http://127.0.0.1:${address.port}`,abort=AbortSignal.any([AbortSignal.timeout(remainingMs()),...(signal?[signal]:[])]);
    const ack=await fetch(url+'/apply',{method:'POST',body:JSON.stringify(input),headers:{'content-type':'application/json'},signal:abort});
    const acknowledged=await ack.json();
    // Full independently read records, not the mutation response or a substring.
    const observed=await Promise.all(['C_01','C_010'].map(async id=>{
      const response=await fetch(url+'/observe/'+encodeURIComponent(id),{signal:abort});
      if(response.status!==200)throw Error('INDEPENDENT_OBSERVER_UNAVAILABLE');return response.json() as Promise<any>;
    }));
    const wanted=observed.find(o=>o.record.entityId===input.entityId)!;
    const actual=observed.find(o=>o.record.entityId===appliedEntity)!;
    const expected=input.operation==='CLEAR'?null:input.value;
    const valid=e.fixture!=='UNKNOWN'&&(actual.record.entityId!==input.entityId||
      actual.record.fields[input.field]!==expected||wanted.record.fields[input.field]!==expected||actual.record.operation!==input.operation);
    return {status:e.fixture==='UNKNOWN'?'UNRESOLVED':valid?'VALID':'INVALID',
      reason:e.fixture==='UNKNOWN'?'UNKNOWN_OUTCOME_RECONCILIATION_REQUIRED':valid?'EXACT_TARGET_FIELD_VALUE_MISMATCH':'PREDICATE_HOLDS',
      failureKey:valid?hash({entity:input.entityId,field:input.field,expected,observedEntity:actual.record.entityId,
        observed:actual.record.fields[input.field],operation:actual.record.operation,unit:input.unit,currency:input.currency}):null,
      qualification:'ISOLATED_LOOPBACK_H0_FIXTURE_NOT_AUTHORIZED_PROVIDER',material:valid,
      native:{checker:'M4_ISOLATED_HANDLER_V1',observed:acknowledged,trace:{request:input,posts}},
      independent:{checker:'M4_INDEPENDENT_LOOPBACK_GET_V1',observed:{requestedEntity:input.entityId,
        observedEntity:actual.record.entityId,field:input.field,requested:expected,observed:actual.record.fields[input.field],
        operation:actual.record.operation,expectedOperation:input.operation,unit:input.unit,currency:input.currency},trace:observed},
      predicate:{expected,relation:'EXACT_ENTITY_FIELD_VALUE_AND_NULL',location:input.entityId+'.'+input.field,unit:input.unit}};
  }finally{
    server.closeAllConnections();
    await new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes()));
  }
}
