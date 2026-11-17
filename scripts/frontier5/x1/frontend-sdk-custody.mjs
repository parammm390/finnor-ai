import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,realpath,open,mkdir} from 'node:fs/promises';
import {join,resolve,sep,isAbsolute} from 'node:path';

const assets=[
  ['frontend-package.json','package.json'],
  ['frontend-package-lock.json','package-lock.json'],
  ['sdk-package.json','node_modules/@supabase/supabase-js/package.json'],
  ['supabase.js','node_modules/@supabase/supabase-js/dist/umd/supabase.js'],
];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const metadata=s=>[s.dev,s.ino,s.size,s.mode,s.uid,s.gid,s.nlink,s.mtimeNs,s.ctimeNs].join(':');
async function directories(root,relative){
  const parts=relative?relative.split('/'):[];
  assert(!isAbsolute(relative)&&!relative.includes('\\')&&!relative.includes('\0')
    &&parts.every(p=>p&&p!=='.'&&p!=='..'),'W2_SDK_RELATIVE_PATH_REQUIRED');
  let path=root;const physical=await realpath(root),identities=[];
  for(const part of ['',...parts]){
    if(part)path=join(path,part);
    const s=await lstat(path,{bigint:true});
    assert(s.isDirectory()&&!s.isSymbolicLink(),'W2_SDK_DIRECTORY_SYMLINK_REFUSED');
    const actual=await realpath(path);
    assert(actual===physical||actual.startsWith(physical+sep),'W2_SDK_BORROWED_ROOT_REFUSED');
    identities.push([s.dev,s.ino,s.mode,s.uid,s.gid].join(':'));
  }
  return {physical,key:physical+':'+identities.join('/')};
}
async function ownedFile(root,relative){
  const parent=relative.split('/').slice(0,-1).join('/'),beforeParents=await directories(root,parent);
  const path=join(root,relative),physical=await realpath(path);
  assert(physical.startsWith(beforeParents.physical+sep),'W2_SDK_BORROWED_FILE_REFUSED');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=await handle.stat({bigint:true});
    assert(before.isFile()&&before.nlink===1n&&before.size>0n&&before.size<=1048576n,'W2_SDK_PUBLIC_FILE_BOUND');
    const buffer=Buffer.alloc(1048577);let size=0;
    while(size<buffer.length){
      const result=await handle.read(buffer,size,buffer.length-size,null);
      if(!result.bytesRead)break;size+=result.bytesRead;
    }
    const after=await handle.stat({bigint:true}),named=await lstat(path,{bigint:true});
    assert(BigInt(size)===before.size&&size<=1048576&&metadata(after)===metadata(before)
      &&metadata(named)===metadata(before)&&!named.isSymbolicLink(),'W2_SDK_PUBLIC_FILE_CHANGED');
    assert.equal((await directories(root,parent)).key,beforeParents.key,'W2_SDK_PARENT_CHANGED');
    assert.equal(await realpath(path),physical,'W2_SDK_FILE_LOCATION_CHANGED');
    const bytes=buffer.subarray(0,size);
    return {bytes,sha256:sha(bytes),metadata:metadata(before),parents:beforeParents.key,mode:Number(before.mode&0o7777n)};
  }finally{await handle.close();}
}

// The closure retains only four public files from this build's own installation.
export async function captureFrontendSdkCustody(repo){
  const root=resolve(repo),before=await Promise.all(assets.map(([,path])=>ownedFile(root,path)));
  const [frontend,lock,sdk]=before.slice(0,3).map(file=>JSON.parse(file.bytes.toString('utf8')));
  const name='@supabase/supabase-js';
  assert.equal(frontend.name,'centropy');assert.equal(lock.lockfileVersion,3);
  assert.equal(lock.name,frontend.name);assert.equal(lock.version,frontend.version);
  assert.equal(lock.packages?.['']?.name,frontend.name);assert.equal(lock.packages?.['']?.version,frontend.version);
  assert.equal(frontend.dependencies?.[name],'^2.45.1');
  assert.equal(lock.packages?.['']?.dependencies?.[name],frontend.dependencies[name]);
  assert.equal(sdk.name,name);assert.equal(sdk.version,'2.99.3');
  assert.equal(lock.packages?.['node_modules/'+name]?.version,sdk.version);
  assert.equal(before[3].bytes.length,166800);
  assert.equal(before[3].sha256,'588fb53d9380e3cb8688065c48144fa839205c328b416cc68c11331ba01955ee');
  return async(runtime,projectPath)=>{
    const after=await Promise.all(assets.map(([,path])=>ownedFile(root,path)));
    for(let i=0;i<assets.length;i++){
      assert.equal(after[i].metadata,before[i].metadata,'W2_SDK_SOURCE_REPLACED_DURING_BUILD');
      assert.equal(after[i].parents,before[i].parents,'W2_SDK_SOURCE_PARENT_REPLACED_DURING_BUILD');
      assert(after[i].bytes.equals(before[i].bytes),'W2_SDK_SOURCE_BYTES_CHANGED_DURING_BUILD');
    }
    await directories(runtime,projectPath);
    const relative=[projectPath,'.finnor-w2-sdk-custody'].filter(Boolean).join('/');
    await mkdir(join(runtime,relative),{mode:0o700});
    for(let i=0;i<assets.length;i++){
      const path=relative+'/'+assets[i][0],handle=await open(join(runtime,path),
        constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o444);
      try{await handle.writeFile(before[i].bytes);await handle.sync();}finally{await handle.close();}
      const staged=await ownedFile(runtime,path);
      assert.equal(staged.mode,0o444);assert.equal(staged.sha256,before[i].sha256);
    }
  };
}
