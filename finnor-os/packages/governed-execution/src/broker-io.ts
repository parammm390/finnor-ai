/** Fixed-route IO for the protected broker; no redirects, proxies or shared agents. */
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import {createHash} from 'node:crypto';
import {LedgerFault,canonical} from './protocol.js';

export const brokerHash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export const brokerBytesHash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export async function brokerPrivateFile(path:string,expectedDigest?:string){
 if(typeof path!=='string'||path.length<1||path.length>4096)throw new LedgerFault(503,'BROKER_FILE_PATH_INVALID');
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const st=await fd.stat();if(!st.isFile()||st.size>2*1024*1024||(st.mode&0o077)!==0||st.uid!==process.getuid?.())throw new LedgerFault(503,'BROKER_PRIVATE_FILE_UNSAFE');const bytes=await fd.readFile();if(expectedDigest!==undefined&&brokerBytesHash(bytes)!==expectedDigest)throw new LedgerFault(503,'BROKER_PRIVATE_FILE_CHANGED');return bytes;}
 finally{await fd.close();}
}
export async function brokerSourceDigests(paths:string[]){return Promise.all(paths.map(async path=>{const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await fd.stat();if(!st.isFile()||st.size>2*1024*1024)throw new LedgerFault(503,'BROKER_SOURCE_UNAVAILABLE');return {path,sha256:brokerBytesHash(await fd.readFile())};}finally{await fd.close();}}));}
export function brokerOrigin(value:unknown,domain:string){
 if(typeof value!=='string')throw new LedgerFault(503,'BROKER_ORIGIN_INVALID');const url=new URL(value);
 if(url.origin!==value||url.username||url.password||!(url.protocol==='https:'||domain==='DISPOSABLE_TEST_AUTHORITY'&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)))throw new LedgerFault(503,'BROKER_ORIGIN_INVALID');return url;
}
export function brokerToken(bytes:Buffer){const token=bytes.toString();if(!/^[\x21-\x7e]{16,4096}$/.test(token))throw new LedgerFault(503,'BROKER_TOKEN_INVALID');return token;}

export function brokerRequest(url:URL,options:{method:'GET'|'POST'|'PATCH';token:string;body?:unknown;ca?:Buffer;deadlineAt:number;ifMatch?:string}):Promise<{status:number;body:any;etag:string|null;responseDigest:string}>{
 const remaining=Math.min(10000,options.deadlineAt-Date.now());if(remaining<=0)return Promise.reject(new LedgerFault(503,'BROKER_WORK_DEADLINE'));
 const bytes=options.body===undefined?undefined:Buffer.from(canonical(options.body));if(bytes&&bytes.length>2*1024*1024)return Promise.reject(new LedgerFault(413,'BROKER_REQUEST_BOUND'));
 return new Promise((done,no)=>{
  let settled=false;const finish=(error?:Error,value?:any)=>{if(settled)return;settled=true;clearTimeout(timer);error?no(error):done(value);};
  const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:options.method,agent:false,rejectUnauthorized:true,...(options.ca?{ca:options.ca}:{}),headers:{authorization:'Bearer '+options.token,'content-type':'application/json','accept':'application/json','cache-control':'no-cache',...(bytes?{'content-length':bytes.length}:{}),...(options.ifMatch?{'if-match':options.ifMatch}:{})}},response=>{
   const chunks:Buffer[]=[];let count=0;
   response.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>1024*1024){response.destroy();finish(new LedgerFault(503,'BROKER_RESPONSE_BOUND'));}else chunks.push(chunk);});
   response.on('error',()=>finish(new LedgerFault(503,'BROKER_TRANSPORT_UNAVAILABLE')));
   response.on('end',()=>{try{const raw=Buffer.concat(chunks);const body=raw.length?JSON.parse(raw.toString()):null;finish(undefined,{status:response.statusCode??0,body,etag:typeof response.headers.etag==='string'?response.headers.etag:null,responseDigest:brokerBytesHash(raw)});}catch{finish(new LedgerFault(503,'BROKER_RESPONSE_JSON_INVALID'));}});
  });
  const timer=setTimeout(()=>{request.destroy();finish(new LedgerFault(503,'BROKER_TRANSPORT_DEADLINE'));},remaining);
  request.on('error',()=>finish(new LedgerFault(503,'BROKER_TRANSPORT_UNAVAILABLE')));
  if(bytes)request.end(bytes);else request.end();
 });
}
