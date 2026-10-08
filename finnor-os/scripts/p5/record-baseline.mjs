import {readFile, writeFile, realpath, mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve, join} from 'node:path';
const root=resolve(import.meta.dirname,'../../..');
const destination=join(root,'scope-pm/phase-10-p5-interface-synthesis');
const control='/Users/paramdave/.codex/visualizations/2026/10/04/01a10828-82e3-7572-8d13-530b28a346bf/finnor-pm-control';
const sha=b=>createHash('sha256').update(b).digest('hex');
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const mission=await readFile(join(control,'prompts/phase-10-p5-interface-synthesis-factory.md'));
if(sha(mission)!=='5977e03c83a927ea01a42ae1b01abdcca1405cf713ee5a5cbc30429e39407417')throw Error('Mission bytes changed');
if(git('rev-parse','HEAD')!=='94423a17ac24992f4edaf12b0ab99d6731a80a7e')throw Error('Unexpected base');
const paths=[
 ['finnor-os/apps/api/app/api/company-brain/[operation]/route.ts','POST','requireContext -> owner dispatch; no-store authenticated response'],
 ['finnor-os/apps/worker/src/index.ts','createWorker','canonical job registration'],
 ['finnor-os/apps/worker/src/queue.ts','JobQueue','durable delivery/token/fence/lease; reconcilable recovery quarantines'],
 ['finnor-os/packages/db/compute-contract.ts','PRODUCTION_JOB_CONTRACTS','SQL-mirrored trusted classification'],
 ['finnor-os/packages/db/migration-head.ts','CURRENT_MIGRATION_HEAD','readiness/heartbeat migration cut'],
 ['finnor-os/packages/db/migrations-bundle.ts','BUNDLED_MIGRATIONS','generated migration closure'],
 ['finnor-os/packages/private-equity/src/evidence-execution/store.ts','authorize/tx/codeIdentity','S1 rights; principal RLS; loaded source identity'],
 ['finnor-os/packages/private-equity/src/program-synthesis/store.ts','readCurrentProgram','actual issued P1/Work/source/plan reader'],
 ['finnor-os/packages/private-equity/src/program-synthesis/ports.ts','harnessPorts','qualified owner requests, not receipts'],
 ['finnor-os/packages/private-equity/src/branch-fabric/runtime.ts','fixedProcess','registered native, isolated false; no generated Harness qualification'],
 ['finnor-os/packages/governed-execution/src/adapter-contract.ts','requireProtectedAdapter','conditional-JSON only'],
 ['finnor-os/packages/governed-execution/src/dispatch-broker.ts','DispatchBroker','durable possible egress, independent exact read, no unsafe replay'],
 ['finnor-os/packages/governed-execution/src/executor.ts','launchIsolatedNodeExecutor','actual local Seatbelt; pure output; aggregate limits unqualified'],
 ['finnor-os/packages/capability-evolution/src/lifecycle.ts','CapabilityEvolution.command','authenticated roles; journal; S6 reference transport'],
 ['finnor-os/packages/capability-evolution/src/contracts.ts','RevisionBodySchema','S5 specialized payload, preserve it'],
 ['finnor-os/packages/capability-evolution/src/source-closure.ts','requiredCapabilitySourcePaths','loaded dependency closure'],
 ['finnor-os/packages/capability-evolution/src/journal.ts','CapabilityJournal','signed/fsynced immutable history and writer lock'],
 ['finnor-os/scripts/generate-openapi.ts','OpenAPI generator','active owner schema discovery'],
 ['src/components/centropy/canvas/CanvasDocument.tsx','CanvasDocument','mounted canonical Work consumer'],
 ['src/components/centropy/canvas/canvas-compose.ts','canvas composition','root/Work-bound blocks'],
 ['src/components/centropy/canvas/canvas-contract.ts','CanvasBlockSchema','discriminated UI payloads']
];
const map=[];
for(const [path,symbol,boundary] of paths){
 const bytes=await readFile(join(root,path));map.push({path,symbol,boundary,commit:git('rev-parse','HEAD'),blob:git('rev-parse','HEAD:'+path),sha256:sha(bytes)});
}
const families=mission.toString().split('\n').flatMap(line=>{
 const match=line.match(/^\| (P5-\d{2}) \| (.+) \|$/);
 return match?[{id:match[1],predicate:match[2],status:'REGISTERED_NOT_RUN',oracle:'original predicate, independent persisted requested/decoy state and role/SQL/process observations',novelty:'PUBLIC_DEVELOPMENT_NOT_SEALED'}]:[];
});
if(families.length!==34)throw Error('Incomplete original registration');
const locks=await Promise.all(['package-lock.json','finnor-os/package-lock.json'].map(async path=>({path,sha256:sha(await readFile(join(root,path)))})));
const runtime=[];
for(const [name,folder] of [['next','node_modules'],['next','finnor-os/node_modules'],['tsx','finnor-os/node_modules'],['pg','finnor-os/node_modules'],['embedded-postgres','finnor-os/node_modules'],['@playwright/test','node_modules']]){
 const file=join(root,folder,name,'package.json');const bytes=await readFile(file);runtime.push({name,version:JSON.parse(bytes).version,manifestSha256:sha(bytes),realpath:await realpath(file)});
}
await mkdir(destination,{recursive:true});
for(const [name,body] of [
 ['base-receipt.json',{schema:'finnor.p5.base-receipt.v1',recordedAt:new Date().toISOString(),commit:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),branch:git('branch','--show-current'),commonDirectory:git('rev-parse','--git-common-dir'),remote:git('remote','get-url','origin'),preexistingStatus:git('status','--short'),locks,runtime,node:process.version,dependencyQualification:'WARM_EXTERNAL_READ_ONLY_DEPENDENCIES_LOCAL_WORKSPACE_LINKS_NOT_CLEAN_INSTALL',migrationHead:'0161_p2_compute_search.sql',peerImports:[],otherCheckout:'Preserved, not imported',p7:'PENDING_P7_COMMITTED_PORT'}],
 ['source-reference-map.json',{baseCommit:git('rev-parse','HEAD'),paths:map}],
 ['registration.json',{schema:'finnor.p5.registration.v1',registeredAt:new Date().toISOString(),missionSha256:sha(mission),families,fixtureOwner:'scripts/p5/target.mjs; driver reference state and constants not imported by producer',originalGate:'NOT_RUN'}]
])await writeFile(join(destination,name),JSON.stringify(body,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({destination,families:families.length,base:git('rev-parse','HEAD'),imports:0}));
