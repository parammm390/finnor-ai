// backup_db job (A4.T4): global, not tenant-scoped — same convention as worker_heartbeat
// (a DB backup isn't per-tenant data). Dumps every finnor_os table (packages/db/backup.ts,
// pure-JS, no pg_dump dependency), gzips, uploads to the dedicated GitHub backups repo,
// then prunes to the 14-daily+8-weekly retention policy. No-ops loudly (logged, never
// silent, never throws — matching healthchecks.io/Sentry's own "safe until configured"
// posture) until Param supplies BACKUP_GITHUB_TOKEN/BACKUP_GITHUB_REPO.

import { gzipSync } from "node:zlib";
// @finnor/db's package.json only points "main"/"types" at index.ts (no subpath
// exports) — migrate.ts/seed.ts are imported the same relative way everywhere else in
// this repo, not re-exported through the index; backup.ts follows that convention.
import { dumpAllTables } from "../../../../packages/db/backup";
import { backupStorageConfig, uploadBackup, listBackupReleases, deleteBackupRelease, applyRetention, getLogger } from "@finnor/tools";
import type { JobHandler } from "../queue";

export const backupDb: JobHandler = async () => {
  const cfg = backupStorageConfig();
  if (!cfg) {
    // Backup storage is an optional supplementary integration. Treat its absent
    // credentials as a successful no-op so the proactive scheduler does not poison
    // the queue with a job that cannot ever succeed. The verdict stays visible.
    getLogger().warn({ verdict: "BLOCKED-CONFIG" }, "[backup_db] managed backup storage is not configured; skipping");
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("backup_db requires DATABASE_URL");

  const dump = await dumpAllTables(databaseUrl);
  const gzipped = gzipSync(Buffer.from(JSON.stringify(dump)));
  const tag = `backup-${dump.generatedAt.replace(/[:.]/g, "-")}`;
  const { releaseId } = await uploadBackup(cfg, tag, "finnor-backup.json.gz", gzipped);
  getLogger().info(
    { tag, releaseId, tables: Object.keys(dump.tables).length, sizeBytes: gzipped.length },
    "[backup_db] uploaded",
  );

  const releases = await listBackupReleases(cfg);
  const { deleteIds } = applyRetention(releases);
  for (const id of deleteIds) {
    await deleteBackupRelease(cfg, id);
  }
  if (deleteIds.length > 0) getLogger().info({ pruned: deleteIds.length }, "[backup_db] pruned old backups past retention");
};
