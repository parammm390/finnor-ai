import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mjs';
import {POST as allocationPost} from '../../apps/api/app/api/allocations/[operation]/route';

export async function acquisitionSearchFixture(e:any,dealId:string){
 const {admin,tenant,actor,evidence}=e,root={entityType:'external_organization' as const,entityId:e.browserFixtureContext.companies.A};
 const directory=join(evidence,'acquisition-search-grant');await mkdir(directory,{recursive:true});
 const artifact=async(name:string,body:unknown)=>{const file=join(directory,name);await mkdir(join(file,'..'),{recursive:true});await writeFile(file,JSON.stringify(body,null,2));};
 const rows=spawnSync(process.env.FINNOR_S3_PYTHON!,['scripts/s3/reference.py'],{input:JSON.stringify({operation:'equivalent'}),encoding:'utf8'});assert.equal(rows.status,0,rows.stderr);
 const api=async(f:any,operation:string,body:unknown,handler=allocationPost)=>{const response=await handler(new Request('http://localhost/api/allocations/'+operation,{method:'POST',headers:{'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal},body:JSON.stringify(body)}),{params:Promise.resolve({operation})});return {status:response.status,body:await response.json()};};
 const day=86400000,support=createUpstreamFixtureSupport({admin:()=>admin,generatedRows:JSON.parse(rows.stdout).rows,begin:new Date(Math.floor(Date.now()/day)*day-128*day).toISOString(),day,fixtures:{},api,artifact});
 const f=await support.fixture('acquisition-search-'+randomUUID(),1,[{id:'compute',unit:'native-attempt',capacity:8,totalLimit:8,resourceClass:'COMPUTE'}],{existing:{tenant,principal:actor,root}});
 const policy=await support.policy(f,'compute',{compute:8});
 await support.resource(f,'compute','native-attempt','CUMULATIVE_EXPENDITURE',['8','8'],undefined,[],{permittedRoots:process.env.FINNOR_ACQUISITION_SEARCH_ROOT_REFUSAL==='1'?[root]:[root,{entityType:'pe_deal',entityId:dealId}]});
 const allocation=await api(f,'clear',support.clearing(f,{compute:['1']}));assert.equal(allocation.status,200,JSON.stringify(allocation));assert.equal(allocation.body.status,'FEASIBLE');
 await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source) VALUES('native:p2',2,2,0,60,'Disposable real P2 engineering capacity; original S5 grant remains separate') ON CONFLICT(resource_key) DO NOTHING");
 const ownerBindings={policyRef:policy.ref,allocationRef:allocation.body.certificate.ref};await artifact('accepted-grant.json',{ownerBindings,dealId,resource:f.resources[0],qualification:'GENUINE_NATIVE_ATTEMPT_OWNER_FIXTURE_NO_DOLLAR_OR_FIELD_VALUE_QUALIFICATION'});
 return ownerBindings;
}
