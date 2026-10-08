/** Positive production target and effective-role admission. Never return a URL,
 * password, or managed-secret value in proof/error output. */
export function assertProductionDatabaseTarget(connectionString, database, kind) {
  const reject = () => { throw new Error("Canonical production database target required"); };
  let url, project;
  try { url = new URL(connectionString); project = new URL(database.supabaseUrl); } catch { reject(); }
  const match = /^([a-z0-9]+)\.supabase\.co$/.exec(project.hostname);
  const role = kind === "owner" ? "postgres" : kind === "application" ? "finnor_app" : null;
  let username;
  try { username = decodeURIComponent(url.username); } catch { reject(); }
  if (!match || !role || !["postgres:", "postgresql:"].includes(url.protocol)
      || url.hostname !== database.host || username !== `${role}.${match[1]}`
      || (url.port || "5432") !== "5432" || url.pathname !== "/postgres"
      || !url.password || url.hash) reject();
  return { host: url.hostname, projectRef: match[1], database: "postgres", port: 5432, role };
}

export async function verifyRestrictedApplicationRole(client, database) {
  const { rows } = await client.query(`
    SELECT current_user AS role, r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls,
      EXISTS (SELECT 1 FROM pg_roles privileged
        WHERE (privileged.rolsuper OR privileged.rolbypassrls)
          AND pg_has_role(current_user, privileged.oid, 'MEMBER')) AS privileged_membership
    FROM pg_roles r WHERE r.rolname = current_user`);
  const role = rows[0];
  if (role?.role !== "finnor_app" || role.superuser !== false || role.bypass_rls !== false
      || role.privileged_membership !== false) {
    throw new Error("Restricted application database role required");
  }
  const tables = await client.query(`
    SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
      pg_has_role(current_user, c.relowner, 'MEMBER') AS owner_membership
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
      AND EXISTS (SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`,
  [database.schema]);
  if (!tables.rows.length || tables.rows.some((table) => table.rls !== true || table.owner_membership !== false)) {
    throw new Error("Tenant RLS posture required");
  }
  return { role: role.role, superuser: false, bypassRls: false, privilegedMembership: false,
    tenantTables: tables.rows.length, forcedTables: tables.rows.filter((table) => table.forced).length,
    tenantTableOwnership: false };
}
