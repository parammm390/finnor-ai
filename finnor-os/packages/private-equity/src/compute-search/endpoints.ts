import {env as runtimeEnvironment} from 'node:process';
import {z} from 'zod';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {sha,stable} from '../evidence-execution/store';
import {tx} from '../evidence-execution/store';
import type {PeMutationContext} from '../types';
// Trusted server configuration; request data cannot choose arbitrary egress.
const limit=z.number().int().min(1).max(10000000);
export const EndpointSchema=z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),kind:z.literal('DIAGNOSTIC_MODEL'),provider:z.literal('LOCAL_HTTP_FIXTURE'),
 model:z.string().min(1).max(128),region:z.null(),tier:z.literal('ordinary-diagnostic'),url:z.string().url().max(2048),
 limits:z.object({concurrency:limit.max(2),rpm:limit,inputTpm:limit,outputTpm:limit,tpd:limit,maxOutputTokens:limit.max(4096)}).strict(),
 source:z.literal('PREDECLARED_LOCAL_POLICY_NOT_PROVIDER_QUOTA'),windowMs:z.literal(60000),expiresAt:z.string().datetime(),price:z.null()}).strict();
export type Endpoint=z.infer<typeof EndpointSchema>&{key:string;digest:string};
export async function readEndpointConfig():Promise<Endpoint[]> {
 const path=process.env.FINNOR_P2_ENDPOINT_CONFIG;if(!path)return [];
 if(runtimeEnvironment.NODE_ENV==='production'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable')throw Error('P2_DIAGNOSTIC_ENDPOINT_PROFILE_REQUIRED');
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try {const st=await fd.stat();if(!st.isFile()||st.size>16384||st.uid!==process.getuid?.())throw Error('P2_ENDPOINT_CONFIG_BOUNDS_OR_OWNER');
  const value=z.object({schema:z.literal('finnor.p2.endpoint-config.v1'),endpoints:z.array(EndpointSchema).max(4)}).strict().parse(JSON.parse(await fd.readFile('utf8')));
  if(new Set(value.endpoints.map(e=>e.id)).size!==value.endpoints.length)throw Error('P2_DUPLICATE_ENDPOINT');
  return value.endpoints.map(e=>{const url=new URL(e.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.hash||url.search)throw Error('P2_ORDINARY_LOOPBACK_ROUTE_REQUIRED');
   if(Date.parse(e.expiresAt)<=Date.now())throw Error('P2_ENDPOINT_SNAPSHOT_EXPIRED');
   return {...e,key:sha({provider:e.provider,model:e.model,region:e.region,tier:e.tier,url:e.url}),digest:sha(e)};
  });
 }finally{await fd.close();}
}
export function endpointProjection(e:Endpoint){return {id:e.id,key:e.key,digest:e.digest,provider:e.provider,requestedModel:e.model,region:e.region,tier:e.tier,limits:e.limits,windowMs:e.windowMs,expiresAt:e.expiresAt,source:e.source,price:e.price,qualification:'LOCAL_POLICY_NO_DOCUMENTED_PROVIDER_QUOTA_OR_MODEL_ADMISSION'};}
export function sameEndpoint(a:Endpoint,b:Endpoint){return a.digest===b.digest&&stable(a)===stable(b);}
export async function nativeCapacitySnapshot(ctx:PeMutationContext,model:boolean){
 const keys=model?['native:p2','model:global','model-provider:LOCAL_HTTP_FIXTURE']:['native:p2'];
 const rows=await tx(ctx,async c=>(await c.query('SELECT resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source FROM finnor_os.compute_resource_policies WHERE resource_key=ANY($1::text[]) ORDER BY resource_key',[keys])).rows,true);
 if(rows.length!==keys.length)throw Error('P2_REQUIRED_PHYSICAL_CAPACITY_POLICY_UNAVAILABLE');
 return {schema:'finnor.p2.physical-capacity-snapshot.v1',digest:sha(rows),rows,qualification:'ACTUAL_SHARED_ENGINEERING_POLICY_NOT_FUNDING_OR_PROVIDER_QUOTA'};
}
