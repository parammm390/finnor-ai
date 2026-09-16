import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertDisposableDatabaseTarget,
  assertNotProductionDatabaseTarget,
  assertNotProductionSupabaseTarget,
  isCanonicalProductionDatabaseTarget,
} from "../../packages/db/production-target-guard";

const contract = JSON.parse(readFileSync(fileURLToPath(new URL("../../../infra/deployment/production.contract.json", import.meta.url)), "utf8")) as {
  topology: { database: { host: string; supabaseUrl: string } };
};
const projectRef = new URL(contract.topology.database.supabaseUrl).hostname.split(".")[0];
const canonicalPooler = `postgres://postgres.${projectRef}:secret@${contract.topology.database.host}:5432/postgres`;

describe("production target guards", () => {
  it("recognizes the contract project through pooled and direct Supabase identities", () => {
    expect(isCanonicalProductionDatabaseTarget(canonicalPooler)).toBe(true);
    expect(isCanonicalProductionDatabaseTarget(`postgres://postgres:secret@db.${projectRef}.supabase.co:5432/postgres`)).toBe(true);
    expect(() => assertNotProductionDatabaseTarget(canonicalPooler, "fixture")).toThrow(/certified production release workflow/);
  });

  it("does not fossilize the current Supabase region and permits unrelated disposable targets", () => {
    expect(isCanonicalProductionDatabaseTarget("postgres://finnor:finnor@127.0.0.1:5432/finnor")).toBe(false);
    expect(isCanonicalProductionDatabaseTarget("postgres://postgres.otherproject:secret@aws-9.example.invalid:5432/postgres")).toBe(false);
    expect(() => assertDisposableDatabaseTarget("postgres://finnor:finnor@localhost:5432/finnor")).not.toThrow();
    expect(() => assertDisposableDatabaseTarget("postgres://example.invalid:5432/finnor")).toThrow(/loopback/);
  });

  it("rejects the canonical Supabase admin target", () => {
    expect(() => assertNotProductionSupabaseTarget(contract.topology.database.supabaseUrl, "identity fixture")).toThrow(/governed release/);
    expect(() => assertNotProductionSupabaseTarget("https://different-project.supabase.co", "identity fixture")).not.toThrow();
  });
});
