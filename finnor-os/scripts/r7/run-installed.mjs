/** Scope-private final-image execution. No registry push, host mount or port.
 * Registered acceptance/failure basis: milestone amendments 59 and the original
 * runtime-schema/full-profile owner E2Es. All failed inputs and logs are retained.
 */
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {statfsSync} from 'node:fs';
const attempt=process.env.FINNOR_R7_IMAGE_ATTEMPT??'installed-final';
if(!/^[a-z0-9][a-z0-9-]{0,60}$/.test(attempt))throw Error('Bounded image attempt name required');
const repo=resolve(import.meta.dirname,'../../..'),scratch=join(repo,'.r7-scratch'),
  output=resolve(process.env.FINNOR_R7_EVIDENCE_DIR??'.'),
  cli=process.env.FINNOR_CONTAINER_CLI;
if(!process.env.FINNOR_R7_EVIDENCE_DIR||output.startsWith(repo+'/'))throw Error('Explicit private installed-image evidence directory outside source cut required');
if(!cli||!cli.startsWith('/'))throw Error('Explicit installed container CLI required');
const builder='finnor-r7-'+attempt+'-builder',runtime='finnor-r7-'+attempt+'-runtime',
  builderImage='ghcr.io/apple/container-builder-shim/builder@sha256:b5b3f7fa81e662db6929f1ad66d835d151a1b03f682cfe5f9fcb17fa46d6bcc9',
  image='finnor-r7-local:'+attempt,archive=join(scratch,'private-build-context-'+attempt+'.tar'),
  imageArchive=join(scratch,'r7-'+attempt+'.oci.tar'),steps=[],begun=new Date().toISOString(),deadline=Date.now()+1200000;
const sha=b=>createHash('sha256').update(b).digest('hex');
await mkdir(output,{recursive:true});
const artifact=async(name,value)=>{const p=join(output,name);await mkdir(dirname(p),{recursive:true});await writeFile(p,JSON.stringify(value,null,2)+'\n');};
let builderCreated=false,runtimeCreated=false,guardTriggered=false,minFree=Infinity;
const free=()=>{const s=statfsSync(repo);return Number(s.bavail)*Number(s.bsize);};
minFree=free();
const run=async(args,{input,seconds=90,log,cleanup=false}={})=>{
  const remaining=cleanup?seconds*1000:Math.min(seconds*1000,deadline-Date.now());
  if(remaining<=0)throw Error('REGISTERED_INSTALLED_CAMPAIGN_TIMEOUT');
  const started=performance.now(),cp=spawn(cli,args,{stdio:['pipe','pipe','pipe']});cp.stdin.end(input??'');
  let stdout='',stderr='';cp.stdout.on('data',b=>stdout+=b);cp.stderr.on('data',b=>stderr+=b);
  let hardStop;
  const timer=setTimeout(()=>{cp.kill('SIGTERM');hardStop=setTimeout(()=>cp.kill('SIGKILL'),2000);},remaining);
  const result=await new Promise((yes,no)=>{cp.once('error',no);cp.once('close',(code,signal)=>yes({code,signal}));});
  clearTimeout(timer);clearTimeout(hardStop);
  if(log)await writeFile(join(output,log),stdout+stderr);
  steps.push({command:args[0],operation:args[1],code:result.code,signal:result.signal,wallMs:performance.now()-started,log});
  if(result.code!==0)throw Error(`PRIVATE_CONTAINER_COMMAND_FAILED:${args[0]}:${result.code}:${(stderr||stdout).slice(-400)}`);
  return stdout;
};
const stop=async name=>{
  const cp=spawn(cli,['stop',name],{stdio:'ignore'}),timer=setTimeout(()=>cp.kill('SIGKILL'),20000);
  await new Promise(yes=>cp.once('close',yes));clearTimeout(timer);
};
const guard=setInterval(()=>{
  minFree=Math.min(minFree,free());
  if(minFree<536870912&&!guardTriggered){
    guardTriggered=true;
    if(runtimeCreated)void stop(runtime);
    if(builderCreated)void stop(builder);
  }
},1000);
try{
  if(free()<4*1024**3)throw Error('PRIVATE_IMAGE_PREFLIGHT_BELOW_FOUR_GIB_FREE');
  const listed=JSON.parse(await run(['list','--format','json']));
  if(listed.some(x=>[builder,runtime].includes(x.id)))throw Error('Owned image names must be fresh');
  const inputManifest=JSON.parse(await readFile(join(output,'inputs.json'),'utf8'));
  if(sha(await readFile(archive))!==inputManifest.archiveSha256)throw Error('IMAGE_INPUT_ARCHIVE_DRIFT');
  await run(['run','-d','--name',builder,'--cpus','2','--memory','2G','--cap-add','SYS_ADMIN',
    '--entrypoint','/bin/sh',builderImage,'-c','sleep 1200']);
  builderCreated=true;
  await artifact('builder-inspect.json',JSON.parse(await run(['inspect',builder])));
  await run(['cp',archive,builder+':/r7-inputs.tar']);
  await run(['exec',builder,'/bin/sh','-c',
    'mkdir -p /r7-context /r7-buildstate; tar -xf /r7-inputs.tar -C /r7-context; printf \'[worker.oci]\\n  max-parallelism = 1\\n  snapshotter = "overlayfs"\\n\' > /r7-buildkit.toml']);
  await run(['exec','-d',builder,'/bin/sh','-c',
    'buildkitd --config /r7-buildkit.toml --root /r7-buildstate --addr unix:///run/buildkit/buildkitd.sock > /r7-buildkit.log 2>&1']);
  await run(['exec',builder,'/bin/sh','-c',
    'i=0; until buildctl --addr unix:///run/buildkit/buildkitd.sock debug workers >/dev/null 2>&1; do i=$((i+1)); test "$i" -lt 30 || exit 1; sleep 1; done']);
  await run(['exec',builder,'buildctl','--addr','unix:///run/buildkit/buildkitd.sock','build',
    '--frontend','dockerfile.v0','--local','context=/r7-context','--local','dockerfile=/r7-context/finnor-os',
    '--opt','filename=Dockerfile.worker','--opt','platform=linux/amd64',
    '--output',`type=oci,name=${image},dest=/r7-image.tar`,'--metadata-file','/r7-image-metadata.json'],
    {seconds:900,log:'build.log'});
  await run(['cp',builder+':/r7-image-metadata.json',join(output,'image-metadata.json')]);
  await run(['cp',builder+':/r7-image.tar',imageArchive],{seconds:180,log:'image-transfer.log'});
  await artifact('image-archive.json',{sha256:sha(await readFile(imageArchive)),sourceArchiveSha256:inputManifest.archiveSha256});
  await run(['image','load','--input',imageArchive],{seconds:180,log:'image-load.log'});
  await artifact('loaded-image.json',JSON.parse(await run(['image','inspect',image])));
  await stop(builder);
  await artifact('builder-stopped.json',JSON.parse(await run(['inspect',builder])));
  await run(['delete',builder]);builderCreated=false;
  await run(['run','-d','--name',runtime,'--cpus','2','--memory','2G','--arch','amd64',
    '--entrypoint','/bin/sh',image,'-c','sleep 900']);
  runtimeCreated=true;
  await artifact('runtime-inspect.json',JSON.parse(await run(['inspect',runtime])));
  await run(['exec','--uid','0',runtime,'/bin/sh','-c',
    'mkdir -p /tmp/r7-installed-owner; chown -R 1000:1000 /tmp/r7-installed-owner']);
  const parent=(await readFile(join(output,'parent.json'),'utf8'));
  const commit=JSON.parse(parent).commit;
  if(!/^[a-f0-9]{40}$/.test(commit))throw Error('Explicit immutable Git parent required');
  await run(['exec',runtime,'node','--input-type=module','-e',
    `import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
     const files=${JSON.stringify(inputManifest.files)};
     if(process.getuid()!==1000)throw Error('Non-root final user required');
     for(const f of files){if(f.path.endsWith('Dockerfile.worker')||f.path.endsWith('Dockerfile.worker.dockerignore'))continue;
       if(createHash('sha256').update(readFileSync('/app/'+f.path)).digest('hex')!==f.sha256)throw Error('Installed source bytes differ:'+f.path);}
     console.log(JSON.stringify({uid:process.getuid(),node:process.version,platform:process.platform,arch:process.arch,matchedFiles:files.length-2}));`],
    {log:'installed-source-custody.log'});
  await run(['exec','-e','NODE_ENV=test','-e','NEXT_TELEMETRY_DISABLED=1','-e',`FINNOR_COMMIT_SHA=${commit}`,
    '-e','FINNOR_R7_CASE_FILTER=runtime-schema-compatibility,owner-full-profile,authenticated-owner-runtime,actual-s4-s5-intent',
    '-e','FINNOR_R7_EVIDENCE_DIR=/tmp/r7-installed-owner',
    runtime,'node','--import=tsx','scripts/r7/run-owner.mts'],{seconds:600,log:'installed-owner.log'});
  await run(['exec',runtime,'python3','-c',
    `import json; p='/tmp/r7-installed-owner/results.json'; r=json.load(open(p)); print(json.dumps({'cases':[{'id':x['id'],'status':x['status']} for x in r['cases']],'runtime':r['runtime'],'qualification':r['qualification']})); assert len(r['cases'])==4 and all(x['status']=='PASS' for x in r['cases'])`],
    {log:'installed-summary.log'});
  await run(['exec',runtime,'/bin/sh','-c',
    'tar -czf /tmp/r7-installed-owner.tgz -C /tmp r7-installed-owner']);
  await run(['cp',runtime+':/tmp/r7-installed-owner.tgz',join(output,'raw-owner.tgz')],{seconds:90});
  await artifact('results.json',{schema:'finnor.r7.installed-image.v1',begun,finishedAt:new Date().toISOString(),status:'PASS',
    image,inputArchiveSha256:inputManifest.archiveSha256,steps,minFreeBytes:minFree,installedImageQualified:true,
    qualification:'Actual local linux/amd64 installed bytes, non-root source custody, ordinary authenticated owner/API/production registry/SQL/child execution. Not release, S8, protected effects or hosted activation.'});
}catch(error){
  await artifact('results.json',{schema:'finnor.r7.installed-image.v1',begun,finishedAt:new Date().toISOString(),
    status:'INCOMPLETE',predicate:String(error),steps,minFreeBytes:minFree,guardTriggered,installedImageQualified:false});
  process.exitCode=1;
}finally{
  clearInterval(guard);
  for(const [name,created]of [[runtime,runtimeCreated],[builder,builderCreated]]){
    if(!created)continue;await stop(name);
    try{await artifact(name+'-final-inspect.json',JSON.parse(await run(['inspect',name],{seconds:15,cleanup:true})));}catch{}
  }
}
