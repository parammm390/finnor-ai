// A5.T2 Preview cutover: replace the privileged Preview DATABASE_URL with a
// dedicated LOGIN role that inherits only finnor_app's restricted permissions.
// The password is generated in memory, never printed, and sent directly to Vercel.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import pg from "pg";
import { assertNotProductionDatabaseTarget } from "../packages/db/production-target-guard";
import { pgConnectionConfig } from "../packages/db/postgres-connection.mjs";

function arg(name: string): string {
  const value = process.argv.slice(2).find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

function databaseUrl(envFile: string): Promise<string> {
  return readFile(envFile, "utf8").then((contents) => {
    const line = contents.split(/\r?\n/).find((entry) => entry.startsWith("DATABASE_URL="));
    if (!line) throw new Error("Preview DATABASE_URL is missing");
    return line.slice(line.indexOf("=") + 1).replace(/^"|"$/g, "").replace(/\\n$/, "").trim();
  });
}

async function main(): Promise<void> {
  const envFile = arg("preview-env");
  const cwd = arg("vercel-cwd");
  const adminUrl = await databaseUrl(envFile);
  assertNotProductionDatabaseTarget(adminUrl, "preview role configuration");
  const password = randomBytes(32).toString("base64url");
  const admin = new pg.Client(pgConnectionConfig(adminUrl));
  await admin.connect();
  try {
    await admin.query("SELECT set_config($1, $2, false)", ["app.a5_preview_role_password", password]);
    await admin.query(`DO $role$
      DECLARE p text := current_setting('app.a5_preview_role_password');
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'finnor_preview_app') THEN
          CREATE ROLE finnor_preview_app LOGIN NOSUPERUSER NOBYPASSRLS INHERIT;
        END IF;
        EXECUTE format('ALTER ROLE finnor_preview_app LOGIN NOSUPERUSER NOBYPASSRLS INHERIT PASSWORD %L', p);
        ALTER ROLE finnor_preview_app SET search_path = finnor_os, public;
        ALTER ROLE finnor_preview_app SET statement_timeout = '10s';
      END $role$;`);
    await admin.query("GRANT finnor_app TO finnor_preview_app");
    await admin.query("SELECT set_config($1, $2, false)", ["app.a5_preview_role_password", ""]);
  } finally {
    await admin.end();
  }

  const appUrl = new URL(adminUrl);
  appUrl.username = "finnor_preview_app";
  appUrl.password = password;
  const verify = new pg.Client(pgConnectionConfig(appUrl.toString()));
  await verify.connect();
  const { rows } = await verify.query<{ current_user: string; rolbypassrls: boolean }>(
    "SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  await verify.end();
  if (rows[0]?.current_user !== "finnor_preview_app" || rows[0]?.rolbypassrls) throw new Error("Preview role posture is not restricted");

  const remove = spawnSync("/Users/paramdave/.npm-global/bin/vercel", ["env", "rm", "DATABASE_URL", "preview", "--yes", "--cwd", "."], {
    cwd,
    encoding: "utf8",
  });
  if (remove.status !== 0) throw new Error("Vercel Preview DATABASE_URL removal failed");
  const add = spawnSync("/Users/paramdave/.npm-global/bin/vercel", ["env", "add", "DATABASE_URL", "preview", "--cwd", "."], {
    cwd,
    input: appUrl.toString(),
    encoding: "utf8",
  });
  if (add.status !== 0) throw new Error("Vercel Preview DATABASE_URL update failed");
  console.log(JSON.stringify({ previewRoleConfigured: true, databaseRole: rows[0], vercelDatabaseUrlUpdated: true }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
