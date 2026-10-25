import {createHash,createPublicKey,verify} from 'node:crypto';
import {SignedPrimaryResponseSchema,SignedPrimaryRequestStatusSchema,type PrimaryRequest,type PrimarySourceProfile,type SignedPrimaryResponse,type SignedPrimaryRequestStatus} from '@finnor/shared-types';
import {brokerOrigin,brokerPrivateFile,brokerRequest,brokerToken} from './broker-io';
import {LedgerFault} from './protocol';

/** The primary signature contract sorts keys by code unit, never host locale. */
function primaryCanonical(value:unknown):string{
 let nodes=0;
 const encode=(v:unknown,depth:number):string=>{
  if(++nodes>100000||depth>64)throw new LedgerFault(413,'PRIMARY_JSON_COMPLEXITY_LIMIT');
  if(v===null)return 'null';
  if(typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(item=>encode(item,depth+1)).join(',')+']';
  if(v&&typeof v==='object'&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null)){
   const record=v as Record<string,unknown>;
   return '{'+Object.keys(record).sort().map(key=>JSON.stringify(key)+':'+encode(record[key],depth+1)).join(',')+'}';
  }
  throw new LedgerFault(400,'PRIMARY_NON_CANONICAL_JSON');
 };
 return encode(value,0);
}

export function primarySourceEndpoint(profile:PrimarySourceProfile){
 const protectedSource=profile.environment==='LIVE';
 if(!protectedSource&&(profile.environment!=='DEVELOPMENT'||profile.admissionRef!==null||process.env.NODE_ENV==='production'||process.env.FINNOR_V2_PROFILE!=='ordinary_disposable'))throw new LedgerFault(424,'LIVE_PRIMARY_S8_ROUTE_UNAVAILABLE');
 const endpoint=new URL(profile.endpoint);
 if(endpoint.pathname!=='/primary'||endpoint.search||endpoint.hash||endpoint.username||endpoint.password
  ||(protectedSource?endpoint.protocol!=='https:':endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'))
  throw new LedgerFault(422,protectedSource?'PRIMARY_PROTECTED_ORIGIN_REQUIRED':'PRIMARY_DISPOSABLE_ORIGIN_REQUIRED');
 brokerOrigin(endpoint.origin,protectedSource?'PROTECTED':'DISPOSABLE_TEST_AUTHORITY');
 return endpoint;
}

/** S6 fixed primary READ / positive-confirmation protocol. This is not the
 * conditional set-field intervention protocol, and cannot write a financial field. */
export async function primarySourceOperation(profile:PrimarySourceProfile,request:PrimaryRequest,input:{
 operation:'ACQUIRE'|'STATUS'|'PAGE'|'READ_RESULT';cursor?:string;deadlineAt:number;
}):Promise<{response:SignedPrimaryResponse|null;requestStatus:SignedPrimaryRequestStatus|null;transportDigest:string;status:number}>{
 const protectedSource=profile.environment==='LIVE',endpoint=primarySourceEndpoint(profile);
 const admission=protectedSource?await import('../../capability-evolution/src/primary-admission'):null;
 const route=admission?await admission.admittedPrimarySource(profile,{kind:'request',request,operation:input.operation}):{credentialDirectory:process.env.FINNOR_PRIMARY_CREDENTIAL_DIRECTORY,ca:undefined};
 if(!profile.credentialRef||!route.credentialDirectory)throw new LedgerFault(424,'PRIMARY_SCOPED_CREDENTIAL_UNAVAILABLE');
 if(!/^[A-Za-z0-9_-]{1,100}$/.test(profile.credentialRef))throw new LedgerFault(422,'PRIMARY_CREDENTIAL_REFERENCE_INVALID');
 const token=brokerToken(await brokerPrivateFile(route.credentialDirectory+'/'+profile.credentialRef));
 const url=new URL(input.operation==='ACQUIRE'?'/primary/requests':'/primary/requests/'+request.requestId+(input.operation==='STATUS'?'/status':''),endpoint.origin);
 if(input.operation==='PAGE'){if(!input.cursor||input.cursor.length>200)throw new LedgerFault(422,'PRIMARY_CURSOR_INVALID');url.searchParams.set('cursor',input.cursor);}
 const result=await brokerRequest(url,{method:input.operation==='ACQUIRE'?'POST':'GET',token,...(input.operation==='ACQUIRE'?{body:request}:{}),...(route.ca?{ca:route.ca}:{}),deadlineAt:input.deadlineAt});
 if(admission)await admission.admittedPrimarySource(profile,{kind:'request',request,operation:input.operation});
 if(result.status===404&&input.operation==='STATUS')return {response:null,requestStatus:null,transportDigest:result.responseDigest,status:404};
 if(result.status!==200&&result.status!==202)throw new LedgerFault(503,'PRIMARY_SOURCE_TRANSPORT_UNAVAILABLE');
 const response=input.operation==='STATUS'?SignedPrimaryRequestStatusSchema.parse(result.body):SignedPrimaryResponseSchema.parse(result.body);
 const publicKey=createPublicKey(profile.responsePublicKeyPem);
 if(publicKey.asymmetricKeyType!=='ed25519'||!verify(null,Buffer.from(primaryCanonical(response.body)),publicKey,Buffer.from(response.signature,'base64')))throw new LedgerFault(422,'PRIMARY_RESPONSE_SIGNATURE_INVALID');
 if(response.body.requestId!==request.requestId||response.body.requestDigest!==createHash('sha256').update(primaryCanonical(request)).digest('hex')||response.body.issuer!==profile.issuer||response.body.system!==profile.system||response.body.channelId!==profile.channelId||response.body.legalEntityId!==request.legalEntityId||
  'sourceClass' in response.body&&(response.body.sourceClass!==profile.sourceClass||response.body.sourceControl!==profile.sourceControl))throw new LedgerFault(422,'PRIMARY_EXACT_RESPONSE_BINDING_INVALID');
 return {response:input.operation==='STATUS'?null:response as SignedPrimaryResponse,requestStatus:input.operation==='STATUS'?response as SignedPrimaryRequestStatus:null,transportDigest:result.responseDigest,status:result.status};
}
