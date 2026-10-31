import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

type Save = (path: string, value: unknown) => Promise<unknown>;
export async function verifyClosingReaderPrivacy(client: pg.Client, save: Save) {
  const tenant = randomUUID(), principal = randomUUID(), foreign = randomUUID();
  const ordinary = { schema: "CONTROLLED_PRIVACY_PROBE", value: randomUUID() };
  const confidential = { schema: "CONTROLLED_PRIVACY_PROBE", owner: "Y4_CONFIDENTIAL_RELEASE", value: randomUUID() };
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const ordinaryDigest = digest(ordinary), privateDigest = digest(confidential);
  const rows: unknown[] = [];
  await save("closing-reader-privacy-original.json", { tenant, principal, foreign, ordinary, confidential,
    ordinaryDigest, privateDigest, roles: ["finnor_closing_checker", "finnor_closing_broker"],
    expected: { ordinaryVisible: true, confidentialVisible: false, spoofedOwnerVisible: false,
      foreignTenantVisible: false, applicationRecipientVisible: true, persistedProbeRows: 0 },
    qualification: "SYNTHETIC_ROLLED_BACK_SQL_PRIVACY_PROBE_NO_ALLOCATION_OR_RECEIPT" });
  await client.query("BEGIN");
  try {
    await client.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Controlled closing privacy probe')", [tenant, randomUUID()]);
    await client.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
      [principal, tenant, principal + "@test.invalid"]);
    for (const [body, hash] of [[ordinary, ordinaryDigest], [confidential, privateDigest]] as const)
      await client.query(`INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate)
       VALUES($1,$2,$3,$4::jsonb,'{"schema":"CONTROLLED_PRIVACY_PROBE_NOT_AN_ALLOCATION_CERTIFICATE"}'::jsonb)`,
        [tenant, principal, hash, JSON.stringify(body)]);
    for (const role of ["finnor_closing_checker", "finnor_closing_broker"] as const) {
      await client.query(`SET LOCAL ROLE ${role}`);
      const identity = (await client.query(`SELECT current_user AS role,rolsuper,rolbypassrls,
        has_table_privilege(current_user,'finnor_os.y4_source_handles','SELECT') private_source_read,
        has_table_privilege(current_user,'finnor_os.s5_proposals','INSERT') proposal_write,
        has_function_privilege(current_user,'finnor_os.y4_private_source_cut(uuid,uuid)','EXECUTE') private_cut
        FROM pg_roles WHERE rolname=current_user`)).rows[0];
      assert.deepEqual(identity, { role, rolsuper: false, rolbypassrls: false,
        private_source_read: false, proposal_write: false, private_cut: false });
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id','',true)", [tenant]);
      const view = (await client.query(`SELECT finnor_os.y4_s5_visible($1,$2) ordinary,
        finnor_os.y4_s5_visible($1,$3) confidential,
        finnor_os.y4_s5_subject_visible($1,$2) ordinary_subject,
        finnor_os.y4_s5_subject_visible($1,$3) confidential_subject,
        finnor_os.y4_s6_effect_visible($1,$4) ordinary_effect`,
        [tenant, ordinaryDigest, privateDigest, randomUUID()])).rows[0];
      assert.deepEqual(view, { ordinary: true, confidential: false,
        ordinary_subject: true, confidential_subject: false, ordinary_effect: true });
      await client.query("SELECT set_config('app.user_id',$1,true)", [principal]);
      const spoof = (await client.query("SELECT finnor_os.y4_s5_visible($1,$2) visible", [tenant, privateDigest])).rows[0];
      assert.equal(spoof.visible, false);
      if (role === "finnor_closing_checker") {
        const visible = (await client.query("SELECT content_digest FROM finnor_os.s5_proposals WHERE tenant_id=$1 ORDER BY content_digest", [tenant])).rows;
        assert.deepEqual(visible, [{ content_digest: ordinaryDigest }]);
      }
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [foreign]);
      const foreignView = (await client.query("SELECT finnor_os.y4_s5_visible($1,$2) visible", [tenant, ordinaryDigest])).rows[0];
      assert.equal(foreignView.visible, false);
      rows.push({ identity, view, spoof, foreignView });
      await client.query("RESET ROLE");
    }
    await client.query("SET LOCAL ROLE finnor_app");
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [tenant, principal]);
    const recipient = (await client.query("SELECT content_digest FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND content_digest=$2", [tenant, privateDigest])).rows;
    assert.deepEqual(recipient, [{ content_digest: privateDigest }]);
    rows.push({ applicationRecipient: recipient });
  } finally {
    await client.query("ROLLBACK");
  }
  const persisted = (await client.query("SELECT count(*)::integer count FROM finnor_os.s5_proposals WHERE tenant_id=$1", [tenant])).rows[0];
  assert.equal(persisted.count, 0);
  await save("closing-reader-privacy-result.json", { status: "PASS", rows, persisted,
    qualification: "ACTUAL_ORDINARY_ROLE_PRIVACY_BOUNDARY_NOT_CLOSING_OR_Y4_DOMAIN_QUALIFICATION" });
  return { status: "PASS", roles: rows.length - 1, rolledBack: true };
}
