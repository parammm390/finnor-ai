/** Development build custody, not a protected signature or an execution grant. */
import {strict as assert} from 'node:assert';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {join,resolve,relative,sep} from 'node:path';
const repo=resolve(import.meta.dirname,'../../..'),
 hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex'),
 digest=(value:unknown)=>hash(Buffer.from(JSON.stringify(value)));
const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',maxBuffer:16777216}).trim();
export async function sourceCut(){
 const paths=[...new Set(execFileSync('git',['-C',repo,'ls-files','-c','-o','--exclude-standard','-z'],
  {encoding:'utf8',maxBuffer:16777216}).split('\0').filter(Boolean))].sort(),
  files:Array<{path:string;bytes:number;sha256:string;executable:boolean}>=[];
 for(const path of paths){
  const metadata=await lstat(join(repo,path));assert(metadata.isFile(),'REGULAR_SOURCE_PREIMAGES_REQUIRED:'+path);
  const bytes=await readFile(join(repo,path));files.push({path,bytes:bytes.length,sha256:hash(bytes),executable:!!(metadata.mode&0o111)});
 }
 return {head:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),dirty:git('status','--porcelain','--untracked-files=all')!=='',
  files,preimageDigest:digest(files),branch:git('branch','--show-current')};
}
export async function emittedFiles(root:string,excluded:ReadonlySet<string>=new Set()){
 const files:Array<{path:string;bytes:number;sha256:string}>=[];
 async function scan(directory:string){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const file=join(directory,entry.name),path=relative(root,file).split(sep).join('/');
   if(excluded.has(path)||path==='cache'||path.startsWith('cache/'))continue;
   assert(!entry.isSymbolicLink(),'REGULAR_EMITTED_PREIMAGES_REQUIRED:'+path);
   if(entry.isDirectory())await scan(file);
   else if(entry.isFile()){const bytes=await readFile(file);files.push({path,bytes:bytes.length,sha256:hash(bytes)});}
  }
 }
 await scan(root);files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);return files;
}
export async function currentApiReceipt(cut:Awaited<ReturnType<typeof sourceCut>>){
 const root=join(repo,'finnor-os/apps/api/.next'),receipt=JSON.parse(await readFile(join(root,'y3-build-receipt.json'),'utf8'));
 assert.equal(receipt.schema,'finnor.y3.emitted-api-build.v1');
 assert.equal(receipt.source.preimageDigest,cut.preimageDigest,'Y3_BUILT_API_SOURCE_PREIMAGE_STALE');
 assert.equal(receipt.source.head,cut.head,'Y3_BUILT_API_COMMIT_STALE');assert.equal(cut.dirty,false,'CLEAN_INSTALLED_Y3_SOURCE_REQUIRED');
 assert.equal(digest(await emittedFiles(root,new Set(['y3-build-receipt.json']))),digest(receipt.files),'Y3_BUILT_API_BYTES_CHANGED');
 return receipt;
}
