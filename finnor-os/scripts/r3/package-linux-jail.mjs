/** Build/seal the ordinary callee root. Run as image-build root only. */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmod,copyFile,lstat,mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
const [node,launcher,base,mode]=process.argv.slice(2);
if(process.getuid()!==0||!node||!launcher||base!==`/opt/finnor-s6-jail-${process.arch}`||!['x64','arm64'].includes(process.arch))throw Error('JAIL_BUILD_IDENTITY');
const root=base+'/root',hash=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(base,{recursive:true,mode:0o755});
await mkdir(root,{mode:0o755});
for(const path of ['lib','lib64','usr/lib','dev','jobs'])await mkdir(root+'/'+path,{recursive:true,mode:0o755});
await copyFile(await realpath(node),root+'/node');await chmod(root+'/node',0o555);
const listing=execFileSync('/usr/bin/ldd',[node],{encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin',LANG:'C'}});
const dependencies=[...new Set([...listing.matchAll(/(?:=>\s*)?(\/[^\s()]+)/g)].map(match=>match[1]))];
if(!dependencies.length||dependencies.length>32)throw Error('JAIL_DYNAMIC_RUNTIME_INVENTORY');
for(const path of dependencies){
 if(!/^\/(?:lib|lib64|usr\/lib)\//.test(path)||path.split('/').includes('..'))throw Error('JAIL_LIBRARY_PATH');
 await mkdir(dirname(root+path),{recursive:true,mode:0o755});
 await copyFile(await realpath(path),root+path);await chmod(root+path,0o555);
}
if(launcher!==base+'/launcher')await copyFile(launcher,base+'/launcher');
await chmod(base+'/launcher',0o555);
await chmod(root+'/jobs',0o1733);
const files=[];
async function visit(path){
 for(const name of await readdir(path)){
  const full=join(path,name),st=await lstat(full);
  if(full===root+'/jobs'||full===root+'/dev')continue;
  if(st.isDirectory()){if(st.uid!==0||(st.mode&0o022))throw Error('JAIL_DIRECTORY_CUSTODY');await visit(full);await chmod(full,0o555);}
  else if(st.isFile()&&st.uid===0&&!(st.mode&0o6022))files.push({path:full.slice(base.length+1),sha256:hash(await readFile(full))});
  else throw Error('JAIL_UNSEALED_ENTRY');
 }
}
await visit(root);files.push({path:'launcher',sha256:hash(await readFile(base+'/launcher'))});
const source=new URL('../../packages/governed-execution/native/linux-launcher.c',import.meta.url);
const lifetimeSource=new URL('../../packages/governed-execution/native/linux-lifetime.h',import.meta.url);
await writeFile(base+'/manifest.json',JSON.stringify({schema:'finnor.s6.fixed-jail.v1',architecture:process.arch,files:files.sort((a,b)=>a.path.localeCompare(b.path)),
 launcherSourceSha256:hash(await readFile(source)),launcherLifetimeSourceSha256:hash(await readFile(lifetimeSource)),bootstrapCapability:'CAP_SYS_CHROOT_ONLY_THEN_ZERO',landlockMinimumAbi:2,
 authority:'NONE_OUTPUT_UNTRUSTED',protectedExecution:'UNADMITTED'},null,2)+'\n',{mode:0o444,flag:'wx'});
await chmod(root,0o555);
if(mode!=='stage'){
 for(const [name,minor] of [['null',3],['random',8],['urandom',9]])execFileSync('/usr/bin/mknod',['-m','666',root+'/dev/'+name,'c','1',String(minor)]);
 execFileSync('/usr/sbin/setcap',['cap_sys_chroot=ep',base+'/launcher']);
}
