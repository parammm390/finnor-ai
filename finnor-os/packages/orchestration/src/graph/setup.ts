// One-time setup: creates the finnor_langgraph schema + checkpoint tables. Run once
// in CI right after db:migrate — never on a cold start (a serverless cold start racing
// concurrent DDL would be a bad pattern). PostgresSaver.setup() issues its own
// `CREATE SCHEMA IF NOT EXISTS` before creating tables, so no separate SQL migration
// file is needed for this.

import { closePool } from "@finnor/db";
import { getCheckpointer } from "./checkpointer";
import { fileURLToPath } from "node:url";
import { assertNotProductionDatabaseTarget } from "../../../db/production-target-guard";

export async function setupLangGraphCheckpointer(): Promise<void> {
  assertNotProductionDatabaseTarget(process.env.DATABASE_URL, "LangGraph schema setup");
  await getCheckpointer().setup();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  setupLangGraphCheckpointer()
    .then(async () => {
      console.log("LangGraph checkpointer schema ready (finnor_langgraph)");
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(err);
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
