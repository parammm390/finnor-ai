/** Real disposable migration boundary, including upgrade/replay and unchanged
 * prior jobs. No X4 success/model/effect rows are supplied by this driver. */
import {resolve} from 'node:path';
import {strict as assert} from 'node:assert';
import {startEnvironment,artifact,repo} from '../x3/environment.mts';
const evidence=resolve(process.env.FINNOR_X4_EVIDENCE_DIR??resolve(repo,'scope-x4/evidence/migration-'+Date.now()));
const e=await startEnvironment(evidence,{migrationsOnly:true,baseHead:'0190_x5_experience_policy.sql'});
try{
 const tables=(await e.admin.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
  has_table_privilege('finnor_app',c.oid,'DELETE') app_delete
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='finnor_os' AND (c.relname LIKE 'x4_%' OR c.relname='s5_identification_charges') AND c.relkind='r' ORDER BY c.relname`)).rows;
 assert.equal(tables.length,12);assert(tables.every(t=>t.relrowsecurity&&t.relforcerowsecurity&&!t.app_delete));
 const triggers=(await e.admin.query(`SELECT c.relname,t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='finnor_os' AND NOT t.tgisinternal
  AND (c.relname LIKE 'x4_%' OR c.relname='s5_identification_charges') ORDER BY c.relname,t.tgname`)).rows;
 const policies=(await e.admin.query("SELECT resource_key,capacity,per_tenant_capacity,lease_seconds FROM finnor_os.compute_resource_policies WHERE resource_key LIKE 'native:x4-%' ORDER BY resource_key")).rows;
 assert.equal(policies.length,2);assert.equal(Number(policies.find(p=>p.resource_key==='native:x4-experiment')?.capacity),1);
 await artifact(evidence,'receipt.json',{schema:'finnor.x4.migration-preflight.v1',allPassed:true,tables,triggers,policies,
  boundary:'REAL_DISPOSABLE_POSTGRES_MIGRATION_UPGRADE_AND_REPLAY',hostedQualification:false,terminalScientificRowsInserted:0});
}catch(error){await artifact(evidence,'failure.json',{error:String(error),stack:(error as Error).stack});throw error;}
finally{await e.close();}
