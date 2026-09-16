// A4.T4 restore drill (production-path mechanism): downloads the LATEST real backup
// from the GitHub backups repo, restores it into a throwaway database, runs a smoke
// check, prints a pass/fail verdict, cleans up. This is the drill that actually proves
// the real backup_db job's output is restorable — scripts/backup-restore-drill.ts
// remains the separate pg_dump-based drill for a machine with Postgres client tools
// (it dumps live rather than downloading, so it can't prove the GitHub artifact itself
// round-trips).
//
// Usage: npx tsx scripts/restore-drill-from-backup.ts
// Requires: BACKUP_GITHUB_TOKEN, BACKUP_GITHUB_REPO, DATABASE_URL (target Postgres
// server to create the throwaway drill database on — same server as a real target,
// e.g. staging, or a local dev Postgres).

import { gunzipSync } from "node:zlib";
import pg from "pg";
import { migrate } from "../packages/db/migrate";
import { restoreAllTables, type DatabaseDump } from "../packages/db/backup";
import { backupStorageConfig, downloadLatestBackup } from "../packages/tools/src/backup-storage-github";
import { assertNotProductionDatabaseTarget } from "../packages/db/production-target-guard";

const SOURCE_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const DRILL_DB = `finnor_restore_drill_${Date.now()}`;

function targetUrl(dbName: string): string {
  const u = new URL(SOURCE_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function smokeCheck(url: string): Promise<{ ok: boolean; detail: string }> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT count(*)::int AS n FROM finnor_os.tenants");
    const tenantCount = rows[0].n as number;
    if (tenantCount === 0) return { ok: false, detail: "restored database has zero tenants — dump was likely empty or restore silently no-op'd" };
    // A real query through a join, not just a row count — proves referential structure
    // survived the restore (RLS's own set_config gate, exercised via withTenant
    // elsewhere, isn't reachable from this bare script — a plain cross-table SELECT is
    // the honest smoke check available here).
    await client.query("SELECT a.id FROM finnor_os.domain_actions a LEFT JOIN finnor_os.tenants t ON a.tenant_id = t.id LIMIT 1");
    return { ok: true, detail: `${tenantCount} tenant(s) restored, cross-table query succeeded` };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  assertNotProductionDatabaseTarget(SOURCE_URL, "backup restore drill database server");
  const cfg = backupStorageConfig();
  if (!cfg) {
    console.error("[restore-drill] BACKUP_GITHUB_TOKEN/BACKUP_GITHUB_REPO not set — nothing to download. Not a drill failure, just unconfigured.");
    process.exit(1);
  }

  console.log(`[restore-drill] downloading latest backup from ${cfg.repo}`);
  const gzipped = await downloadLatestBackup(cfg);
  if (!gzipped) {
    console.error("[restore-drill] no backup releases found in the repo yet — run the backup_db job at least once first.");
    process.exit(1);
  }
  const dump = JSON.parse(gunzipSync(gzipped).toString("utf-8")) as DatabaseDump;
  console.log(`[restore-drill] downloaded backup generated at ${dump.generatedAt}, ${Object.keys(dump.tables).length} tables`);

  const admin = new pg.Client({ connectionString: SOURCE_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DRILL_DB}`);
  await admin.end();

  try {
    console.log(`[restore-drill] migrating throwaway database ${DRILL_DB}`);
    await migrate(targetUrl(DRILL_DB));

    console.log(`[restore-drill] restoring ${Object.keys(dump.tables).length} tables into ${DRILL_DB}`);
    const { restoredTables, restoredRows } = await restoreAllTables(targetUrl(DRILL_DB), dump);
    console.log(`[restore-drill] restored ${restoredTables} tables, ${restoredRows} rows`);

    const verdict = await smokeCheck(targetUrl(DRILL_DB));
    console.log(`[restore-drill] smoke check: ${verdict.ok ? "PASS" : "FAIL"} — ${verdict.detail}`);
    if (!verdict.ok) process.exitCode = 1;
  } finally {
    console.log(`[restore-drill] dropping throwaway database ${DRILL_DB}`);
    const cleanup = new pg.Client({ connectionString: SOURCE_URL });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${DRILL_DB} WITH (FORCE)`).catch((err) => {
      console.error(`[restore-drill] cleanup warning (drop ${DRILL_DB} manually if this failed):`, err);
    });
    await cleanup.end();
  }
}

main().catch((err) => {
  console.error("[restore-drill] FAILED:", err);
  process.exit(1);
});
