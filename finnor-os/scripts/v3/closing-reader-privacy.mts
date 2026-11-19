import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

type Save = (path: string, value: unknown) => Promise<unknown>;
export async function verifyClosingReaderPrivacy(client: pg.Client, save: Save) {
  const tenant = randomUUID(), principal = randomUUID(), foreign = randomUUID();
  const ordinarySource = randomUUID(), nangoSource = randomUUID(), publicSource = randomUUID();
  const ordinary = { schema: "CONTROLLED_PRIVACY_PROBE", value: randomUUID() };
  const confidential = { schema: "CONTROLLED_PRIVACY_PROBE", owner: "Y4_CONFIDENTIAL_RELEASE", value: randomUUID() };
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const ordinaryDigest = digest(ordinary), privateDigest = digest(confidential);
  const rows: unknown[] = [];
  await save("closing-reader-privacy-original.json", { tenant, principal, foreign, ordinary, confidential,
    ordinaryDigest, privateDigest, ordinarySource, nangoSource, publicSource, roles: ["finnor_closing_checker", "finnor_closing_broker"],
    expected: { ordinaryVisible: true, confidentialVisible: false, spoofedOwnerVisible: false,
      foreignTenantVisible: false, applicationRecipientVisible: true, persistedProbeRows: 0 },
    qualification: "SYNTHETIC_ROLLED_BACK_SQL_PRIVACY_PROBE_NO_ALLOCATION_OR_RECEIPT" });
  await client.query("BEGIN");
  try {
    const permissionPlan: unknown[] = [], failures: unknown[] = [];
    for (const role of ["finnor_closing_checker", "finnor_closing_broker"] as const) {
      const tables = (await client.query<{ schema: string; name: string }>(`SELECT n.nspname schema,c.relname name
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='finnor_os' AND c.relkind IN ('r','p')
          AND has_table_privilege($1,c.oid,'SELECT') ORDER BY c.relname`, [role])).rows;
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id','',true)", [tenant]);
      for (const table of tables) {
        assert(/^[a-z_][a-z0-9_]*$/.test(table.schema) && /^[a-z_][a-z0-9_]*$/.test(table.name));
        await client.query("SAVEPOINT reader_permission_plan");
        try {
          await client.query(`EXPLAIN (FORMAT JSON) SELECT * FROM "${table.schema}"."${table.name}" LIMIT 0`);
          permissionPlan.push({ role, table: table.name, status: "PASS" });
        } catch (error) {
          const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
          const permission = error instanceof Error
            ? /^permission denied for (function|table|schema|sequence|database|relation) ([a-zA-Z_][a-zA-Z0-9_.]{0,127})$/.exec(error.message) : null;
          const row = { role, table: table.name, status: "FAIL", code,
            permission: permission ? { kind: permission[1], identifier: permission[2] } : null };
          failures.push(row); permissionPlan.push(row);
          await client.query("ROLLBACK TO SAVEPOINT reader_permission_plan");
        } finally { await client.query("RELEASE SAVEPOINT reader_permission_plan"); }
      }
      await client.query("RESET ROLE");
    }
    await save("closing-reader-permission-plan.json", { status: failures.length ? "FAIL" : "PASS",
      originalSource: "ALL_EXISTING_CATALOG_TABLE_SELECT_PRIVILEGES_PER_ROLE", permissionPlan, failures,
      qualification: "ACTUAL_ORDINARY_ROLE_QUERY_PLANNING_NOT_ROW_OR_CLOSING_QUALIFICATION" });
    assert.deepEqual(failures, [], "COMPLETE_EXISTING_READER_PERMISSION_PLAN");
    await client.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Controlled closing privacy probe')", [tenant, randomUUID()]);
    await client.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
      [principal, tenant, principal + "@test.invalid"]);
    for (const [body, hash] of [[ordinary, ordinaryDigest], [confidential, privateDigest]] as const)
      await client.query(`INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate)
       VALUES($1,$2,$3,$4::jsonb,'{"schema":"CONTROLLED_PRIVACY_PROBE_NOT_AN_ALLOCATION_CERTIFICATE"}'::jsonb)`,
        [tenant, principal, hash, JSON.stringify(body)]);
    for (const [id, sourceType, scope] of [[ordinarySource, "controlled_privacy_probe", "tenant"],
      [nangoSource, "nango_record", "tenant"], [publicSource, "controlled_privacy_probe", "public"]] as const)
      await client.query(`INSERT INTO finnor_os.evidence_sources(id,scope,tenant_id,source_key,source_type,title,metadata)
        VALUES($1,$2,$3,$4,$5,'Controlled rolled-back source privacy probe',$6::jsonb)`,
        [id, scope, scope === "public" ? null : tenant, id, sourceType,
          JSON.stringify({ capabilityPrincipalId: principal, capabilityAuthorityRevision: "1" })]);
    for (const role of ["finnor_closing_checker", "finnor_closing_broker"] as const) {
      await client.query(`SET LOCAL ROLE ${role}`);
      const identity = (await client.query(`SELECT current_user AS role,rolsuper,rolbypassrls,
        has_table_privilege(current_user,'finnor_os.y4_source_handles','SELECT') private_source_read,
        has_table_privilege(current_user,'finnor_os.s5_proposals','INSERT') proposal_write,
        has_table_privilege(current_user,'finnor_os.capability_nango_bindings','SELECT') connection_binding_read,
        has_function_privilege(current_user,'finnor_os.y4_private_source_cut(uuid,uuid)','EXECUTE') private_cut
        FROM pg_roles WHERE rolname=current_user`)).rows[0];
      assert.deepEqual(identity, { role, rolsuper: false, rolbypassrls: false,
        private_source_read: false, proposal_write: false, connection_binding_read: false, private_cut: false });
      await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id','',true)", [tenant]);
      const emptyIdentityCut = (await client.query("SELECT finnor_os.pe_closing_cut($1,$2) cut", [tenant, randomUUID()])).rows[0];
      assert.deepEqual(emptyIdentityCut, { cut: null }, "COMPLETE_CLOSING_QUERY_PERMISSION_PREFLIGHT");
      const sourceVisibility = (await client.query(`SELECT
        finnor_os.capability_nango_source_current($1,'controlled_privacy_probe','{}'::jsonb) ordinary,
        finnor_os.capability_nango_source_current($1,'nango_record','{}'::jsonb) nango`, [tenant])).rows[0];
      assert.deepEqual(sourceVisibility, { ordinary: true, nango: false });
      const sources = (await client.query("SELECT id FROM finnor_os.evidence_sources WHERE id=ANY($1::uuid[]) ORDER BY id", [[ordinarySource, nangoSource, publicSource]])).rows;
      assert.deepEqual(sources, [ordinarySource, publicSource].sort().map(id => ({ id })));
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
      const foreignSources = (await client.query("SELECT id FROM finnor_os.evidence_sources WHERE id=ANY($1::uuid[])", [[ordinarySource, nangoSource, publicSource]])).rows;
      assert.deepEqual(foreignSources, [{ id: publicSource }]);
      rows.push({ identity, emptyIdentityCut, sourceVisibility, sources, view, spoof, foreignView, foreignSources });
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
  const persistedSources = (await client.query("SELECT count(*)::integer count FROM finnor_os.evidence_sources WHERE id=ANY($1::uuid[])", [[ordinarySource, nangoSource, publicSource]])).rows[0];
  assert.equal(persistedSources.count, 0);
  await save("closing-reader-privacy-result.json", { status: "PASS", rows, persisted, persistedSources,
    qualification: "ACTUAL_ORDINARY_ROLE_PRIVACY_BOUNDARY_NOT_CLOSING_OR_Y4_DOMAIN_QUALIFICATION" });
  return { status: "PASS", roles: rows.length - 1, rolledBack: true };
}
