/** Actual owned filesystem refusal, registered before the atomic writer change. */
import assert from 'node:assert/strict';
import {chmod,mkdir,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {writeEvidenceJson} from './evidence.mts';

export async function evidenceAtomicCorrespondence(output:string,artifact:(name:string,value:unknown)=>Promise<unknown>){
 const directory=join(output,'owned-atomic-writer-control'),path=join(directory,'record.json');
 await mkdir(directory,{mode:0o700});
 await writeEvidenceJson(path,{generation:1,value:'complete owned evidence'});
 const before=await readFile(path),observations:Array<{cause:string}>=[];
 try{
  await chmod(directory,0o500);
  await assert.rejects(()=>writeEvidenceJson(path,{generation:2,value:'must not replace on refused write'}),
   (error:any)=>{observations.push({cause:error.code});return error.code==='EACCES';});
  assert.deepEqual(await readFile(path),before,'Refused write destroyed previous complete JSON');
 }finally{await chmod(directory,0o700);}
 assert.deepEqual(await readdir(directory),['record.json'],'Refused write left a temporary writer file');
 await writeEvidenceJson(path,{generation:3,value:'complete replacement after permission restoration'});
 assert.deepEqual(JSON.parse((await readFile(path)).toString()),{generation:3,value:'complete replacement after permission restoration'});
 const report={observations,previousCompleteBytesPreserved:true,temporaryFilesAbsent:true,actualPermissionRestored:true,
  successfulReplacementObserved:true,qualification:'ACTUAL_FS_EACCES_CONTROL_NOT_RECONSTRUCTED_ENOSPC_FINAL'};
 await artifact('evidence/atomic-writer-correspondence.json',report);return report;
}
