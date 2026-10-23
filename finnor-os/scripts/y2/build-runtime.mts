import {build} from 'esbuild';
import {mkdir,readFile,copyFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import './stamp-source.mts';
const backend=resolve(import.meta.dirname,'../..'),repository=dirname(backend),out=join(backend,'dist-y2'),
 source=join(backend,'packages/epistemic-runtime/src/strategic-response'),assets=join(out,'assets/packages/epistemic-runtime/src/strategic-response');
if(process.versions.node.split('.')[0]!=='22')throw Error('Y2_BUILD_NODE_22_REQUIRED');
const {strategicRuntimeIdentity}=await import('../../packages/epistemic-runtime/src/strategic-response/process');
const identity=await strategicRuntimeIdentity();
if(!identity.assetsMatchEmitted)throw Error('Y2_EMITTED_METHOD_ASSET_MISMATCH');
await mkdir(out,{recursive:true});
for(const pin of identity.sourcePins){
 const target=resolve(assets,pin.path);
 if(!target.startsWith(join(out,'assets')+sep))throw Error('Y2_PACKAGED_ASSET_ESCAPE');
 await mkdir(dirname(target),{recursive:true});await copyFile(resolve(source,pin.path),target);
}
await copyFile(join(source,'source-manifest.generated.ts'),join(assets,'source-manifest.generated.ts'));
await build({entryPoints:[join(backend,'scripts/y2/worker-loop.mts')],outfile:join(out,'worker-loop.mjs'),
 bundle:true,platform:'node',target:'node22',format:'esm',sourcemap:false,tsconfig:join(backend,'tsconfig.base.json'),
 banner:{js:"import {createRequire as __y2Require} from 'node:module';const require=__y2Require(import.meta.url);"},
 plugins:[{name:'external-npm-and-canonical-source-urls',setup(builder){
  builder.onResolve({filter:/^[^./]|^\//},args=>{
   if(args.path==='@finnor/source-custody'||!args.path.startsWith('/')&&!args.path.startsWith('@finnor/'))return {path:args.path,external:true};
   return undefined;
  });
  builder.onLoad({filter:/\.(?:[cm]?ts|tsx|[cm]?js)$/},async args=>{
   if(!args.path.startsWith(repository+sep)||args.path.includes('/node_modules/'))return;
   const original=await readFile(args.path,'utf8');
   if(!original.includes('import.meta.url')&&!original.includes('import.meta.dirname'))return;
   const path=relative(repository,args.path),contents=
    'import {sourceURL as __y2SourceURL,sourceDirectory as __y2SourceDirectory} from "@finnor/source-custody";\n'+
    original.replace(/import\.meta\.url/g,'__y2SourceURL('+JSON.stringify(path)+')')
     .replace(/import\.meta\.dirname/g,'__y2SourceDirectory('+JSON.stringify(path)+')');
   return {contents,loader:args.path.endsWith('.tsx')?'tsx':/\.[cm]?js$/.test(args.path)?'js':'ts',resolveDir:dirname(args.path)};
  });
 }}]});
const file=await readFile(join(out,'worker-loop.mjs'));
await writeFile(join(out,'manifest.json'),JSON.stringify({schema:'finnor.y2.installed-runtime.v1',node:process.version,source:identity,
 assetRoot:'assets/packages/epistemic-runtime/src/strategic-response',worker:{path:'worker-loop.mjs',bytes:file.length,
 sha256:createHash('sha256').update(file).digest('hex')},canonicalSourceTreeRequired:true,
 dependencies:'FRESH_LOCKFILE_INSTALL_REQUIRED',protectedQualification:false},null,2)+'\n');
console.log('Y2 emitted actual native worker and bounded checker assets',file.length);
