import { defineConfig } from "drizzle-kit";
import { assertNotProductionDatabaseTarget } from "./production-target-guard";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
assertNotProductionDatabaseTarget(databaseUrl, "Drizzle Kit CLI");

export default defineConfig({
  schema: "./packages/db/schema.ts",
  out: "./packages/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    // eslint-disable-next-line no-restricted-syntax
    url: databaseUrl,
  },
});
