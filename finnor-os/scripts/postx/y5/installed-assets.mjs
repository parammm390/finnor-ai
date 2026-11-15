import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readFileSync,readlinkSync,lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':
 value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
const modelPath='finnor-os/packages/epistemic-runtime/src/uniform-algorithms/total';
const exportRequired=[
 'finnor-os/packages/private-equity/src/allocation-experience.ts',
 'finnor-os/packages/private-equity/src/allocation-total-task.ts',
 'finnor-os/packages/shared-types/src/total-algorithm-theory.ts',
 ...['native.ts','native-supervisor.mjs','native-sandbox.sb','total/Total.lean','total/model-pin.generated.ts','total/model-asset.ts']
  .map(name=>'finnor-os/packages/epistemic-runtime/src/uniform-algorithms/'+name),
];
function bytes(path,maximum){
 assert.equal(realpathSync(path),path,'Y5_INSTALLED_ASSET_ALIAS');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=fstatSync(fd,{bigint:true});
  assert(before.isFile()&&before.size>0n&&before.size<=BigInt(maximum),'Y5_INSTALLED_ASSET_BOUND');
  const body=readFileSync(fd),after=fstatSync(fd,{bigint:true});
  assert.equal(body.length,Number(before.size));
  assert.deepEqual([after.ino,after.size,after.mtimeNs,after.ctimeNs],[before.ino,before.size,before.mtimeNs,before.ctimeNs],
   'Y5_INSTALLED_ASSET_CHANGED');
  return body;
 }finally{closeSync(fd);}
}
export function verifyExportSourceClosure(source,selectedPaths){
 const selected=new Set(selectedPaths),manifestPath='finnor-os/packages/private-equity/src/uniform-algorithms/source-manifest.generated.ts';
 assert(selected.has(manifestPath),'Y5_EXPORT_SOURCE_MANIFEST_NOT_SELECTED');
 const manifestBytes=bytes(join(source,manifestPath),8388608),match=manifestBytes.toString('utf8').match(/export default\s+(\{[\s\S]*\})\s+as const;\s*$/);
 assert(match,'Y5_EXPORT_SOURCE_MANIFEST_FORMAT');
 const manifest=JSON.parse(match[1]);assert(Array.isArray(manifest.files)&&manifest.files.length>0);
 assert.equal(sha256(canonical(manifest.files)),manifest.sourceDigest,'Y5_EXPORT_SOURCE_MANIFEST_DIGEST');
 const pins=new Map(manifest.files.map(file=>[file.path,file.sha256]));assert.equal(pins.size,manifest.files.length);
 for(const path of exportRequired){
  assert(selected.has(path),'Y5_REQUIRED_RUNTIME_SOURCE_NOT_EXPORTED:'+path);
  assert(pins.has(path),'Y5_REQUIRED_RUNTIME_SOURCE_NOT_IN_CLOSURE:'+path);
 }
 const files=[];
 for(const [path,pin] of pins){
  assert(typeof path==='string'&&!isAbsolute(path)&&!path.includes('\\')&&path.split('/').every(part=>part&&part!=='.'&&part!=='..'));
  assert(selected.has(path),'Y5_PINNED_RUNTIME_SOURCE_NOT_EXPORTED:'+path);
  const body=bytes(join(source,path),16777216);assert.equal(sha256(body),pin,'Y5_EXPORT_SOURCE_PIN_CHANGED:'+path);
  files.push({path,bytes:body.length,sha256:pin});
 }
 files.sort((a,b)=>a.path.localeCompare(b.path));
 return {schema:'finnor.y5.exported-source-closure.v1',manifestDigest:sha256(manifestBytes),sourceDigest:manifest.sourceDigest,files};
}
export function readTotalPin(source){
 const pinBytes=bytes(join(source,modelPath,'model-pin.generated.ts'),16384);
 const match=pinBytes.toString('utf8').match(/export const TOTAL_MODEL_PIN\s*=\s*(\{[\s\S]*\})\s*as const;\s*$/);
 assert(match,'Y5_INSTALLED_MODEL_PIN_FORMAT');
 const pin=JSON.parse(match[1]);
 assert.equal(pin.schema,'finnor.y5.total-model-pin.v2');assert.equal(pin.version,'4.34.1');
 assert.deepEqual(Object.keys(pin).sort(),['schema','version','sourceDigest','objectDigest','archiveDigest','inventoryDigest','identityDigest'].sort());
 for(const key of ['sourceDigest','objectDigest','archiveDigest','inventoryDigest','identityDigest'])assert.match(pin[key],/^[a-f0-9]{64}$/);
 assert.equal(sha256(bytes(join(source,modelPath,'Total.lean'),131072)),pin.sourceDigest,'Y5_INSTALLED_MODEL_SOURCE_PIN');
 return pin;
}
export function inspectTotalModel(source,root,toolRoot,verifyToolInventory=false){
 assert(isAbsolute(root)&&resolve(root)===root&&realpathSync(root)===root,'Y5_INSTALLED_CANONICAL_MODEL_ROOT');
 assert(isAbsolute(toolRoot)&&resolve(toolRoot)===toolRoot&&realpathSync(toolRoot)===toolRoot,'Y5_INSTALLED_CANONICAL_TOOL_ROOT');
 const pin=readTotalPin(source),directory=join(root,pin.sourceDigest);
 assert.equal(realpathSync(directory),directory,'Y5_INSTALLED_MODEL_DIRECTORY_ALIAS');
 const identityBytes=bytes(join(toolRoot,'finnor-runtime-identity.json'),8388608),identity=JSON.parse(identityBytes);
 assert.equal(sha256(identityBytes),pin.identityDigest,'Y5_INSTALLED_MODEL_TOOL_IDENTITY');
 assert.equal(identity.archiveSha256,pin.archiveDigest);assert.equal(identity.inventoryDigest,pin.inventoryDigest);
 assert.equal(sha256(JSON.stringify(identity.files)),pin.inventoryDigest);
 if(verifyToolInventory)for(const file of identity.files){
  assert(typeof file.path==='string'&&!isAbsolute(file.path)&&!file.path.includes('\\')&&
   file.path.split('/').every(part=>part&&part!=='.'&&part!=='..'),'Y5_INSTALLED_TOOL_PATH');
  const path=join(toolRoot,file.path),info=lstatSync(path);
  if(file.kind==='SYMLINK'){
   assert(info.isSymbolicLink());assert(realpathSync(path).startsWith(toolRoot+'/'));
   assert.equal(sha256(readlinkSync(path)),file.sha256);
  }else{
   assert.equal(file.kind,'FILE');assert(info.isFile()&&!info.isSymbolicLink());assert.equal(realpathSync(path),path);
   const body=readFileSync(path);assert.equal(body.length,file.bytes);assert.equal(sha256(body),file.sha256);
  }
 }
 const object=bytes(join(directory,'Total.olean'),16777216),setupBytes=bytes(join(directory,'setup.json'),2097152),setup=JSON.parse(setupBytes);
 assert.equal(sha256(object),pin.objectDigest,'Y5_INSTALLED_MODEL_OBJECT_PIN');
 assert.equal(setup.schema,'finnor.y5.total-model-setup.v2');assert.deepEqual(setup.pin,pin);
 assert.deepEqual(Object.keys(setup).sort(),['schema','pin','native','wallMs','accounting','completeMoney','completeHumanSeconds','aggregatePeakBytes'].sort());
 assert.equal(setup.accounting,'RECORDED_SHARED_SETUP_NOT_FREE_OR_INDEPENDENTLY_QUALIFIED');
 assert.equal(setup.completeMoney,null);assert.equal(setup.completeHumanSeconds,null);assert.equal(setup.aggregatePeakBytes,null);
 assert(Number.isFinite(setup.wallMs)&&setup.wallMs>=0);assert.equal(setup.native.length,2);
 for(const [i,receipt] of setup.native.entries()){
  assert.equal(receipt.exitCode,0);assert.equal(receipt.signal,null);assert.equal(receipt.childCloseObserved,true);
  assert.equal(receipt.command[0],i===0?'lean':'leanchecker');assert(receipt.command.includes('Total'+(i===0?'.lean':'')));
  assert.equal(receipt.supervision,'INDEPENDENT_IPC_DEADLINE_GUARDIAN');
 }
 return {schema:'finnor.y5.installed-total-model.v2',root:'.y5-tools/total-core',pin,
  pinDigest:sha256(canonical(pin)),setupDigest:sha256(setupBytes),objectBytes:object.length,
  setupBytes:setupBytes.length,accounting:setup.accounting,completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null,
  provenance:'EXACT_PREPARED_SHARED_SETUP_BYTES_NOT_FRESH_COMPILATION',runtimeReplay:'REQUIRED_PER_CHECK_NO_BUILD_FALLBACK'};
}
export function verifyInstalledAssets(runtime){
 assert(isAbsolute(runtime)&&resolve(runtime)===runtime&&realpathSync(runtime)===runtime,'Y5_INSTALLED_CANONICAL_RUNTIME');
 const identityBytes=bytes(join(runtime,'finnor-os/y5-runtime/identity.json'),2097152),identity=JSON.parse(identityBytes);
 assert.equal(identity.schema,'finnor.y5.installed-identity.v1');
 assert.equal(identity.node,process.version);assert.equal(identity.platform,process.platform);assert.equal(identity.architecture,process.arch);
 assert.equal(sha256(readFileSync(process.execPath)),identity.nodeBinarySha256);
 const output=resolve(runtime,'..'),sourceInputs=JSON.parse(readFileSync(join(output,'source-inputs.json')));
 assert.equal(sha256(JSON.stringify(sourceInputs.files)),identity.sourceInputsDigest);
 const sourceClosure=verifyExportSourceClosure(runtime,sourceInputs.files.map(file=>file.path));
 assert.equal(sha256(JSON.stringify(sourceClosure)),identity.sourceClosureDigest);
 assert.deepEqual(JSON.parse(readFileSync(join(output,'source-closure.json'))),sourceClosure);
 function filePath(name){
  assert(typeof name==='string'&&!name.includes('\\')&&!isAbsolute(name)&&name.split('/').every(p=>p&&p!=='.'&&p!=='..'));
  return join(runtime,name);
 }
 function verifyFiles(files){
  assert(Array.isArray(files)&&files.length>0);
  for(const file of files){
   const path=filePath(file.path);
   if(file.kind==='link'){
    assert(lstatSync(path).isSymbolicLink());assert.equal(realpathSync(path),filePath(file.target));
   }else{
    const body=readFileSync(path);assert.equal(realpathSync(path),path);assert(lstatSync(path).isFile());
    assert.equal(body.length,file.bytes);assert.equal(sha256(body),file.sha256,'Y5_INSTALLED_INVENTORY_BYTES:'+file.path);
   }
  }
 }
 for(const [name,digest] of [['api-assets','apiAssetsDigest'],['dependency-assets','dependencyAssetsDigest'],
  ['native-assets','nativeAssetsDigest'],['total-model-assets','totalModelAssetsDigest'],['frontend-assets',null]]){
  const files=JSON.parse(readFileSync(join(output,name+'.json')));
  assert.equal(sha256(JSON.stringify(files)),digest?identity[digest]:identity.frontend.assetsDigest);verifyFiles(files);
 }
 verifyFiles(identity.emittedFiles);
 for(const lock of identity.locks)assert.equal(sha256(readFileSync(filePath(lock.path))),lock.sha256);
 const generated=new Map((identity.buildGeneratedSourceFiles??[]).map(file=>[file.path,file]));
 for(const file of sourceInputs.files){
  const path=filePath(file.path);
  if(file.kind==='link')assert.equal(realpathSync(path),filePath(file.target));
  else{
   const changed=generated.get(file.path);
   if(changed){
    assert(['next-env.d.ts','finnor-os/apps/api/next-env.d.ts'].includes(file.path));
    assert.equal(changed.sourceSha256,file.sha256);
   }
   assert.equal(sha256(readFileSync(path)),changed?.sha256??file.sha256,'Y5_INSTALLED_SOURCE_BYTES:'+file.path);
  }
 }
 const totalModel=inspectTotalModel(runtime,join(runtime,'.y5-tools/total-core'),join(runtime,'.y5-tools/lean-4.34.1-darwin_aarch64'),true);
 assert.deepEqual(totalModel,identity.totalModel);
 return {identityDigest:sha256(identityBytes),buildId:identity.buildId,totalModel,sourceInputsDigest:identity.sourceInputsDigest,
  worker:identity.emittedFiles.find(file=>file.path==='finnor-os/y5-runtime/worker-once.mjs')};
}
