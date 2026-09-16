import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface ProductionTargetContract {
  topology: {
    database: { host: string; supabaseUrl: string };
  };
}

function contract(): ProductionTargetContract {
  const path = fileURLToPath(new URL("../../../infra/deployment/production.contract.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as ProductionTargetContract;
}

function parsedDatabaseUrl(databaseUrl: string, label: string): URL {
  try {
    return new URL(databaseUrl);
  } catch {
    throw new Error(`${label} is not a valid database URL`);
  }
}

export function isLoopbackDatabaseTarget(databaseUrl: string): boolean {
  const host = parsedDatabaseUrl(databaseUrl, "database target").hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function isCanonicalProductionDatabaseTarget(databaseUrl: string): boolean {
  const target = contract().topology.database;
  const parsed = parsedDatabaseUrl(databaseUrl, "database target");
  const projectRef = new URL(target.supabaseUrl).hostname.split(".")[0]?.toLowerCase();
  const identity = `${decodeURIComponent(parsed.username)} ${parsed.hostname} ${databaseUrl}`.toLowerCase();
  return projectRef !== undefined && projectRef.length > 0 && identity.includes(projectRef);
}

export function assertNotProductionDatabaseTarget(databaseUrl: string | undefined, label = "database mutation"): asserts databaseUrl is string {
  if (!databaseUrl) throw new Error(`${label} requires a database URL`);
  if (isCanonicalProductionDatabaseTarget(databaseUrl)) {
    throw new Error(`${label} is not an authorized production mutation path; use the certified production release workflow`);
  }
}

export function assertDisposableDatabaseTarget(databaseUrl: string | undefined, label = "fixture mutation"): asserts databaseUrl is string {
  if (!databaseUrl) throw new Error(`${label} requires a database URL`);
  if (!isLoopbackDatabaseTarget(databaseUrl)) throw new Error(`${label} is restricted to a loopback disposable database`);
}

export function assertNotProductionSupabaseTarget(supabaseUrl: string | undefined, label = "Supabase admin mutation"): asserts supabaseUrl is string {
  if (!supabaseUrl) throw new Error(`${label} requires SUPABASE_URL`);
  const expected = new URL(contract().topology.database.supabaseUrl);
  const observed = new URL(supabaseUrl);
  if (observed.origin.toLowerCase() === expected.origin.toLowerCase()) {
    throw new Error(`${label} is not an authorized production mutation path; use a governed release operation`);
  }
}
