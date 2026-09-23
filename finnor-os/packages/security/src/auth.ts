// Supabase-JWT verification + tenant resolution (§17), extracted out of
// apps/api/lib/auth.ts so B1.T2's SSE gateway (apps/worker, a plain Node HTTP server,
// not a Next.js Request) can authenticate callers the exact same way — one Supabase
// client + one users-table lookup, not two copies of the same logic. apps/api/lib/
// auth.ts's requireContext() now calls into resolveTenantFromBearerToken() below for
// the bearer-token path; its dev-bypass branch, rate limiting, and Sentry tagging stay
// there since those are Next.js-Request-specific concerns, not identity verification.
//
// Deviation from CENTROPY-MAESTRO-PLAN.md §5 B1's "Read: packages/security (JWT verify)"
// line: this logic did not actually live here before B1 — it was inlined inside
// apps/api/lib/auth.ts's requireContext(). Moved here rather than duplicated, which is
// what "Read: packages/security (JWT verify)" implied should already be true.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getPool } from "@finnor/db";
import type { TenantContext, Role } from "@finnor/shared-types";

export class AuthVerificationError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export type IdentityContext = Omit<TenantContext, "correlationId">;

let authClient: SupabaseClient | null = null;
let authClientConfig = "";

function supabaseAuthClient(url: string, key: string): SupabaseClient {
  // Reuse one client so auth-js can reuse its cached JWKS. Creating a client for
  // every API read forced a remote /user verification for every Home poll and
  // multiplied one browser session into dozens of auth round trips.
  const config = `${url}\u0000${key}`;
  if (!authClient || authClientConfig !== config) {
    authClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    authClientConfig = config;
  }
  return authClient;
}

/** Verifies a Supabase-issued bearer token and returns the caller's email. Throws
 *  AuthVerificationError (never a bare Error) so every caller can map it to the right
 *  HTTP status without knowing anything about Supabase's own error shape. */
export async function verifyBearerToken(token: string): Promise<{ email: string }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new AuthVerificationError("Auth is not configured (SUPABASE_URL / key missing)", 500);
  const supabase = supabaseAuthClient(url, key);
  // getClaims verifies asymmetric Supabase JWTs locally after a cached JWKS fetch;
  // it still falls back to the Auth server for symmetric signing. Either path
  // cryptographically validates expiry/signature—this is not decode-and-trust.
  const { data, error } = await supabase.auth.getClaims(token);
  const email = data?.claims.email;
  if (error || typeof email !== "string" || !email) throw new AuthVerificationError("Invalid or expired token", 401);
  return { email };
}

/** Identity → tenant lookup. Outside any withTenant() scope deliberately — tenant
 *  identity is not yet known at this point, it's the bootstrap step. */
export async function resolveTenantContextByEmail(email: string): Promise<IdentityContext | null> {
  // The lookup happens before we know which tenant GUC to set. Under the restricted
  // production finnor_app role, direct users-table reads are therefore correctly
  // RLS-empty. The migration's narrowly granted SECURITY DEFINER function returns
  // only this already Supabase-verified email's mapping.
  const { rows } = await getPool().query(
    `SELECT user_id AS id, tenant_id, user_role AS role, employee_status, authority_revision
     FROM finnor_os.resolve_authenticated_identity($1)`,
    [email],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.employee_status !== "active") throw new AuthVerificationError("Employee access is suspended", 403);
  return {
    userId: row.id,
    employeeId: row.id,
    tenantId: row.tenant_id,
    role: row.role as Role,
    authorityRevision: Number(row.authority_revision ?? 1),
  };
}

/** Bearer token → tenant context in one call. No Next.js Request dependency, so any
 *  Node HTTP surface (Next.js route handlers, apps/worker's SSE gateway) can use it. */
export async function resolveTenantFromBearerToken(token: string): Promise<IdentityContext> {
  const { email } = await verifyBearerToken(token);
  const ctx = await resolveTenantContextByEmail(email);
  if (!ctx) throw new AuthVerificationError("User has no tenant — contact your administrator", 403);
  return ctx;
}
