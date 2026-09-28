import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { closePool, withTenant } from "@finnor/db";
import { appendEvidenceVersion } from "@finnor/memory";
import { groundedMemoBytes, ingestArtifact } from "@finnor/artifacts";
import { attachCanonicalDocument, attachCanonicalEvidence, createIcRecommendation, createUnderwritingRun, getIcWorkspace, getUnderwritingRun, selectIcMemoVersion, selectPrimaryIcUnderwritingRun, type PeMutationContext } from "@finnor/private-equity";
import { assertDisposableDatabaseTarget } from "../packages/db/production-target-guard";

const tenantId = "00000000-0000-4000-8000-000000000001";
const dealId = "90000000-0000-4000-8000-000000000001";
const caseId = "69dfece1-c000-489d-98a9-d6ea918c492b";
const sourceScenarioRunId = "d111cba2-e5b7-41d2-8461-bc06fd5abf04";
const stateDir = resolve("../.centropy-certification/atlas-temporal-clone");
async function main(): Promise<void> {
  assertDisposableDatabaseTarget(process.env.DATABASE_URL, "CENTROPY current temporal fixture changes");
  const baseline = JSON.parse(await readFile(resolve(stateDir, "temporal-baseline.json"), "utf8"));
  if (baseline.fixture !== "atlas-temporal-clone" || process.env.CENTROPY_TEMPORAL_CLONE !== "1") throw new Error("Authored baseline clone required");
  try {
    const directory = await withTenant(tenantId, async (db) => (await db.execute<{ directory: string }>(sql`SELECT current_setting('data_directory') directory`)).rows[0]?.directory);
    if (resolve(String(directory)) !== resolve(stateDir, "postgres")) throw new Error("This is not the named temporal clone");
    const previous = await readFile(resolve(stateDir, "temporal-change.json"), "utf8").then(JSON.parse).catch(() => null);
    if (previous) { console.log(JSON.stringify({ status: "already_recorded", ...previous })); return; }
    const owner = await withTenant(tenantId, async (db) => (await db.execute<{ id: string }>(sql`SELECT id::text FROM finnor_os.users WHERE tenant_id=${tenantId}::uuid AND email=${process.env.TEST_OWNER_EMAIL} AND role='owner' AND status='active'`)).rows[0]);
    if (!owner) throw new Error("Fixture owner missing");
    const ctx: PeMutationContext = { auth: { tenantId, userId: owner.id, employeeId: owner.id, role: "owner" }, provenance: { sourceSystem: "certification:authored-temporal-change", createdBy: owner.id } };
    const before = await getIcWorkspace(ctx, { icCaseId: caseId, asOf: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() });
    const baselineRun = await getUnderwritingRun(ctx, String(before.case.primaryUnderwritingRunId));
    const scenarioSource = await getUnderwritingRun(ctx, sourceScenarioRunId);
    const worldAt = scenarioSource.worldAt instanceof Date ? scenarioSource.worldAt.toISOString() : new Date(String(scenarioSource.worldAt)).toISOString();
    const fresh = await createUnderwritingRun(ctx, { investmentCaseId: String(scenarioSource.investmentCaseId), modelVersionId: String(scenarioSource.modelVersionId), scenarioId: String(scenarioSource.scenarioId), baseRunId: String(scenarioSource.baseRunId ?? "bee8df8e-d65a-4c47-b9e6-acc2c60f010c"), worldAt, idempotencyKey: "centropy-temporal-current-run-v1" });
    const run = await getUnderwritingRun(ctx, fresh.id);
    if (run.validity !== "VALID" || run.status !== "SUCCEEDED") throw new Error("Fresh temporal fixture Run is not valid");
    const evidenceSource = await withTenant(tenantId, async (db) => (await db.execute<{ evidence_source_id: string }>(sql`SELECT evidence_source_id::text FROM finnor_os.pe_evidence_links WHERE tenant_id=${tenantId}::uuid AND deal_id=${dealId}::uuid ORDER BY created_at LIMIT 1`)).rows[0]);
    if (!evidenceSource) throw new Error("Atlas Evidence source missing");
    const evidence = await appendEvidenceVersion(tenantId, evidenceSource.evidence_source_id, { content: "Authored temporal certification update: the customer cohort revision is available for comparison. This controlled record does not assert a production customer fact or a causal change to the model.", snapshot: { fixture: "centropy-temporal-change-v1", conclusion: "new evidence; model causality unrepresented" }, asOf: new Date(), retrievedAt: new Date() });
    await attachCanonicalEvidence(ctx, { dealId, entity: { entityType: "pe_assumption", entityId: "90000000-0000-4000-8000-000000000004" }, evidenceSourceId: evidence.sourceId, evidenceVersionId: evidence.versionId, relationship: "supports" });
    const actor = { tenantId, userId: owner.id, role: "owner" as const };
    const current = await getIcWorkspace(ctx, { icCaseId: caseId });
    const memo = current.memo?.underwritingRunId === fresh.id
      ? { documentId: String(current.memo.documentId), version: { id: String(current.memo.documentVersionId) } }
      : await ingestArtifact(actor, { title: "Atlas current temporal comparison memo.docx", bytes: groundedMemoBytes("Atlas controlled temporal comparison", [{ heading: "Recorded underwriting basis", paragraphs: [{ text: `The selected sensitivity uses the recorded 300bps growth reduction and 9x exit assumption. Run ${fresh.id} is valid. The evidence-to-model causal edge is not represented.`, sourceRefs: [`underwriting_run:${fresh.id}`] }] }, { heading: "New evidence", paragraphs: [{ text: "A new authored cohort evidence version is recorded for this comparison; its meaning is limited to this controlled fixture.", sourceRefs: [`evidence_version:${evidence.versionId}`] }] }]), origin: "manual_upload", sourceSystem: "certification:authored-temporal-change" });
    await attachCanonicalDocument(ctx, { dealId, entity: { entityType: "pe_ic_case", entityId: caseId }, documentId: memo.documentId, linkRole: "source" });
    let workspace = await getIcWorkspace(ctx, { icCaseId: caseId });
    await selectPrimaryIcUnderwritingRun(ctx, { icCaseId: caseId, expectedCaseVersion: Number(workspace.case.version), underwritingRunId: fresh.id });
    workspace = await getIcWorkspace(ctx, { icCaseId: caseId });
    const selected = workspace.memo?.documentVersionId === memo.version.id && workspace.memo.underwritingRunId === fresh.id
      ? { memo: workspace.memo }
      : await selectIcMemoVersion(ctx, { icCaseId: caseId, expectedCaseVersion: Number(workspace.case.version), artifactRole: "MEMO", documentId: memo.documentId, documentVersionId: memo.version.id, underwritingRunId: fresh.id, evidenceCutoffAt: new Date().toISOString(), sourceCompleteness: "COMPLETE", changeClassification: "MATERIAL", idempotencyKey: "centropy-temporal-current-memo-v1" });
    workspace = await getIcWorkspace(ctx, { icCaseId: caseId });
    const recommendation = await createIcRecommendation(ctx, { icCaseId: caseId, expectedCaseVersion: Number(workspace.case.version), outcome: "CONTINUE_DILIGENCE", rationale: "Continue diligence. The recorded recommendation outcome is unchanged; its selected model sensitivity and sourced memo basis changed. This controlled comparison makes no evidence-to-model causal assertion.", memoId: String(selected.memo.id), underwritingRunId: fresh.id, idempotencyKey: "centropy-temporal-current-recommendation-v1" });
    const proof = { schema: "centropy.current-temporal-fixture/v1", fixture: "atlas-temporal-clone", sourceFixture: baseline.sourceFixture, recordedAt: new Date().toISOString(), dealId, caseId, baselineRecommendationId: before.currentRecommendation?.id, currentRecommendationId: recommendation.recommendation.id, baselineRunId: baselineRun.id, currentRunId: fresh.id, baselineRunHash: baselineRun.resultHash, currentRunHash: run.resultHash, baselineMemoId: before.memo?.id, currentMemoId: selected.memo.id, currentMemoDocumentId: memo.documentId, currentMemoVersionId: memo.version.id, evidenceSourceId: evidence.sourceId, evidenceVersionId: evidence.versionId, evidenceContentHash: evidence.contentHash, providerEffect: "none", missingCausalEdge: "evidence-to-model", mutations: ["createUnderwritingRun", "appendEvidenceVersion", "attachCanonicalEvidence", "ingestArtifact", "attachCanonicalDocument", "selectPrimaryIcUnderwritingRun", "selectIcMemoVersion", "createIcRecommendation"], fixtureOnly: true };
    await writeFile(resolve(stateDir, "temporal-change.json"), JSON.stringify(proof, null, 2) + "\n");
    console.log(JSON.stringify(proof));
  } finally { await closePool(); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
