/** Retains genuine prefix-upgrade/replay observations, not a schema mock. */
import {resolve} from 'node:path';
import {startEnvironment,artifact} from './environment.mts';
const input=process.env.FINNOR_X3_EVIDENCE_DIR;
if(!input||!input.startsWith('/'))throw Error('FINNOR_X3_ABSOLUTE_EVIDENCE_DIRECTORY_REQUIRED');
const evidence=resolve(input),startedAt=new Date().toISOString(),started=performance.now();
try{
 const env=await startEnvironment(evidence,{migrationsOnly:true});
 await env.close();
 await artifact(evidence,'result.json',{status:'PASS_LOCAL',predicate:'Historical prefix, additive upgrade, idempotent replay and retained durable job',startedAt,elapsedMs:performance.now()-started,productionQualified:false});
 console.log('X3_MIGRATION_PROOF_PASS');
}catch(error){
 await artifact(evidence,'result.json',{status:'FAIL',startedAt,elapsedMs:performance.now()-started,error:String(error),stack:(error as Error).stack});
 throw error;
}
