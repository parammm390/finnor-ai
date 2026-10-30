/** Build exact coordinator inputs without modifying any shared runtime file. */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { frontendIntegration } from "./integration-frontend.mts";

export const INTEGRATION_BASE = "684d805e471836a720aa6741a3128eca17d28202";
export const MIGRATION_NAME = "postz_z0_institution_application_bridge.sql";
const leaf = "finnor-os/packages/orchestration/src/project-z/z0-convergence";
const app = "finnor-os/packages/private-equity/src/application-semantics";
const p1 = "finnor-os/packages/private-equity/src/program-synthesis";
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export interface IntegrationChange { path: string; before: string | null; after: string }
export type Replace = (path: string, before: string, after: string) => Promise<void>;

export async function buildIntegrationChanges(root: string): Promise<IntegrationChange[]> {
  const changes = new Map<string, IntegrationChange>();
  const load = async (path: string) => {
    let change = changes.get(path);
    if (!change) {
      const before = await readFile(resolve(root, path), "utf8");
      change = { path, before, after: before };
      changes.set(path, change);
    }
    return change;
  };
  const replace: Replace = async (path, before, after) => {
    const change = await load(path), at = change.after.indexOf(before);
    if (!before || at < 0 || change.after.indexOf(before, at + before.length) >= 0) {
      throw new Error(`Exact single preimage required: ${path}: ${before.slice(0, 100)}`);
    }
    change.after = change.after.slice(0, at) + after + change.after.slice(at + before.length);
  };
  const owner = "../../../orchestration/src/project-z/z0-convergence";
  await replace(`${app}/native-contracts.ts`,
    'import { z } from "zod";',
    `import { z } from "zod";\nimport { InstitutionApplicationSelectorSchema } from "${owner}/semantics";`);
  await replace(`${app}/native-contracts.ts`,
    "  deadlineAt: instant, idempotencyKey: key,\n}).strict();",
    "  deadlineAt: instant, idempotencyKey: key,\n  institutionalOrigin: InstitutionApplicationSelectorSchema.optional(),\n}).strict();");
  await replace(`${app}/ports.ts`, "  institutionalProgramRef: ExperimentRef | null;",
    "  institutionalProgramRef: ExperimentRef | null;\n  institutionalOriginRef?: ExperimentRef;");

  await replace(`${app}/api.ts`, 'import { randomUUID } from "node:crypto";',
    `import { randomUUID } from "node:crypto";
import { originOf, prepareInstitutionApplicationOrigin } from "${owner}/institution-origin";
import { returnInstitutionApplicationToOriginal } from "${owner}/institution-consumer";
import { projectInstitutionApplication } from "${owner}/projection";`);
  await replace(`${app}/api.ts`,
    "  if (new Set(request.profileIds).size !== request.profileIds.length",
    "  const institutionalOrigin = await prepareInstitutionApplicationOrigin(ctx, request);\n  if (new Set(request.profileIds).size !== request.profileIds.length");
  await replace(`${app}/api.ts`,
    "  const sessionId = randomUUID(), validAfter = new Date().toISOString();",
    `  if (institutionalOrigin && (institutionalOrigin.body.workInputId !== inputRow.id
    || institutionalOrigin.body.workInputDigest !== x2Digest(inputRow.body))) x2Fault("Z0_EXACT_ORIGINAL_X1_INPUT_REQUIRED");
  const sessionId = randomUUID(), validAfter = new Date().toISOString();`);
  await replace(`${app}/api.ts`,
    "    requestDigest, deadlineAt: request.deadlineAt, registeredResourceDemand: request.resourceDemand,",
    "    requestDigest, deadlineAt: request.deadlineAt, registeredResourceDemand: request.resourceDemand,\n    institutionalOriginRef: institutionalOrigin?.ref ?? null,");
  await replace(`${app}/api.ts`,
    "    deadlineAt: request.deadlineAt, idempotencyKey: key, requestDigest, demand: request.resourceDemand,",
    "    deadlineAt: request.deadlineAt, idempotencyKey: key, requestDigest, demand: request.resourceDemand,\n    institutionalOrigin, institutionalRequest: request,");
  await replace(`${app}/api.ts`,
    "        originalParentRef: originalRef, tenantRef: refs.tenant, workRef: refs.work, institutionalProgramRef: null,",
    `        originalParentRef: originalRef, tenantRef: refs.tenant, workRef: refs.work,
        institutionalProgramRef: institutionalOrigin?.body.institutionalProgramRef ?? null,
        ...(institutionalOrigin ? { institutionalOriginRef: institutionalOrigin.ref } : {}),`);
  await replace(`${app}/api.ts`, "  const parent = await applicationSession(ctx, request.sessionId);",
    `  const parent = await applicationSession(ctx, request.sessionId);
  if (originOf(parent)) x2Fault("Z0_INSTITUTION_LEARNING_IS_NOT_FRESH_BUSINESS_AUTHORITY", 403);`);
  await replace(`${app}/api.ts`,
    '      effects, charges: await applicationParentCharges(ctx, row.allocation_ref), billing: "UNKNOWN",',
    '      effects, charges: await applicationParentCharges(ctx, row.allocation_ref), billing: "UNKNOWN",\n      institutional: await projectInstitutionApplication(ctx, row),');
  await replace(`${app}/api.ts`,
    '      await enqueueApplicationSession(ctx, updated, "cancellation-observation", c);',
    '      await enqueueApplicationSession(ctx, updated, "cancellation-observation", c);\n      await returnInstitutionApplicationToOriginal(ctx, updated, c);');
  await replace(`${app}/api.ts`, "    const current = rows[0];",
    "    const current = rows.find(row => !originOf(row));");

  await replace(`${app}/allocation.ts`, 'import type { PoolClient } from "pg";',
    `import type { PoolClient } from "pg";
import { assertStandaloneApplicationWork, type InstitutionalAcquireRequest,
  type PreparedInstitutionOrigin } from "${owner}/institution-origin";
import { chargeInheritedApplicationParent, inheritedApplicationConsumption, isInheritedApplicationAllocation,
  readInheritedApplicationAllocation, reserveInheritedApplicationParent,
  type OriginalInstitutionReservation } from "${owner}/institution-allocation";`);
  await replace(`${app}/allocation.ts`,
    "  certificate: ApplicationAllocationCertificate; reservation: ApplicationReservation;",
    "  certificate: ApplicationAllocationCertificate; reservation: ApplicationReservation | OriginalInstitutionReservation;");
  await replace(`${app}/allocation.ts`,
    "  root: { entityType: string; entityId: string };\n  onReserved?:",
    "  root: { entityType: string; entityId: string };\n  institutionalOrigin?: PreparedInstitutionOrigin | null;\n  institutionalRequest?: InstitutionalAcquireRequest;\n  onReserved?:");
  await replace(`${app}/allocation.ts`,
    "  const snapshot = await readAllocationSnapshot(ctx);",
    `  if (input.institutionalOrigin) {
    if (!input.institutionalRequest || !input.onReserved) x2Fault("Z0_ATOMIC_ORIGINAL_INSTITUTION_SESSION_REQUIRED");
    return reserveInheritedApplicationParent(ctx, {
      originalParentRef: input.originalParentRef, preparationRef: input.preparationRef,
      rightsRef: input.rightsRef, requestDigest: input.requestDigest, demand: input.demand,
      request: input.institutionalRequest, origin: input.institutionalOrigin, onReserved: input.onReserved,
    });
  }
  if (input.institutionalRequest?.institutionalOrigin) x2Fault("Z0_ORIGINAL_INSTITUTION_PREPARATION_REQUIRED");
  const snapshot = await readAllocationSnapshot(ctx);`);
  await replace(`${app}/allocation.ts`,
    '    if (Date.parse(input.deadlineAt) <= Date.now()',
    '    await assertStandaloneApplicationWork(ctx, input.workId, c);\n    if (Date.parse(input.deadlineAt) <= Date.now()');
  await replace(`${app}/allocation.ts`,
    "async function readApplicationAllocationInTransaction(ctx: PeMutationContext, c: PoolClient, ref: ExperimentRef): Promise<ApplicationAllocation> {",
    `async function readApplicationAllocationInTransaction(ctx: PeMutationContext, c: PoolClient, ref: ExperimentRef, recovery = false): Promise<ApplicationAllocation> {
  if (isInheritedApplicationAllocation(ref)) return readInheritedApplicationAllocation(ctx, ref, c, recovery);`);
  await replace(`${app}/allocation.ts`,
    "    const current = await readApplicationAllocationInTransaction(ctx, client, ref);",
    "    const current = await readApplicationAllocationInTransaction(ctx, client, ref, recovery);");
  await replace(`${app}/allocation.ts`,
    "    if (x2Digest(current.reservation.envelopes) !== x2Digest(current.certificate.check.envelopes))",
    "    if (!isInheritedApplicationAllocation(ref) && x2Digest(current.reservation.envelopes) !== x2Digest(current.certificate.check.envelopes))");
  await replace(`${app}/allocation.ts`,
    "export async function applicationConsumptionInTransaction(ctx: PeMutationContext, c: PoolClient, input: ConsumptionInput) {",
    `export async function applicationConsumptionInTransaction(ctx: PeMutationContext, c: PoolClient, input: ConsumptionInput) {
  if (isInheritedApplicationAllocation(input.certificateRef)) return inheritedApplicationConsumption(ctx, c, input);`);
  await replace(`${app}/allocation.ts`,
    '  if (!Number.isSafeInteger(input.units) || input.units < 1 || input.units > 2048 || !input.key',
    '  if (isInheritedApplicationAllocation(input.allocationRef)) return chargeInheritedApplicationParent(ctx, input, client);\n  if (!Number.isSafeInteger(input.units) || input.units < 1 || input.units > 2048 || !input.key');

  await replace(`${app}/store.ts`, 'import { readFile } from "node:fs/promises";',
    `import { readFile } from "node:fs/promises";\nimport { currentInstitutionApplicationSession } from "${owner}/institution-origin";`);
  await replace(`${app}/store.ts`, "export const APPLICATION_SOURCE_FILES = [",
    `export const APPLICATION_SOURCE_FILES = [
  ...["index", "semantics", "original-work-observation", "institution-origin", "institution-allocation",
    "institution-consumer", "projection"].map(name => \`${leaf}/\${name}.ts\`),
  "${leaf}/s5-owner-adapter.sql",
  "finnor-os/packages/db/migration-head.ts",
  "finnor-os/packages/db/migrations/${MIGRATION_NAME}",`);
  await replace(`${app}/store.ts`,
    '    const actor = await c.query("SELECT id FROM finnor_os.users',
    '    await currentInstitutionApplicationSession(ctx, row, c, recovery);\n    const actor = await c.query("SELECT id FROM finnor_os.users');

  await replace(`${app}/worker.ts`, 'import { z } from "zod";',
    `import { z } from "zod";
import { originOf } from "${owner}/institution-origin";
import { acceptInstitutionApplicationModel, returnInstitutionApplicationToOriginal } from "${owner}/institution-consumer";`);
  await replace(`${app}/worker.ts`, "    if (workStatus) {", "    if (workStatus && !originOf(current)) {");
  await replace(`${app}/worker.ts`,
    '    await applicationEvent(ctx, next, "NATIVE_SESSION_" + status, detail, c);',
    '    await applicationEvent(ctx, next, "NATIVE_SESSION_" + status, detail, c);\n    await returnInstitutionApplicationToOriginal(ctx, next, c);');
  await replace(`${app}/worker.ts`,
    '    await transitionWorkTx(db, current.tenant_id, current.work_id, "completed", "application_model_independently_checked",',
    `    const originalAcceptance = await acceptInstitutionApplicationModel(ctx, next, model, check, execution, c);
    if (!originalAcceptance) await transitionWorkTx(db, current.tenant_id, current.work_id, "completed", "application_model_independently_checked",`);
  await replace(`${app}/worker.ts`,
    '      await applicationEvent(ctx, row, "STOPPED_ORIGINAL_OBSERVATION_FALLBACK", { recovered, unresolved,',
    '      await tx(ctx, c => returnInstitutionApplicationToOriginal(ctx, row, c));\n      await applicationEvent(ctx, row, "STOPPED_ORIGINAL_OBSERVATION_FALLBACK", { recovered, unresolved,');

  await replace(`${app}/obligations.ts`, 'import { randomUUID } from "node:crypto";',
    `import { randomUUID } from "node:crypto";
import { originOf } from "${owner}/institution-origin";
import { inheritedApplicationEffectState } from "${owner}/institution-allocation";`);
  await replace(`${app}/obligations.ts`,
    `    await c.query("UPDATE finnor_os.s5_consumption_states SET effect_ref=$1::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$2 AND consumption_id=$3",
      [JSON.stringify({ owner: "S6", id: effectId, version: "business-effect-v1", contentDigest: effect.semanticHash }), ctx.auth.tenantId, consumption.ref.id]);
    await c.query("UPDATE finnor_os.s5_reservations SET status='CONSUMPTION_PENDING',revision=revision+1,updated_at=clock_timestamp()"
      + " WHERE tenant_id=$1 AND reservation_id=$2 AND status='RESERVED'",
      [ctx.auth.tenantId, session.reservation_ref.id]);`,
    `    if (originOf(session)) await inheritedApplicationEffectState(ctx, c, obligation.ref.id, "BOUND");
    else {
      await c.query("UPDATE finnor_os.s5_consumption_states SET effect_ref=$1::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$2 AND consumption_id=$3",
        [JSON.stringify({ owner: "S6", id: effectId, version: "business-effect-v1", contentDigest: effect.semanticHash }), ctx.auth.tenantId, consumption.ref.id]);
      await c.query("UPDATE finnor_os.s5_reservations SET status='CONSUMPTION_PENDING',revision=revision+1,updated_at=clock_timestamp()"
        + " WHERE tenant_id=$1 AND reservation_id=$2 AND status='RESERVED'",
        [ctx.auth.tenantId, session.reservation_ref.id]);
    }`);
  await replace(`${app}/obligations.ts`,
    `    await c.query("UPDATE finnor_os.s5_consumption_states SET status='UNKNOWN_OUTCOME',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND consumption_id=$2",
      [ctx.auth.tenantId, obligation.consumptionRef.id]);
    await c.query("UPDATE finnor_os.s5_reservations SET status='UNKNOWN_OUTCOME',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",
      [ctx.auth.tenantId, session.reservation_ref.id]);`,
    `    if (originOf(session)) await inheritedApplicationEffectState(ctx, c, obligation.ref.id, "POSSIBLE");
    else {
      await c.query("UPDATE finnor_os.s5_consumption_states SET status='UNKNOWN_OUTCOME',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND consumption_id=$2",
        [ctx.auth.tenantId, obligation.consumptionRef.id]);
      await c.query("UPDATE finnor_os.s5_reservations SET status='UNKNOWN_OUTCOME',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",
        [ctx.auth.tenantId, session.reservation_ref.id]);
    }`);
  await replace(`${app}/obligations.ts`,
    "    const state = (await c.query<{ revision: number }>(",
    '    const state = originOf(session) ? await inheritedApplicationEffectState(ctx, c, obligation.ref.id, "OBSERVED") : (await c.query<{ revision: number }>(');
  await replace(`${app}/obligations.ts`,
    "    if (verified || denied) await c.query(",
    "    if (!originOf(session) && (verified || denied)) await c.query(");

  await replace(`${p1}/institution.ts`,
    "import type { JobExecutionContext } from '../../../../apps/worker/src/queue';",
    `import type { JobExecutionContext } from '../../../../apps/worker/src/queue';\nimport { consumeInstitutionApplicationModels } from '${owner}/institution-consumer';`);
  await replace(`${p1}/institution.ts`,
    " if(q.head_id)return continueInstitutionProgram(ctx,q,execution);",
    " if(q.head_id)return continueInstitutionProgram(ctx,q,execution);\n await consumeInstitutionApplicationModels(ctx,q.id);");
  await replace(`${p1}/institution-continuation.ts`,
    'import type { PoolClient } from "pg";',
    `import type { PoolClient } from "pg";\nimport { consumeInstitutionApplicationModels } from "${owner}/institution-consumer";`);
  await replace(`${p1}/institution-continuation.ts`,
    ' const started=performance.now(),startedAt=new Date().toISOString();',
    ' await consumeInstitutionApplicationModels(ctx,q.id);\n const started=performance.now(),startedAt=new Date().toISOString();');

  const orchestration = "finnor-os/packages/orchestration/src/index.ts";
  await replace(orchestration,
    'import { fail as economicQueryFault } from "@finnor/private-equity/src/economic-action-theory/contracts";',
    `import { isOriginalWorkObservation } from "./project-z/z0-convergence/semantics";
import { observeOriginalWork } from "./project-z/z0-convergence/original-work-observation";
export { ConvergedInstitutionRuntime } from "./project-z/z0-convergence";`);
  await replace(orchestration,
    "export interface OperationalQueryOptions {\n  sessionId?: string;",
    "export interface OperationalQueryOptions {\n  workInputId?: string;\n  sessionId?: string;");
  const orchestrationChange = await load(orchestration);
  const blockStart = orchestrationChange.after.indexOf('    if (request.intent === "economic_programme_v1") {');
  const blockEnd = orchestrationChange.after.indexOf('    const instruction = `Typed operational query: ${request.intent}`;', blockStart);
  if (blockStart < 0 || blockEnd < 0) throw new Error("Native observation preimage missing");
  await replace(orchestration, orchestrationChange.after.slice(blockStart, blockEnd),
    `    if (isOriginalWorkObservation(request)) {
      return observeOriginalWork(request, ctx, opts, this.fastReadOnlyRouter);
    }
`);
  await replace("finnor-os/apps/api/app/api/queries/route.ts",
    '  if (!isRecord(input)) return { success: false, error: "A JSON object is required" };',
    `  if (!isRecord(input)) return { success: false, error: "A JSON object is required" };
  if (input.intent === "harness_program_v1" || input.intent === "confidential_economic_computation_v1") {
    return { success: false, error: "NATIVE_ORIGINAL_WORK_OWNER_REQUIRED" };
  }`);

  await frontendIntegration(replace);
  await replace("finnor-os/packages/db/migration-head.ts",
    'export const CURRENT_MIGRATION_HEAD = "postx_y4_runtime_migration_order.sql";',
    `export const CURRENT_MIGRATION_HEAD = "${MIGRATION_NAME}";`);
  await replace("infra/deployment/production.contract.json",
    '"requiredMigrationHead": "postx_y4_runtime_migration_order.sql"',
    `"requiredMigrationHead": "${MIGRATION_NAME}"`);
  await replace("scripts/release/release-policy.test.mjs",
    'assert.equal(contract.release.requiredMigrationHead, "postx_y4_runtime_migration_order.sql")',
    `assert.equal(contract.release.requiredMigrationHead, "${MIGRATION_NAME}")`);
  const migration = await readFile(resolve(root, `${leaf}/s5-owner-adapter.sql`), "utf8");
  const migrationPath = `finnor-os/packages/db/migrations/${MIGRATION_NAME}`;
  try {
    await readFile(resolve(root, migrationPath));
    throw new Error("New migration target already exists");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  changes.set(migrationPath, { path: migrationPath, before: null, after: migration });
  await replace("finnor-os/scripts/bundle-migrations.ts",
    '"postx_y4_runtime_migration_order.sql"].includes(name)',
    `"postx_y4_runtime_migration_order.sql","${MIGRATION_NAME}"].includes(name)`);
  await replace("finnor-os/packages/db/migrations-bundle.ts", "\n];\n",
    `\n  { name: ${JSON.stringify(MIGRATION_NAME)}, sql: ${JSON.stringify(migration)} },\n];\n`);
  const pinned = JSON.parse(await readFile(resolve(root,
    "finnor-os/scripts/project-z/z0/integration-preimages.json"), "utf8")) as {
      sourceBase: string; sourceTree: string; preimages: Record<string, string | null>;
    };
  if (pinned.sourceBase !== INTEGRATION_BASE || Object.keys(pinned.preimages).length !== changes.size) {
    throw new Error("Exact coordinator preimage population changed");
  }
  for (const change of changes.values()) {
    if (!Object.hasOwn(pinned.preimages, change.path)
      || pinned.preimages[change.path] !== (change.before === null ? null : sha256(change.before))) {
      throw new Error(`Exact coordinator preimage changed: ${change.path}`);
    }
  }
  return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path, "en"));
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const output = process.argv.find(arg => arg.startsWith("--output="))?.slice("--output=".length);
  if (!output || !resolve(output).startsWith(`${root}/scope-z/phase-evidence/z0/execution-20261024/`)) {
    throw new Error("Explicit fresh owned evidence output directory required");
  }
  const pinned = JSON.parse(await readFile(resolve(root,
    "finnor-os/scripts/project-z/z0/integration-preimages.json"), "utf8")) as {
      sourceBase: string; sourceTree: string;
    };
  let head: string | null = null, tree: string | null = null;
  try {
    const options = { encoding: "utf8" as const, stdio: "pipe" as const };
    head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], options).trim();
    tree = execFileSync("git", ["-C", root, "rev-parse", "HEAD^{tree}"], options).trim();
  } catch {
    head = null; tree = null;
    // Exact source preimages, not local Git objects or an unchanged owned HEAD,
    // bind this proposal. Plain source-archive reconstruction is supported.
  }
  const changes = await buildIntegrationChanges(root);
  if (head !== null) execFileSync("git", ["-C", root, "diff", "--exit-code", "--",
    ...changes.filter(c => c.before !== null).map(c => c.path)]);
  await mkdir(resolve(output), { recursive: false });
  const scratch = await mkdtemp(resolve(output, ".diff-"));
  const temporary: string[] = [];
  try {
    const manifest = [], patches: string[] = [];
    for (let i = 0; i < changes.length; i++) {
      const change = changes[i]!, before = resolve(scratch, `${i}.before`), after = resolve(scratch, `${i}.after`);
      if (change.before !== null) {
        await writeFile(before, change.before, { flag: "wx" }); temporary.push(before);
      }
      await writeFile(after, change.after, { flag: "wx" }); temporary.push(after);
      const diff = spawnSync("git", ["-C", root, "diff", "--no-index", "--no-ext-diff", "--no-color",
        "--text", "--", change.before === null ? "/dev/null" : before, after], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
      if (diff.status !== 1 || diff.error) throw new Error(`Patch generation failed: ${change.path}: ${diff.error ?? diff.stderr}`);
      let header = true;
      const patch = diff.stdout.split("\n").map(line => {
        if (line.startsWith("@@")) header = false;
        if (!header) return line;
        if (line.startsWith("diff --git ")) return `diff --git a/${change.path} b/${change.path}`;
        if (line.startsWith("--- ")) return change.before === null ? "--- /dev/null" : `--- a/${change.path}`;
        if (line.startsWith("+++ ")) return `+++ b/${change.path}`;
        return line;
      }).join("\n");
      patches.push(patch);
      manifest.push({ path: change.path, preimageSha256: change.before === null ? null : sha256(change.before),
        postimageSha256: sha256(change.after), patchSha256: sha256(patch),
        sourceBytes: change.before === null ? null : Buffer.byteLength(change.before),
        postimageBytes: Buffer.byteLength(change.after) });
    }
    const patch = patches.join("");
    await writeFile(resolve(output, "coordinator-integration.patch"), patch, { flag: "wx" });
    await writeFile(resolve(output, "coordinator-integration.json"), JSON.stringify({
      schema: "finnor.z0.coordinator-integration.v1", disposition: "PROPOSED_NOT_APPLIED",
      interfaceVersion: "institution-runtime-convergence-v1", sourceBase: pinned.sourceBase,
      sourceTree: pinned.sourceTree, observedHead: head, observedHeadTree: tree,
      gitObjectsRequiredForPreimageBinding: false,
      patchSha256: sha256(patch), paths: manifest,
      authority: "COORDINATOR_REVIEW_AND_SHARED_FILE_OWNERSHIP_REQUIRED",
      migrationExecuted: false, grantsExecuted: false, authenticatedProductProof: "NOT_RUN",
    }, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ sourceBase: pinned.sourceBase, observedHead: head, output,
      sharedPaths: manifest.length, patchSha256: sha256(patch) }));
  } finally {
    for (const path of temporary) await unlink(path);
    await rmdir(scratch);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
