// Administrative CLI wrapper around the tenant-isolating ensureTenantUser primitive.
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { closePool } from "@finnor/db";
import { ensureTenantUser, type TenantUserRole } from "./tenant-user";

const DEFAULT_TENANT_ID = "00000000-0000-4000-8000-000000000001";
const VALID_ROLES: TenantUserRole[] = ["owner"];

function parseArgs(): { email: string; role: TenantUserRole; tenantId: string; resetPassword: boolean } {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=")];
  }));
  if (!args.email || !args.email.includes("@")) {
    throw new Error("Usage: --email=you@example.com [--role=owner] [--tenant=<uuid>] [--reset-password]");
  }
  const role = (args.role ?? "owner") as TenantUserRole;
  if (!VALID_ROLES.includes(role)) throw new Error(`--role must be one of ${VALID_ROLES.join(", ")}`);
  return {
    email: args.email,
    role,
    tenantId: args.tenant ?? DEFAULT_TENANT_ID,
    resetPassword: "reset-password" in args,
  };
}

async function main(): Promise<void> {
  const input = parseArgs();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must be set");
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } });
  const result = await ensureTenantUser(input, { auth: supabase.auth.admin });

  console.log(`finnor_os.users row ready: id=${result.id} email=${result.email} tenant=${result.tenantId} role=${result.role}`);
  if (result.password) {
    console.log("");
    console.log("=== LOGIN PASSWORD — shown once, not stored anywhere ===");
    console.log(`  email:    ${result.email}`);
    console.log(`  password: ${result.password}`);
    console.log("Log in, then change this password from the account settings.");
    console.log("==========================================================");
  } else {
    console.log(`Supabase auth user for ${result.email} already existed — password unchanged.`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closePool());
