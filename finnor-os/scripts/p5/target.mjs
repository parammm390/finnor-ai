// Independently owned application. No product helpers, code, receipts or oracles.
import {createServer} from 'node:http';
import {writeFileSync, renameSync, readFileSync} from 'node:fs';
const path=process.argv[2];
if(!path)throw Error('Owned state path required');
let state={mode:'normal',variant:'alpha',layout:'reversed',boundary:'submit',
 records:{C_01:{name:'Same company',price:1000,version:1,operationId:null},
 C_010:{name:'Same company',price:1000,version:1,operationId:null}},writes:[],requests:[]};
const save=()=>{writeFileSync(path+'.new',JSON.stringify(state));renameSync(path+'.new',path);};
const revision=r=>'"v'+r.version+'"';
save();
function schema(){
 const v=state.variant,bodyKey=v==='alpha'?'quoted_minor':'fee_minor_v2';
 const readKey=v==='alpha'?'settled_minor':'current_amount_v2';
 const account=v==='alpha'?'ledger':'book',entity=v==='alpha'?'entry':'party';
 return {openapi:'3.1.1',info:{title:'Independent disposable lender application',version:v},
 paths:{[`/ledgers/{${account}}/entries/{${entity}}`]:{
  parameters:[{name:account,in:'path',required:true,schema:{type:'string'},'x-finnor-role':'account'},
   {name:entity,in:'path',required:true,schema:{type:'string'},'x-finnor-role':'entity'}],
  patch:{operationId:'amend-fee-'+v,'x-finnor-operation':{meaning:'set-record-field',field:'price',unit:'currency',currency:'USD',encoding:'minor_integer',decimalPlaces:2,nullable:true},
   parameters:[{name:'If-Match',in:'header',required:true,schema:{type:'string'},'x-finnor-role':'revision'},
    {name:'X-Operation-Id',in:'header',required:true,schema:{type:'string'},'x-finnor-role':'operationId'}],
   requestBody:{required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,required:[bodyKey],properties:{[bodyKey]:{type:['integer','null'],'x-finnor-role':'value'}}}}}},
   responses:{'200':{description:'Acknowledgement, not settlement'}}},
  get:{operationId:'read-entry-'+v,responses:{'200':{description:'Independent persisted state',
   content:{'application/json':{schema:{type:'object',additionalProperties:false,
    required:['ledger_id','entity_id',readKey,'etag','operation_id','unit','currency'],
    properties:{ledger_id:{type:'string','x-finnor-role':'account'},entity_id:{type:'string','x-finnor-role':'entity'},
     [readKey]:{type:['integer','null'],'x-finnor-role':'value'},etag:{type:'string','x-finnor-role':'revision'},
     operation_id:{type:['string','null'],'x-finnor-role':'operationId'},unit:{type:'string','const':'currency','x-finnor-role':'unit'},
     currency:{type:'string','const':'USD','x-finnor-role':'currency'}}}}}}}}
 }},'x-finnor-effect-history':{path:'/history/{account}/{operationId}',accountParameter:'account',operationParameter:'operationId'}};
}
const escape=s=>s.replace(/[&"<>]/g,c=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[c]));
function html(){
 const names=state.variant==='alpha'?['fee','request_key']:['novel_charge','association_v2'];
 const forms=Object.entries(state.records).map(([id,r])=>{
  const amount=`<label>Quoted fee<input name="${names[0]}" data-field="price" data-unit="currency" data-currency="USD" data-places="2" value="${r.price===null?'':(r.price/100).toFixed(2)}"></label>`;
  return `<form data-account="test-account" data-entity="${id}" data-revision="${escape(revision(r))}" data-boundary="${state.boundary}">
   <h2>${r.name}</h2><p>Record ${id}</p><label>Request identity<input name="${names[1]}" data-role="operationId"></label>
   ${state.layout==='duplicate'?amount+amount:amount}<label>Clear fee<input type="checkbox" data-action="explicit-null"></label>
   ${state.boundary==='submit'?'<button type="submit">Apply fee</button>':''}</form>`;
 });
 if(state.layout==='reversed')forms.reverse();
 return `<!doctype html><html><head><title>Disposable lender records</title></head><body><h1>Permitted test application</h1>${forms.join('')}
 <p id="status" role="status">Not submitted</p><script>
 document.querySelectorAll('form').forEach(form=>{
  const send=async event=>{event?.preventDefault();const field=form.querySelector('[data-field]'),request=form.querySelector('[data-role]'),clear=form.querySelector('[data-action]');
   const key=${JSON.stringify(state.variant==='alpha'?'quoted_minor':'fee_minor_v2')};
   const original='/ledgers/'+encodeURIComponent(form.dataset.account)+'/entries/'+encodeURIComponent(form.dataset.entity);
   const options=
   {method:'PATCH',headers:{'Content-Type':'application/json','If-Match':form.dataset.revision,'X-Operation-Id':request.value},
   body:JSON.stringify({[key]:clear.checked?null:Math.round(Number(field.value)*100)})};
   ${state.mode==='ui-wrong-extra'?"await fetch('/ledgers/test-account/entries/C_010',options);":''}
   const response=await fetch(original,options);
   ${state.mode==='ui-duplicate'?'await fetch(original,options);':''}
   document.querySelector('#status').textContent=response.ok?'Green acknowledgement':'Not confirmed';};
  if(form.dataset.boundary==='submit')form.addEventListener('submit',send);
  else form.querySelector('[data-field]').addEventListener('change',send);
 });
 ${state.mode==='ui-discovery-write'?`fetch('/ledgers/test-account/entries/C_010',{method:'PATCH',headers:{'Content-Type':'application/json','If-Match':'"v1"','X-Operation-Id':'forbidden-discovery'},body:JSON.stringify({${JSON.stringify(state.variant==='alpha'?'quoted_minor':'fee_minor_v2')}:20000})});`:''}
 </script></body></html>`;
}
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  state.requests.push({method:req.method,path:url.pathname});save();
  const json=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
  const body=async()=>{let text='';for await(const chunk of req){text+=chunk;if(text.length>16384)throw Error('TARGET_INPUT_BOUND');}return JSON.parse(text||'{}');};
  if(url.pathname==='/docs'&&req.method==='GET'){
   if(state.mode==='pause-docs')await new Promise(yes=>setTimeout(yes,10000));
   return json(schema());
  }
  if(url.pathname==='/ui'&&req.method==='GET'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end(html());return;}
  if(url.pathname==='/control'&&req.method==='POST'){const change=await body();state={...state,...change};save();return json({changed:true});}
  if(url.pathname==='/reference'&&req.method==='GET')return json(JSON.parse(readFileSync(path,'utf8')));
  const h=url.pathname.match(/^\/history\/([^/]+)\/([^/]+)$/);
  if(h&&req.method==='GET'){if(h[1]!=='test-account')return json({code:'unavailable'},404);if(state.mode==='no-observer')return json({code:'unavailable'},503);return json({account:h[1],operationId:decodeURIComponent(h[2]),writes:state.writes.filter(w=>w.operationId===decodeURIComponent(h[2]))});}
  const m=url.pathname.match(/^\/ledgers\/([^/]+)\/entries\/([^/]+)$/);
  if(m){
   const account=decodeURIComponent(m[1]),id=decodeURIComponent(m[2]),r=state.records[id];
   if(account!=='test-account'||!r)return json({code:'unavailable'},404);
   if(req.method==='GET'){
    if(state.mode==='pause-observation')await new Promise(yes=>setTimeout(yes,10000));
    if(state.mode==='no-observer')return json({code:'unavailable'},503);
    const observed=state.mode==='wrong-entity'?state.records.C_010:r;
    const readKey=state.variant==='alpha'?'settled_minor':'current_amount_v2';
    const data={ledger_id:account,entity_id:state.mode==='wrong-entity'?'C_010':id,etag:revision(observed),
     operation_id:state.mode==='wrong-operation'?'other-operation':observed.operationId,unit:'currency',currency:state.mode==='wrong-currency'?'EUR':'USD'};
    if(state.mode!=='missing')data[readKey]=observed.price;
    if(state.mode==='empty')data[readKey]='';
    if(state.mode==='stale-version')data.etag='"v1"';
    return json(data);
   }
   if(req.method==='PATCH'){
    const b=await body(),key=state.variant==='alpha'?'quoted_minor':'fee_minor_v2';
    const op=req.headers['x-operation-id'];
    if(!op||req.headers['if-match']!==revision(r)||Object.keys(b).length!==1||!Object.hasOwn(b,key)||
     b[key]!==null&&!Number.isSafeInteger(b[key]))return json({code:'conditional-binding-refused'},409);
    if(state.writes.some(w=>w.operationId===op))return json({code:'operation-identity-conflict'},409);
    const target=state.mode==='wrong-write'?'C_010':id,record=state.records[target];
    record.price=state.mode==='times-ten'&&b[key]!==null?b[key]*10:b[key];record.version++;record.operationId=op;
    const write={account,entity:target,field:'price',value:record.price,unit:'currency',currency:'USD',operationId:op,revision:revision(record),at:new Date().toISOString()};
    state.writes.push(write);
    if(state.mode==='wrong-then-correct'){state.writes.push({...write,entity:'C_010'});state.records.C_010.price=record.price;}
    save();
    if(state.mode==='lost-response'||state.mode==='pause-after-write'){
     if(state.mode==='lost-response'){req.socket.destroy();return;}
     setTimeout(()=>json({greenToast:true}),10000);return;
    }
    if(state.mode==='partial'){res.writeHead(200,{'content-type':'application/json'});res.end('{"greenToast":');return;}
    return json({greenToast:true,reportedValue:20,reportedCompany:'Same company'});
   }
  }
  return json({code:'not-found'},404);
 }catch{res.writeHead(400,{'content-type':'application/json'});res.end('{"code":"invalid-request"}');}
});
server.requestTimeout=12000;
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,path,qualification:'INDEPENDENT_DISPOSABLE_TARGET'})));
process.once('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
