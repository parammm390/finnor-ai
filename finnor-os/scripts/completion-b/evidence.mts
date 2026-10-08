import {randomUUID} from 'node:crypto';
import {mkdir,rename,unlink,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';

export async function writeEvidenceJson(path:string,value:unknown):Promise<string>{
 const bytes=JSON.stringify(value,null,2)+'\n',directory=dirname(path),
  temporary=join(directory,'.evidence-'+randomUUID()+'.tmp');
 await mkdir(directory,{recursive:true});
 try{
  await writeFile(temporary,bytes,{flag:'wx'});
  await rename(temporary,path);
 }finally{
  await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});
 }
 return bytes;
}
