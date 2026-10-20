import {build} from 'esbuild';
import {mkdir,copyFile,writeFile,readFile} from 'node:fs/promises';
import {resolve,join,dirname,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {runtimeIdentity} from '../../packages/private-equity/src/economic-action-theory/process';
import {PROFILE_DIGEST,digest} from '../../packages/private-equity/src/economic-action-theory/contracts';
const root=resolve(import.meta.dirname,'../..'),repository=dirname(root),output=join(root,'dist-y1'),source=join(root,'packages/private-equity/src/economic-action-theory'),
 assets=join(output,'assets/packages/private-equity/src/economic-action-theory');
await mkdir(output,{recursive:true});
if(digest(JSON.parse(await readFile(join(root,'../scope-postx/y1-economic-action-theory/profile.json'),'utf8')))!==PROFILE_DIGEST)
 throw Error('Y1_FROZEN_AND_PACKAGED_PROFILE_MISMATCH');
const identity=await runtimeIdentity();
for(const pin of identity.sourcePins){
 const target=resolve(assets,pin.path);
 if(!target.startsWith(join(output,'assets')+'/'))throw Error('Y1_ASSET_PATH_ESCAPED');
 await mkdir(dirname(target),{recursive:true});await copyFile(resolve(source,pin.path),target);
}
await build({entryPoints:[join(root,'scripts/y1/worker-loop.mts')],outfile:join(output,'worker-loop.mjs'),
 bundle:true,platform:'node',target:'node22',format:'esm',sourcemap:false,tsconfig:join(root,'tsconfig.base.json'),
 banner:{js:"import {createRequire as __y1CreateRequire} from 'node:module'; const require=__y1CreateRequire(import.meta.url);"},
 plugins:[{name:'external-npm-only',setup(builder){
  builder.onResolve({filter:/^[^./]|^\//},args=>{
   if(args.path==='@finnor/source-custody'||!args.path.startsWith('/')&&!args.path.startsWith('@finnor/'))return {path:args.path,external:true};
   return undefined;
  });
  // Preserve the existing native owners' canonical source URLs when bundling.
  // Source custody resolves the delivered tree, never the builder's path.
  builder.onLoad({filter:/\.(?:[cm]?ts|tsx|[cm]?js)$/},async args=>{
   if(!args.path.startsWith(repository+sep)||args.path.includes('/node_modules/')||args.path.endsWith('/scripts/y1/worker-loop.mts'))return;
   const original=await readFile(args.path,'utf8');
   if(!original.includes('import.meta.url')&&!original.includes('import.meta.dirname'))return;
   const path=relative(repository,args.path),contents=
    'import {sourceURL as __y1SourceURL,sourceDirectory as __y1SourceDirectory} from "@finnor/source-custody";\n'+
    original.replace(/import\.meta\.url/g,'__y1SourceURL('+JSON.stringify(path)+')')
     .replace(/import\.meta\.dirname/g,'__y1SourceDirectory('+JSON.stringify(path)+')');
   return {contents,loader:args.path.endsWith('.tsx')?'tsx':/\.[cm]?js$/.test(args.path)?'js':'ts',resolveDir:dirname(args.path)};
  });
 }}]});
const file=await readFile(join(output,'worker-loop.mjs'));
await writeFile(join(output,'manifest.json'),JSON.stringify({schema:'finnor.y1.installed-runtime.v1',node:process.version,
 source:identity,profileDigest:PROFILE_DIGEST,worker:{path:'worker-loop.mjs',bytes:file.length,sha256:createHash('sha256').update(file).digest('hex')},
 assetRoot:'assets/packages/private-equity/src/economic-action-theory',canonicalSourceTreeRequired:true,
 externalDependencies:'FRESH_LOCKFILE_INSTALL_REQUIRED',
 protectedQualification:false},null,2)+'\n');
console.log('Y1 emitted native factory and checker assets',file.length);
