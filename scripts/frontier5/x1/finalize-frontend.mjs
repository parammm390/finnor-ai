import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile, readdir, lstat, realpath, readlink, unlink, symlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {frontendTracingLayout} from './frontend-tracing-root.mjs';
import {assertKnownNextTypeInput} from './frontend-generated-inputs.mjs';

const repo=fileURLToPath(new URL('../../../',import.meta.url)),args=process.argv.slice(2);
const w2=args.length===6&&args[4]==='--profile'&&args[5]==='postz-w2';
if(w2)args.splice(4);
const label=w2?'w2':'x1',distDir=`.next-${label}-install`;
if(args.length!==4||args[0]!=='--output'||args[2]!=='--origin'||!args[1].startsWith('/'))throw Error('X1_EXISTING_FRONTEND_PACKAGE_ARGUMENTS_REQUIRED');
const output=await realpath(args[1]),runtime=join(output,'runtime'),manifestPath=join(output,`${label}-frontend-installation.json`);
if(existsSync(manifestPath))throw Error('X1_FRONTEND_ALREADY_FINALIZED');
const origin=new URL(args[3]);
if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||!origin.port||origin.pathname!=='/'||origin.search||origin.hash||origin.username||origin.password)
  throw Error('X1_EXACT_LOOPBACK_FRONTEND_ORIGIN_REQUIRED');
const buildBytes=await readFile(join(output,'build-resources.json')),build=JSON.parse(buildBytes);
assert.equal(build.ending.code,0);assert.equal(build.ending.signal,null);assert.equal(build.guardFailure,null);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...argv)=>execFileSync('git',argv,{cwd:repo,timeout:5000,maxBuffer:32*1024*1024});
const source=build.source,sourcePreimages=[],generatedInputDeltas=[];
assert.equal(git('rev-parse','HEAD').toString().trim(),source.commit,'original frontend source commit retained');
const paths=git('ls-tree','-r','--name-only','-z',source.commit).toString().split('\0').filter(Boolean);
for(const path of paths){
  if(!/^(?:src\/|scripts\/centropy\/|scripts\/frontier5\/|public\/)/.test(path)
    &&!['package.json','package-lock.json','next.config.mjs','next-env.d.ts','tsconfig.json','tailwind.config.ts','postcss.config.mjs'].includes(path))continue;
  const original=git('show',source.commit+':'+path),current=await readFile(join(repo,path));
  if(sha(original)!==sha(current)){
    assertKnownNextTypeInput(path,original,current,distDir);
    generatedInputDeltas.push({path,originalSha256:sha(original),generatedSha256:sha(current),basis:'EXACT_OBSERVED_NEXT_GENERATED_TYPE_INPUT'});
  }
  sourcePreimages.push({path,sha256:sha(original),...(generatedInputDeltas.some(p=>p.path===path)?{generatedSha256:sha(current)}:{})});
}
const buildId=label+'-'+source.commit,files=[],links=[],linkRepairs=[];let outputBytes=0,authUrlFound=false;
const limits=JSON.parse(await readFile(join(repo,w2?'scope-postz/w2-accountable-workforce/verification-plan.json':
  'scope-frontier5/x1-institutional-programme-compiler/verification-plan.json'),'utf8')).limits;
assert.ok(build.elapsedMs<=limits.finalBuildWallSeconds*1000);
async function fileHash(path){const h=createHash('sha256');for await(const bytes of createReadStream(path))h.update(bytes);return h.digest('hex');}
const layout=frontendTracingLayout(repo),{tracingRoot,projectPath}=layout;
if(build.tracingLayout)assert.deepEqual(build.tracingLayout,layout,'actual original build tracing layout');
async function sameCopiedBytes(copied,original){for(const item of await readdir(copied,{withFileTypes:true})){
  const a=join(copied,item.name),b=join(original,item.name),s=await lstat(a);
  if(s.isDirectory())await sameCopiedBytes(a,b);
  else if(s.isFile())assert.equal(await fileHash(a),await fileHash(b),'already-copied original dependency bytes');
  else if(s.isSymbolicLink())assert.equal(await readlink(a),await readlink(b));
  else throw Error('X1_FRONTEND_DEPENDENCY_SPECIAL_FILE');
}}
async function scan(directory){for(const item of await readdir(directory,{withFileTypes:true})){
  const path=join(directory,item.name),r=relative(output,path),s=await lstat(path);
  if(s.isDirectory())await scan(path);
  else if(s.isSymbolicLink()){
    let target=await readlink(path),actual=resolve(dirname(path),target);
    if(!actual.startsWith(runtime+sep)){
      const original=await realpath(actual);
      if(!original.startsWith(tracingRoot+sep))throw Error('X1_FRONTEND_EXTERNAL_DEPENDENCY_ROOT_REFUSED');
      const copied=join(runtime,relative(tracingRoot,original));
      if(!existsSync(copied)||(await lstat(copied)).isSymbolicLink())throw Error('X1_FRONTEND_COPIED_DEPENDENCY_REQUIRED');
      await sameCopiedBytes(copied,original);
      const replacement=relative(dirname(path),copied);
      linkRepairs.push({path:r,originalTarget:target,installedTarget:replacement,alreadyCopiedBytesIndependentlyCompared:true});
      await unlink(path);await symlink(replacement,path);target=replacement;
    }
    if(!(await realpath(path)).startsWith(runtime+sep))throw Error('X1_FRONTEND_LINK_OUTSIDE_INSTALLATION');
    links.push({path:r,target});
  }else if(s.isFile()){
    outputBytes+=s.size;if(outputBytes>limits.finalBuildOutputBytes)throw Error('X1_FINAL_BUILD_OUTPUT_BOUND');
    files.push({path:r,bytes:s.size,mode:s.mode&0o7777,sha256:await fileHash(path)});
    if(r.includes('/static/')&&path.endsWith('.js')&&!authUrlFound)authUrlFound=(await readFile(path)).includes(Buffer.from(origin.origin));
  }else throw Error('X1_FRONTEND_SPECIAL_FILE_REFUSED');
}}
await scan(runtime);assert.ok(authUrlFound,'actual compiled public auth URL matches original supplied origin');
const entry=files.find(row=>row.path===join('runtime',projectPath,'server.js'));
assert.ok(entry,'actual compiled standalone server');
assert.equal((await readFile(join(dirname(join(output,entry.path)),distDir,'BUILD_ID'),'utf8')).trim(),buildId);
const hostBytes=git('show',source.commit+':scripts/frontier5/x1/frontend-host.mjs');
await writeFile(join(output,'frontend-host.mjs'),hostBytes,{flag:'wx',mode:0o444});
files.push({path:'frontend-host.mjs',bytes:hostBytes.length,mode:0o444,sha256:sha(hostBytes)});outputBytes+=hostBytes.length;
const nextPath=files.find(row=>/\/node_modules\/next\/package.json$/.test(row.path));assert.ok(nextPath);
const manifest={schema:w2?'finnor.postz.w2.frontend-installation.v1':'finnor.x1.frontend-installation.v1',mode:'DEVELOPMENT_ONLY',source,sourcePreimages,generatedInputDeltas,
  runtime:{node:process.version,platform:process.platform,arch:process.arch,nodeBinarySha256:await fileHash(process.execPath)},
  nextVersion:JSON.parse(await readFile(join(output,nextPath.path),'utf8')).version,buildId,frontendOrigin:origin.origin,
  tracingLayout:layout,
  entrypoint:entry.path,files,links,outputBytes,elapsedMs:build.elapsedMs,limits,linkRepairs,
  buildReceipt:{path:'build-resources.json',sha256:sha(buildBytes),ending:build.ending},
  originalCompileRetainedWithoutRebuild:true,authTransport:'SAME_ORIGIN_AUTH_V1_TO_EXISTING_DISPOSABLE_AUTH_OWNER',
  finalizerSource:{commit:git('rev-parse','HEAD').toString().trim()},productionActive:false,
  protectedQualification:false,executionAuthorityGranted:false,monetaryCost:null,humanSeconds:null,aggregatePeakMemoryBytes:null};
assert.ok(outputBytes<=limits.finalBuildOutputBytes);
assert.equal(git('rev-parse','HEAD').toString().trim(),source.commit,'frontend source unchanged during finalization');
const permittedDirty=new Set([...source.dirty.split('\n').filter(Boolean).map(line=>line.slice(3)),
  ...generatedInputDeltas.map(delta=>delta.path)]);
assert.ok(git('status','--porcelain=v1','-uall').toString().trimEnd().split('\n').filter(Boolean)
  .every(line=>permittedDirty.has(line.slice(3))),'only observed original dirty paths and exact Next generated type inputs');
await writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o444});
console.log(JSON.stringify({event:'X1_FRONTEND_FINALIZED',output,source,buildId,entrypoint:entry.path,
  actualFiles:files.length,links:links.length,linkRepairs:linkRepairs.length,outputBytes,generatedInputDeltas,
  originalCompileRetainedWithoutRebuild:true,productionActive:false}));
