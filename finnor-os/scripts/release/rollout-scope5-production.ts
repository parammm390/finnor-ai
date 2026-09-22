/** Governed Phase-5 cutover. The canonical release first deploys the exact API
 * and protocol-2 worker, then uses this bounded tenant-by-tenant shadow gate. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import pg from "pg";
import { CURRENT_MIGRATION_HEAD, pgConnectionConfig, withTenantTransaction } from "@finnor/db";
import {
  activateDurableEpistemicImpact,
  compareDurableShadowWithOracle,
  recoverAcceptedEpistemicChanges,
  scanDueEpistemicFreshness,
  setEpistemicKillSwitch,
} from "@finnor/epistemic-runtime";
import { prepareTenantPrivateEquityEpistemicGraph } from "@finnor/private-equity";
import { isCanonicalProductionDatabaseTarget } from "../../packages/db/production-target-guard";
import { authorizeProductionMutation } from "../../../scripts/release/production-mutation-guard.mjs";

const MAX_TENANTS = 100;
const DRAIN_DEADLINE_MS = 180_000;
const RELEASE_SHA = process.env.FINNOR_COMMIT_SHA ?? "";

async function drainAcceptedChanges(tenantId: string, rolloutDeadline: number): Promise<void> {
  const deadline = Math.min(Date.now() + DRAIN_DEADLINE_MS,rolloutDeadline);
  while (Date.now() < deadline) {
    await recoverAcceptedEpistemicChanges(tenantId);
    await scanDueEpistemicFreshness(tenantId);
    const state = await withTenantTransaction(tenantId,{ readOnly:true },async (_db,client) => {
      const result = await client.query<{ pending:number; processing:boolean; due:boolean }>(`
        SELECT
          (SELECT count(*)::int FROM finnor_os.epistemic_changes
            WHERE tenant_id=$1 AND status<>'processed') AS pending,
          (SELECT processing_change_id IS NOT NULL FROM finnor_os.epistemic_runtime_controls
            WHERE tenant_id=$1) AS processing,
          EXISTS(SELECT 1 FROM finnor_os.epistemic_current c
            JOIN finnor_os.epistemic_runtime_controls control ON control.tenant_id=c.tenant_id
            WHERE c.tenant_id=$1 AND c.graph_version_id=control.graph_version_id
              AND c.next_freshness_at<=clock_timestamp()) AS due`,[tenantId]);
      return result.rows[0];
    });
    if (state?.pending === 0 && !state.processing && !state.due) return;
    await new Promise((resolve) => setTimeout(resolve,5_000));
  }
  throw new Error("Accepted epistemic changes or due freshness did not drain within the bounded release window");
}

async function main(): Promise<void> {
  const envPath = process.argv[2];
  if (!envPath || process.argv.length !== 3) throw new Error("Usage: rollout-scope5-production.ts <protected-env-file>");
  if (process.env.FINNOR_ENVIRONMENT !== "production" || !/^[0-9a-f]{40}$/.test(RELEASE_SHA)) {
    throw new Error("Scope-5 cutover requires exact production release provenance");
  }
  await authorizeProductionMutation("epistemic-impact-activate");

  const contractRaw = await readFile(fileURLToPath(new URL("../../../infra/deployment/production.contract.json",import.meta.url)));
  const contract = JSON.parse(contractRaw.toString("utf8")) as { topology:{ database:{ host:string } }; release:{ requiredMigrationHead:string } };
  const preflightPath = process.env.FINNOR_PREFLIGHT_EVIDENCE;
  if (!preflightPath) throw new Error("Scope-5 cutover requires release preflight evidence");
  const preflight = JSON.parse(await readFile(preflightPath,"utf8")) as {
    ok?:boolean; commitSha?:string; remoteMain?:string; contractSha256?:string;
  };
  if (preflight.ok !== true || preflight.commitSha !== RELEASE_SHA || preflight.remoteMain !== RELEASE_SHA
    || preflight.contractSha256 !== createHash("sha256").update(contractRaw).digest("hex")) {
    throw new Error("Scope-5 cutover preflight does not match the exact release contract and SHA");
  }
  const protectedEnv = parse(await readFile(envPath));
  const ownerUrl = protectedEnv.MIGRATIONS_DATABASE_URL;
  const appUrl = protectedEnv.DATABASE_URL;
  if (!ownerUrl || !appUrl || new URL(ownerUrl).hostname !== contract.topology.database.host
    || !isCanonicalProductionDatabaseTarget(appUrl)
    || ["localhost","127.0.0.1","::1"].includes(new URL(appUrl).hostname)) {
    throw new Error("Scope-5 cutover database targets differ from the protected production contract");
  }
  if (CURRENT_MIGRATION_HEAD !== contract.release.requiredMigrationHead) {
    throw new Error("Scope-5 cutover code and production migration head differ");
  }
  process.env.DATABASE_URL = appUrl;

  const owner = new pg.Client({ ...pgConnectionConfig(ownerUrl),connectionTimeoutMillis:15_000 });
  await owner.connect();
  let tenantIds: string[];
  try {
    await owner.query("BEGIN READ ONLY");
    const migration = await owner.query<{ name:string }>("SELECT name FROM finnor_os._migrations ORDER BY name DESC LIMIT 1");
    const compute = await owner.query<{ state:string }>("SELECT state FROM finnor_os.compute_plane_cutover WHERE singleton=true");
    const product = await owner.query<{ state:string }>("SELECT state FROM finnor_os.product_runtime_authority WHERE authority_key='product'");
    const worker = await owner.query(`SELECT 1 FROM finnor_os.service_release_heartbeats
      WHERE service='compute-background' AND release_sha=$1 AND migration_head=$2
        AND capabilities @> ARRAY['epistemic-v2']::text[]
        AND last_beat_at>=clock_timestamp()-interval '2 minutes' LIMIT 1`,[RELEASE_SHA,CURRENT_MIGRATION_HEAD]);
    if (migration.rows[0]?.name !== CURRENT_MIGRATION_HEAD || compute.rows[0]?.state !== "authoritative"
      || product.rows[0]?.state !== "water_retired" || !worker.rowCount) {
      throw new Error("Scope-5 cutover requires exact migration, finalized product/compute authority, and fresh protocol-2 worker");
    }
    const tenants = await owner.query<{ tenant_id:string }>(`
      SELECT a.tenant_id::text FROM finnor_os.tenant_vertical_assignments a
      WHERE a.vertical_key='private_equity' AND (
        EXISTS(SELECT 1 FROM finnor_os.pe_deals d WHERE d.tenant_id=a.tenant_id AND d.status='active')
        OR EXISTS(SELECT 1 FROM finnor_os.canonical_entity_versions v WHERE v.tenant_id=a.tenant_id)
      ) ORDER BY a.tenant_id LIMIT $1`,[MAX_TENANTS+1]);
    if (tenants.rows.length > MAX_TENANTS) throw new Error("Scope-5 tenant rollout exceeds the bounded release limit");
    tenantIds = tenants.rows.map((row) => row.tenant_id);
    await owner.query("COMMIT");
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await owner.end();
  }

  const staged: Array<{ tenantId:string; graphVersionId:string; mode:string }> = [];
  const rolloutDeadline = Date.now() + 20 * 60_000;
  let noGraph = 0;
  let disabled = 0;
  for (const tenantId of tenantIds) {
    if (Date.now() >= rolloutDeadline) throw new Error("Scope-5 shadow rollout exceeded its bounded release window");
    const prepared = await prepareTenantPrivateEquityEpistemicGraph({
      ctx:{ auth:{ tenantId,userId:"system:scope5-production-release",role:"owner" },
        provenance:{ sourceSystem:"scope5:production-release",createdBy:"system:scope5-production-release" } },
      baselineBatchSize:64,baselineBatches:160,
    });
    if (prepared.status === "NO_ACTIVE_DEALS") { noGraph += 1; continue; }
    if (prepared.status !== "BASELINE_COMPLETE" || !prepared.graphVersionId) {
      throw new Error("Scope-5 baseline did not finish within its bounded release budget");
    }
    await drainAcceptedChanges(tenantId,rolloutDeadline);
    const control = await withTenantTransaction(tenantId,{ readOnly:true },async (_db,client) =>
      (await client.query<{ mode:string; kill_switch:boolean }>(
        "SELECT mode,kill_switch FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1",[tenantId])).rows[0]);
    const comparison = await compareDurableShadowWithOracle(tenantId,{ recordShadowCheckpoint:control?.mode !== "active" });
    if (!comparison.equivalent || comparison.graphVersionId !== prepared.graphVersionId) {
      throw new Error("Scope-5 shadow result differs from the independent full recompute oracle");
    }
    if (control?.kill_switch) { disabled += 1; continue; }
    if (!control || !["active","shadow","refreshing"].includes(control.mode)) {
      throw new Error("Scope-5 runtime is not in a deployable operational state");
    }
    staged.push({ tenantId,graphVersionId:prepared.graphVersionId,mode:control.mode });
  }

  const newlyActivated: string[] = [];
  try {
    for (const item of staged) {
      if (item.mode === "active") continue;
      await activateDurableEpistemicImpact({
        tenantId:item.tenantId,graphVersionId:item.graphVersionId,releaseSha:RELEASE_SHA,
      });
      newlyActivated.push(item.tenantId);
    }
    for (const item of staged) {
      const control = await withTenantTransaction(item.tenantId,{ readOnly:true },async (_db,client) =>
        (await client.query<{ mode:string; kill_switch:boolean; graph_version_id:string }>(
          "SELECT mode,kill_switch,graph_version_id FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1",
          [item.tenantId])).rows[0]);
      if (control?.mode !== "active" || control.kill_switch || control.graph_version_id !== item.graphVersionId) {
        throw new Error("Scope-5 post-cutover tenant state is not the verified active graph");
      }
    }
  } catch (error) {
    const rollback = await Promise.allSettled(newlyActivated.map((tenantId) => setEpistemicKillSwitch(tenantId,true)));
    const failedRollback = rollback.filter((result) => result.status === "rejected").length;
    throw new Error(`Scope-5 activation failed; ${newlyActivated.length-failedRollback} new activations disabled; ${failedRollback} disable attempts failed`,{ cause:error });
  }
  const status = !staged.length ? "NO_OPERATIONAL_TENANTS"
    : newlyActivated.length ? "PASS_LIVE_CUTOVER" : "PASS_LIVE_VERIFIED";
  console.log(JSON.stringify({ status,releaseSha:RELEASE_SHA,
    eligibleTenants:tenantIds.length,activeTenants:staged.length,newActivations:newlyActivated.length,
    disabledTenants:disabled,noGraphTenants:noGraph,migrationHead:CURRENT_MIGRATION_HEAD }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
