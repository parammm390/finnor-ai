/** Actual HTTP preflight race, without changing an application row or bypassing
 * RLS. The fixed restrictive policy is installed before original schema pins. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { closeInternalResources } from "./native-internal-support.mjs";

export async function nativeSubmitGate(e: any) {
  const name = "w1_submit_gate_" + randomUUID().replaceAll("-", ""), fn = name + "_read";
  const drop = async () => {
    const cleanup: any = {};
    await closeInternalResources(cleanup, [
      () => e.admin.query(`DROP POLICY IF EXISTS ${name} ON finnor_os.s5_reservations`),
      () => e.admin.query(`DROP FUNCTION IF EXISTS finnor_os.${fn}(uuid)`),
      () => e.admin.query(`DROP TABLE IF EXISTS finnor_os.${name}`),
    ]);
  };
  try {
  await e.admin.query(`CREATE TABLE finnor_os.${name}(tenant_id uuid PRIMARY KEY,advisory_key bigint NOT NULL,active boolean NOT NULL)`);
  await e.admin.query(`CREATE FUNCTION finnor_os.${fn}(scope_tenant uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog,finnor_os AS $gate$
    DECLARE target bigint;
    BEGIN
      SELECT advisory_key INTO target FROM finnor_os.${name} WHERE tenant_id=scope_tenant AND active;
      IF target IS NOT NULL THEN PERFORM pg_advisory_xact_lock(target); END IF;
      RETURN true;
    END $gate$`);
  // This is the late existing S5 owner read in resolveSearchOwners, AFTER its
  // final Work preflight. Pausing an earlier Work read would be caught by the
  // next preflight and would not exercise canonical submission acceptance.
  await e.admin.query(`CREATE POLICY ${name} ON finnor_os.s5_reservations AS RESTRICTIVE
    FOR SELECT TO finnor_app USING(finnor_os.${fn}(tenant_id))`);
  } catch (error) { await drop(); throw error; }
  let held = false;
  const key = 727007;
  return {
    catalogue: { name, fn, key, table: "s5_reservations",
      scope: "RESTRICTIVE_LATE_OWNER_PREFLIGHT_BEFORE_CANONICAL_ACCEPTANCE_NOT_AUTHORIZATION" },
    async hold(tenantId: string) {
      assert(!held);
      await e.admin.query("SELECT pg_advisory_lock($1)", [key]); held = true;
      await e.admin.query(`INSERT INTO finnor_os.${name}(tenant_id,advisory_key,active) VALUES($1,$2,true)
        ON CONFLICT(tenant_id) DO UPDATE SET active=true`, [tenantId, key]);
    },
    async observedBlocked() {
      const expires = Date.now() + 5000;
      for (let decision = 0; decision < 100 && Date.now() < expires; decision++) {
        const blocked = (await e.admin.query(`SELECT pid,usename,wait_event_type,wait_event,query,
          pg_blocking_pids(pid) blockers,clock_timestamp()::text observed_at FROM pg_stat_activity
          WHERE datname=current_database() AND usename='finnor_app' AND wait_event='advisory'
            AND pg_backend_pid()=ANY(pg_blocking_pids(pid))`)).rows;
        if (blocked.length) {
          assert(blocked.every((row: any) => row.query.includes("s5_reservations")),
            "Canonical submit race must reach the last original owner preflight");
          return blocked;
        }
        await new Promise<void>(resolve => setTimeout(resolve, 25));
      }
      throw Error("W1_ACTUAL_SUBMIT_PREFLIGHT_BLOCK_NOT_OBSERVED");
    },
    async release() {
      try { await e.admin.query(`UPDATE finnor_os.${name} SET active=false`); }
      finally { if (held) { await e.admin.query("SELECT pg_advisory_unlock($1)", [key]); held = false; } }
    },
    async close() {
      const cleanup: any = {};
      await closeInternalResources(cleanup, [() => this.release(), drop]);
    },
  };
}
