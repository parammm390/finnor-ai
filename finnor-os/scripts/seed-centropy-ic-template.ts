import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { ingestArtifact, listArtifactTemplates, registerArtifactTemplate } from "@finnor/artifacts";
import { closePool, withTenant } from "@finnor/db";
import { assertDisposableDatabaseTarget } from "../packages/db/production-target-guard";

const tenantId = "00000000-0000-4000-8000-000000000001";
const templateKey = "centropy_ic_default_v1";
assertDisposableDatabaseTarget(process.env.DATABASE_URL, "CENTROPY local IC template seed");
const ownerEmail = process.env.TEST_OWNER_EMAIL;
if (!ownerEmail) throw new Error("TEST_OWNER_EMAIL is required");

async function main(): Promise<void> {
try {
  const owner = await withTenant(tenantId, async (db) => {
    const result = await db.execute<{ id: string }>(sql`
      SELECT id::text FROM finnor_os.users
      WHERE tenant_id=${tenantId}::uuid AND email=${ownerEmail} AND role='owner' AND status='active'
      LIMIT 1
    `);
    return result.rows[0];
  });
  if (!owner) throw new Error("The disposable Atlas owner is missing");
  const actor = { tenantId, userId: owner.id, role: "owner" as const };
  const bytes = await readFile(new URL("../tests/artifact-corpus/centropy-ic-default-template.pptx", import.meta.url));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const existing = (await listArtifactTemplates(actor)).find((item) => item.template_key === templateKey);
  const sameBytes = existing && await withTenant(tenantId, async (db) => {
    const result = await db.execute<{ byte_sha256: string }>(sql`SELECT byte_sha256 FROM finnor_os.document_versions WHERE id=${String(existing.version_id)}::uuid AND tenant_id=${tenantId}::uuid`);
    return result.rows[0]?.byte_sha256 === hash;
  });
  let defaultVersionId: string;
  if (existing && sameBytes) {
    defaultVersionId = String(existing.version_id);
    console.log(JSON.stringify({ status: "already_seeded", templateKey, versionId: existing.version_id }));
  } else {
    const source = await ingestArtifact(actor, {
      title: "CENTROPY default IC working template.pptx",
      bytes,
      origin: "manual_upload",
      sourceSystem: "certification:phase9-local-template",
    });
    await registerArtifactTemplate(actor, source.documentId, { versionId: source.version.id, templateKey });
    defaultVersionId = source.version.id;
    console.log(JSON.stringify({ status: "seeded", templateKey, documentId: source.documentId, versionId: source.version.id }));
  }
  // Template history is append-only. Retire the superseded local fixture key
  // with a new registry record instead of rewriting its historical registration.
  await withTenant(tenantId, async (db) => {
    await db.execute(sql`INSERT INTO finnor_os.artifact_templates(tenant_id,template_key,version_id,kind,status,actor_id)
      SELECT ${tenantId}::uuid,'centropy_ic_local_test_v1',${defaultVersionId}::uuid,'pptx','retired',${owner.id}::uuid
      WHERE EXISTS(SELECT 1 FROM finnor_os.artifact_templates WHERE tenant_id=${tenantId}::uuid AND template_key='centropy_ic_local_test_v1')
      ON CONFLICT DO NOTHING`);
  });
} finally {
  await closePool();
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
