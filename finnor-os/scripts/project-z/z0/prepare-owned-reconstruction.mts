/** A separately installed replay of the already declared literal contracts.
 * It is deliberately NOT an integrated native owner or phase-I proof. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const output = process.argv.find(arg => arg.startsWith("--output="))?.slice("--output=".length);
if (!output || !resolve(output).startsWith(`${root}/scope-z/phase-evidence/z0/execution-20261024/`)) {
  throw new Error("Explicit fresh owned evidence output directory required");
}
const lock = JSON.parse(await readFile(resolve(root, "finnor-os/package-lock.json"), "utf8")) as {
  packages: Record<string, Record<string, unknown>>;
};
const names = ["typescript", "zod"];
const dependencies: Record<string, string> = {};
const packages: Record<string, Record<string, unknown>> = {};
for (const name of names) {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry || typeof entry.version !== "string" || typeof entry.integrity !== "string"
    || typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://registry.npmjs.org/")) {
    throw new Error("Exact public locked replay dependency required");
  }
  dependencies[name] = entry.version;
  packages[`node_modules/${name}`] = { ...entry, dev: false };
}
const manifest = { name: "finnor-z0-owned-contract-reconstruction", version: "0.0.0", private: true,
  type: "module", engines: { node: "22.x" }, dependencies };
const files = [
  ["finnor-os/packages/orchestration/src/project-z/z0-convergence/semantics.ts", "source/semantics.ts"],
  ["finnor-os/packages/private-equity/src/application-semantics/contracts.ts", "source/application-contracts.ts"],
  ["finnor-os/packages/governed-execution/src/protocol.ts", "source/governed-protocol.ts"],
  ["finnor-os/scripts/project-z/z0/verify-contracts.mts", "source/verify-contracts.mts"],
] as const;
await mkdir(resolve(output), { recursive: false });
await mkdir(resolve(output, "source"));
const inputs = [];
for (const [origin, path] of files) {
  const bytes = await readFile(resolve(root, origin));
  await writeFile(resolve(output, path), bytes, { flag: "wx" });
  inputs.push({ origin, path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
await writeFile(resolve(output, "package.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
await writeFile(resolve(output, "package-lock.json"), JSON.stringify({
  name: manifest.name, version: manifest.version, lockfileVersion: 3, requires: true,
  packages: { "": { name: manifest.name, version: manifest.version, engines: manifest.engines, dependencies }, ...packages },
}, null, 2) + "\n", { flag: "wx" });
await writeFile(resolve(output, "source-manifest.json"), JSON.stringify({
  evidenceClass: "OWNED_LITERAL_COMPONENT_RECONSTRUCTION_NOT_INTEGRATED_PRODUCT_OR_PHASE_I",
  inputs, originalDependencyLockSha256: createHash("sha256").update(
    await readFile(resolve(root, "finnor-os/package-lock.json"))).digest("hex"),
  sourceFallback: false, copiedNodeModules: false, nativeAssetsRequiredByThisFiniteSweep: false,
  expectedCasesChanged: false, authenticatedProductFlow: "NOT_RUN", installedIntegratedFlow: "NOT_RUN",
}, null, 2) + "\n", { flag: "wx" });
const build = String.raw`import { createHash } from "node:crypto";
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
`;
await writeFile(resolve(output, "build.mjs"), build, { flag: "wx" });
console.log(JSON.stringify({ output, dependencies, inputs: inputs.length,
  evidenceClass: "OWNED_LITERAL_COMPONENT_RECONSTRUCTION_NOT_INTEGRATED_PRODUCT_OR_PHASE_I" }));
