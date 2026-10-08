import { constants } from 'node:fs';
import { mkdir, open, link, unlink, rename, lstat, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { epistemicHash } from '../../../epistemic-runtime/src/source-precedence';
import type { PeMutationContext } from '../types';
import { principal } from './adapters';
import { assertBounded, DecisionSliceError, RefSchema, unavailable, type M1Ref } from './contracts';
import { checkEpisode, episodeDeadline } from './budget';

type Category='bindings'|'graphs'|'slices'|'contexts'|'attempts'|'publications'|'heads'|'working'|'context-heads'|'invalidations'|'locks'|'dependencies';
const categories:Category[]=['bindings','graphs','slices','contexts','attempts','publications','heads','working','context-heads','invalidations','locks','dependencies'];
const nativeFlock=createRequire(import.meta.url)('fs-ext').flock as
  (fd:number,operation:'exnb'|'un',callback:(error:NodeJS.ErrnoException|null)=>void)=>void;
const flock=(fd:number,operation:'exnb'|'un')=>new Promise<void>((yes,no)=>
  nativeFlock(fd,operation,error=>error?no(error):yes()));
const hex=(value:string):void=>{if(!/^[a-f0-9]{64}$/.test(value))throw unavailable();};
async function directory(path:string):Promise<void>{
  await mkdir(path,{recursive:true,mode:0o700});
  const st=await lstat(path);
  if(st.isSymbolicLink()||!st.isDirectory()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw unavailable();
}
async function root():Promise<string>{
  if(!process.env.FINNOR_M1_STORE)throw new DecisionSliceError('CONFIGURATION_REQUIRED','M1 private producer store is not configured');
  const path=resolve(process.env.FINNOR_M1_STORE);await directory(path);
  if(await realpath(path)!==path)throw unavailable();
  return path;
}
export async function scopedStore(ctx:PeMutationContext):Promise<string>{
  if(![ctx.auth.tenantId,principal(ctx)].every(id=>/^[a-f0-9-]{36}$/i.test(id)))throw unavailable();
  const base=await root(),tenant=join(base,ctx.auth.tenantId),actor=join(tenant,principal(ctx));
  await directory(tenant);await directory(actor);return actor;
}
async function pathFor(ctx:PeMutationContext,category:Category,key:string):Promise<string>{
  hex(key);if(!categories.includes(category))throw unavailable();
  const parent=join(await scopedStore(ctx),category);await directory(parent);return join(parent,`${key}.json`);
}
async function syncDirectory(path:string):Promise<void>{const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{await file.sync();}finally{await file.close();}}
export async function readPrivateText(ctx:PeMutationContext,category:Category,key:string):Promise<string>{
  try{
    // Reject FIFOs/devices after descriptor acquisition without waiting for a
    // writer. Stat-before-open alone would still race a disposable replacement.
    const path=await pathFor(ctx,category,key),fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const st=await fd.stat();if(!st.isFile()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0||st.size>8*1024*1024)throw unavailable();
      // A mutable regular file can grow after stat. Read at most the validated
      // size plus one byte, never an unbounded read-to-EOF allocation.
      const bytes=Buffer.alloc(st.size+1);
      let used=0;
      while(used<bytes.length){
        checkEpisode();
        const result=await fd.read(bytes,used,Math.min(65536,bytes.length-used),used);
        if(!result.bytesRead)break;used+=result.bytesRead;
      }
      if(used!==st.size)throw unavailable();
      return bytes.subarray(0,used).toString('utf8');
    }finally{await fd.close();}
  }catch{throw unavailable();}
}
export async function readPrivate<T>(ctx:PeMutationContext,category:Category,key:string):Promise<T>{
  try{return JSON.parse(await readPrivateText(ctx,category,key)) as T;}
  catch{throw unavailable();}
}
export async function readOptional<T>(ctx:PeMutationContext,category:Category,key:string):Promise<T|null>{
  const path=await pathFor(ctx,category,key);
  try{await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw unavailable();}
  return readPrivate<T>(ctx,category,key);
}
export async function writePrivate(ctx:PeMutationContext,category:Category,key:string,value:unknown,immutable=false):Promise<void>{
  assertBounded(value);const path=await pathFor(ctx,category,key),parent=resolve(path,'..');
  // Never replace an existing symlink, even for a disposable working object.
  try{const st=await lstat(path);if(st.isSymbolicLink()||!st.isFile()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw unavailable();}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const bytes=JSON.stringify(value),temporary=join(parent,`.${randomUUID()}.tmp`);
  const fd=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
  try{
    if(immutable){
      try{await link(temporary,path);}
      catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const old=await readPrivate(ctx,category,key);
        if(epistemicHash(old)!==epistemicHash(value))throw new DecisionSliceError('CONFLICT','Immutable decision record differs');}
    }else await rename(temporary,path);
    await syncDirectory(parent);
  }finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export async function writeRecord<T>(ctx:PeMutationContext,category:Category,ref:M1Ref,body:T):Promise<void>{
  if(ref.owner!=='M1'||epistemicHash(body)!==ref.contentDigest)throw new DecisionSliceError('CHECK_FAILED','Producer record preimage differs');
  await writePrivate(ctx,category,ref.contentDigest,{ref,body},true);
}
export async function readRecord<T>(ctx:PeMutationContext,category:Category,value:unknown):Promise<T>{
  const ref=RefSchema.parse(value);if(ref.owner!=='M1'||ref.version!=='m1-exact-dependency-v1'||!ref.id.endsWith(`:${ref.contentDigest}`))throw unavailable();
  const stored=await readPrivate<{ref:M1Ref;body:T}>(ctx,category,ref.contentDigest);
  if(epistemicHash(stored.ref)!==epistemicHash(ref)||epistemicHash(stored.body)!==ref.contentDigest)throw unavailable();
  return stored.body;
}
/** One physical lock shared by cold processes. A stale JS map is not a CAS. */
export async function withStoreLock<T>(ctx:PeMutationContext,key:string,invoke:()=>Promise<T>,deadlineAt=episodeDeadline()):Promise<T>{
  const path=await pathFor(ctx,'locks',key),fd=await open(path,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
  const st=await fd.stat();if(!st.isFile()||st.uid!==process.getuid?.()||(st.mode&0o077)!==0){await fd.close();throw unavailable();}
  let held=false;
  try{
    while(!held){
      try{await flock(fd.fd,'exnb');held=true;}
      catch(e){if(!['EAGAIN','EWOULDBLOCK'].includes((e as NodeJS.ErrnoException).code??''))throw e;
        if(performance.now()>=deadlineAt)throw new DecisionSliceError('LIMIT_EXCEEDED','Decision store contention consumed the episode deadline');
        await new Promise(r=>setTimeout(r,10));}
    }
    checkEpisode();return await invoke();
  }finally{try{if(held)await flock(fd.fd,'un');}finally{await fd.close();}}
}
