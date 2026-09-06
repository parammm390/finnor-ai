// Phase 3 shared safety gates. These checks are deliberately independent of the
// deployment provider: a runner must have an explicitly identified, non-production
// target before it can make a network request. Missing configuration is a truthful
// BLOCKED-CONFIG result, never an implicit localhost or production fallback.

export type StagingGuardMode = "identity" | "e2e" | "load" | "live-smoke";

export interface StagingGuardReport {
  mode: StagingGuardMode;
  status: "PASS" | "BLOCKED-CONFIG";
  productionEgress: false;
  targetHosts: Record<string, string>;
  missing: string[];
  failures: string[];
  observations: string[];
}

const TARGETS = [
  ["STAGING_API_URL", "api"],
  ["STAGING_FRONTEND_URL", "frontend"],
  ["STAGING_WORKER_URL", "worker"],
  ["STAGING_ORCHESTRATOR_URL", "orchestrator"],
  ["STAGING_DATABASE_URL", "database"],
  ["STAGING_REDIS_URL", "redis"],
] as const;

const AUTH_TARGETS = ["STAGING_JWT_ALPHA", "STAGING_JWT_BRAVO", "STAGING_JWT_CHARLIE"] as const;

const EXTERNAL_BINDINGS = [
  ["COMMUNICATIONS_BINDING", ["emulator"]],
] as const;

function present(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function hostFor(name: string, value: string): string {
  try {
    return new URL(value).hostname || "invalid-host";
  } catch {
    return "invalid-url";
  }
}

function isProductionHost(host: string): boolean {
  const normalized = host.toLowerCase().replaceAll(".", "");
  return host === "finnorai.com"
    || host.endsWith(".finnorai.com")
    || host.includes("production")
    || normalized.includes("production");
}

function checkTarget(name: string, label: string, missing: string[], failures: string[], targetHosts: Record<string, string>): void {
  const value = process.env[name];
  if (!value?.trim()) {
    missing.push(name);
    return;
  }
  const host = hostFor(name, value);
  targetHosts[label] = host;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "postgres:", "postgresql:", "redis:", "rediss:"].includes(parsed.protocol)) failures.push(`${name} uses an unsupported protocol`);
    if (isProductionHost(parsed.hostname)) failures.push(`${name} resolves to a known production host`);
  } catch {
    failures.push(`${name} is not a valid URL`);
  }
}

function requireOne(name: string, missing: string[], failures: string[], expected?: string): void {
  if (!present(name)) {
    missing.push(name);
    return;
  }
  if (expected && process.env[name] !== expected) failures.push(`${name} must equal ${expected}`);
}

/**
 * Evaluate the Phase 3 target contract without printing secrets, URLs, JWTs, or
 * allowlist values. The caller decides whether a BLOCKED-CONFIG result is fatal.
 */
export function evaluateStagingGuards(mode: StagingGuardMode): StagingGuardReport {
  const missing: string[] = [];
  const failures: string[] = [];
  const targetHosts: Record<string, string> = {};
  const observations: string[] = ["productionEgress=false", "secretValuesPrinted=false", "providerPayloadsPrinted=false"];

  for (const [name, label] of TARGETS) checkTarget(name, label, missing, failures, targetHosts);

  requireOne("P3_STAGING_IDENTITY_CONFIRMED", missing, failures, "1");
  requireOne("STAGING_AUTH_MODE", missing, failures, "jwt");
  requireOne("CERTIFICATION_TEST_EMAILS", missing, failures);
  requireOne("CERTIFICATION_TEST_PHONES", missing, failures);

  if (mode === "identity") {
    requireOne("LIVE_SMOKE_ALLOWED", missing, failures, "0");
  } else {
    requireOne("STAGING_EXPECTED_SHA", missing, failures);
    requireOne("LIVE_SMOKE_ALLOWED", missing, failures, mode === "live-smoke" ? "1" : "0");
  }

  if (mode === "identity" || mode === "e2e" || mode === "load") requireOne("P3_NO_EGRESS", missing, failures, "1");
  if (mode === "live-smoke") {
    requireOne("P3_LIVE_ALLOWLIST_CONFIRMED", missing, failures, "1");
    requireOne("P3_LIVE_WRITE_FLAGS_CONFIRMED", missing, failures, "1");
    requireOne("P3_LIVE_BINDINGS", missing, failures);
    requireOne("P3_LIVE_SMOKE_CASES_FILE", missing, failures);
  }

  if (mode === "identity" || mode === "e2e" || mode === "live-smoke") {
    for (const name of AUTH_TARGETS) requireOne(name, missing, failures);
  }
  if (mode === "load") {
    requireOne("P3_LOAD_JWTS_FILE", missing, failures);
    requireOne("P3_LOAD_RECONCILIATION_FILE", missing, failures);
    requireOne("P3_LOAD_INSTRUCTION", missing, failures);
  }

  if (mode !== "live-smoke") {
    for (const [name, allowed] of EXTERNAL_BINDINGS) {
      const value = process.env[name];
      if (value && !allowed.includes(value as never)) failures.push(`${name} must remain an emulator-safe binding`);
    }
  }

  const distinctHosts = new Set(Object.values(targetHosts));
  if (Object.keys(targetHosts).length === TARGETS.length && distinctHosts.size < 2) failures.push("service targets are not sufficiently distinguishable");
  observations.push(`targets=${Object.keys(targetHosts).length}/${TARGETS.length}`);
  observations.push(`targetHosts=${Object.entries(targetHosts).map(([label, host]) => `${label}:${host}`).join(",") || "none"}`);
  observations.push(`externalBindings=${mode === "live-smoke" ? "allowlisted-live-mode" : "emulator-safe-required"}`);

  return {
    mode,
    status: missing.length || failures.length ? "BLOCKED-CONFIG" : "PASS",
    productionEgress: false,
    targetHosts,
    missing,
    failures,
    observations,
  };
}

export function formatStagingGuardReport(report: StagingGuardReport): string {
  return [
    `STAGING_GUARD mode=${report.mode} status=${report.status}`,
    ...report.observations,
    `missing=${report.missing.join(",") || "none"}`,
    `failures=${report.failures.join(" | ") || "none"}`,
  ].join("\n");
}
