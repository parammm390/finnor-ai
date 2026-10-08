/** Failure model: a changed owner catalogue must invalidate the old immutable
 * derivation; restoration cannot resurrect it; a new process must acquire new
 * handles and produce a distinct checked derivation at the new closure. */
import {strict as assert} from 'node:assert';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {currentCodeIdentity,schemaIdentity} from '../../packages/private-equity/src/evidence-execution/store';
export async function schemaRestartFixture(e:any){
 const {test,ctx,admin,api,submit,finish,root,descriptor,validAt,program,evidence,tenant,actor}=e;
 await test('broad-P4-catalogue-native-restart',{mutation:'CREATE TABLE finnor_os.p1_catalogue_challenge',profile:'OWN_DISPOSABLE_DATABASE_ONLY'},'actual whole-schema mismatch refuses old values; physically fresh process freezes the changed closure and rederives without refreshing old hashes',async()=>{
  const original=await finish(await submit('C'));assert.equal(original.status,'TESTED');const prior=(await admin.query('SELECT digest,body FROM finnor_os.p4_derivations WHERE id=$1',[original.derivation.id])).rows[0];
  const before={code:await currentCodeIdentity(),schemaDigest:await schemaIdentity(ctx)};let invalid:any,child:any;
  await admin.query('CREATE TABLE finnor_os.p1_catalogue_challenge(id uuid PRIMARY KEY, flag boolean NOT NULL DEFAULT false)');
  try{
   const changed={code:await currentCodeIdentity(),schemaDigest:await schemaIdentity(ctx)};assert.equal(changed.code.digest,before.code.digest);assert.notEqual(changed.schemaDigest,before.schemaDigest);
   invalid=await api('evidence-read',{queryId:original.queryId});assert.equal(invalid.body.status,'INVALIDATED',JSON.stringify(invalid));assert(!invalid.body.derivation?.result);const witness=await api('evidence-witness',{queryId:original.queryId,output:'equity'});assert.equal(witness.status,422);
   const input=join(evidence,'catalogue-restart-input.json'),output=join(evidence,'catalogue-restart-child.json'),freeze=join(evidence,'catalogue-restart-freeze.json');
   await writeFile(input,JSON.stringify({tenant,actor,root:root('C'),validAt,descriptors:['EV','debt','EBITDA'].map(key=>({inputId:key,source:descriptor('C',key)})),request:{schema:'finnor.evidence-request.v1',question:'Reacquire exact current sources and rederive equity and leverage at the changed owner catalogue.',root:root('C'),validAt,mode:'ordinary_disposable',program,acceptance:{selectedUniverse:'COMPLETE',absoluteTolerance:'0',materialOutputs:['equity','leverage']}},output,freeze},null,2));
   let stdout='',stderr='';const result=await new Promise<{pid:number;code:number|null;signal:string|null}>((yes,no)=>{const p=spawn(process.execPath,['--import=tsx','scripts/p1/schema-restart-child.mts',input],{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>p.kill('SIGKILL'),90000);p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('error',no);p.once('exit',(code,signal)=>{clearTimeout(timer);yes({pid:p.pid!,code,signal});});});
   await writeFile(join(evidence,'catalogue-restart-process.json'),JSON.stringify({...result,stdout,stderr,parentPid:process.pid},null,2));assert.equal(result.code,0,stderr);assert.notEqual(result.pid,process.pid);
   child=JSON.parse(await readFile(output,'utf8'));assert.equal(child.frozen.schemaDigest,changed.schemaDigest);assert.notEqual(child.current.body.derivation.id,original.derivation.id);assert.equal(child.current.body.derivation.result.outputs.equity.value,'45');assert.equal(child.current.body.derivation.result.outputs.leverage.value,'3');
   const current=await api('evidence-read',{queryId:child.submitted.body.queryId});assert.equal(current.body.status,'TESTED');const immutable=(await admin.query('SELECT digest,body FROM finnor_os.p4_derivations WHERE id=$1',[original.derivation.id])).rows[0];assert.deepEqual(immutable,prior);
   await writeFile(join(evidence,'catalogue-restart-evidence.json'),JSON.stringify({before,changed,original,invalid,witness,child,current,oldBodyUnchanged:true},null,2));
  }finally{await admin.query('DROP TABLE finnor_os.p1_catalogue_challenge');}
  const restored=await api('evidence-read',{queryId:original.queryId});assert.equal(restored.body.status,'INVALIDATED');const childAfterRestoration=await api('evidence-read',{queryId:child.submitted.body.queryId});assert.equal(childAfterRestoration.body.status,'INVALIDATED');return {before,invalid,childPid:child.pid,childDerivationId:child.current.body.derivation.id,restored,childAfterRestoration,oldBodyUnchanged:true};
 });
}
