import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { closePool, withTenant } from "@finnor/db";
import { assertDisposableDatabaseTarget } from "../packages/db/production-target-guard";

const tenantId = "00000000-0000-4000-8000-000000000001";
const partyId = "c0e00000-0000-4000-8000-000000000001";
const identityId = "c0e00000-0000-4000-8000-000000000002";
const stateDir = resolve("../.centropy-certification/atlas-temporal-clone");
async function main() {
  assertDisposableDatabaseTarget(process.env.DATABASE_URL, "CENTROPY SMTP canary fixture");
  if (process.env.CENTROPY_SMTP_CANARY !== "1") throw new Error("Explicit SMTP canary flag required");
  try {
    const result = await withTenant(tenantId, async (db) => {
      const directory = (await db.execute<{ directory: string }>(sql`SELECT current_setting('data_directory') directory`)).rows[0]?.directory;
      if (resolve(String(directory)) !== resolve(stateDir, "postgres")) throw new Error("Only the named disposable clone is allowed");
      const owner = (await db.execute<{ id: string }>(sql`SELECT id::text FROM finnor_os.users WHERE tenant_id=${tenantId}::uuid AND email=${process.env.TEST_OWNER_EMAIL} AND role='owner' AND status='active'`)).rows[0];
      if (!owner) throw new Error("Fixture owner missing");
      const existing = (await db.execute<{ id: string }>(sql`SELECT id::text FROM finnor_os.external_contacts WHERE tenant_id=${tenantId}::uuid AND lower(name)='sarah' AND id<>${partyId}::uuid`)).rows;
      if (existing.length) throw new Error("Another Sarah already exists; fixture must not replace or confuse her identity");
      const integrations = (await db.execute<{ id: string; binding: string }>(sql`SELECT id::text,binding FROM finnor_os.tenant_integrations WHERE tenant_id=${tenantId}::uuid AND capability='communications'`)).rows;
      if (integrations.some((row) => row.binding !== 'gmail')) throw new Error("A different communication integration already exists in the clone");
      await db.execute(sql`INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode,config,credential_provider,credential_ref)
        VALUES('c0e00000-0000-4000-8000-000000000003'::uuid,${tenantId}::uuid,'communications','gmail','sandbox','{"fixtureOnly":true}'::jsonb,'legacy-env','legacy-env:gmail') ON CONFLICT(tenant_id,capability) DO NOTHING`);
      await db.execute(sql`INSERT INTO finnor_os.external_contacts(id,tenant_id,contact_key,name,title,business_email)
        VALUES(${partyId}::uuid,${tenantId}::uuid,'centropy-sarah-smtp-fixture','Sarah','Authored localhost communication fixture','sarah@centropy-certification.invalid') ON CONFLICT(id) DO NOTHING`);
      await db.execute(sql`INSERT INTO finnor_os.communication_identities(id,tenant_id,identity_key,provider,channel,address,status,capabilities,credential_provider,credential_ref)
        VALUES(${identityId}::uuid,${tenantId}::uuid,'centropy-smtp-fixture','gmail','email','owner@centropy-certification.invalid','active','["send"]'::jsonb,'legacy-env','legacy-env:gmail') ON CONFLICT(id) DO NOTHING`);
      await db.execute(sql`INSERT INTO finnor_os.communication_identity_bindings(tenant_id,communication_identity_id,principal_type,principal_id,purpose,priority,status)
        VALUES(${tenantId}::uuid,${identityId}::uuid,'employee',${owner.id}::uuid,'default',100,'active') ON CONFLICT DO NOTHING`);
      return { ownerId: owner.id, partyId, identityId };
    });
    await writeFile(resolve(stateDir, "communication-fixture.json"), JSON.stringify({ schema: "centropy.smtp-fixture/v1", ...result, tenantId, recipientAddress: "sarah@centropy-certification.invalid", senderAddress: "owner@centropy-certification.invalid", fixtureOnly: true, transport: "loopback SMTP capture; not Gmail delivery" }, null, 2) + "\n");
    console.log("Authored Sarah party and owner-bound SMTP canary identity recorded");
  } finally { await closePool(); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
