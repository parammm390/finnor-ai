import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { closePool } from "@finnor/db";
import { createClosingCondition, createClosingItem, markClosingItemReady, recordPrivateEquitySourceObservation, type PeMutationContext } from "@finnor/private-equity";
import { assertDisposableDatabaseTarget } from "../packages/db/production-target-guard";

async function main(): Promise<void> {
const url = process.env.DATABASE_URL;
assertDisposableDatabaseTarget(url, "CENTROPY authored human-control fixture");
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error("Use the named localhost fixture");
if (!process.env.TEST_OWNER_EMAIL) throw new Error("Configure the actual fixture owner email");
const admin = new pg.Client({ connectionString: url });
await admin.connect();
const tenantId = "00000000-0000-4000-8000-000000000001";
const dealId = "90000000-0000-4000-8000-000000000001";
try {
  const owner = (await admin.query<{ id: string }>("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND email=$2 AND role='owner' AND status='active'", [tenantId, process.env.TEST_OWNER_EMAIL])).rows[0];
  const source = (await admin.query<{ document_id: string }>("SELECT document_id FROM finnor_os.pe_document_links WHERE tenant_id=$1 AND deal_id=$2 AND archived_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1", [tenantId, dealId])).rows[0];
  const workstream = (await admin.query<{ id: string }>("SELECT id FROM finnor_os.pe_workstreams WHERE tenant_id=$1 AND deal_id=$2 AND archived_at IS NULL ORDER BY created_at,id LIMIT 1", [tenantId, dealId])).rows[0];
  if (!owner || !source || !workstream) throw new Error("Seed the Atlas owner, workstream and real Artifact bytes first");
  const appUrl = new URL(url); appUrl.username = "finnor_app"; appUrl.password = "finnor_app";
  process.env.DATABASE_URL = appUrl.toString();
  const ctx: PeMutationContext = { auth: { tenantId, userId: owner.id, employeeId: owner.id, role: "owner" }, provenance: { sourceSystem: "fixture:centropy-human-controls", createdBy: owner.id } };
  await admin.query("INSERT INTO finnor_os.tenant_integrations(id,tenant_id,capability,binding,mode) VALUES($1,$2,'documents','centropy-authored-control-fixture','emulator') ON CONFLICT(tenant_id,capability) DO NOTHING", [randomUUID(), tenantId]);
  const integration = (await admin.query<{ id: string; binding: string; mode: string }>("SELECT id,binding,mode FROM finnor_os.tenant_integrations WHERE tenant_id=$1 AND capability='documents'", [tenantId])).rows[0];
  if (!integration || integration.binding !== "centropy-authored-control-fixture" || integration.mode !== "emulator") throw new Error("The disposable document integration must belong to this authored fixture; existing bindings are preserved");
  const integrationId = integration.id;
  const conditionId = randomUUID(), itemId = randomUUID();
  await createClosingCondition(ctx, { id: conditionId, dealId, workstreamId: workstream.id, conditionText: "Authored control certification condition — disposable fixture", category: "certification_fixture", owner: { partyType: "employee", partyId: owner.id }, requiredForClose: false, evidenceRequired: false });
  await createClosingItem(ctx, { id: itemId, dealId, workstreamId: workstream.id, itemText: "Authored control certification item — disposable fixture", category: "certification_fixture", owner: { partyType: "employee", partyId: owner.id }, requiredForClose: false, verificationEvidenceRequired: true });
  await markClosingItemReady(ctx, { closingItemId: itemId, expectedVersion: 1 });
  // An explicit authored fixture observation establishes only this disposable
  // item's input fact. It cannot itself mutate the canonical ClosingItem state.
  const evidence = await recordPrivateEquitySourceObservation(ctx, {
    dealId, entity: { entityType: "pe_closing_item", entityId: itemId }, integrationId,
    provider: "centropy-authored-control-fixture", sourceScope: "disposable-verification-inputs",
    externalObjectType: "authored-verification-fixture", externalId: itemId,
    claims: [{ entity: { entityType: "pe_closing_item", entityId: itemId }, predicate: "closing_item.verified", value: true }],
    observedAt: new Date().toISOString(), sourceVersion: "1", sourceSequence: "1",
    provenance: { fixture: true, authored: true, noLiveBusinessAssertion: true },
  });
  if (!evidence.evidenceSourceId || !evidence.evidenceVersionId) throw new Error("The exact authored verification evidence was not materialized");
  const output = resolve(process.argv[2] ?? "../.centropy-certification/atlas-final-v2/human-controls-fixture.json");
  await mkdir(dirname(output), { recursive: true });
  const fixture = { schema: "centropy.human-controls-fixture/v1", authored: true, createdAt: new Date().toISOString(), tenantId, ownerId: owner.id, dealId, conditionId, conditionVersion: 1, itemId, itemVersion: 2, documentId: source.document_id, evidenceSourceId: evidence.evidenceSourceId, evidenceVersionId: evidence.evidenceVersionId, integrationId };
  await writeFile(output, JSON.stringify(fixture, null, 2) + "\n");
  console.log(JSON.stringify({ status: "AUTHORED_FIXTURE_CREATED", conditionId, itemId, output }));
} finally { await admin.end(); await closePool(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Fixture failed"); process.exitCode = 1; });
