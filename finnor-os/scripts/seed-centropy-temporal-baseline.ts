import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { inputSnapshotHash, runResultHash } from "@finnor/underwriting";
import { assertDisposableDatabaseTarget } from "../packages/db/production-target-guard";

const expectedDirectory = resolve("../.centropy-certification/atlas-temporal-clone/postgres");
assertDisposableDatabaseTarget(process.env.DATABASE_URL, "CENTROPY authored historical clone");
if (process.env.CENTROPY_TEMPORAL_CLONE !== "1") throw new Error("Explicit temporal clone context is required");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const shift = 48 * 60 * 60 * 1000;
const timestampKeys = new Set(["created_at", "updated_at", "recorded_at", "observed_at", "computed_at", "world_at", "as_of", "evidence_cutoff_at", "createdAt", "updatedAt", "recordedAt", "observedAt", "computedAt", "worldAt", "asOf", "effectiveAt", "evidenceCutoffAt"]);
function earlier(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => earlier(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, earlier(item, name)]));
  if (timestampKeys.has(key) && typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value) - shift).toISOString();
  return value;
}
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
async function main(): Promise<void> {
const source = JSON.parse(await readFile(resolve(expectedDirectory, "../clone-source.json"), "utf8"));
if (source.sourceFixture !== "atlas-release-v1" || source.copiedAfterCleanShutdown !== true) throw new Error("A clean fixture clone marker is required");
try {
  await client.connect();
  const actual = (await client.query<{ directory: string }>("SELECT current_setting('data_directory') directory")).rows[0]?.directory;
  if (resolve(String(actual)) !== expectedDirectory) throw new Error("The connected database is not the named temporal clone");
  const marker = resolve(expectedDirectory, "../temporal-baseline.json");
  const existing = await readFile(marker, "utf8").then(JSON.parse).catch(() => null);
  if (existing) { console.log(JSON.stringify({ status: "already_authored", ...existing })); }
  else {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role=replica");
    const columns = (await client.query<{ table_name: string; column_name: string }>(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='finnor_os' AND data_type IN ('timestamp with time zone','timestamp without time zone')
      AND table_name IN (SELECT table_name FROM information_schema.tables WHERE table_schema='finnor_os' AND table_type='BASE TABLE')
      AND column_name IN ('created_at','updated_at','recorded_at','observed_at','computed_at','world_at','as_of','evidence_cutoff_at','coverage_started_at')`)).rows;
    const tables = new Map<string, string[]>();
    for (const column of columns) tables.set(column.table_name, [...(tables.get(column.table_name) ?? []), column.column_name]);
    for (const [table, names] of tables) await client.query(`UPDATE finnor_os.${quote(table)} SET ${names.map((name) => `${quote(name)}=${quote(name)}-interval '48 hours'`).join(',')}`);
    const runs = (await client.query("SELECT id,input_snapshot,result FROM finnor_os.underwriting_runs")).rows;
    for (const row of runs) {
      const snapshot = earlier(row.input_snapshot) as Parameters<typeof inputSnapshotHash>[0];
      const inputHash = inputSnapshotHash(snapshot);
      const result = earlier(row.result) as Parameters<typeof runResultHash>[0];
      const sealed = { ...snapshot, semanticHash: inputHash };
      const resultBody = { ...result, inputSemanticHash: inputHash };
      const resultHash = runResultHash(resultBody);
      await client.query("UPDATE finnor_os.underwriting_runs SET input_snapshot=$2,input_hash=$3,result=$4,result_hash=$5 WHERE id=$1", [row.id, sealed, inputHash, { ...resultBody, resultSemanticHash: resultHash }, resultHash]);
    }
    const versions = (await client.query("SELECT id,snapshot FROM finnor_os.canonical_entity_versions")).rows;
    for (const row of versions) await client.query("UPDATE finnor_os.canonical_entity_versions SET snapshot=$2,snapshot_hash=encode(public.digest(convert_to(($2::jsonb)::text,'UTF8'),'sha256'),'hex') WHERE id=$1", [row.id, JSON.stringify(earlier(row.snapshot))]);
    await client.query("SET LOCAL session_replication_role=origin");
    await client.query("COMMIT");
    const proof = { schema: "centropy.authored-temporal-fixture/v1", sourceFixture: source.sourceFixture, fixture: "atlas-temporal-clone", authoredAt: new Date().toISOString(), baselineShiftHours: 48, tables: tables.size, runsResealed: runs.length, historySnapshotsResealed: versions.length, financialInputsAndOutputsUnchanged: true, originalDatabaseUnchanged: true };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(marker, JSON.stringify(proof, null, 2) + "\n");
    console.log(JSON.stringify({ status: "authored", ...proof }));
  }
} catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
finally { await client.end(); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
