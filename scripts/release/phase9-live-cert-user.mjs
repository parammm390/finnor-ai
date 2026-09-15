import { appendFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FINNOR_OS = join(ROOT, "finnor-os");
const requireFromOs = createRequire(pathToFileURL(join(FINNOR_OS, "package.json")));
const { Client } = requireFromOs("pg");
const { createClient } = requireFromOs("@supabase/supabase-js");

const DEFAULT_PE_TENANT_ID = "7d57aa44-df32-4ff7-87e8-e0b8236d9c31";
const DEFAULT_EMAIL = "phase9-live-cert@finnor.local";

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function isProviderRestriction(error) {
  return /exceed_egress_quota|project is restricted|remove spend caps|upgrade their plan/i.test(messageOf(error));
}

function providerBlocked(error) {
  const detail = messageOf(error);
  console.error(JSON.stringify({
    ok: false,
    code: "SUPABASE_AUTH_PROVIDER_BLOCKED",
    provider: "supabase",
    retryableAfterProviderRecovery: true,
    detail,
  }));
  throw new Error(`SUPABASE_AUTH_PROVIDER_BLOCKED: ${detail}`);
}

async function findAuthUser(admin, email) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.listUsers({ page, perPage: 1000 });
    if (error) {
      if (isProviderRestriction(error)) providerBlocked(error);
      throw error;
    }
    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());
    if (user) return user;
    if (data.users.length < 1000) return null;
  }
  throw new Error("Supabase auth user scan exceeded the guarded page limit");
}

async function main() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.FINNOR_ENVIRONMENT !== "production") {
    throw new Error("Refusing live certification identity outside protected production GitHub Actions");
  }
  const envFile = arg("--database-env");
  if (!envFile) throw new Error("Usage: node scripts/release/phase9-live-cert-user.mjs --database-env <file> [--cleanup]");
  process.loadEnvFile(resolve(ROOT, envFile));

  const databaseUrl = process.env.MIGRATIONS_DATABASE_URL;
  const supabaseUrl = process.env.SUPABASE_URL || "https://kpxrnonhnhexutvdywbh.supabase.co";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const tenantId = process.env.FINNOR_PHASE9_PE_TENANT_ID || DEFAULT_PE_TENANT_ID;
  const email = process.env.FINNOR_PHASE9_CERT_EMAIL || DEFAULT_EMAIL;
  if (!databaseUrl || !serviceKey) throw new Error("MIGRATIONS_DATABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const tenant = await client.query(
      `SELECT v.vertical_key FROM finnor_os.tenants t
       JOIN finnor_os.tenant_vertical_assignments v ON v.tenant_id=t.id
       WHERE t.id=$1`,
      [tenantId],
    );
    if (tenant.rows[0]?.vertical_key !== "private_equity") throw new Error("Certification identity target is not a Private Equity tenant");

    if (process.argv.includes("--cleanup")) {
      let authCleanup = "not_found";
      let authCleanupError = null;
      try {
        const existingAuth = await findAuthUser(supabase.auth.admin, email);
        if (existingAuth) {
          const { error } = await supabase.auth.admin.deleteUser(existingAuth.id);
          if (error) throw error;
          authCleanup = "deleted";
        }
      } catch (error) {
        authCleanupError = messageOf(error);
        authCleanup = isProviderRestriction(error) || /SUPABASE_AUTH_PROVIDER_BLOCKED/.test(authCleanupError)
          ? "provider_blocked"
          : "failed";
      }

      // Application access is disabled regardless of provider health. This makes the
      // cleanup fail-safe: a Supabase outage/quota event cannot leave a cert identity
      // authorized inside FINNOR even when the external auth deletion cannot run.
      await client.query("UPDATE finnor_os.users SET status='suspended' WHERE lower(email)=lower($1)", [email]);
      console.log(JSON.stringify({ ok: authCleanup !== "failed", mode: "cleanup", email, tenantId, authCleanup, authCleanupError }));
      if (authCleanup === "failed") throw new Error(`Supabase auth cleanup failed after FINNOR access was suspended: ${authCleanupError}`);
      return;
    }

    const existingAuth = await findAuthUser(supabase.auth.admin, email);
    const password = `${randomBytes(27).toString("base64url")}Aa1!`;
    if (existingAuth) {
      const { error } = await supabase.auth.admin.updateUserById(existingAuth.id, { password, email_confirm: true });
      if (error) {
        if (isProviderRestriction(error)) providerBlocked(error);
        throw error;
      }
    } else {
      const { error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) {
        if (isProviderRestriction(error)) providerBlocked(error);
        throw error;
      }
    }

    const appUser = await client.query(
      `INSERT INTO finnor_os.users(tenant_id,email,role,status,display_name)
       VALUES($1,$2,'owner','active','Phase 9 Live Certification')
       ON CONFLICT(email) DO UPDATE SET tenant_id=EXCLUDED.tenant_id,role='owner',status='active',display_name=EXCLUDED.display_name
       RETURNING id::text,tenant_id::text,email,role,status`,
      [tenantId, email],
    );

    const resolved = await client.query(
      "SELECT tenant_id::text,user_id::text,role,status FROM finnor_os.resolve_authenticated_identity($1)",
      [email],
    );
    if (resolved.rows[0]?.tenant_id !== tenantId || resolved.rows[0]?.role !== "owner" || resolved.rows[0]?.status !== "active") {
      throw new Error("Live certification identity failed application identity resolution");
    }

    if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required for guarded credential handoff");
    console.log(`::add-mask::${password}`);
    await appendFile(process.env.GITHUB_ENV, `TEST_OWNER_EMAIL=${email}\nTEST_OWNER_PASSWORD=${password}\n`, "utf8");
    console.log(JSON.stringify({ ok: true, mode: "prepared", email, tenantId, appUser: appUser.rows[0] }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
