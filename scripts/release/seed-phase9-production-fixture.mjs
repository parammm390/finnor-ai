import { readFile, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FINNOR_OS = join(ROOT, "finnor-os");
const requireFromOs = createRequire(pathToFileURL(join(FINNOR_OS, "package.json")));
const { Client } = requireFromOs("pg");

const DEFAULT_PE_TENANT_ID = "7d57aa44-df32-4ff7-87e8-e0b8236d9c31";
const DEAL_ID = "90000000-0000-4000-8000-000000000001";
const INVESTMENT_CASE_ID = "90000000-0000-4000-8000-000000000002";
const PRIMARY_WORK_ID = "90000000-0000-4000-8000-000000000015";
const ACTION_ID = "90000000-0000-4000-8000-000000000020";
const EFFECT_ID = "90000000-0000-4000-8000-000000000021";
const RECEIPT_ID = "90000000-0000-4000-8000-000000000022";
const AGENT_PROFILE_ID = "90000000-0000-4000-8000-000000000023";
const ASSIGNMENT_ID = "90000000-0000-4000-8000-000000000025";
const IC_CASE_ID = "90000000-0000-4000-8000-000000000036";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function replaceExactlyOnce(source, from, to, label) {
  const first = source.indexOf(from);
  const second = first < 0 ? -1 : source.indexOf(from, first + from.length);
  if (first < 0 || second >= 0) throw new Error(`Phase 9 source drift: expected exactly one ${label}`);
  return `${source.slice(0, first)}${to}${source.slice(first + from.length)}`;
}

async function run(command, args, options) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited ${code ?? `via ${signal}`}`));
    });
  });
}

async function verifyFixture(client, tenantId) {
  const result = await client.query(
    `SELECT
       EXISTS(SELECT 1 FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2) deal,
       EXISTS(SELECT 1 FROM finnor_os.pe_investment_cases WHERE tenant_id=$1 AND id=$3) investment_case,
       EXISTS(SELECT 1 FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND investment_case_id=$3) underwriting,
       EXISTS(SELECT 1 FROM finnor_os.pe_ic_cases WHERE tenant_id=$1 AND id=$4) ic_case,
       EXISTS(SELECT 1 FROM finnor_os.works WHERE tenant_id=$1 AND id=$5 AND status='completed') work,
       EXISTS(SELECT 1 FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=$6 AND status='completed') action,
       EXISTS(SELECT 1 FROM finnor_os.business_effects WHERE tenant_id=$1 AND id=$7 AND status='verified') effect,
       EXISTS(SELECT 1 FROM finnor_os.decision_receipts WHERE tenant_id=$1 AND id=$8 AND finalized_at IS NOT NULL) receipt,
       EXISTS(SELECT 1 FROM finnor_os.agent_profiles WHERE tenant_id=$1 AND id=$9) agent,
       EXISTS(SELECT 1 FROM finnor_os.workforce_assignments WHERE tenant_id=$1 AND id=$10 AND state='completed') assignment`,
    [tenantId, DEAL_ID, INVESTMENT_CASE_ID, IC_CASE_ID, PRIMARY_WORK_ID, ACTION_ID, EFFECT_ID, RECEIPT_ID, AGENT_PROFILE_ID, ASSIGNMENT_ID],
  );
  const state = result.rows[0];
  const missing = Object.entries(state).filter(([, present]) => present !== true).map(([key]) => key);
  return { complete: missing.length === 0, missing, state };
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.FINNOR_ENVIRONMENT !== "production") {
    throw new Error("Refusing production Phase 9 fixture outside protected GitHub Actions production execution");
  }

  const envFile = arg("--database-env");
  if (!envFile) throw new Error("Usage: node scripts/release/seed-phase9-production-fixture.mjs --database-env <file>");
  process.loadEnvFile(resolve(ROOT, envFile));

  const databaseUrl = process.env.MIGRATIONS_DATABASE_URL;
  const tenantId = process.env.FINNOR_PHASE9_PE_TENANT_ID || DEFAULT_PE_TENANT_ID;
  const ownerEmail = process.env.FINNOR_PHASE9_OWNER_EMAIL || "owner@test-dealer.finnor.local";
  if (!databaseUrl) throw new Error("MIGRATIONS_DATABASE_URL is required");
  if (["localhost", "127.0.0.1", "::1"].includes(new URL(databaseUrl).hostname)) throw new Error("Refusing a local database");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const boundary = await client.query(
      `SELECT t.client_key,v.vertical_key,u.id::text owner_id,u.status
         FROM finnor_os.tenants t
         JOIN finnor_os.tenant_vertical_assignments v ON v.tenant_id=t.id
         JOIN finnor_os.users u ON u.tenant_id=t.id AND lower(u.email)=lower($2) AND u.role='owner'
        WHERE t.id=$1`,
      [tenantId, ownerEmail],
    );
    const row = boundary.rows[0];
    if (!row || row.vertical_key !== "private_equity" || row.status !== "active") {
      throw new Error("Production fixture refused: target tenant/owner is not an active Private Equity boundary");
    }

    const before = await verifyFixture(client, tenantId);
    if (before.complete) {
      console.log(JSON.stringify({ ok: true, status: "already_complete", tenantId, dealId: DEAL_ID }));
      return;
    }
    if (before.state.deal === true) {
      throw new Error(`Production Phase 9 fixture is partial and will not be guessed/replayed: missing ${before.missing.join(", ")}`);
    }
  } finally {
    await client.end();
  }

  const sourcePath = join(FINNOR_OS, "scripts", "seed-phase9-e2e.ts");
  const generatedPath = join(FINNOR_OS, "scripts", ".phase9-production.generated.ts");
  let source = await readFile(sourcePath, "utf8");
  source = replaceExactlyOnce(
    source,
    `const appUrl = new URL(ADMIN_URL);\nappUrl.username = "finnor_app";\nappUrl.password = "finnor_app";\nconst APP_URL = appUrl.toString();`,
    `const APP_URL = ADMIN_URL;`,
    "local finnor_app URL block",
  );
  source = replaceExactlyOnce(
    source,
    `const TENANT_ID = "00000000-0000-4000-8000-000000000001";`,
    `const TENANT_ID = process.env.FINNOR_PHASE9_PE_TENANT_ID ?? "${DEFAULT_PE_TENANT_ID}";`,
    "fixture tenant constant",
  );
  source = replaceExactlyOnce(
    source,
    `    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");\n    await admin.query("SET app.test_vertical_mode = 'explicit'");`,
    `    if (process.env.FINNOR_ENVIRONMENT !== "production" || process.env.GITHUB_ACTIONS !== "true") throw new Error("production fixture guard missing");`,
    "local role/test-mode mutation",
  );

  await writeFile(generatedPath, source, "utf8");
  try {
    await run("npm", ["exec", "--", "tsx", "scripts/.phase9-production.generated.ts"], {
      cwd: FINNOR_OS,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        TEST_OWNER_EMAIL: ownerEmail,
        FINNOR_PHASE9_PE_TENANT_ID: tenantId,
        FINNOR_ENVIRONMENT: "production",
      },
    });
  } finally {
    await rm(generatedPath, { force: true });
  }

  const verify = new Client({ connectionString: databaseUrl });
  await verify.connect();
  try {
    const after = await verifyFixture(verify, tenantId);
    if (!after.complete) throw new Error(`Phase 9 fixture postcondition failed: missing ${after.missing.join(", ")}`);
    console.log(JSON.stringify({ ok: true, status: "seeded_and_verified", tenantId, dealId: DEAL_ID, verified: after.state }));
  } finally {
    await verify.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
