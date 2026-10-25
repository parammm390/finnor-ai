// Additive, exact-preimage shared requests. Does not change shared live files.
import { readFileSync, mkdirSync, writeFileSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, join, relative, isAbsolute } from "node:path";

const repo = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const output = process.argv.find(a => a.startsWith("--output="))?.slice(9);
const generatorOnly = process.argv.find(a => a.startsWith("--emit-generator-only="))?.slice(22);
const catalogueOverlay = process.argv.find(a => a.startsWith("--catalogue-overlay="))?.slice(20);
if (!output && !generatorOnly) throw Error("Fresh absolute owned --output required");
if (generatorOnly && !isAbsolute(generatorOnly)) throw Error("Absolute generator output required");
if (output && (!catalogueOverlay || !isAbsolute(catalogueOverlay))) throw Error("Absolute validated catalogue overlay required");
if (output && (!isAbsolute(output) || relative(join(repo, "scope-z/phase-evidence/z3"), output).startsWith(".."))) {
  throw Error("Fresh absolute owned --output required");
}
if (output) mkdirSync(output, { recursive: false });
const sha = body => createHash("sha256").update(body).digest("hex");
const blob = body => shaBlob(Buffer.from(body));
const shaBlob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const read = path => readFileSync(join(repo, path), "utf8");
const replace = (body, find, replacement) => {
  if (body.split(find).length !== 2) throw Error("Exact unique correction anchor missing: " + find.slice(0, 90));
  return body.replace(find, replacement);
};
// Coordinator review 06 catalogue corrections as exact generator bytes.
// Computed before any emit so --emit-generator-only can seed the disposable
// generation copy without a packet directory.
const genPath = "scripts/centropy/generate-capability-manifest.mjs", genBefore = read(genPath);
let gen = replace(genBefore,
  "const companyBrainOperations = [...new Set([",
  'const z3ViabilityOperations = registeredOperations("finnor-os/packages/private-equity/src/project-z/z3-viability/contracts.ts", "Z3_OPERATIONS")\n'
  + 'if (!z3ViabilityOperations.length || !companyBrainSource.includes("VIABILITY_OPERATIONS")) throw new Error("Z3 viability operations must be actually delegated")\n'
  + "const companyBrainOperations = [...new Set([");
gen = replace(gen, "...capitalOperations,...formationOperations,...m4Operations.keys(),",
  "...capitalOperations,...formationOperations,...m4Operations.keys(),...z3ViabilityOperations,");
gen = replace(gen, ' "interaction-local", "interaction-run-read",\n])',
  ' "interaction-local", "interaction-run-read",\n  "viability-read",\n])');
gen = replace(gen, '  operationClasses.set(`company-brain/${operation}`, "CONTROL")',
  '  operationClasses.set(`company-brain/${operation}`, "CONTROL")\noperationClasses.set("company-brain/viability-recover", "CONTROL")');
gen = replace(gen, '      path.startsWith("company-brain/response-")?["work","company-brain"]:',
  '      path.startsWith("company-brain/viability-")?["work","company-brain"]:\n      path.startsWith("company-brain/response-")?["work","company-brain"]:');
if (generatorOnly) {
  writeFileSync(generatorOnly, gen, { flag: "wx" });
  console.log(JSON.stringify({ generatorSha256: sha(gen) }));
  process.exit(0);
}
const requests = [];
function request(path, before, after, reason) {
  const ordinal = String(requests.length + 1).padStart(2, "0");
  const leaf = path.split("/").at(-1);
  const beforeFile = `${ordinal}-${leaf}.before`, afterFile = `${ordinal}-${leaf}.after`;
  writeFileSync(join(output, beforeFile), before, { flag: "wx" });
  writeFileSync(join(output, afterFile), after, { flag: "wx" });
  const result = execFileSync("git", ["diff", "--no-index", "--no-ext-diff", "--",
    join(output, beforeFile), join(output, afterFile)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    // git diff exits 1 for a diff. Handled by caller below.
  });
  return result;
}
// execFileSync throws on git-diff's expected exit 1.
function emitFromFile(path, absoluteAfter, reason) {
  const after = readFileSync(absoluteAfter, "utf8");
  emit(path, read(path), after, reason);
}
function emit(path, before, after, reason) {
  const ordinal = String(requests.length + 1).padStart(2, "0"), leaf = path.split("/").at(-1);
  let raw;
  try { raw = request(path, before, after, reason); }
  catch (error) {
    if (error.status !== 1 || typeof error.stdout !== "string") throw error;
    raw = error.stdout;
  }
  const lines = raw.split("\n");
  lines[0] = `diff --git a/${path} b/${path}`;
  lines[1] = `index ${blob(before)}..${blob(after)} 100644`;
  lines[2] = `--- a/${path}`;
  lines[3] = `+++ b/${path}`;
  const patch = lines.join("\n"), patchFile = `${ordinal}-${leaf}.patch`;
  writeFileSync(join(output, patchFile), patch, { flag: "wx" });
  requests.push({ path, reason, beforeFile: `${ordinal}-${leaf}.before`, afterFile: `${ordinal}-${leaf}.after`,
    beforeSha256: sha(before), afterSha256: sha(after), beforeBlob: blob(before), afterBlob: blob(after),
    beforeMode: path === "src/components/centropy/world/ViabilityPanel.tsx" ? 0o644 : lstatSync(join(repo, path)).mode & 0o777,
    afterMode: 0o644, patchFile, patchSha256: sha(patch), appliedToLiveSharedSource: false });
}

const s5Path = "finnor-os/packages/private-equity/src/allocation-store.ts";
const s5Before = read(s5Path);
let s5 = replace(s5Before,
  "export async function chargeInstitutionDemand(ctx:PeMutationContext,ref:ExperimentRef,request:InstitutionChargeRequest){\n return locked(ctx,async c=>{",
  `/** Same original S5 owner, optionally joined to a physical publisher's transaction. */
export const INSTITUTION_TRANSACTION_BINDING='finnor.s5.existing-institution-transaction.v1' as const;
async function institutionTransaction<T>(ctx:PeMutationContext,client:pg.PoolClient|undefined,fn:(c:pg.PoolClient)=>Promise<T>):Promise<T>{
 if(!client)return locked(ctx,fn);
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[\`s5-portfolio:\${ctx.auth.tenantId}\`]);
 await authorize(ctx,client);return fn(client);
}
export async function chargeInstitutionDemand(ctx:PeMutationContext,ref:ExperimentRef,request:InstitutionChargeRequest,client?:pg.PoolClient){
 return institutionTransaction(ctx,client,async c=>{`);
s5 = replace(s5, "export async function validateInstitutionDemand(ctx:PeMutationContext,ref:ExperimentRef){\n return locked(ctx,async c=>{",
  "export async function validateInstitutionDemand(ctx:PeMutationContext,ref:ExperimentRef,client?:pg.PoolClient){\n return institutionTransaction(ctx,client,async c=>{");
emit(s5Path, s5Before, s5, "Reuse existing S5 currentness, portfolio serializer and physical charge in the SAME transaction, no second ledger");

const s4Path = "finnor-os/packages/private-equity/src/enterprise-control.ts", s4Before = read(s4Path);
const s4 = s4Before + `
/** S4-owned entry for the first original-Work Z3 native profile. This is a
 * finite observed prefix, not a verdict-only acknowledgement or effect grant. */
export async function continueEnterpriseViabilityTx(ctx:PeMutationContext,sessionId:string,
 claim:import('./project-z/z3-viability/contracts').ViabilityClaim,client:PoolClient,db:import('@finnor/db').Db){
 return (await import('./project-z/z3-viability/consumer')).consumeCheckedViabilityTx(ctx,sessionId,claim,client,db);
}
`;
emit(s4Path, s4Before, s4, "Concrete S4 owner entry selects checked actions, observes native outcomes, advances finite memory and original Work");

const panelPath = "src/components/centropy/world/ViabilityPanel.tsx";
const panelBefore = read("scope-z/phase-evidence/z3/integration-patches/ViabilityPanel.tsx");
let panel = replace(panelBefore,
  "remainingBudget:null;remainingBudgetQualification:string;",
  "remainingBudget:{attempts:number;steps:number;computeRequests:number}|null;remainingBudgetQualification:string;\n  nativeActions:number;s4Cursor:{stateId:string;memory:number;operations:number;goalVisits:Record<string,number>}|null;");
panel = replace(panel, 'const TERMINAL=new Set(["VIABLE","UNREALIZABLE","STALE","FAILED"])',
  'const TERMINAL=new Set(["UNREALIZABLE","STALE","FAILED"])');
panel = replace(panel, 'const [busy,setBusy]=useState(false);',
  'const [busy,setBusy]=useState(false);\n  const [absentIdentity,setAbsentIdentity]=useState<string|null>(null);\n  const submitKey=useRef<{identity:string;key:string}|null>(null);');
panel = replace(panel, 'setView({identity:expected,read:result});', 'setAbsentIdentity(null);setView({identity:expected,read:result});');
panel = replace(panel, 'setView({identity:expected,read:null});', 'setAbsentIdentity(expected);setView({identity:expected,read:null});');
panel = replace(panel, 'setView(null);\n        setMessage("Current recurring-strategy state could not be verified.',
  'setAbsentIdentity(null);setView(null);\n        setMessage("Current recurring-strategy state could not be verified.');
panel = replace(panel, "  async function recover(){", `  async function submit(){
    if(busy||!session||absentIdentity!==identity)return;
    const sequence=++epoch.current,expected=identity;setBusy(true);
    if(submitKey.current?.identity!==identity)submitKey.current={identity,key:\`panel:\${workId}:\${crypto.randomUUID()}\`};
    try{
      await centropyPost("company-brain/viability-submit",{workId,idempotencyKey:submitKey.current.key});
      if(sequence===epoch.current&&identityRef.current===expected){await refresh(sequence);onChanged?.()}
    }catch(error){
      if(sequence===epoch.current&&identityRef.current===expected){
        const predicate=error instanceof CentropyApiError?(error.details as {predicate?:string}|null)?.predicate:null;
        setMessage(predicate?.startsWith("Z3_")?label(predicate):"Original Work readiness could not be confirmed. No replacement mandate or allowance was created.");
      }
    }finally{if(sequence===epoch.current&&identityRef.current===expected)setBusy(false)}
  }
  async function recover(){`);
panel = replace(panel, "if(!current||busy||!session||TERMINAL.has(current.status)||current.pendingJobs>0)return;",
  "if(!current||busy||!session||current.staleReason||TERMINAL.has(current.status)||current.pendingJobs>0)return;");
panel = replace(panel,
  "New sessions arrive through the original Work intake.",
  "Check the existing original Work below. Its accepted instruction must declare the supported internal-readiness arena, with an already current native parent and remaining original allowance. This control never asks you to invent dependency digests or authority identities.");
panel = replace(panel, '    {read?<>',
  '    {absentIdentity===identity&&session?<button type="button" disabled={busy} onClick={()=>void submit()}>Check original Work strategy</button>:null}\n    {read?<>');
panel = replace(panel, "S4 consumption recorded:", "S4 finite prefix observed:");
panel = replace(panel,
  '      <p>USD cost remains unknown. Remaining budget is unmetered: unknown, not zero. {read.s7HistoryComplete?"":"The bounded cost read is incomplete."}</p>',
  '      <p>USD cost remains unknown. {read.remainingBudget?`Original allowance remaining: ${read.remainingBudget.attempts} attempts, ${read.remainingBudget.steps} steps, ${read.remainingBudget.computeRequests} compute requests.`:"Current remaining allowance is unavailable, not zero."} {read.s7HistoryComplete?"":"Interrupted or incomplete cost evidence remains a gap."}</p>\n      {read.s4Cursor?<p>Native prefix: {read.nativeActions} observations, state {read.s4Cursor.stateId}, memory {read.s4Cursor.memory}. No effect or UNKNOWN was cleared by this observation.</p>:null}');
panel = replace(panel,
  'disabled={!session||busy||read.pendingJobs>0} onClick={()=>void recover()}>Reconcile recovery',
  'disabled={!session||busy||!!read.staleReason||read.pendingJobs>0||!read.remainingBudget||read.remainingBudget.attempts<1||read.remainingBudget.steps<5||read.remainingBudget.computeRequests<1} onClick={()=>void recover()}>{read.status==="VIABLE"?"Continue bounded readiness":"Reconcile recovery"}');
emit(panelPath, panelBefore, panel, "Mounted original-Work submit and explicit finite continuation, no caller-chosen digests or authority");
writeFileSync(join(output, "ViabilityPanel.tsx"), panel, { flag: "wx" });
const queuePath = "finnor-os/apps/worker/src/queue.ts", queueBefore = read(queuePath);
let queue = replace(queueBefore,
  "UPDATE jobs SET lease_expires_at=now()+($5 || ' seconds')::interval,lease_heartbeat_at=now()",
  "UPDATE jobs SET lease_expires_at=clock_timestamp()+($5 || ' seconds')::interval,lease_heartbeat_at=clock_timestamp()");
queue = replace(queue,
  "WHERE id=$1 AND status='running' AND lease_owner=$2 AND claim_token=$3 AND claim_fence=$4\n            RETURNING id\n         )\n         UPDATE job_delivery_attempts SET heartbeat_at=now()",
  "WHERE id=$1 AND status='running' AND lease_owner=$2 AND claim_token=$3 AND claim_fence=$4\n              AND lease_expires_at>clock_timestamp()\n            RETURNING id\n         )\n         UPDATE job_delivery_attempts SET heartbeat_at=now()");
queue = replace(queue,
  "WHERE id=$1 AND status='running' AND lease_owner=$2 AND claim_token=$3 AND claim_fence=$4\n            RETURNING id\n         )\n         UPDATE job_delivery_attempts SET outcome='completed'",
  "WHERE id=$1 AND status='running' AND lease_owner=$2 AND claim_token=$3 AND claim_fence=$4\n              AND lease_expires_at>clock_timestamp()\n            RETURNING id\n         )\n         UPDATE job_delivery_attempts SET outcome='completed'");
emit(queuePath, queueBefore, queue, "Do not resurrect or complete an expired physical lease, even without a successor; exact global queue request only");
emit(genPath, genBefore, gen, "Enumerate delegated Z3 viability operations; read stays READ, recover becomes CONTROL, both writes invalidate work/company-brain per coordinator review 06");
if (!catalogueOverlay || !isAbsolute(catalogueOverlay)) throw Error("Absolute --catalogue-overlay with --check-validated regenerated catalogue bytes required");
emitFromFile("src/lib/centropy/capability-manifest.generated.json", join(catalogueOverlay, "src/lib/centropy/capability-manifest.generated.json"),
  "Regenerated deterministic capability manifest including the three mounted viability operations");
emitFromFile("docs/centropy/capability-coverage.json", join(catalogueOverlay, "docs/centropy/capability-coverage.json"),
  "Regenerated coverage audit; generatedAt/sourceBaseCommit are generation metadata excluded from the staleness comparison");
const prior = read("scope-z/phase-evidence/z3/integration-patches/manifest.json");
const manifest = { schema: "finnor.z3.native-correction-patches.v4", repoSource: "CURRENT_OWNED_WORKTREE",
  priorNinePatchManifestSha256: sha(prior), sharedApplicationOwner: "COORDINATOR",
  builderSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
  nativeOwnerCorrectionCommit: "ae8d1f68e201c23044be9cf7b7fec2c19a71750c",
  purpose: "STANDALONE_RECONSTRUCTION_ONLY_ALREADY_ADOPTED_NOT_COORDINATOR_REAPPLY",
  coordinatorDisposition: "v3 owner corrections and equivalent Z3 catalogue semantics are already integrated; retain the combined S5/Z1 source and do not reapply this standalone packet",
  prerequisite: "Original nine patches; supersedes retained v2/v3; requests 05-07 carry the coordinator review 06 catalogue corrections as preimage-bound bytes",
  requests, databaseExecutionAuthorized: false, protectedQualification: "NOT_RUN" };
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ patches: requests.length, manifestSha256: sha(readFileSync(join(output, "manifest.json"))) }));
