/** Reconstruct a private validation cut; never modifies common product source.
 * Usage: node scripts/r7/serial-projection.mjs /tmp/<fresh-cut>
 *   <borrowed-os-node_modules> [<borrowed-root-node_modules>]
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,readdir,readlink,stat,symlink,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';

const repo=resolve(import.meta.dirname,'../../..'),base='4a90ed33ca96afa252c51f511fea279e0034cddb',
  output=process.argv[2],dependencies=process.argv[3],rootDependencies=process.argv[4];
assert(output&&output===resolve(output)&&output.startsWith('/tmp/'),'Fresh absolute /tmp cut required');
assert(dependencies&&dependencies===resolve(dependencies),'Explicit read-only borrowed node_modules required');
try{await stat(output);throw Error('Projection destination already exists');}
catch(error){if(error.code!=='ENOENT')throw error;}
assert((await stat(dependencies)).isDirectory());
if(rootDependencies)assert(rootDependencies===resolve(rootDependencies)&&(await stat(rootDependencies)).isDirectory());
await mkdir(output,{mode:0o700});
const sha=b=>createHash('sha256').update(b).digest('hex');
function git(args,input){
  const r=spawnSync('git',args,{cwd:repo,input,maxBuffer:200*1024*1024});
  if(r.status!==0)throw Error('Projection Git failure: '+r.stderr.toString());
  return r.stdout;
}
const tree=git(['ls-tree','-r','-z',base]).toString().split('\0').filter(Boolean).map(line=>{
  const [meta,path]=line.split('\t'),[mode,type,blob]=meta.split(' ');
  return {mode,type,blob,path};
});
// Original retained S5 driver hashes these exact public governing assets.
// Export only this finite allowlist from the pinned base, never scope evidence.
const retainedS5Sources=new Set(['scope-5/scope-plan.md','scope-5/scope-evidence/test-registration.json',
  'scope-5/scope-evidence/failure-model.md','scope-5/scope-evidence/test-selection.md',
  'scope-5/scope-evidence/additional-challenge-registration.md','finnor-os/openapi.json']);
const source=tree.filter(f=>f.type==='blob'&&f.mode!=='120000'&&
  !/(?:^|\/)(?:node_modules|\.venv|\.cache|source-snapshot)(?:\/|$)/.test(f.path)&&
  !/^finnor-os\/scripts\/(?:.*\/)?(?:evidence|artifacts)\//.test(f.path)&&
  (retainedS5Sources.has(f.path)||
   /^finnor-os\/(?:packages|apps|scripts)\//.test(f.path)&&/\.(?:ts|tsx|mts|mjs|cjs|js|m|py|json|sql|yml|yaml|txt)$/.test(f.path)||
   /^src\//.test(f.path)&&/\.(?:ts|tsx|js|mjs|cjs|json|css|svg)$/.test(f.path)||
   /^public\//.test(f.path)&&/\.(?:svg|woff2?|ttf)$/.test(f.path)||
   f.path==='scripts/centropy/generate-capability-manifest.mjs'||
   /^(?:next(?:-env\.d)?\.config\.(?:js|mjs|ts)|next-env\.d\.ts|postcss\.config\.(?:js|mjs)|tailwind\.config\.(?:js|ts)|components\.json)$/.test(f.path)||
   /^scripts\/release\/[^/]+\.(?:mjs|mts)$/.test(f.path)||
   f.path==='infra/deployment/production.contract.json'||
   /^(?:finnor-os\/)?(?:package(?:-lock)?\.json|tsconfig(?:\.base)?\.json)$/.test(f.path)));
const batch=git(['cat-file','--batch'],Buffer.from(source.map(f=>base+':'+f.path+'\n').join('')));
const files=[];let cursor=0;
async function put(path,bytes,origin,mode='100644'){
  assert(!path.startsWith('/')&&!path.split('/').includes('..'),'Safe repository-relative public source path required');
  const destination=join(output,path);await mkdir(dirname(destination),{recursive:true});
  await writeFile(destination,bytes,{mode:mode==='100755'?0o755:0o644});
  files.push({path,sha256:sha(bytes),bytes:bytes.length,origin});
}
for(const f of source){
  const end=batch.indexOf(10,cursor);assert(end>=cursor);
  const [blob,type,size]=batch.subarray(cursor,end).toString().split(' ');
  assert.equal(blob,f.blob);assert.equal(type,'blob');cursor=end+1;
  const body=batch.subarray(cursor,cursor+Number(size));assert.equal(body.length,Number(size));
  await put(f.path,body,{commit:base,blob},f.mode);cursor+=body.length+1;
}
assert.equal(cursor,batch.length);
const owned=['finnor-os/packages/epistemic-runtime/src/policy-atlas','finnor-os/packages/private-equity/src/r7',
  'finnor-os/scripts/r7','scope-r/r7-policy-atlas-compiler'];
async function copy(directory){
  for(const e of await readdir(join(repo,directory),{withFileTypes:true})){
    const path=directory+'/'+e.name;
    if(e.isDirectory()){if(e.name!=='evidence')await copy(path);}
    else if(e.isFile())await put(path,await readFile(join(repo,path)),{kind:'OWNED_WORKING_BYTES'});
  }
}
for(const directory of owned)await copy(directory);
await put('finnor-os/packages/shared-types/src/decision-atlas.ts',
  await readFile(join(repo,'finnor-os/packages/shared-types/src/decision-atlas.ts')),{kind:'OWNED_WORKING_BYTES'});
for(const path of ['src/components/centropy/canvas/DecisionAtlasReview.tsx','src/components/centropy/canvas/decision-atlas-view.ts'])
  await put(path,await readFile(join(repo,path)),{kind:'OWNED_WORKING_BYTES'});
const proposals=join(output,'scope-r/r7-policy-atlas-compiler/handoff/proposals'),
  manifest=JSON.parse(await readFile(join(proposals,'manifest.json'),'utf8'));
assert.equal(manifest.base,base);
for(const record of manifest.records){
  let bytes=null;
  try{bytes=await readFile(join(output,record.path));}catch(e){if(e.code!=='ENOENT')throw e;}
  assert.equal(bytes?sha(bytes):null,record.baseSha256,'Exact shared preimage: '+record.path);
}
for(const patch of manifest.orderedPatches){
  for(const args of [['apply','--check',join(proposals,patch)],['apply',join(proposals,patch)]]){
    const r=spawnSync('git',args,{cwd:output,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
  }
}
for(const record of manifest.records)assert.equal(sha(await readFile(join(output,record.path))),record.postSha256,'Exact serial postimage: '+record.path);
// Third-party dependency files are borrowed read-only, but @finnor workspace
// links must resolve INSIDE the cut. A whole-directory node_modules symlink
// would silently resolve @finnor/* imports into the borrowed foreign tree
// (which lacks r1/r4/r7 sources), mixing unverified bytes into the verified
// cut; successor-3 retained S5 failed exactly this way.
const workspaceLinks=[],skippedWorkspaceLinks=[];
async function linkDependencies(target,borrowed){
  await mkdir(target,{recursive:true});
  for(const e of await readdir(borrowed,{withFileTypes:true})){
    if(e.name==='@finnor')continue;
    await symlink(join(borrowed,e.name),join(target,e.name));
  }
  const scope=join(borrowed,'@finnor'),sourceRoot=dirname(borrowed);
  let entries=[];
  try{entries=await readdir(scope,{withFileTypes:true});}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!entries.length)return;
  await mkdir(join(target,'@finnor'),{recursive:true});
  for(const e of entries){
    const absolute=resolve(scope,await readlink(join(scope,e.name))),
      rel=relative(sourceRoot,absolute),cutTarget=join(dirname(target),rel);
    try{await stat(cutTarget);}
    catch(error){if(error.code==='ENOENT'){skippedWorkspaceLinks.push({name:e.name,repoPath:rel});continue;}throw error;}
    await symlink(join('..','..',rel),join(target,'@finnor',e.name));
    workspaceLinks.push({name:e.name,repoPath:rel});
  }
}
await linkDependencies(join(output,'finnor-os/node_modules'),dependencies);
if(rootDependencies)await linkDependencies(join(output,'node_modules'),rootDependencies);
const projection={schema:'finnor.r7.private-serial-projection.v1',base,output,files,shared:manifest.records,
  borrowedDependencies:dependencies,borrowedRootDependencies:rootDependencies??null,
  borrowedDependencyLinkMode:'symlink-farm-except-finnor-workspace',workspaceLinks,skippedWorkspaceLinks,
  qualification:'R7_SERIAL_PROPOSALS_CHECKED_NOT_CANONICAL_JOINED_RELEASE_OR_INSTALLED',
  excluded:'No Git history, raw evidence, private state, dependency/runtime/cache tree or unrelated R adoption'};
const destination=join(output,'serial-projection.json');
await writeFile(destination,JSON.stringify(projection,null,2)+'\n');
console.log(JSON.stringify({output,manifest:destination,baseFiles:source.length,ownedFiles:files.length-source.length,proposedSharedPaths:manifest.records.length}));
