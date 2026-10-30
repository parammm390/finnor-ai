/**
 * R12 BEFORE probe (failure model case R12-01, side A). Runs the unchanged base tree (43e8e3a) on the native stack
 * and records that ordinary authenticated Work has no typed primary_diligence_v1 query and no primary-plan operation.
 * The control call (an existing typed intent) proves the endpoint itself works, so the refusal is attributable to the
 * missing intent. No product code is changed or imported here.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readNativeEnvironment, signInOwner } from "./x1-origin-fixture.mts";

const here = dirname(fileURLToPath(import.meta.url));
const backend = join(here, "../../..");
const repoRoot = join(backend, "..");
const state = process.env.FINNOR_NATIVE_STATE, evidence = process.env.FINNOR_NATIVE_EVIDENCE;
if (!state || !evidence) throw Error("R12_BEFORE_NATIVE_ENVIRONMENT_REQUIRED");
mkdirSync(evidence, { recursive: true });
const sha = text => createHash("sha256").update(text).digest("hex");

const env = readNativeEnvironment(state);
const owner = await signInOwner(env);
const workId = randomUUID();
const control = await owner.call("/api/queries", { intent: "work_list", openOnly: true });
const typed = await owner.call("/api/queries", { intent: "primary_diligence_v1", workId });
const plan = await owner.operation("primary-plan", {});
const manifestPath = join(repoRoot, "src/lib/centropy/capability-manifest.generated.json");
const manifest = readFileSync(manifestPath, "utf8");
const typesSource = readFileSync(join(backend, "packages/shared-types/src/operational-queries.ts"), "utf8");
const head = readFileSync(join(backend, "packages/db/migration-head.ts"), "utf8").match(/postz_[a-z0-9_]+\.sql|[0-9a-z_]+\.sql/)?.[0] ?? null;

const checks = {
  controlIntentWorks: control.status === 200,
  typedIntentRefused: typed.status >= 400 && typed.status < 500,
  planOperationRefused: plan.status >= 400 && plan.status < 500,
  capabilityManifestLacksIntent: !manifest.includes("primary_diligence_v1"),
  sharedTypesLackIntent: !typesSource.includes("primary_diligence_v1"),
};
const outcome = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
const artifact = {
  schema: "finnor.project-z.z0-r12-before.v1", case: "R12-01", side: "BEFORE", outcome, checks,
  observed: {
    control: { status: control.status },
    typedIntent: { status: typed.status, body: typed.body, bodySha256: typed.bodySha256 },
    primaryPlan: { status: plan.status, body: plan.body, bodySha256: plan.bodySha256 },
    capabilityManifest: { path: "src/lib/centropy/capability-manifest.generated.json", sha256: sha(manifest) },
    sharedTypesSha256: sha(typesSource), migrationHead: head,
  },
  finishedAt: new Date().toISOString(),
};
writeFileSync(join(evidence, "r12-before.json"), JSON.stringify(artifact, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ case: "R12-01-before", outcome, checks }));
process.exit(outcome === "PASS" ? 0 : 1);
