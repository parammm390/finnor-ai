import {build} from 'esbuild';
import {mkdir,copyFile,writeFile,readFile} from 'node:fs/promises';
import {resolve,join,dirname,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {runtimeIdentity as y1Runtime} from '../../packages/private-equity/src/economic-action-theory/process';
import {productRuntimeIdentity,OWNER_ASSETS} from '../../packages/private-equity/src/interaction-synthesis/product-runtime';
import {PROFILE_DIGEST} from '../../packages/private-equity/src/interaction-synthesis/contracts';
import {sourceCut} from './runtime-custody.mjs';

const root=resolve(import.meta.dirname,'../..'),repository=dirname(root),output=join(root,'dist-y3'),
 source=join(root,'packages/private-equity/src/interaction-synthesis'),
 assets=join(output,'assets/finnor-os/packages/private-equity/src/interaction-synthesis'),
 y1Source=join(root,'packages/private-equity/src/economic-action-theory'),
 y1Assets=join(output,'assets/finnor-os/packages/private-equity/src/economic-action-theory'),
 math=['profile.json','producer.py','checker.py','contracts.ts','exact.ts','game.ts','producer.ts','process.ts'];
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
await mkdir(output,{recursive:true});
if(hash(await readFile(join(repository,'scope-postx/y3-dynamic-interaction-synthesizer/profile.json')))!==PROFILE_DIGEST)
 throw Error('Y3_FROZEN_AND_PACKAGED_PROFILE_MISMATCH');
const cut=await sourceCut(),identity=await productRuntimeIdentity(),y1=await y1Runtime(),copied=new Map<string,string>();
async function copy(sourceRoot:string,targetRoot:string,path:string){
 const from=resolve(sourceRoot,path),to=resolve(targetRoot,path);
 if(!to.startsWith(join(output,'assets')+sep))throw Error('Y3_ASSET_PATH_ESCAPED');
 const bytes=await readFile(from),previous=copied.get(to);
 if(previous&&previous!==hash(bytes))throw Error('Y3_CONFLICTING_OWNER_PREIMAGE');
 await mkdir(dirname(to),{recursive:true});await copyFile(from,to);copied.set(to,hash(bytes));
}
for(const path of [...math,...OWNER_ASSETS])await copy(source,assets,path);
for(const pin of y1.sourcePins)await copy(y1Source,y1Assets,pin.path);
await build({entryPoints:[join(root,'scripts/y3/worker-loop.mts')],outfile:join(output,'worker-loop.mjs'),
 bundle:true,platform:'node',target:'node22',format:'esm',sourcemap:false,tsconfig:join(root,'tsconfig.base.json'),
 banner:{js:"import {createRequire as __y3CreateRequire} from 'node:module'; const require=__y3CreateRequire(import.meta.url);"},
 plugins:[{name:'native-owner-packaging',setup(builder){
  builder.onResolve({filter:/^[^./]|^\//},args=>{
   if(args.path==='@finnor/source-custody'||!args.path.startsWith('/')&&!args.path.startsWith('@finnor/'))
    return {path:args.path,external:true};
   return undefined;
  });
  builder.onLoad({filter:/\.(?:[cm]?ts|tsx|[cm]?js)$/},async args=>{
   if(!args.path.startsWith(repository+sep)||args.path.includes('/node_modules/')||
    args.path===join(source,'process.ts'))return;
   const original=await readFile(args.path,'utf8');
   if(!original.includes('import.meta.url')&&!original.includes('import.meta.dirname'))return;
   // Y3 process.ts deliberately keeps its real emitted module URL. Its
   // dispatch receipt hashes this executing bundle, not a copied TS source.
   const path=relative(repository,args.path).split(sep).join('/'),contents=
    'import {sourceURL as __y3SourceURL,sourceDirectory as __y3SourceDirectory} from "@finnor/source-custody";\n'+
    original.replace(/import\.meta\.url/g,'__y3SourceURL('+JSON.stringify(path)+')')
     .replace(/import\.meta\.dirname/g,'__y3SourceDirectory('+JSON.stringify(path)+')');
   return {contents,loader:args.path.endsWith('.tsx')?'tsx':/\.[cm]?js$/.test(args.path)?'js':'ts',resolveDir:dirname(args.path)};
  });
 }}]});
const file=await readFile(join(output,'worker-loop.mjs')),manifest={
 schema:'finnor.y3.installed-runtime.v1',node:process.version,source:identity,sourceCut:cut,profileDigest:PROFILE_DIGEST,
 worker:{path:'worker-loop.mjs',bytes:file.length,sha256:hash(file),mathematics:'BUNDLED_ESM_NOT_TS_LOADED'},
 assetRoot:relative(output,assets),ownerAssetRoot:relative(output,assets),y1AssetRoot:relative(output,y1Assets),
 assets:[...copied].map(([path,sha256])=>({path:relative(output,path),sha256})).sort((a,b)=>a.path.localeCompare(b.path)),
 canonicalSourceTreeRequiredForInheritedOwners:true,externalDependencies:'FRESH_LOCKFILE_INSTALL_REQUIRED',
 protectedQualification:false,productionActivated:false,externalEffects:false,
};
if((await sourceCut()).preimageDigest!==cut.preimageDigest)throw Error('Y3_SOURCE_CHANGED_DURING_WORKER_BUILD');
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Y3 emitted native factory, exact engine and owner preimages',file.length);
