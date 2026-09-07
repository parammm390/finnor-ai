/** Apply checked-in migrations to the production owner connection before code
 * deployment. The release workflow pulls this secret from the protected Vercel
 * project; this script never prints the URL and refuses local database targets. */

import { config } from "dotenv";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pgConnectionConfig } from "@finnor/db";
import { migrate } from "@finnor/db/migrate";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

async function main(): Promise<void> {
  const envPath = process.argv[2];
  if (!envPath) throw new Error("Usage: npm run release:migrate:production -- <production-env-file>");
  if (process.env.FINNOR_ENVIRONMENT !== "production") {
    throw new Error("Refusing production migration without FINNOR_ENVIRONMENT=production");
  }

  const evidencePath = process.env.FINNOR_PREFLIGHT_EVIDENCE;
  const commitSha = process.env.FINNOR_COMMIT_SHA;
  if (!evidencePath || !commitSha) {
    throw new Error("Production migration requires FINNOR_PREFLIGHT_EVIDENCE and FINNOR_COMMIT_SHA");
  }
  const [evidenceRaw, contractRaw] = await Promise.all([
    readFile(evidencePath, "utf8"),
    readFile(fileURLToPath(new URL("../../../infra/deployment/production.contract.json", import.meta.url))),
  ]);
  const evidence = JSON.parse(evidenceRaw) as {
    ok?: boolean;
    checkedAt?: string;
    commitSha?: string;
    remoteMain?: string;
    contractSha256?: string;
    aws?: {
      accountId?: string;
      region?: string;
      clusterName?: string;
      serviceName?: string;
      taskFamily?: string;
      ecrRepository?: string;
    };
    database?: { host?: string };
  };
  const contract = JSON.parse(contractRaw.toString("utf8")) as {
    topology: {
      worker: {
        accountId: string;
        region: string;
        clusterName: string;
        serviceName: string;
        taskFamily: string;
        ecrRepository: string;
      };
      database: { host: string };
    };
  };
  const evidenceAge = Date.now() - Date.parse(evidence.checkedAt ?? "");
  const contractHash = createHash("sha256").update(contractRaw).digest("hex");
  if (
    evidence.ok !== true ||
    evidence.commitSha !== commitSha ||
    evidence.remoteMain !== commitSha ||
    evidence.contractSha256 !== contractHash ||
    evidence.aws?.accountId !== contract.topology.worker.accountId ||
    evidence.aws?.region !== contract.topology.worker.region ||
    evidence.aws?.clusterName !== contract.topology.worker.clusterName ||
    evidence.aws?.serviceName !== contract.topology.worker.serviceName ||
    evidence.aws?.taskFamily !== contract.topology.worker.taskFamily ||
    evidence.aws?.ecrRepository !== contract.topology.worker.ecrRepository ||
    evidence.database?.host !== contract.topology.database.host ||
    !Number.isFinite(evidenceAge) || evidenceAge < 0 || evidenceAge > 60 * 60 * 1000
  ) {
    throw new Error("Production migration refused: preflight evidence is stale or does not match this release/topology");
  }

  const loaded = config({ path: envPath });
  if (loaded.error) throw new Error(`Unable to load protected production environment: ${loaded.error.message}`);
  const databaseUrl = process.env.MIGRATIONS_DATABASE_URL;
  if (!databaseUrl) throw new Error("MIGRATIONS_DATABASE_URL is missing from the protected production environment");

  const parsed = new URL(databaseUrl);
  if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error("Refusing to run the production migrator against a local database");
  }
  if (parsed.hostname !== contract.topology.database.host) {
    throw new Error(`Refusing migration for unknown database host ${parsed.hostname}`);
  }

  const applied = await migrate(databaseUrl);
  const pool = new pg.Pool(pgConnectionConfig(databaseUrl));
  try {
    await new PostgresSaver(pool, undefined, { schema: "finnor_langgraph" }).setup();
  } finally {
    await pool.end();
  }

  console.log(JSON.stringify({ ok: true, applied, langGraphSchemaReady: true }));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
