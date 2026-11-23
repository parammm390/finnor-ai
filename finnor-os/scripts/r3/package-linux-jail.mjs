/** Build/seal the ordinary callee root. Run as image-build root only. */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmod,chown,copyFile,lstat,mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
const [node,launcher,base,mode,profile,specialistFilter]=process.argv.slice(2);
if(process.getuid()!==0||!node||!launcher||base!==`/opt/finnor-s6-jail-${process.arch}`||!['x64','arm64'].includes(process.arch))throw Error('JAIL_BUILD_IDENTITY');
if(profile&&(profile!=='specialist-dev'||mode!=='stage'||!specialistFilter))
 throw Error('SPECIALIST_DEV_STAGE_AND_FILTER_REQUIRED');
const root=base+'/root',hash=bytes=>createHash('sha256').update(bytes).digest('hex');
await mkdir(base,{recursive:true,mode:0o755});
await mkdir(root,{mode:0o755});
for(const path of ['lib','lib64','usr/lib','dev','jobs'])await mkdir(root+'/'+path,{recursive:true,mode:0o755});
await copyFile(await realpath(node),root+'/node');await chown(root+'/node',0,0);await chmod(root+'/node',0o555);
const listing=execFileSync('/usr/bin/ldd',[node],{encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin',LANG:'C'}});
const dependencies=[...new Set([...listing.matchAll(/(?:=>\s*)?(\/[^\s()]+)/g)].map(match=>match[1]))];
if(!dependencies.length||dependencies.length>32)throw Error('JAIL_DYNAMIC_RUNTIME_INVENTORY');
for(const path of dependencies){
 if(!/^\/(?:lib|lib64|usr\/lib)\//.test(path)||path.split('/').includes('..'))throw Error('JAIL_LIBRARY_PATH');
 await mkdir(dirname(root+path),{recursive:true,mode:0o755});
 await copyFile(await realpath(path),root+path);await chown(root+path,0,0);await chmod(root+path,0o555);
}
if(launcher!==base+'/launcher')await copyFile(launcher,base+'/launcher');
await chown(base+'/launcher',0,0);await chmod(base+'/launcher',0o555);
await chmod(root+'/jobs',0o1733);
const files=[];
async function visit(path){
 for(const name of await readdir(path)){
  const full=join(path,name),st=await lstat(full);
  if(full===root+'/jobs'||full===root+'/dev')continue;
  if(st.isDirectory()){if(st.uid!==0||(st.mode&0o022))throw Error('JAIL_DIRECTORY_CUSTODY');await visit(full);await chmod(full,0o555);}
  else if(st.isFile()&&st.uid===0&&!(st.mode&0o6022))files.push({path:full.slice(base.length+1),sha256:hash(await readFile(full))});
  else throw Object.assign(Error('JAIL_UNSEALED_ENTRY'),{path:full.slice(base.length+1),ownerUid:st.uid,mode:st.mode&0o7777});
 }
}
await visit(root);files.push({path:'launcher',sha256:hash(await readFile(base+'/launcher'))});
const source=new URL('../../packages/governed-execution/native/linux-launcher.c',import.meta.url);
const lifetimeSource=new URL('../../packages/governed-execution/native/linux-lifetime.h',import.meta.url);
await writeFile(base+'/manifest.json',JSON.stringify({schema:'finnor.s6.fixed-jail.v1',architecture:process.arch,files:files.sort((a,b)=>a.path.localeCompare(b.path)),
 launcherSourceSha256:hash(await readFile(source)),launcherLifetimeSourceSha256:hash(await readFile(lifetimeSource)),bootstrapCapability:'CAP_SYS_CHROOT_ONLY_THEN_ZERO',landlockMinimumAbi:2,
 authority:'NONE_OUTPUT_UNTRUSTED',protectedExecution:'UNADMITTED'},null,2)+'\n',{mode:0o444,flag:'wx'});
await chmod(root,0o555);
if(profile==='specialist-dev'){
 const filter=await readFile(specialistFilter),metadata=await lstat(specialistFilter),
  launcherBytes=await readFile(base+'/launcher');
 if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.uid!==0||(metadata.mode&0o022)
   ||filter.length===0||filter.length>32768||filter.length%8
   ||!launcherBytes.includes(Buffer.from('finnor.s6.linux-specialist-bootstrap.v1'))
   ||!launcherBytes.includes(Buffer.from('KERNEL_ABSOLUTE_CLOCK_MONOTONIC')))
   throw Error('SPECIALIST_DEV_NATIVE_PROFILE_UNAVAILABLE');
 const specialistSource=new URL('../../packages/governed-execution/native/linux-specialist.h',import.meta.url);
 const manifest={schema:'finnor.s6.protected-specialist-jail.v1',
  profile:'BOUNDED_SPECIALIST_ANALYSIS_CGROUP2_V1',qualificationDomain:'DEVELOPMENT_LINUX_DELEGATED_CGROUP',
  productionActive:false,architecture:process.arch,nodeVersion:execFileSync(node,['--version'],{encoding:'utf8',timeout:10000}).trim(),
  ordinaryManifestDigest:hash(await readFile(base+'/manifest.json')),nativeABI:'LINUX_SPECIALIST_CGROUP2_V1',
  launcherSha256:hash(launcherBytes),nodeSha256:hash(await readFile(root+'/node')),filterSha256:hash(filter),
  memoryBytes:268435456,swapBytes:0,pids:24,cpuQuotaMicros:100000,cpuPeriodMicros:100000,
  cpuBurstMicros:0,scratchWriteBytes:0,network:'DENIED_IN_GUEST',
  credentials:'BROKER_OWNED_NEVER_DISCLOSED_TO_GUEST',files:'FIXED_JAIL_READ_ONLY_JOB',
  lifetimeGuard:'TRUSTED_NONEXECUTING_PROCESS_GROUP_GUARD',
  guardianWallTimer:'KERNEL_ABSOLUTE_CLOCK_MONOTONIC'};
 if(!/^v22\./.test(manifest.nodeVersion))throw Error('SPECIALIST_DEV_NODE_ABI');
 await writeFile(base+'/specialist-manifest.json',JSON.stringify(manifest,null,2)+'\n',{mode:0o444,flag:'wx'});
 await writeFile(base+'/specialist-source-pins.json',JSON.stringify({schema:'finnor.s6.specialist-build-sources.v1',
  launcherSourceSha256:hash(await readFile(source)),launcherLifetimeSourceSha256:hash(await readFile(lifetimeSource)),
  launcherSpecialistSourceSha256:hash(await readFile(specialistSource)),
  requiredNativeLinkLibraries:['crypto','rt'],requiredGuardianTimer:'KERNEL_ABSOLUTE_CLOCK_MONOTONIC',
  productionActive:false},null,2)+'\n',
  {mode:0o444,flag:'wx'});
}
if(mode!=='stage'){
 for(const [name,minor] of [['null',3],['random',8],['urandom',9]])execFileSync('/usr/bin/mknod',['-m','666',root+'/dev/'+name,'c','1',String(minor)]);
 execFileSync('/usr/sbin/setcap',['cap_sys_chroot=ep',base+'/launcher']);
}
