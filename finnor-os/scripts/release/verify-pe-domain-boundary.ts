import { access, readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_ENTITY_TYPES,
  EXECUTABLE_VERTICALS,
  OPERATIONAL_QUERY_INTENTS,
  PARTY_TYPES,
  PHASE5_DISPOSITION_COUNTS,
  PHASE5_DISPOSITION_LEDGER,
  PHASE5_DISPOSITION_LEDGER_VERSION,
  RETIRED_WATER_ACTION_TYPES,
  RETIRED_WATER_CANONICAL_ENTITY_TYPES,
  RETIRED_WATER_IMPLEMENTATION_PATHS,
  RETIRED_WATER_JOB_TYPES,
  RETIRED_WATER_PARTY_TYPES,
  RETIRED_WATER_QUERY_INTENTS,
  RETIRED_WATER_WORKFLOW_TYPES,
} from "@finnor/shared-types";
import { PE_ENTITY_TYPES } from "../../packages/private-equity/src/types";
import {
  ACTION_HARDENING_SPEC,
  EXECUTABLE_ACTION_COUNT,
} from "./action-hardening-spec";
import { discoverActionRegistry } from "./discover-action-registry";
import { activeImportEntityTypes } from "../../packages/import-engine/src/definition";
import { activeCanonicalImportWriterTypes } from "../../packages/import-engine/src/index";
import { createSourceAdapterRegistry } from "../../packages/tools/src/source-adapters";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");

const SOURCE_ROOTS = [
  "apps/api",
  "apps/orchestrator",
  "apps/worker",
  "apps/supplier-canary",
  "packages",
  "scripts",
  "tests",
] as const;

const HISTORICAL_OR_CONTROL_PREFIXES = [
  "packages/db/migrations/",
] as const;

const HISTORICAL_OR_CONTROL_FILES = new Set([
  "packages/db/migrations-bundle.ts",
  "packages/db/schema.ts",
  "packages/shared-types/src/retired-water.ts",
  "packages/read-models/src/work-cases.ts",
  "packages/read-models/src/causal-replay.ts",
  // Exact negative-control fixture proving a retired answer action is never browser-eligible.
  "packages/orchestration/src/instruction-trace.test.ts",
  "apps/api/lib/retired-water-webhook.ts",
  "apps/api/app/api/webhooks/ghl/route.ts",
  "apps/api/app/api/webhooks/marketing/route.ts",
  "apps/api/app/api/webhooks/payment/route.ts",
  "apps/api/app/api/webhooks/esign/route.ts",
  "scripts/release/verify-pe-domain-boundary.ts",
  "scripts/release/run-pe5-water-retirement-certification.ts",
  // Exact negative/history tests. There is deliberately no tests/** wildcard.
  "tests/unit/graph-allowlist.test.ts",
  "tests/unit/import-mapping.test.ts",
  "tests/unit/outcome-pack-contracts.test.ts",
  "tests/unit/pe5-runtime-boundary.test.ts",
  "tests/unit/private-equity-phase4-contract.test.ts",
  "tests/unit/private-equity-planner-isolation.test.ts",
  "tests/integration/private-equity-phase2.test.ts",
  "tests/integration/private-equity-phase3.test.ts",
  "tests/integration/work-cases.test.ts",
]);

const COGNITION_PATHS = [
  "packages/orchestration/src/planner.ts",
  "packages/orchestration/src/conversation.ts",
  "packages/orchestration/src/conversation-kernel.ts",
  "packages/orchestration/src/objective-loop.ts",
  "packages/orchestration/src/repair.ts",
  "packages/orchestration/src/operating-context.ts",
  "packages/orchestration/src/interaction-context.ts",
  "packages/orchestration/src/planner-memory.ts",
  "packages/epistemic-runtime/fixtures",
  "packages/epistemic-runtime/src",
  "tests/planner-evals",
] as const;

const RETIRED_COGNITION_PATTERN = /\b(?:water[ _-]?test|water[ -]treatment|water-treatment|household|technician|service_visit|maintenance_agreement|warehouse_stock|inventory_item|dealer[ _-]?zero|water dispatch|water reorder)\b/i;

const ALLOWED_PLUGIN_DIRECTORIES = new Set([
  "clarification",
  "computer-task",
  "private-equity",
  "shared",
  "universal-actions",
  "web-research",
]);

const ACTIVE_PLUGIN_PACKAGES = new Set([
  "@finnor/plugin-computer-task",
  "@finnor/plugin-private-equity",
  "@finnor/plugin-universal-actions",
  "@finnor/plugin-web-research",
]);

const RETIRED_EXECUTABLE_TOKENS = [
  ...RETIRED_WATER_ACTION_TYPES,
  ...RETIRED_WATER_QUERY_INTENTS,
  ...RETIRED_WATER_JOB_TYPES,
  ...RETIRED_WATER_WORKFLOW_TYPES,
] as const;

export interface BoundaryViolation {
  file: string;
  line: number;
  token: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RETIRED_TOKEN_PATTERN = new RegExp(`\\b(${RETIRED_EXECUTABLE_TOKENS.map(escapeRegex).join("|")})\\b`, "g");

export function scanExecutableText(file: string, source: string): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    RETIRED_TOKEN_PATTERN.lastIndex = 0;
    for (const match of line.matchAll(RETIRED_TOKEN_PATTERN)) {
      violations.push({ file, line: index + 1, token: match[0] });
    }
  }
  return violations;
}

function isAllowedHistoricalOrControl(path: string): boolean {
  return HISTORICAL_OR_CONTROL_FILES.has(path)
    || HISTORICAL_OR_CONTROL_PREFIXES.some((entry) => path.startsWith(entry));
}

async function collectFiles(path: string): Promise<string[]> {
  const absolute = resolve(ROOT, path);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") continue;
    if (/ 2\.[^.]+$/.test(entry.name)) continue; // unrelated local conflict copies are never release inputs
    const nested = join(absolute, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(relative(ROOT, nested)));
    else if ([".ts", ".tsx", ".js", ".mjs", ".json"].includes(extname(entry.name))) files.push(nested);
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  try { await access(resolve(ROOT, path)); return true; } catch { return false; }
}

async function collectPath(path: string): Promise<string[]> {
  const info = await stat(resolve(ROOT, path));
  return info.isDirectory() ? collectFiles(path) : [resolve(ROOT, path)];
}

async function containsFile(path: string): Promise<boolean> {
  const absolute = resolve(ROOT, path);
  try {
    const info = await stat(absolute);
    if (info.isFile()) return true;
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.isFile()) return true;
      if (entry.isDirectory() && await containsFile(relative(ROOT, join(absolute, entry.name)))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function equalSets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

async function verifyPackageEntrypoints(errors: string[]): Promise<void> {
  const pkg = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (scanExecutableText("package.json", command).length) errors.push(`package script ${name} contains a retired executable token`);
    const match = command.match(/(?:^|&&\s*|;\s*)(?:npx\s+)?tsx\s+([^\s]+)/);
    if (match && !await exists(match[1]!)) errors.push(`package script ${name} points to missing ${match[1]}`);
  }
  if (pkg.scripts?.["PE-DOMAIN-BOUNDARY"] !== "tsx scripts/release/verify-pe-domain-boundary.ts") {
    errors.push("package script PE-DOMAIN-BOUNDARY is missing or altered");
  }
}

async function verifyPackageDependencyBoundary(errors: string[]): Promise<void> {
  const manifests = [resolve(ROOT, "package.json"),
    ...(await Promise.all(["apps", "packages"].map(collectFiles))).flat()
      .filter((path) => path.endsWith("/package.json"))];
  const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
  for (const manifest of manifests) {
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of dependencyFields) {
      for (const dependency of Object.keys(parsed[field] ?? {})) {
        if (dependency.startsWith("@finnor/plugin-") && !ACTIVE_PLUGIN_PACKAGES.has(dependency)) {
          errors.push(`${relative(ROOT, manifest)} ${field} retains retired plugin dependency ${dependency}`);
        }
      }
    }
  }

  const lockPath = resolve(ROOT, "package-lock.json");
  if (!await exists("package-lock.json")) {
    errors.push("package-lock.json is missing");
    return;
  }
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
    packages?: Record<string, { name?: string }>;
  };
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const dependency = entry.name ?? "";
    if (dependency.startsWith("@finnor/plugin-") && !ACTIVE_PLUGIN_PACKAGES.has(dependency)) {
      errors.push(`package-lock.json retains retired plugin package ${dependency} at ${path}`);
    }
    const pluginPath = path.match(/^packages\/domain-plugins\/([^/]+)$/)?.[1];
    if (pluginPath && !ALLOWED_PLUGIN_DIRECTORIES.has(pluginPath)) {
      errors.push(`package-lock.json retains retired plugin workspace ${pluginPath}`);
    }
  }
}

export async function verifyPeDomainBoundary(): Promise<{ scannedFiles: number; negativeControl: true }> {
  const errors: string[] = [];

  for (const path of RETIRED_WATER_IMPLEMENTATION_PATHS) if (await containsFile(path)) errors.push(`retired path exists: ${path}`);

  if (PHASE5_DISPOSITION_LEDGER_VERSION !== 2 || PHASE5_DISPOSITION_COUNTS.unknown !== 0) {
    errors.push("PE0/P1/P5 disposition ledger version or UNKNOWN count is invalid");
  }
  if (PHASE5_DISPOSITION_COUNTS.total !== PHASE5_DISPOSITION_LEDGER.length) {
    errors.push("disposition ledger count does not match its rows");
  }
  const ledgerIds = new Set<string>();
  const allowedP5Actions = new Set(["REMOVE_RUNTIME", "DELETE_SOURCE", "QUARANTINE_HISTORY", "RETAIN_CORE", "RETAIN_PROVIDER_TRANSPORT"]);
  for (const row of PHASE5_DISPOSITION_LEDGER) {
    if (ledgerIds.has(row.id)) errors.push(`duplicate disposition ledger id: ${row.id}`);
    ledgerIds.add(row.id);
    if (!row.evidence.trim() || !allowedP5Actions.has(row.p5Action) || !row.postCutoverReachability) {
      errors.push(`incomplete disposition ledger row: ${row.id}`);
    }
  }

  const pluginEntries = await readdir(resolve(ROOT, "packages/domain-plugins"), { withFileTypes: true });
  const unexpectedPlugins: string[] = [];
  for (const entry of pluginEntries) {
    if (entry.isDirectory() && !ALLOWED_PLUGIN_DIRECTORIES.has(entry.name)
        && await containsFile(`packages/domain-plugins/${entry.name}`)) unexpectedPlugins.push(entry.name);
  }
  unexpectedPlugins.sort();
  if (unexpectedPlugins.length) errors.push(`unexpected active plugin directories: ${unexpectedPlugins.join(", ")}`);

  const files = (await Promise.all(SOURCE_ROOTS.map(collectFiles))).flat();
  const violations: BoundaryViolation[] = [];
  for (const absolute of files) {
    const path = relative(ROOT, absolute);
    if (isAllowedHistoricalOrControl(path)) continue;
    violations.push(...scanExecutableText(path, await readFile(absolute, "utf8")));
  }
  for (const violation of violations) errors.push(`${violation.file}:${violation.line} contains retired executable token ${violation.token}`);

  for (const absolute of (await Promise.all(COGNITION_PATHS.map(collectPath))).flat()) {
    const path = relative(ROOT, absolute);
    // Ignore comments so denial-boundary documentation can name the retired product;
    // executable strings and fixtures remain in scope.
    const source = (await readFile(absolute, "utf8"))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const match = source.match(RETIRED_COGNITION_PATTERN);
    if (match) errors.push(`${path} contains retired cognition semantics ${match[0]}`);
  }

  const discovered = await discoverActionRegistry();
  const discoveredTypes = discovered.map((row) => row.actionType);
  const expectedTypes = ACTION_HARDENING_SPEC.map((row) => row.actionType);
  if (EXECUTABLE_ACTION_COUNT !== 41 || !equalSets(discoveredTypes, expectedTypes)) {
    errors.push(`active action registry mismatch: discovered=${discoveredTypes.length}, expected=${EXECUTABLE_ACTION_COUNT}`);
  }
  const retiredActions = discoveredTypes.filter((type) => (RETIRED_WATER_ACTION_TYPES as readonly string[]).includes(type));
  if (retiredActions.length) errors.push(`retired actions registered: ${retiredActions.join(", ")}`);

  const expectedVerticals = ["none", "private_equity"];
  if (!equalSets(EXECUTABLE_VERTICALS, expectedVerticals)) errors.push(`executable verticals are ${EXECUTABLE_VERTICALS.join(", ")}`);
  if (OPERATIONAL_QUERY_INTENTS.length !== 14) errors.push(`active query registry has ${OPERATIONAL_QUERY_INTENTS.length} intents; expected 14`);
  const retiredQueries = OPERATIONAL_QUERY_INTENTS.filter((intent) => (RETIRED_WATER_QUERY_INTENTS as readonly string[]).includes(intent));
  if (retiredQueries.length) errors.push(`retired queries registered: ${retiredQueries.join(", ")}`);
  const expectedParties = ["employee", "team", "location", "external_organization", "external_contact"];
  if (!equalSets(PARTY_TYPES, expectedParties)) errors.push(`active party contract is ${PARTY_TYPES.join(", ")}`);
  const activeEntityIntersection = [...CANONICAL_ENTITY_TYPES, ...PE_ENTITY_TYPES]
    .filter((type) => (RETIRED_WATER_CANONICAL_ENTITY_TYPES as readonly string[]).includes(type));
  if (activeEntityIntersection.length) errors.push(`retired canonical entities remain active: ${activeEntityIntersection.join(", ")}`);
  const partyIntersection = PARTY_TYPES.filter((type) => (RETIRED_WATER_PARTY_TYPES as readonly string[]).includes(type));
  if (partyIntersection.length) errors.push(`retired party types remain active: ${partyIntersection.join(", ")}`);

  if (activeImportEntityTypes().length || activeCanonicalImportWriterTypes().length) {
    errors.push("active import entity/writer registry must be empty until a PE import pack is explicitly certified");
  }
  if (createSourceAdapterRegistry().providers().length) errors.push("active provider-to-business source mapping registry must be empty");

  const workerSource = await readFile(resolve(ROOT, "apps/worker/src/index.ts"), "utf8");
  const registeredJobs = [...workerSource.matchAll(/queue\.register\(["']([^"']+)["']/g)].map((match) => match[1]!);
  const scheduledJobs = [...workerSource.matchAll(/\{\s*type:\s*["']([^"']+)["']/g)].map((match) => match[1]!);
  const retiredJobs = [...registeredJobs, ...scheduledJobs].filter((type) => (RETIRED_WATER_JOB_TYPES as readonly string[]).includes(type));
  if (retiredJobs.length) errors.push(`retired worker/scheduler jobs registered: ${[...new Set(retiredJobs)].join(", ")}`);

  await verifyPackageEntrypoints(errors);
  await verifyPackageDependencyBoundary(errors);

  const openApiRaw = await readFile(resolve(ROOT, "openapi.json"), "utf8");
  for (const intent of OPERATIONAL_QUERY_INTENTS) {
    if (!openApiRaw.includes(`\"const\": \"${intent}\"`)) errors.push(`OpenAPI is missing active query intent ${intent}`);
  }
  for (const intent of RETIRED_WATER_QUERY_INTENTS) {
    if (openApiRaw.includes(`\"const\": \"${intent}\"`)) errors.push(`OpenAPI exposes retired query intent ${intent}`);
  }

  const injected = scanExecutableText("negative-control.ts", 'queue.register("scan_low_inventory", handler);');
  if (injected.length !== 1 || injected[0]?.token !== "scan_low_inventory") {
    errors.push("deliberate negative injection was not detected exactly once");
  }

  if (errors.length) throw new Error(`PE-DOMAIN-BOUNDARY FAIL\n${errors.map((error) => `- ${error}`).join("\n")}`);
  return { scannedFiles: files.length, negativeControl: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void verifyPeDomainBoundary()
    .then((result) => console.log(`PE-DOMAIN-BOUNDARY PASS files=${result.scannedFiles} actions=32 queries=14 negative_injection=PASS`))
    .catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
