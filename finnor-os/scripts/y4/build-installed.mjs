/** Task-local emitted installation. No deployment or outside-platform writes. */
import {build,transform,version as esbuildVersion} from "esbuild";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {constants,copyFileSync,existsSync,linkSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,statfsSync,writeFileSync} from "node:fs";
import {dirname,isAbsolute,join,relative,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {builtinModules} from "node:module";
const source=resolve(dirname(fileURLToPath(import.meta.url)),"../../.."),args=process.argv.slice(2),options=new Map();
for(let i=0;i<args.length;i++){
 const key=args[i];
 if(key==="--link-dependencies"){options.set(key,true);continue;}
 if(!["--output","--dependencies","--reuse-source"].includes(key)||options.has(key)||!isAbsolute(args[i+1]??""))
  throw Error("NEW_ABSOLUTE_INSTALLATION_AND_TASK_DEPENDENCIES_REQUIRED");
 options.set(key,args[++i]);
}
if(!options.has("--output")||!options.has("--dependencies"))throw Error("INSTALLATION_ARGUMENTS_REQUIRED");
const output=resolve(options.get("--output")),dependencies=realpathSync(options.get("--dependencies")),
 runtime=join(output,"runtime"),emitted=join(runtime,"y4-runtime");
const reuse=options.has("--reuse-source")?realpathSync(options.get("--reuse-source")):null,linked=options.has("--link-dependencies");
if(existsSync(output)||output.startsWith(source+"/")||esbuildVersion!=="0.25.12")throw Error("UNUSED_OUTPUT_AND_LOCKED_EMITTER_REQUIRED");
mkdirSync(emitted,{recursive:true,mode:0o700});
const hash=bytes=>createHash("sha256").update(bytes).digest("hex"),files=[];
const exclude=path=>path.split("/").some(part=>["node_modules",".git",".next","evidence","PRIVATE-NOT-FOR-HANDOFF"].includes(part)||/^\.env(?:\.|$)/.test(part));
// Existing owners identify both workspace locks and their closed frontend
// source cuts, even when their business operation is not invoked by Y4.
const inheritedSourceFiles=new Set(["package.json","package-lock.json","tsconfig.json","next.config.mjs",
 "scope-frontier5/x1-institutional-programme-compiler/profile.json"]);
for(const owner of ["enterprise-applications","policy-learning","system-identification"]){
 for(const name of ["source-paths.ts","source-manifest.generated.ts"]){
  const path=join(source,"finnor-os/packages/private-equity/src",owner,name);
  for(const match of readFileSync(path,"utf8").matchAll(/["'](src\/[^"']+)["']/g)){
   if(match[1].split("/").some(part=>part==="..")||exclude(match[1]))throw Error("CONTAINED_INHERITED_SOURCE_REQUIRED");
   inheritedSourceFiles.add(match[1]);
  }
 }
}
const paths=execFileSync("git",["-C",source,"ls-files","--cached","--others","--exclude-standard","-z"],{encoding:"utf8",maxBuffer:8*1024*1024}).split("\0")
 .filter(p=>(p.startsWith("finnor-os/")||p.startsWith("src/")||p.startsWith("e2e/y4/")||inheritedSourceFiles.has(p))&&!exclude(p));
for(const path of [...new Set(paths)].sort()){
 const original=join(source,path),target=join(runtime,path);
 if(!lstatSync(original).isFile())throw Error("REGULAR_SOURCE_FILES_REQUIRED:"+path);
 mkdirSync(dirname(target),{recursive:true});
 const previous=reuse&&join(reuse,"runtime",path);
 if(previous&&existsSync(previous)&&lstatSync(previous).isFile()
  &&realpathSync(previous).startsWith(reuse+"/")&&hash(readFileSync(previous))===hash(readFileSync(original)))linkSync(previous,target);
 else copyFileSync(original,target,constants.COPYFILE_EXCL);
 files.push({path:relative(output,target),bytes:lstatSync(target).size,sha256:hash(readFileSync(target)),kind:"source"});
}
// createRequire()/resolve() calls are deliberately not rewritten by esbuild.
// These existing native/child-process dependencies are part of the runtime too.
const dynamicDependencies=["fs-ext","tsx","typescript"];
const external=new Set(dynamicDependencies),builtins=new Set([...builtinModules,...builtinModules.map(name=>"node:"+name)]);
const omittedBuildOnlyOptional=new Set();
const externalRoot=path=>path.startsWith("@")?path.split("/").slice(0,2).join("/"):path.split("/")[0];
const bundle=await build({absWorkingDir:runtime,entryPoints:{
 "api-host":"finnor-os/scripts/y4/api-host.mts","worker-loop":"finnor-os/scripts/y4/worker-loop.mts",
 "capability-service":"finnor-os/packages/capability-evolution/src/server.mts"},
 outdir:emitted,outExtension:{".js":".mjs"},bundle:true,format:"esm",platform:"node",target:"node22",
 tsconfig:join(runtime,"finnor-os/tsconfig.json"),metafile:true,write:false,sourcemap:false,
 banner:{js:'import {createRequire as __y4Require} from "node:module";import {fileURLToPath as __y4Path} from "node:url";import {dirname as __y4Dir} from "node:path";const require=__y4Require(import.meta.url);const __y4URL=p=>new URL("../"+p,import.meta.url).href;const __y4Directory=p=>__y4Dir(__y4Path(__y4URL(p)));'},
 plugins:[{name:"explicit-installed-dependencies-and-source-paths",setup(plugin){
  plugin.onResolve({filter:/^[^./]/},({path})=>{
   if(!path.startsWith("@finnor/")&&!path.startsWith("@/")&&!builtins.has(path)){
    external.add(externalRoot(path));
    return {path:path==="next/server"?"next/server.js":path,external:true};
   }
  });
  plugin.onLoad({filter:/\.[cm]?[jt]sx?$/},async({path})=>{
   if(!path.startsWith(runtime+"/")||path.includes("/node_modules/"))return;
   const contents=readFileSync(path,"utf8"),name=relative(runtime,path);
   if(!/import\.meta\.(url|dirname)/.test(contents))return;
   const transformed=await transform(contents,{loader:path.endsWith("tsx")?"tsx":/\.[cm]?ts$/.test(path)?"ts":"js",target:"node22",format:"esm",
    define:{"import.meta.url":"__y4ModuleURL","import.meta.dirname":"__y4ModuleDirectory"},
    banner:"const __y4ModuleURL=__y4URL("+JSON.stringify(name)+");const __y4ModuleDirectory=__y4Directory("+JSON.stringify(name)+");"});
   return {contents:transformed.code,loader:"js"};
  });
 }}]});
for(const file of bundle.outputFiles){
 const target=resolve(file.path);
 if(!target.startsWith(emitted+"/"))throw Error("CONTAINED_EMITTED_ENTRY_REQUIRED");
 const previous=reuse&&join(reuse,relative(output,target));
 if(previous&&existsSync(previous)&&lstatSync(previous).isFile()
  &&realpathSync(previous).startsWith(reuse+"/")&&hash(readFileSync(previous))===hash(file.contents))linkSync(previous,target);
 else writeFileSync(target,file.contents,{flag:"wx"});
}
const copied=new Set(),visited=new Set(),rootSlots=new Set();
function materialize(original,target,ancestors=new Set()){
 const actual=realpathSync(original),entry=lstatSync(actual);
 if(!actual.startsWith(dependencies+"/"))throw Error("DEPENDENCY_ESCAPES_TASK_CLOSURE");
 if(entry.isDirectory()){
  if(ancestors.has(actual))throw Error("DEPENDENCY_DIRECTORY_CYCLE");
  mkdirSync(target,{recursive:true});
  const next=new Set(ancestors);next.add(actual);
  for(const name of readdirSync(actual).sort())if(![".cache",".git"].includes(name))materialize(join(actual,name),join(target,name),next);
 }else if(entry.isFile()){
  mkdirSync(dirname(target),{recursive:true});
  if(linked)linkSync(actual,target);else copyFileSync(actual,target,constants.COPYFILE_EXCL);
 }else throw Error("REGULAR_DEPENDENCY_FILES_REQUIRED");
}
function locate(name,directory){
 if(!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name))throw Error("PACKAGE_SLOT_REQUIRED");
 let current=directory;
 while(current.startsWith(dependencies+"/")){
  const candidate=join(current,"node_modules",name);
  if(existsSync(join(candidate,"package.json")))return candidate;
  current=dirname(current);
 }
 const candidate=join(dependencies,name);
 return existsSync(join(candidate,"package.json"))?candidate:null;
}
function visit(directory){
 const actual=realpathSync(directory);
 if(visited.has(actual))return;visited.add(actual);
 const manifest=JSON.parse(readFileSync(join(actual,"package.json"),"utf8"));copied.add(manifest.name);
 const required=new Set(Object.keys(manifest.dependencies??{}));
 for(const [name,details] of Object.entries(manifest.peerDependencies??{})){
  if(!manifest.peerDependenciesMeta?.[name]?.optional)required.add(name);
 }
 const children=new Set([...required,...Object.keys(manifest.optionalDependencies??{}),...Object.keys(manifest.peerDependencies??{})]);
 for(const name of children){
  if(name.startsWith("@next/swc-")||name==="sharp"){omittedBuildOnlyOptional.add(name);continue;}
  const child=locate(name,actual);
  if(!child){if(required.has(name))throw Error("RUNTIME_DEPENDENCY_MISSING:"+manifest.name+":"+name);continue;}
  // Preserve npm's actual slots, aliases and nested versions. Never flatten a
  // nested version over the root version used by another installed package.
  const relativeName=relative(dependencies,child),root=relativeName.startsWith("@")?relativeName.split("/").slice(0,2).join("/"):relativeName.split("/")[0];
  copyPackage(root);
  visit(child);
 }
}
function copyPackage(name){
 if(rootSlots.has(name))return;
 const directory=join(dependencies,name);
 if(!existsSync(join(directory,"package.json")))throw Error("INSTALLED_LOCKED_DEPENDENCY_MISSING:"+name);
 rootSlots.add(name);
 materialize(directory,join(runtime,"node_modules",name));
 visit(directory);
}
for(const name of external)copyPackage(name);
function inventory(directory){
 for(const entry of readdirSync(directory,{withFileTypes:true})){
  const path=join(directory,entry.name);
  if(entry.isDirectory())inventory(path);
  else if(entry.isFile())files.push({path:relative(output,path),bytes:lstatSync(path).size,sha256:hash(readFileSync(path)),kind:"emitted_or_dependency"});
  else throw Error("NO_EXTERNAL_RUNTIME_LINKS_OR_SPECIAL_FILES:"+path);
 }
}
inventory(join(runtime,"node_modules"));inventory(emitted);
const manifest={schema:"finnor.y4.installed-runtime.v1",head:execFileSync("git",["-C",source,"rev-parse","HEAD"],{encoding:"utf8"}).trim(),
 sourceDiffDigest:hash(execFileSync("git",["-C",source,"diff","HEAD","--binary"],{maxBuffer:16*1024*1024})),
 emitterVersion:esbuildVersion,node:process.version,files,thirdPartyPackageNames:[...copied].sort(),
 explicitDynamicRuntimeDependencies:dynamicDependencies,
 emittedFromRetainedSourceSnapshot:true,
 frontendSourceRetained:true,frontendDependencyClosurePackaged:false,
 inheritedSourceClosure:[...inheritedSourceFiles].sort(),
 omittedBuildOnlyOptionalDependencies:[...omittedBuildOnlyOptional].sort(),
 dependencyMaterialization:linked?"TASK_LOCAL_HARDLINKS_NOT_INDEPENDENT":"REGULAR_BYTE_COPIES",
 sourceReuse:reuse?{path:reuse,unchangedBytesIndividuallyChecked:true,independent:false}:null,
 sourceModules:Object.keys(bundle.metafile.inputs).filter(p=>p.startsWith("finnor-os/")),
 freeBytesAfter:Number(statfsSync(output).bavail)*Number(statfsSync(output).bsize),
 protectedAdmission:false,productionActive:false,deployed:false,independentCleanInstall:false};
writeFileSync(join(output,"emitter-metafile.json"),JSON.stringify(bundle.metafile)+"\n",{flag:"wx"});
const bytes=JSON.stringify(manifest)+"\n";
writeFileSync(join(output,"installation.json"),bytes,{flag:"wx",mode:0o444});
writeFileSync(join(output,"installation.sha256"),hash(bytes)+"\n",{flag:"wx",mode:0o444});
console.log(JSON.stringify({output,manifestSha256:hash(bytes),files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),
 sourceModules:manifest.sourceModules.length,independentCleanInstall:false,protectedAdmission:false}));
