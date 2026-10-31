/** Shared transport only. Each typed consumer owns policy and response binding. */
import {canonical} from '../../governed-execution/src/protocol';
import {privateFile} from './journal';
import {byteDigest,fault} from './contracts';

export async function capabilityConsumerCommand(
 policy:{endpoint:string;tokenPath:string;tokenHash:string;timeoutMs:number},
 operation:string,body:unknown,requestId:string,domain:'APPLICATION'|'INTERFACE'|'LEARNED_POLICY'|'IDENTIFIED_SYSTEM'|'CONFIDENTIAL'|'UNIFORM_ALGORITHM',
 profile?:'TOTAL_THEORY_V2',
){
 if(profile&&domain!=='UNIFORM_ALGORITHM')fault('S8_TYPED_TRANSPORT_PROFILE_MISMATCH');
 const prefix='S8_'+domain,token=await privateFile(policy.tokenPath,4096);
 if(byteDigest(token)!==policy.tokenHash)fault(prefix+'_TOKEN_CHANGED',403);
 const encoded=canonical({operation,body,requestId}),responseBound=profile?2097152:262144;
 if(profile&&Buffer.byteLength(encoded)>2097152)fault(prefix+'_REQUEST_BOUND',413);
 const response=await fetch(policy.endpoint+'/command',{method:'POST',
  headers:{authorization:'Bearer '+token.toString(),'content-type':'application/json'},
  body:encoded,redirect:'error',credentials:'omit',signal:AbortSignal.timeout(policy.timeoutMs)});
 if(!response.body)fault(prefix+'_EMPTY_RESPONSE');
 const chunks:Uint8Array[]=[];let size=0;const reader=response.body.getReader();
 try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>responseBound)fault(prefix+'_RESPONSE_BOUND');chunks.push(next.value);}}
 finally{await reader.cancel().catch(()=>undefined);}
 const data=JSON.parse(Buffer.concat(chunks).toString());
 if(!response.ok)fault(typeof data.code==='string'?data.code:prefix+'_COMMAND_REFUSED',response.status);
 return data;
}
