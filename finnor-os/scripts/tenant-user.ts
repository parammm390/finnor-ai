import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPool } from "@finnor/db";

export type TenantUserRole = "owner";
export type TenantUserStatus = "active" | "suspended";

export type TenantAuthAdmin = SupabaseClient["auth"]["admin"];

export interface EnsureTenantUserInput {
  tenantId: string;
  email: string;
  role: TenantUserRole;
  displayName?: string | null;
  phoneNumber?: string | null;
  status?: TenantUserStatus;
  resetPassword?: boolean;
}

export interface EnsureTenantUserResult {
  id: string;
  tenantId: string;
  email: string;
  role: TenantUserRole;
  createdAuthUser: boolean;
  createdAppUser: boolean;
  password: string | null;
}

export class CrossTenantUserError extends Error {
  constructor(email: string, existingTenantId: string, requestedTenantId: string) {
    super(`User ${email} belongs to tenant ${existingTenantId}; refusing reassignment to ${requestedTenantId}`);
    this.name = "CrossTenantUserError";
  }
}

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) throw new Error("A valid email is required");
  return normalized;
}

/** Supabase Admin has no get-by-email endpoint. Follow every page until the user is
 * found or pagination is exhausted; never treat a first-page miss as nonexistence. */
export async function findAuthUserByEmail(auth: Pick<TenantAuthAdmin, "listUsers">, email: string): Promise<{ id: string } | null> {
  const normalized = normalizeEmail(email);
  const perPage = 200;
  let page = 1;
  for (;;) {
    const { data, error } = await auth.listUsers({ page, perPage });
    if (error) throw new Error(`Supabase listUsers failed: ${error.message}`);
    const match = data.users.find((user) => user.email?.trim().toLowerCase() === normalized);
    if (match) return { id: match.id };
    const nextPage = "nextPage" in data ? data.nextPage : undefined;
    if (nextPage === null || (nextPage === undefined && data.users.length < perPage)) return null;
    page = typeof nextPage === "number" ? nextPage : page + 1;
  }
}

function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

export async function ensureTenantUser(
  input: EnsureTenantUserInput,
  dependencies: { auth: TenantAuthAdmin; pool?: pg.Pool },
): Promise<EnsureTenantUserResult> {
  if (input.role !== "owner") throw new Error("Phase 5 permits only the owner role");
  const email = normalizeEmail(input.email);
  const pool = dependencies.pool ?? getPool();
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SET LOCAL search_path = finnor_os, public");
    // Never let RLS turn a cross-tenant identity into an apparent miss. This
    // administrative path must use the migration/admin database connection; a
    // restricted role fails here before any Supabase Auth mutation.
    await client.query("SET LOCAL row_security = off");
    // The email-scoped lock spans the Auth + app-directory convergence. This is an
    // administrative, low-volume path; serializing it closes the cross-client race.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`user:${email}`]);

    const tenant = await client.query("SELECT id FROM tenants WHERE id = $1", [input.tenantId]);
    if (!tenant.rows[0]) throw new Error(`Tenant ${input.tenantId} does not exist`);

    const currentResult = await client.query<{
      id: string;
      tenant_id: string;
      role: TenantUserRole;
    }>("SELECT id, tenant_id, role FROM users WHERE email = $1", [email]);
    const current = currentResult.rows[0];
    if (current && current.tenant_id !== input.tenantId) {
      // This check happens before every Supabase call and every application UPDATE.
      throw new CrossTenantUserError(email, current.tenant_id, input.tenantId);
    }

    let authUser = await findAuthUserByEmail(dependencies.auth, email);
    let createdAuthUser = false;
    let password: string | null = null;
    if (!authUser) {
      const generated = generatePassword();
      const { data, error } = await dependencies.auth.createUser({
        email,
        password: generated,
        email_confirm: true,
      });
      if (error) {
        if (!/already.*registered|already.*exists/i.test(error.message)) {
          throw new Error(`Supabase admin.createUser failed: ${error.message}`);
        }
        authUser = await findAuthUserByEmail(dependencies.auth, email);
        if (!authUser) throw new Error(`Supabase reports ${email} exists but paginated lookup cannot find it`);
      } else {
        authUser = { id: data.user.id };
        createdAuthUser = true;
        password = generated;
      }
    }

    if (input.resetPassword && !createdAuthUser) {
      const generated = generatePassword();
      const { error } = await dependencies.auth.updateUserById(authUser.id, { password: generated, email_confirm: true });
      if (error) throw new Error(`Supabase updateUserById failed: ${error.message}`);
      password = generated;
    }

    let id: string;
    let createdAppUser = false;
    if (current) {
      await client.query(
        `UPDATE users
         SET role = $2, display_name = $3, phone_number = $4, status = $5
         WHERE id = $1 AND tenant_id = $6
           AND (role, display_name, phone_number, status)
               IS DISTINCT FROM ($2, $3, $4, $5)`,
        [
          current.id,
          input.role,
          input.displayName ?? null,
          input.phoneNumber ?? null,
          input.status ?? "active",
          input.tenantId,
        ],
      );
      id = current.id;
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO users (tenant_id, email, role, display_name, phone_number, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          input.tenantId,
          email,
          input.role,
          input.displayName ?? null,
          input.phoneNumber ?? null,
          input.status ?? "active",
        ],
      );
      id = inserted.rows[0]!.id;
      createdAppUser = true;
    }

    await client.query("COMMIT");
    transactionOpen = false;
    return { id, tenantId: input.tenantId, email, role: input.role, createdAuthUser, createdAppUser, password };
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
