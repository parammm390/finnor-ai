// P2.T4 — one bounded, local-only Bedrock smoke for the configured GLM/Mistral/
// DeepSeek chain. This is deliberately separate from the deterministic chaos
// runner: it makes exactly one short completion request per model, records usage
// through the existing llm_calls ledger, and performs no business action, webhook,
// email, SMS, voice call, or production/staging write.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desc, inArray } from "drizzle-orm";
import { closePool, llmCalls, withTenant } from "@finnor/db";
import {
  describeLLMRoute,
  resolveProvider,
  type LLMChannel,
  type LLMPurpose,
} from "@finnor/tools";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FINNOR_OS_ROOT = resolve(SCRIPT_DIR, "../..");
const REPO_ROOT = resolve(FINNOR_OS_ROOT, "..");
const EVIDENCE_DIR = resolve(REPO_ROOT, "docs/release/evidence/P2");
const JSON_REPORT_PATH = resolve(REPO_ROOT, "docs/release/generated/p2-bedrock-live-smoke.json");
const TEXT_EVIDENCE_PATH = resolve(EVIDENCE_DIR, "p2-bedrock-live-smoke.txt");
const DEFAULT_DATABASE_URL = "postgres://finnor:finnor@localhost:5432/finnor";

const DIRECT_VENDOR_KEYS = [
  "GLM_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;

const MODEL_CONFIGS = [
  { provider: "glm", modelEnv: "AWS_BEDROCK_GLM_MODEL_ID", defaultModel: "zai.glm-4.7" },
  { provider: "mistral", modelEnv: "AWS_BEDROCK_MISTRAL_MODEL_ID", defaultModel: "mistral.mistral-small-2402-v1:0" },
  { provider: "deepseek", modelEnv: "AWS_BEDROCK_DEEPSEEK_MODEL_ID", defaultModel: "deepseek.v3.2" },
] as const;
type BedrockProviderName = (typeof MODEL_CONFIGS)[number]["provider"];

const PURPOSES: readonly LLMPurpose[] = ["planning", "critic", "repair", "classification", "answer"];
const CHANNELS: readonly LLMChannel[] = ["voice", "text", "console", "background"];

interface SmokeResult {
  provider: BedrockProviderName;
  configuredModel: string;
  selectedProvider: string | null;
  observedModel: string | null;
  status: "completed" | "failed";
  responseShape: "non-empty" | "none";
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  elapsedMs: number;
  traceId: string;
  error?: string;
}

interface RouteResult {
  purpose: LLMPurpose;
  channel: LLMChannel;
  providerNames: string[];
  expectedProviderNames: string[];
  pass: boolean;
}

function bedrockCredentialPresent(): boolean {
  return process.env.AWS_BEDROCK_AUTH_MODE === "iam" || Boolean(process.env.AWS_BEDROCK_API_KEY ?? process.env.AWS_BEARER_TOKEN_BEDROCK);
}

function assertGuardedContext(databaseUrl: string): void {
  if (process.env.NODE_ENV === "production") throw new Error("Bedrock live smoke refuses NODE_ENV=production");
  if (process.env.FINNOR_BEDROCK_LIVE_SMOKE !== "1") throw new Error("Bedrock live smoke requires FINNOR_BEDROCK_LIVE_SMOKE=1");
  if (process.env.LIVE_SMOKE_ALLOWED !== "1") throw new Error("Bedrock live smoke requires LIVE_SMOKE_ALLOWED=1");
  if (!bedrockCredentialPresent()) throw new Error("Explicit Bedrock IAM authentication or a Bedrock API key is required");
  const target = new URL(databaseUrl);
  if (!(target.hostname === "localhost" || target.hostname === "127.0.0.1" || target.hostname === "::1")) {
    throw new Error(`Bedrock live smoke requires a local Postgres target; received ${target.hostname}`);
  }
}

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/(api[_ -]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 240);
}

function modelFor(config: (typeof MODEL_CONFIGS)[number]): string {
  return process.env[config.modelEnv] ?? config.defaultModel;
}

function expectedRoute(purpose: LLMPurpose, channel: LLMChannel): string[] {
  if (purpose === "critic" || purpose === "repair") return ["deepseek", "mistral", "glm"];
  if (channel === "background" && (purpose === "planning" || purpose === "answer")) return ["deepseek", "mistral", "glm"];
  return ["mistral", "deepseek", "glm"];
}

async function readLedger(traceIds: string[]): Promise<Array<{
  traceId: string | null;
  provider: string;
  model: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}>> {
  return withTenant(SEED_TENANT_ID, (db) => db.select({
    traceId: llmCalls.traceId,
    provider: llmCalls.provider,
    model: llmCalls.model,
    status: llmCalls.status,
    inputTokens: llmCalls.inputTokens,
    outputTokens: llmCalls.outputTokens,
    costUsd: llmCalls.costUsd,
  }).from(llmCalls).where(inArray(llmCalls.traceId, traceIds)).orderBy(desc(llmCalls.createdAt)));
}

function textEvidence(report: Record<string, unknown>): string {
  const results = report.results as SmokeResult[];
  const routes = report.routes as RouteResult[];
  const ledger = report.ledger as { rows: number; expectedRows: number; pass: boolean; costUsd: number | null };
  const lines = [
    "P2_BEDROCK_LIVE_SMOKE",
    `status=${report.pass ? "PASS" : "FAIL"}`,
    "guardedContext=true",
    "productionEgress=false",
    "businessActions=none",
    `credentialSource=${process.env.AWS_BEDROCK_AUTH_MODE === "iam" ? "AWS SDK credential chain" : "Bedrock API key (value withheld)"}`,
    "directVendorKeysUsed=false",
    `models=${results.filter((result) => result.status === "completed").length}/${results.length} completed`,
    ...results.map((result) => `provider=${result.provider} configuredModel=${result.configuredModel} observedModel=${result.observedModel ?? "none"} selectedProvider=${result.selectedProvider ?? "none"} status=${result.status} response=${result.responseShape} inputTokens=${result.inputTokens ?? "null"} outputTokens=${result.outputTokens ?? "null"} costUsd=${result.costUsd ?? "not_configured"} traceId=${result.traceId}${result.error ? ` error=${result.error}` : ""}`),
    `routes=${routes.filter((route) => route.pass).length}/${routes.length} expected`,
    `ledgerRows=${ledger.rows}/${ledger.expectedRows} pass=${ledger.pass} totalCostUsd=${ledger.costUsd ?? "not_configured"}`,
    "No provider credential value or response content was written to this evidence file.",
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  assertGuardedContext(databaseUrl);
  process.env.DATABASE_URL = databaseUrl;

  // The live proof is intentionally Bedrock-only even if a developer happens to
  // have direct vendor keys in their shell. This mutation is process-local.
  for (const key of DIRECT_VENDOR_KEYS) delete process.env[key];
  if (process.env.AWS_BEDROCK_AUTH_MODE === "iam") {
    const contract = JSON.parse(await readFile(resolve(REPO_ROOT, "infra/deployment/production.contract.json"), "utf8"));
    const environment = contract.topology.computePlane.providerRuntime.environment;
    for (const config of MODEL_CONFIGS) process.env[config.modelEnv] ??= environment[config.modelEnv];
  }

  await mkdir(EVIDENCE_DIR, { recursive: true });
  await mkdir(dirname(JSON_REPORT_PATH), { recursive: true });

  const results: SmokeResult[] = [];
  const traceIds: string[] = [];
  const routes: RouteResult[] = [];
  let ledger: Awaited<ReturnType<typeof readLedger>> = [];
  let fatalError: string | undefined;

  try {
    await migrate(databaseUrl);
    await seed(databaseUrl);

    for (const config of MODEL_CONFIGS) {
      const configuredModel = modelFor(config);
      const traceId = `p2:bedrock-live:${config.provider}:${randomUUID()}`;
      traceIds.push(traceId);
      const provider = resolveProvider(config.provider);
      const startedAt = Date.now();
      try {
        const response = await provider.complete({
          system: "You are a release smoke probe. Reply with exactly BEDROCK_P2_OK.",
          user: "Reply with exactly BEDROCK_P2_OK.",
          purpose: "answer",
          channel: "text",
          tenantId: SEED_TENANT_ID,
          traceId,
          urgent: true,
          deadlineMs: 10_000,
          maxOutputTokens: 128,
        });
        const usage = provider.lastUsage;
        if (!response.trim()) throw new Error("provider returned an empty response");
        results.push({
          provider: config.provider,
          configuredModel,
          selectedProvider: provider.selectedProviderName ?? provider.name,
          observedModel: usage?.model ?? null,
          status: "completed",
          responseShape: "non-empty",
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          costUsd: null,
          elapsedMs: Date.now() - startedAt,
          traceId,
        });
      } catch (error) {
        results.push({
          provider: config.provider,
          configuredModel,
          selectedProvider: provider.selectedProviderName ?? provider.name,
          observedModel: provider.lastUsage?.model ?? null,
          status: "failed",
          responseShape: "none",
          inputTokens: provider.lastUsage?.inputTokens ?? null,
          outputTokens: provider.lastUsage?.outputTokens ?? null,
          costUsd: null,
          elapsedMs: Date.now() - startedAt,
          traceId,
          error: redactError(error),
        });
      }
    }

    for (const purpose of PURPOSES) {
      for (const channel of CHANNELS) {
        const providerNames = describeLLMRoute(purpose, channel).providerNames;
        const expectedProviderNames = expectedRoute(purpose, channel);
        routes.push({ purpose, channel, providerNames, expectedProviderNames, pass: JSON.stringify(providerNames) === JSON.stringify(expectedProviderNames) });
      }
    }
    ledger = await readLedger(traceIds);
  } catch (error) {
    fatalError = redactError(error);
  } finally {
    await closePool().catch(() => undefined);
  }

  const expectedModels = new Map<BedrockProviderName, string>(MODEL_CONFIGS.map((config) => [config.provider, modelFor(config)]));
  const completedResults = results.length === MODEL_CONFIGS.length && results.every((result) => result.status === "completed" && result.responseShape === "non-empty");
  const provenancePass = results.length === MODEL_CONFIGS.length && results.every((result) => result.observedModel === expectedModels.get(result.provider) && result.selectedProvider === result.provider);
  const routePass = routes.length === PURPOSES.length * CHANNELS.length && routes.every((route) => route.pass);
  const ledgerPass = ledger.length === MODEL_CONFIGS.length
    && ledger.every((row) => row.status === "completed" && row.traceId !== null && expectedModels.get(row.provider as BedrockProviderName) === row.model);
  const costValues = ledger.map((row) => row.costUsd).filter((value): value is number => value !== null);
  const costUsd = costValues.length === ledger.length && costValues.length > 0 ? costValues.reduce((sum, value) => sum + value, 0) : null;
  const report: Record<string, unknown> = {
    phase: "P2",
    generatedAt: new Date().toISOString(),
    pass: !fatalError && completedResults && provenancePass && routePass && ledgerPass,
    guardedContext: true,
    localDatabaseOnly: true,
    productionEgress: false,
    businessActions: [],
    credentialSource: process.env.AWS_BEDROCK_AUTH_MODE === "iam" ? "AWS SDK credential chain" : "Bedrock API key (value withheld)",
    directVendorKeysUsed: false,
    models: MODEL_CONFIGS.map((config) => ({ provider: config.provider, model: modelFor(config), transport: "bedrock-converse" })),
    results,
    routes,
    ledger: {
      rows: ledger.length,
      expectedRows: MODEL_CONFIGS.length,
      pass: ledgerPass,
      costUsd,
      costConfigured: costUsd !== null,
      rowsDetail: ledger,
    },
    assertions: { completedResults, provenancePass, routePass, ledgerPass },
    ...(fatalError ? { fatalError } : {}),
  };

  await writeFile(JSON_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(TEXT_EVIDENCE_PATH, textEvidence(report), "utf8");
  if (!report.pass) throw new Error(`P2 Bedrock live smoke failed; inspect ${TEXT_EVIDENCE_PATH}`);
  console.log(`P2_BEDROCK_LIVE_SMOKE_PASS models=${results.length} routes=${routes.length} ledgerRows=${ledger.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`P2_BEDROCK_LIVE_SMOKE_FAIL ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
