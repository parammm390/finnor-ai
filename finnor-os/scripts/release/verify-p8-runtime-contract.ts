import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import {
  DEFAULT_WORKSPACE_CONFIG,
  EXPERIENCE_METRIC_KEYS,
  EXPERIENCE_QUICK_ACTION_KEYS,
  TenantExperienceManifestV3Schema,
  WORKSPACE_SURFACES,
} from "../../apps/api/lib/workspace-config";
import {
  OPERATIONAL_QUERY_INTENTS,
  RETIRED_WATER_ACTION_TYPES,
  RETIRED_WATER_QUERY_INTENTS,
} from "../../packages/shared-types/src";
import {
  createDefaultPluginRegistry,
  plannerActionTypesForVertical,
} from "../../packages/orchestration/src/plugin-registry";

const osRoot = resolve(import.meta.dirname, "../..");
const repoRoot = resolve(osRoot, "..");
const failures: string[] = [];
const exactSurfaces = ["home", "work", "deals", "agents"];

function equalValues(actual: readonly string[], expected: readonly string[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
  }
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const denied = new Set(right);
  return [...new Set(left.filter((value) => denied.has(value)))].sort();
}

equalValues(WORKSPACE_SURFACES, exactSurfaces, "workspace schema surfaces");
equalValues(DEFAULT_WORKSPACE_CONFIG.enabledSurfaces, exactSurfaces, "default workspace surfaces");
equalValues(DEFAULT_WORKSPACE_CONFIG.roles.owner.visibleSurfaces, exactSurfaces, "owner workspace surfaces");
const workspaceParse = TenantExperienceManifestV3Schema.safeParse(DEFAULT_WORKSPACE_CONFIG);
if (!workspaceParse.success) failures.push(`default Workspace V3 is invalid: ${workspaceParse.error.message}`);

const retiredMetrics = EXPERIENCE_METRIC_KEYS.filter((key) => /customer|invoice|inventory|technician|service|water/i.test(key));
const retiredQuickActions = EXPERIENCE_QUICK_ACTION_KEYS.filter((key) => /customer|invoice|inventory|technician|service|water/i.test(key));
if (retiredMetrics.length) failures.push(`retired workspace metric keys are active: ${retiredMetrics.join(", ")}`);
if (retiredQuickActions.length) failures.push(`retired workspace quick actions are active: ${retiredQuickActions.join(", ")}`);

const retiredQueries = intersection(OPERATIONAL_QUERY_INTENTS, RETIRED_WATER_QUERY_INTENTS);
if (retiredQueries.length) failures.push(`retired operational query intents are executable: ${retiredQueries.join(", ")}`);

const plannerRegistry = createDefaultPluginRegistry();
const plannerActions = plannerActionTypesForVertical(plannerRegistry, "private_equity");
const retiredPlannerActions = intersection(plannerActions, RETIRED_WATER_ACTION_TYPES);
if (retiredPlannerActions.length) failures.push(`retired planner actions are executable: ${retiredPlannerActions.join(", ")}`);

const retiredDemoRoots = [
  "src/app/demo",
  "src/app/api/demo",
  "src/app/api/demo-leads",
  "src/app/api/demo-profile",
  "src/app/api/demo-scrape",
  "src/app/api/generate-demo",
  "src/app/api/lifecycle",
  "src/app/api/voice",
  "src/components/demo",
  "src/components/lifecycle",
  "src/lib/demo",
  "src/lib/leads",
  "src/lib/lifecycle",
  "src/lib/scrape",
  "src/lib/voice",
];
const activeDemoFiles = retiredDemoRoots.flatMap((entry) => {
  const directory = join(repoRoot, entry);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((item) => item.isFile() && [".ts", ".tsx", ".js", ".jsx", ".json"].includes(extname(item.name)))
    .map((item) => join(entry, item.parentPath.slice(directory.length + 1), item.name));
});
if (activeDemoFiles.length) failures.push(`retired demo implementation files remain active: ${activeDemoFiles.join(", ")}`);

const publicContractFiles = [
  "src/app/layout.tsx",
  "src/app/manifest.ts",
  "src/config/site.ts",
  "src/components/marketing/PrivateEquityPublicPage.tsx",
  "src/lib/llm/concierge.ts",
];
const prohibitedPublicPositioning = /water[ _-]?(?:treatment|softener|filtration|test)|\bhomeowner\b|\bhousehold\b|\btechnician\b|\bservice[ _-]?visit\b|schedule_water_test|lead_to_water_test/i;
for (const file of publicContractFiles) {
  const absolute = join(repoRoot, file);
  if (!existsSync(absolute)) {
    failures.push(`public contract file is missing: ${file}`);
  } else if (prohibitedPublicPositioning.test(readFileSync(absolute, "utf8"))) {
    failures.push(`public metadata or product doctrine contains retired positioning: ${file}`);
  }
}
const publicPage = readFileSync(join(repoRoot, "src/components/marketing/PrivateEquityPublicPage.tsx"), "utf8");
if (!publicPage.includes("SYNTHETIC CONTRACT WALKTHROUGH · NOT LIVE ACTIVITY")) {
  failures.push("public synthetic walkthrough is not explicitly labeled as non-production");
}

async function main(): Promise<void> {
  let productionAuthority: Record<string, unknown> | "not_requested" = "not_requested";
  const readinessIndex = process.argv.indexOf("--readiness-url");
  if (readinessIndex >= 0) {
    const baseUrl = process.argv[readinessIndex + 1];
    if (!baseUrl) failures.push("--readiness-url requires a URL");
    else {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/ready`, {
        headers: { accept: "application/json", "cache-control": "no-cache" },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await response.json().catch(() => null) as {
        ok?: boolean;
        checks?: Record<string, { ok?: boolean; detail?: Record<string, unknown> }>;
      } | null;
      const authority = body?.checks?.productAuthority;
      productionAuthority = authority?.detail ?? { missing: true };
      if (
        !response.ok
        || body?.ok !== true
        || authority?.ok !== true
        || authority.detail?.state !== "water_retired"
        || authority.detail?.activeProductVertical !== "private_equity"
        || body.checks?.runtimeEpoch?.ok !== true
        || body.checks?.runtimeRelease?.ok !== true
      ) {
        failures.push("production runtime is not converged on water_retired/private_equity with one epoch and release");
      }
    }
  }

  const report = {
    ok: failures.length === 0,
    workspace: {
      version: DEFAULT_WORKSPACE_CONFIG.version,
      surfaces: DEFAULT_WORKSPACE_CONFIG.enabledSurfaces,
      metrics: EXPERIENCE_METRIC_KEYS.length,
      quickActions: EXPERIENCE_QUICK_ACTION_KEYS.length,
    },
    operationalQueryIntents: OPERATIONAL_QUERY_INTENTS.length,
    plannerActions: plannerActions.length,
    retiredQueryOverlap: retiredQueries,
    retiredPlannerOverlap: retiredPlannerActions,
    activeDemoFiles,
    publicContractFiles,
    productionAuthority,
    failures,
  };

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exit(1);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
