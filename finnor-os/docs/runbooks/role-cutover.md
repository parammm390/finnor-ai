# Restricted database-role cutover

Purpose: move runtime application connections from the owning `postgres` role to
`finnor_app`, which is subject to RLS. Migrations retain an owner connection through
`MIGRATIONS_DATABASE_URL`.

## Preconditions

1. Verify `finnor_app` exists and does not have `rolsuper` or `rolbypassrls`.
2. Verify migrations `0032` and `0036` are applied and `finnor_app` has schema/table
   grants for `finnor_os` and `finnor_langgraph`.
3. Store a generated login password only in AWS Secrets Manager; never commit or log it.
4. Preserve the current owner URL as `MIGRATIONS_DATABASE_URL` on every runtime surface.

## Staging, then production

1. Generate a URL using the existing database host/database/options with
   `finnor_app:<generated password>` credentials.
2. `ALTER ROLE finnor_app LOGIN PASSWORD '<generated password>'` through the current
   owner connection.
3. Update the AWS-managed `DATABASE_URL` value to the restricted URL; add the preserved
   owner URL as `MIGRATIONS_DATABASE_URL` only on the canonical Vercel API and Azure worker surfaces.
4. Restart/deploy staging. Probe `SELECT current_user, rolbypassrls` through the runtime
   URL and run the tenant-isolation suite. Roll back by restoring the prior managed
   `DATABASE_URL` value immediately if either fails.
5. After a staging soak, repeat on production. Probe the same role identity, `/healthz`,
   and a tenant-A/tenant-B read isolation check.

## Rollback

Restore the previous owner `DATABASE_URL` secret/value and redeploy/restart the affected
runtime. Do not drop `finnor_app` or revoke grants during rollback; the cutover is only
the connection string.
