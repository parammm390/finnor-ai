import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root=import.meta.dirname;
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
if(process.versions.node.split(".")[0]!=="22")throw Error("Pinned Node 22 required");
const manifest=JSON.parse(await readFile(resolve(root,"source-manifest.json"),"utf8"));
const lock=JSON.parse(await readFile(resolve(root,"package-lock.json"),"utf8"));
const dependencies=[];
for(const name of ["typescript","zod"]){
  const directory=resolve(root,"node_modules",name);
  if(await realpath(directory)!==directory)throw Error("Borrowed dependency or source fallback refused");
  const bytes=await readFile(resolve(directory,"package.json"));
  const installed=JSON.parse(bytes.toString());
  if(installed.version!==lock.packages["node_modules/"+name].version)throw Error("Installed dependency version changed");
  dependencies.push({name,version:installed.version,packageJsonSha256:hash(bytes),
    originalRegistryIntegrity:lock.packages["node_modules/"+name].integrity});
}
const compiler=await import(pathToFileURL(resolve(root,"node_modules/typescript/lib/typescript.js")).href);
const ts=compiler.default;
const exact=(text,before,after)=>{
  const at=text.indexOf(before);
  if(at<0||text.indexOf(before,at+before.length)>=0)throw Error("Exact relocation preimage required");
  return text.slice(0,at)+after+text.slice(at+before.length);
};
await mkdir(resolve(root,"runtime"));
const emitted=[];
for(const input of manifest.inputs){
  const bytes=await readFile(resolve(root,input.path));
  if(hash(bytes)!==input.sha256)throw Error("Reconstruction source changed");
  let text=bytes.toString(),target;
  if(input.path==="source/semantics.ts"){
    text=exact(text,'"@finnor/private-equity/src/application-semantics/contracts"','"./application-contracts.mjs"');
    target="runtime/semantics.mjs";
  }else if(input.path==="source/application-contracts.ts"){
    text=exact(text,'"../../../governed-execution/src/protocol"','"./governed-protocol.mjs"');
    target="runtime/application-contracts.mjs";
  }else if(input.path==="source/governed-protocol.ts")target="runtime/governed-protocol.mjs";
  else{
    text=exact(text,'const root = resolve(import.meta.dirname, "../../../..");','const root = import.meta.dirname;');
    text=exact(text,'  ?? resolve(root, "scope-z/phase-evidence/z0/execution-20261024"));','  ?? resolve(root, "observed"));');
    text=exact(text,'const source = resolve(root, "finnor-os/packages/orchestration/src/project-z/z0-convergence/semantics.ts");',
      'const source = resolve(root, "runtime/semantics.mjs");');
    target="verify.mjs";
  }
  const compiled=ts.transpileModule(text,{fileName:input.path,reportDiagnostics:true,compilerOptions:{
    target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,isolatedModules:true,
  }});
  if(compiled.diagnostics?.length)throw Error("Emitted reconstruction syntax diagnostics");
  await writeFile(resolve(root,target),compiled.outputText,{flag:"wx"});
  emitted.push({path:target,bytes:Buffer.byteLength(compiled.outputText),sha256:hash(compiled.outputText)});
}
await writeFile(resolve(root,"build-receipt.json"),JSON.stringify({
  schema:"finnor.z0.installed-owned-component-build.v1",
  evidenceClass:manifest.evidenceClass,node:process.version,
  nodeBinarySha256:hash(await readFile(process.execPath)),
  compilerLibrarySha256:hash(await readFile(resolve(root,"node_modules/typescript/lib/typescript.js"))),
  isolatedDependencyLockSha256:hash(await readFile(resolve(root,"package-lock.json"))),
  dependencies,inputs:manifest.inputs,emitted,
  sourceFallback:false,copiedNodeModules:false,expectedCasesChanged:false,
  relocations:"Only module specifiers and runner root/output/source paths; no oracle or runtime function replacement",
  authenticatedProductFlow:"NOT_RUN",installedIntegratedFlow:"NOT_RUN",
},null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({evidenceClass:manifest.evidenceClass,emitted:emitted.length,sourceFallback:false,copiedNodeModules:false}));
