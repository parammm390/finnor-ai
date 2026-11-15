import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,statfsSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectTotalModel,verifyExportSourceClosure} from './installed-assets.mjs';

const source=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..'),args=process.argv.slice(2),started=performance.now(),options=new Map();
for(let i=0;i<args.length;i++){
 const flag=args[i];if(!['--output','--fresh-locks','--native-assets','--total-model-assets','--frontend-origin'].includes(flag)||options.has(flag))throw Error('Y5_BUILD_ARGUMENT');
 if(flag==='--fresh-locks')options.set(flag,true);
 else{
  const value=args[++i];if(!value)throw Error('Y5_BUILD_VALUE_REQUIRED');
  if(flag==='--frontend-origin'){
   const url=new URL(value);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Y5_DISPOSABLE_LOOPBACK_FRONTEND_ORIGIN_REQUIRED');
   options.set(flag,url.origin);
  }else{if(!isAbsolute(value))throw Error('Y5_ABSOLUTE_BUILD_PATH_REQUIRED');options.set(flag,value);}
 }
}
if(!options.has('--output')||!options.has('--frontend-origin'))throw Error('Y5_NEW_ABSOLUTE_OUTPUT_AND_FRONTEND_ORIGIN_REQUIRED');
const output=resolve(options.get('--output')),runtime=join(output,'runtime'),backend=join(runtime,'finnor-os'),fresh=options.has('--fresh-locks');
const nativeSource=options.has('--native-assets')?realpathSync(options.get('--native-assets')):source;
const modelSource=resolve(options.get('--total-model-assets')??join(nativeSource,'.y5-tools/total-core'));
const frontendOrigin=options.get('--frontend-origin');
const inside=(base,path)=>path===base||path.startsWith(base+'/');
if(inside(source,output)||inside(output,source)||existsSync(output))throw Error('Y5_NEW_OUTPUT_OUTSIDE_CHECKOUT_REQUIRED');
if(realpathSync(dirname(output))!==dirname(output))throw Error('Y5_OUTPUT_PARENT_ALIAS');
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('Y5_INSTALLED_BUILD_HOST');
const spaces=[statfsSync(source),statfsSync(dirname(output))],freeBytes=Math.min(...spaces.map(space=>Number(space.bavail)*Number(space.bsize)));
if(freeBytes<(fresh?4_500_000_000:1_500_000_000))throw Error('Y5_INSTALLED_BUILD_DISK_PREFLIGHT');
const totalModelInput=inspectTotalModel(source,modelSource,join(nativeSource,'.y5-tools/lean-4.34.1-darwin_aarch64'));
mkdirSync(output,{mode:0o700});mkdirSync(runtime,{mode:0o700});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const save=(name,body)=>writeFileSync(join(output,name),JSON.stringify(body,null,2)+'\n',{mode:0o444,flag:'wx'});
const clonePaths=pairs=>execFileSync('/usr/bin/python3',['-I','-B',join(source,'finnor-os/scripts/postx/y5/clone-paths.py')],{
 input:JSON.stringify(pairs),stdio:['pipe','inherit','inherit'],env:{PATH:'/usr/bin:/bin',LANG:'C',TZ:'UTC'},timeout:300000});
const git=(...a)=>execFileSync('git',['-C',source,...a],{encoding:'utf8',maxBuffer:8*1024*1024}).trim();
const excluded=path=>path==='JARVIS-CREDENTIALS-LEDGER.md'||path.split('/').some(p=>['.git','.next','.vercel','.cache','.vite','evidence','node_modules'].includes(p)||/^\.env(?:\.|$)/.test(p));
const tracked=execFileSync('git',['-C',source,'ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const ownPrefixes=[
 'finnor-os/packages/epistemic-runtime/src/uniform-algorithms/','finnor-os/packages/private-equity/src/uniform-algorithms/',
 'finnor-os/scripts/postx/y5/','finnor-os/apps/api/app/api/uniform-algorithms/','scope-postx/y5-uniform-algorithm-discovery/',
];
const ownFiles=new Set([
 'finnor-os/packages/shared-types/src/algorithm-theory.ts','finnor-os/packages/db/migrations/postx_y7_uniform_algorithms.sql',
 'finnor-os/packages/private-equity/src/allocation-experience.ts','finnor-os/packages/private-equity/src/allocation-total-task.ts',
 'finnor-os/packages/private-equity/src/allocation-total-episodes.ts',
 'finnor-os/packages/shared-types/src/total-algorithm-theory.ts',
 'finnor-os/packages/capability-evolution/src/uniform-algorithm-port.ts','finnor-os/packages/capability-evolution/src/uniform-algorithm-consumer.ts',
 'src/components/centropy/canvas/UniformAlgorithmPanel.tsx',
]);
const untracked=execFileSync('git',['-C',source,'ls-files','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(p=>p&&(ownFiles.has(p)||ownPrefixes.some(prefix=>p.startsWith(prefix))));
try{
const sourceFiles=[],copies=[];
const selectedPaths=[...new Set([...tracked,...untracked])].sort().filter(path=>!excluded(path)&&existsSync(join(source,path)));
const sourceClosure=verifyExportSourceClosure(source,selectedPaths);
for(const path of selectedPaths){
 if(excluded(path)||!existsSync(join(source,path)))continue;
 const from=join(source,path),to=join(runtime,path),info=lstatSync(from);mkdirSync(dirname(to),{recursive:true});
 if(info.isSymbolicLink()){
  const target=realpathSync(from);if(!inside(source,target))throw Error('Y5_FOREIGN_SOURCE_LINK');
  symlinkSync(relative(dirname(to),join(runtime,relative(source,target))),to);
  sourceFiles.push({path,kind:'link',target:relative(source,target)});
 }else if(info.isFile()){
  copies.push([from,to]);sourceFiles.push({path,bytes:info.size,sha256:hash(readFileSync(from))});
 }else throw Error('Y5_UNSUPPORTED_SOURCE_ASSET');
}
clonePaths(copies);
for(const file of sourceFiles)if(file.sha256&&hash(readFileSync(join(runtime,file.path)))!==file.sha256)throw Error('Y5_SOURCE_CHANGED_DURING_EXPORT');
if(JSON.stringify(verifyExportSourceClosure(runtime,sourceFiles.map(file=>file.path)))!==JSON.stringify(sourceClosure))throw Error('Y5_SOURCE_CLOSURE_CHANGED_DURING_EXPORT');
save('source-closure.json',sourceClosure);
save('source-inputs.json',{head:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),
 dirtyDiffDigest:hash(execFileSync('git',['-C',source,'diff','HEAD','--binary'],{maxBuffer:32*1024*1024})),files:sourceFiles});
const home=join(output,'build-home');mkdirSync(home,{mode:0o700});
const env={PATH:process.env.PATH,HOME:home,TMPDIR:home,LANG:'C',TZ:'UTC',NODE_ENV:'production',
 NODE_OPTIONS:'--max-old-space-size=3072',NEXT_TELEMETRY_DISABLED:'1',CI:'1',
 FINNOR_ENVIRONMENT:'ordinary_disposable',FINNOR_Y5_PROFILE:'ORDINARY_NATIVE_DIAGNOSTIC',
 SECRETS_PROVIDER:'env',ALLOW_PLAINTEXT_ENV_SECRETS:'1',NPM_CONFIG_USERCONFIG:'/dev/null',NPM_CONFIG_CACHE:join(output,'npm-cache'),
 UV_CACHE_DIR:join(output,'uv-cache'),UV_PYTHON_DOWNLOADS:'never'};
save('build-start.json',{source,output,startedAt:new Date().toISOString(),freeBytes,freshNpmLockInstalls:fresh,freshNpmIncludeDev:fresh?true:null,
 node:process.version,platform:process.platform,architecture:process.arch,nodeBinarySha256:hash(readFileSync(process.execPath)),
 emitter:{expectedVersion:'0.25.12',sourceSha256:hash(readFileSync(fileURLToPath(import.meta.url)))},declaredNativeAssets:nativeSource,
 declaredTotalModelAssets:modelSource,totalModel:totalModelInput,
 qualification:'DISPOSABLE_LOCAL_NOT_PROTECTED_OR_PRODUCTION'});

function inventory(directory){
 const files=[];
 function visit(current){
  for(const entry of readdirSync(current,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
   if(['.cache','.vite'].includes(entry.name)||current.endsWith('/.next')&&entry.name==='cache')continue;
   const path=join(current,entry.name),name=relative(runtime,path);
   if(entry.isDirectory())visit(path);
   else if(entry.isSymbolicLink()){
    const target=realpathSync(path);if(!inside(runtime,target))throw Error('Y5_INSTALLED_RESOLUTION_ESCAPE:'+name);
    files.push({path:name,kind:'link',target:relative(runtime,target)});
   }else if(entry.isFile()){const bytes=readFileSync(path);files.push({path:name,bytes:bytes.length,sha256:hash(bytes)});}
   else throw Error('Y5_UNSUPPORTED_INSTALLED_ASSET');
  }
 }
 visit(directory);return files;
}
let relocatedLinks=0;
function relocate(directory,originalRoot=source){
 for(const entry of readdirSync(directory,{withFileTypes:true})){
  const path=join(directory,entry.name);
  if(entry.isDirectory())relocate(path,originalRoot);
  else if(entry.isSymbolicLink()){
   const original=join(originalRoot,relative(runtime,path)),target=realpathSync(original);
   if(!inside(originalRoot,target))throw Error('Y5_FOREIGN_DEPENDENCY_LINK');
   unlinkSync(path);symlinkSync(relative(dirname(path),join(runtime,relative(originalRoot,target))),path);relocatedLinks++;
  }
 }
}
 const dependencySources=[];
 for(const name of ['node_modules','finnor-os/node_modules']){
  if(fresh)execFileSync('npm',['ci','--include=dev','--no-audit','--no-fund'],{cwd:name==='node_modules'?runtime:backend,env,stdio:'inherit',timeout:600000});
  else{
   const from=realpathSync(join(source,name)),donor=name==='node_modules'?dirname(from):resolve(from,'../..');
   if(from!==join(donor,name)||hash(readFileSync(join(donor,name==='node_modules'?'package-lock.json':'finnor-os/package-lock.json')))!==
    hash(readFileSync(join(source,name==='node_modules'?'package-lock.json':'finnor-os/package-lock.json'))))throw Error('Y5_DEPENDENCY_DONOR_LOCK_MISMATCH');
   dependencySources.push({path:name,source:from,donorLockSha256:hash(readFileSync(join(donor,name==='node_modules'?'package-lock.json':'finnor-os/package-lock.json'))),
    mode:'READ_ONLY_MATCHING_LOCK_APFS_CLONE_NOT_FRESH_INSTALL'});
   clonePaths([[from,join(runtime,name)]]);
   relocate(join(runtime,name),donor);
  }
 }
 const {build,version:esbuildVersion}=createRequire(join(backend,'package.json'))('esbuild');
 if(esbuildVersion!=='0.25.12')throw Error('Y5_INSTALLED_EMITTER_VERSION');
 const tool=join(nativeSource,'.y5-tools/lean-4.34.1-darwin_aarch64'),toolTarget=join(runtime,'.y5-tools/lean-4.34.1-darwin_aarch64');
 if(realpathSync(tool)!==tool)throw Error('Y5_FOREIGN_TOOL_ROOT');
 clonePaths([[tool,toolTarget]]);
 const modelTarget=join(runtime,'.y5-tools/total-core',totalModelInput.pin.sourceDigest);
 clonePaths(['Total.olean','setup.json'].map(name=>[join(modelSource,totalModelInput.pin.sourceDigest,name),join(modelTarget,name)]));
 const totalModel=inspectTotalModel(runtime,join(runtime,'.y5-tools/total-core'),toolTarget,true);
 if(JSON.stringify(totalModel)!==JSON.stringify(totalModelInput))throw Error('Y5_MODEL_CHANGED_DURING_EXPORT');
 const totalModelAssets=inventory(join(runtime,'.y5-tools/total-core'));save('total-model-assets.json',totalModelAssets);
 const pythonRoot=join(nativeSource,'.y5-tools/python'),pythonTarget=join(runtime,'.y5-tools/python');
 if(realpathSync(pythonRoot)!==pythonRoot)throw Error('Y5_FOREIGN_PYTHON_ROOT');
 clonePaths([[pythonRoot,pythonTarget]]);
 relocate(pythonTarget,nativeSource);
 const originalPython=realpathSync(join(nativeSource,'.y5-tools/numerics/bin/python'));
 if(!inside(pythonRoot,originalPython))throw Error('Y5_DECLARED_PYTHON_BASE_REQUIRED');
 const base=join(pythonTarget,relative(pythonRoot,originalPython)),venv=join(runtime,'.y5-tools/numerics');
 execFileSync(base,['-m','venv','--without-pip',venv],{env,stdio:'inherit',timeout:60000});
 if(fresh)execFileSync('uv',['pip','install','--python',join(venv,'bin/python'),'-r',join(backend,'packages/epistemic-runtime/src/intervention-requirements.txt')],{env,stdio:'inherit',timeout:600000});
 else clonePaths([[join(nativeSource,'.y5-tools/numerics/lib/python3.12/site-packages'),join(venv,'lib/python3.12/site-packages')]]);
 const numericalVersions=execFileSync(join(venv,'bin/python'),['-I','-c','import json,numpy,scipy,statsmodels,arch;print(json.dumps({m.__name__:m.__version__ for m in [numpy,scipy,statsmodels,arch]}))'],
  {env:{PATH:env.PATH,HOME:home,TMPDIR:home,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',VECLIB_MAXIMUM_THREADS:'1'},encoding:'utf8',timeout:90000});
 const emitted=join(backend,'y5-runtime');mkdirSync(emitted,{mode:0o755});
 writeFileSync(join(emitted,'package.json'),'{"type":"module","private":true}\n',{flag:'wx',mode:0o444});
 const compiled=await build({
  absWorkingDir:backend,entryPoints:{'worker-once':'scripts/postx/y5/worker-once.mts','queue-control':'scripts/postx/y5/queue-control.mts','worker/index':'apps/worker/src/index.ts',
   'ledger-server':'packages/governed-execution/src/ledger-server.mts','s8-server':'packages/capability-evolution/src/server.mts'},
  outdir:emitted,outExtension:{'.js':'.mjs'},bundle:true,platform:'node',format:'esm',target:'node22',write:false,metafile:true,sourcemap:false,tsconfig:join(backend,'tsconfig.json'),
  banner:{js:'import {createRequire as __y5CreateRequire} from "node:module";const require=__y5CreateRequire(import.meta.url);'},
  plugins:[{name:'y5-dependencies-and-canonical-source',setup(plugin){
   plugin.onResolve({filter:/^[^./]|^\//},({path})=>{if(!isAbsolute(path)&&(!path.startsWith('@finnor/')||path==='@finnor/source-custody'))return {path,external:true};});
   plugin.onLoad({filter:/\.[cm]?[jt]sx?$/},({path})=>{
    if(!inside(runtime,path)||path.includes('/node_modules/'))return;
    let contents=readFileSync(path,'utf8');
    if(/import\.meta\.(?:dirname|url)/.test(contents)){
     const name=relative(runtime,path).replaceAll('\\','/');if(!/^finnor-os\/(?:packages|scripts|apps)\//.test(name))throw Error('Y5_FOREIGN_SOURCE_METADATA');
     contents='import * as __y5SourceCustody from "@finnor/source-custody";\n'+contents
      .replaceAll('import.meta.dirname',`__y5SourceCustody.sourceDirectory(${JSON.stringify(name)})`)
      .replaceAll('import.meta.url',`__y5SourceCustody.sourceURL(${JSON.stringify(name)})`);
    }
    return {contents,loader:path.endsWith('tsx')?'tsx':/\.[cm]?ts$/.test(path)?'ts':'js'};
   });
  }}],
 });
 const emittedFiles=[];
 for(const file of compiled.outputFiles){
  if(!inside(emitted,file.path))throw Error('Y5_EMITTED_OUTPUT_ESCAPE');mkdirSync(dirname(file.path),{recursive:true});
  writeFileSync(file.path,file.contents,{flag:'wx',mode:0o444});
  emittedFiles.push({path:relative(runtime,file.path),bytes:file.contents.length,sha256:hash(file.contents)});
 }
 save('emitter-metafile.json',compiled.metafile);
 console.log(JSON.stringify({stage:'EMITTED',files:emittedFiles}));
 const app=join(backend,'apps/api'),buildId='y5-'+hash(JSON.stringify(sourceFiles));
 execFileSync(process.execPath,[join(backend,'node_modules/next/dist/bin/next'),'build'],
  {cwd:app,env:{...env,FINNOR_BUILD_ID:buildId},stdio:'inherit',timeout:900000});
 const locks=['package-lock.json','finnor-os/package-lock.json'].map(path=>{
  const before=hash(readFileSync(join(source,path))),after=hash(readFileSync(join(runtime,path)));
  if(before!==after)throw Error('Y5_INSTALLED_LOCK_CHANGED');return {path,sha256:after};
 });
 const frontendDirectory=join(runtime,'.next-x1-install'),frontendStandalone=join(frontendDirectory,'standalone');
 execFileSync(process.execPath,[join(runtime,'node_modules/next/dist/bin/next'),'build','--webpack'],{
  cwd:runtime,env:{...env,FINNOR_BUILD_ID:buildId,FINNOR_X1_FRONTEND_INSTALL:'1',
   NEXT_PUBLIC_SUPABASE_URL:frontendOrigin,NEXT_PUBLIC_SUPABASE_ANON_KEY:'y5-disposable-public-anon-key',
   NEXT_PUBLIC_CENTROPY_TEST_MODE:'0',NEXT_PUBLIC_JARVIS_TEST_MODE:'0'},stdio:'inherit',timeout:900000,
 });
 clonePaths([[join(runtime,'public'),join(frontendStandalone,'public')],
  [join(frontendDirectory,'static'),join(frontendStandalone,'.next-x1-install/static')]]);
 const frontendAssets=inventory(frontendDirectory);save('frontend-assets.json',frontendAssets);
 const dependencies=[...inventory(join(runtime,'node_modules')),...inventory(join(backend,'node_modules'))];
 const api=inventory(join(app,'.next')),nativeAssets=[...inventory(toolTarget),...inventory(pythonTarget),...inventory(venv)];
 save('dependency-assets.json',dependencies);save('api-assets.json',api);save('native-assets.json',nativeAssets);
 const buildGeneratedSourceFiles=[];
 for(const file of sourceFiles){
  if(!file.sha256)continue;
  const body=readFileSync(join(runtime,file.path)),after=hash(body);
  if(after===file.sha256)continue;
  if(!['next-env.d.ts','finnor-os/apps/api/next-env.d.ts'].includes(file.path))throw Error('Y5_BUILD_CHANGED_EXPORTED_SOURCE:'+file.path);
  buildGeneratedSourceFiles.push({path:file.path,sourceSha256:file.sha256,sha256:after,bytes:body.length,
   reason:'NEXT_GENERATED_TYPE_REFERENCES_AT_INSTALLED_BUILD_PATH'});
 }
 const frontend={origin:frontendOrigin,serverPath:'.next-x1-install/standalone/server.js',buildId,
  assetsDigest:hash(JSON.stringify(frontendAssets)),mode:'MAINTAINED_PRODUCTION_STANDALONE',productionCspUnchanged:true,
  authentication:'REAL_SUPABASE_SDK_SAME_ORIGIN_DISPOSABLE_GOTRUE_TRANSPORT_NOT_HOSTED_AUTH_QUALIFICATION'};
 const identity={schema:'finnor.y5.installed-identity.v1',buildId,emittedFiles,apiAssetsDigest:hash(JSON.stringify(api)),
  dependencyAssetsDigest:hash(JSON.stringify(dependencies)),nativeAssetsDigest:hash(JSON.stringify(nativeAssets)),sourceInputsDigest:hash(JSON.stringify(sourceFiles)),
  sourceClosureDigest:hash(JSON.stringify(sourceClosure)),
  locks,frontend,totalModel,totalModelAssetsDigest:hash(JSON.stringify(totalModelAssets)),dependencySources,buildGeneratedSourceFiles,
  node:process.version,nodeBinarySha256:hash(readFileSync(process.execPath)),platform:process.platform,architecture:process.arch,esbuildVersion,
  numericalVersions:JSON.parse(numericalVersions),dependencyInstall:fresh?'FRESH_NPM_CI_LOCK_INSTALLS_AND_VERSION_PINNED_PYTHON':'DECLARED_READ_ONLY_MATCHING_LOCK_APFS_CLONED_INSTALL_ASSETS_NOT_FRESH',
  toolchain:'DECLARED_PINNED_LEAN_RUNTIME_CACHE_WITH_FULL_BYTE_INVENTORY_NOT_NEW_DOWNLOAD',
  clonePrimitive:{system:'/usr/lib/libSystem.B.dylib:clonefile',driver:'finnor-os/scripts/postx/y5/clone-paths.py',
   driverSha256:hash(readFileSync(join(source,'finnor-os/scripts/postx/y5/clone-paths.py'))),fullCopyFallback:false},
  scientificVenv:'RECREATED_AT_FINAL_INSTALLATION_PATH_NOT_ARBITRARILY_RELOCATABLE'};
 writeFileSync(join(emitted,'identity.json'),JSON.stringify(identity,null,2)+'\n',{flag:'wx',mode:0o444});
 save('build-manifest.json',{...identity,source,output,runtime,relocatedLinks,wallMs:performance.now()-started,
  sourceLoadedAdapters:'EXPLICIT_CANONICAL_TS_THROUGH_EXISTING_SOURCE_CUSTODY',hardlinksToCheckout:false,
  qualification:'BUILT_NOT_YET_EXECUTED_RECONSTRUCTED_OR_ADMITTED',protectedAdmission:false,productionActive:false});
 console.log(JSON.stringify({stage:'BUILT_NOT_EXECUTED',output,runtime,wallMs:performance.now()-started}));
}catch(error){
 save('build-failure.json',{status:'FAIL',wallMs:performance.now()-started,error:String(error),outputRetained:true});throw error;
}
