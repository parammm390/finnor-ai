/** Current-coordinator exact-preimage proposal. Never edits either shared tree. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--coordinator" || args[2] !== "--output"
  || !args[1].startsWith("/") || !args[3].startsWith("/")) throw Error("Z0_EXPLICIT_COORDINATOR_AND_OUTPUT_REQUIRED");
const coordinator = resolve(args[1]), output = resolve(args[3]);
if (!output.startsWith(resolve(root, "scope-z/phase-evidence/z0") + sep) || existsSync(output)
  || coordinator === root) throw Error("Z0_NEW_OWNED_PROPOSAL_DIRECTORY_REQUIRED");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const pins = {
  "finnor-os/packages/private-equity/src/application-semantics/store.ts": "d6d675a06d2f0d82b6231667bc52d4397b87e402759c690582a2b73c3bdbcc88",
  "finnor-os/packages/private-equity/src/program-synthesis/institution.ts": "ca957fa26929f6a97c4c585010f4c4d8e668b1d3cbdde7df774a8cd81b7c43e1",
  "finnor-os/packages/private-equity/src/program-synthesis/institution-continuation.ts": "eadf1cc5b7d91781dfc8e430dd27698e4725ba6d65948fc843833bff2efd83ec",
};
const replace = (text, before, after) => {
  if (text.split(before).length !== 2) throw Error("Z0_SHARED_OWNER_SEAM_DRIFT");
  return text.replace(before, after);
};
const changes = [];
for (const [path, pin] of Object.entries(pins)) {
  const before = await readFile(resolve(coordinator, path), "utf8");
  if (digest(before) !== pin) throw Error("Z0_CURRENT_COORDINATOR_PREIMAGE_CHANGED:" + path);
  let after = before;
  if (path.endsWith("/application-semantics/store.ts")) {
    after = replace(after, 'import type { PoolClient } from "pg";',
      'import type { PoolClient } from "pg";\nimport type { JobExecutionContext } from "../../../../apps/worker/src/queue";');
    after = replace(after, "  recovery = false): Promise<void> {",
      "  recovery = false, institutionDelivery?: Readonly<JobExecutionContext>): Promise<void> {");
    after = replace(after, "await currentInstitutionApplicationSession(ctx, row, c, recovery);",
      "await currentInstitutionApplicationSession(ctx, row, c, recovery, institutionDelivery);");
    after = replace(after, "await currentApplicationWork(ctx, parent, client);",
      "await currentApplicationWork(ctx, parent, client, false, institutionDelivery);");
  } else if (path.endsWith("/institution.ts")) {
    after = replace(after, "import { consumeInstitutionApplicationModels }",
      "import { assertInstitutionApplicationDeliveryCurrent }");
    after = replace(after, " await consumeInstitutionApplicationModels(ctx,q.id);\n", "");
    after = replace(after, " const head:InstitutionHarnessProgram=structuredClone(q.proposed);",
      " await assertInstitutionApplicationDeliveryCurrent(ctx,current.id,execution);\n const head:InstitutionHarnessProgram=structuredClone(q.proposed);");
  } else {
    after = replace(after, "import { consumeInstitutionApplicationModels }",
      "import { assertInstitutionApplicationDeliveryCurrent, consumeInstitutionApplicationModels, recordInstitutionApplicationModelUse, institutionApplicationOwnerInputFromCanonicalAction }");
    after = replace(after, " await consumeInstitutionApplicationModels(ctx,q.id);\n", "");
    after = replace(after, "  resourceCharged=true;\n", "  resourceCharged=true;\n  await assertInstitutionApplicationDeliveryCurrent(ctx,claimed.id,execution);\n");
    after = replace(after, "   if(existing&&existing.plan_revision_id!==q.plan_revision_id&&existing.status===\"draft\"){",
      "   const priorApplicationInput=existing?institutionApplicationOwnerInputFromCanonicalAction(node,existing.authority_context):null;\n"
      + "   if(existing?.status===\"draft\"&&priorApplicationInput?.modelUseRef)await recordInstitutionApplicationModelUse(ctx,claimed.id,execution,priorApplicationInput);\n"
      + "   if(existing&&existing.plan_revision_id!==q.plan_revision_id&&existing.status===\"draft\"){");
    after = replace(after, '    const { FinnorOrchestrator }=await import("../../../orchestration/src");',
      '    const applicationInput=priorApplicationInput??await consumeInstitutionApplicationModels(ctx,claimed.id,execution,node);\n'
      + '    const ownerPayload=applicationInput.node.action!.payload;\n'
      + '    if(sha(ownerPayload)!==sha(planNode.groundedPayload))throw Error("Z0_NATIVE_FROZEN_OWNER_ARGUMENT_CHANGED");\n'
      + '    const { FinnorOrchestrator }=await import("../../../orchestration/src");');
    after = replace(after, "draftKnownAction(node.operation,planNode.groundedPayload,q.tenant_id,{",
      "draftKnownAction(node.operation,ownerPayload,q.tenant_id,{");
    after = replace(after, "      stableIdentity:node.stableIdentity,workInputId:q.work_input_id},",
      "      stableIdentity:node.stableIdentity,workInputId:q.work_input_id,\n"
      + "      applicationModelUseRef:applicationInput.modelUseRef,\n"
      + "      applicationModelAcceptanceRef:applicationInput.acceptanceRef,\n"
      + "      applicationModelInputDigest:applicationInput.modelUseRef?sha(applicationInput.node.action):null},");
    after = replace(after, "     planRevisionId:q.plan_revision_id,planNodeId:planNode.id,reviewBeforeExecution:false,",
      "     planRevisionId:q.plan_revision_id,planNodeId:planNode.id,reviewBeforeExecution:false,\n"
      + "     onActionPersisted:async()=>{await recordInstitutionApplicationModelUse(ctx,claimed.id,execution,applicationInput);},");
  }
  changes.push({ path, before, after });
}
await mkdir(output, { mode: 0o700 });
let patch = "";
for (const { path, before, after } of changes) {
  for (const [population, bytes] of [["preimages", before], ["postimages", after]]) {
    const destination = resolve(output, population, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: "wx" });
  }
  const oldLines = before.trimEnd().split("\n"), newLines = after.trimEnd().split("\n");
  patch += `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n`
    + oldLines.map(line => "-" + line + "\n").join("") + newLines.map(line => "+" + line + "\n").join("");
}
const manifest = {
  schema: "finnor.project-z.z0.current-coordinator-owner-use-proposal.v1",
  observedAt: new Date().toISOString(), coordinator,
  coordinatorHead: execFileSync("git", ["-C", coordinator, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  coordinatorTree: execFileSync("git", ["-C", coordinator, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
  patchSha256: digest(patch), paths: changes.map(({ path, before, after }) => ({
    path, preimageSha256: digest(before), postimageSha256: digest(after),
  })), sharedFilesWritten: false, reviewState: "PROPOSED_NOT_APPLIED",
  sqlReconciliation: { sha256: "1511609691eed81aee3f227d70a0a5b061adf604780d5c6ab16822cc47aa029a", changeRequested: false },
};
for (const { path, before } of changes) if (digest(await readFile(resolve(coordinator, path))) !== digest(before)) {
  throw Error("Z0_COORDINATOR_CHANGED_DURING_PROPOSAL");
}
await writeFile(resolve(output, "owner-use.patch"), patch, { flag: "wx" });
await writeFile(resolve(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(manifest));
