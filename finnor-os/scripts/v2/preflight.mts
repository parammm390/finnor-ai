/** Actual disposable schema boundary, registered before its first invocation.
 * This is not a production no-op preflight, full V2 run or packaged-image proof. */
import {strict as assert} from 'node:assert';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {disposablePlatform} from './platform.mts';
import {migrate} from '../../packages/db/migrate';
const output=resolve(import.meta.dirname,'../../../scope-v/v2-primary-reality-due-diligence/evidence',`schema-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(output,{recursive:true});let platform:Awaited<ReturnType<typeof disposablePlatform>>|undefined;
const result:any={schema:'finnor.v2.schema-preflight.v1',startedAt:new Date().toISOString(),command:'node --import=tsx scripts/v2/preflight.mts',status:'NOT_RUN',imageProof:'NOT_RUN'};
try{
 platform=await disposablePlatform();
 result.migrationCount=platform.applied.length;
 const repeated=await migrate(platform.url);assert.equal(repeated.length,0);
 const policy=(await platform.admin.query("SELECT * FROM finnor_os.compute_job_type_policies WHERE job_type='advance_primary_diligence_v1'")).rows[0];assert(policy);
 const security=(await platform.admin.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='finnor_os' AND c.relkind IN('r','p') AND (relname LIKE 'v2_%' OR relname IN('s1_primary_observations','s6_primary_requests','s5_primary_charges','primary_governance_versions','primary_governance_heads'))")).rows;
 result.security=security;
 assert(security.length>=8&&security.every(r=>r.relrowsecurity&&r.relforcerowsecurity));
 result.status='PASS_DISPOSABLE_SCHEMA';result.migrationCount=platform.applied.length;result.repeatApplied=repeated;result.jobPolicy=policy;result.security=security;
}catch(error){result.status='FAIL';result.failure={message:(error as Error).message,cause:(error as Error).cause instanceof Error?((error as Error).cause as Error).message:undefined};process.exitCode=1;}
finally{await platform?.close().catch(()=>undefined);result.finishedAt=new Date().toISOString();await writeFile(resolve(output,'result.json'),JSON.stringify(result,null,2)+'\n');}
console.log(JSON.stringify({status:result.status,evidence:output,failure:result.failure}));process.exit(process.exitCode??0);
