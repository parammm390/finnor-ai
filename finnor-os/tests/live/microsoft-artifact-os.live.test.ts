import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closePool, withTenant } from "@finnor/db";
import {
  MicrosoftDelegatedExcelTransport,
  MicrosoftDriveArtifactTransport,
  MicrosoftGraphClient,
  MicrosoftGraphError,
} from "@finnor/provider-microsoft365";
import { resolveMicrosoftDelegatedAuthContext, resolveMicrosoftProviderAuthContext } from "@finnor/security";
import { syncSource } from "../../apps/worker/src/handlers/sync-source";

const enabled = process.env.P3_OFFICE_LIVE_CERTIFICATION === "1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for opt-in P3 live Office certification`);
  return value;
}

/**
 * This gate is deliberately opt-in and mutates only the explicitly designated
 * Microsoft test workbook. It replaces that item with its own exact bytes, proves
 * stale If-Match rejection, performs delegated Excel calculation/readback, and
 * waits for the existing P2 delta engine to converge on the new provider eTag.
 */
describe.skipIf(!enabled)("P3 live Microsoft Artifact OS certification", () => {
  afterAll(async () => {
    await closePool();
  });

  it("proves real app-only round-trip, provider versions, delegated Excel, conflict, and P2 convergence", async () => {
    const tenantId = required("P3_OFFICE_LIVE_TENANT_ID");
    const integrationId = required("P3_OFFICE_LIVE_INTEGRATION_ID");
    const sourceScopeId = required("P3_OFFICE_LIVE_SOURCE_SCOPE_ID");
    const delegatedPrincipalId = required("P3_OFFICE_LIVE_DELEGATED_PRINCIPAL_ID");
    const driveId = required("P3_OFFICE_LIVE_DRIVE_ID");
    const itemId = required("P3_OFFICE_LIVE_ITEM_ID");
    const worksheetId = required("P3_OFFICE_LIVE_WORKSHEET_ID");
    const range = required("P3_OFFICE_LIVE_RANGE");
    for (const value of [tenantId, integrationId, sourceScopeId, delegatedPrincipalId]) expect(UUID.test(value)).toBe(true);

    const appAuth = await resolveMicrosoftProviderAuthContext({ tenantId, integrationId });
    const appTransport = new MicrosoftDriveArtifactTransport(new MicrosoftGraphClient(appAuth), "app_only");
    const initial = await appTransport.download({ driveId, itemId });
    expect(initial.bytes.length).toBeGreaterThan(0);
    expect(initial.bytes.length).toBe(initial.metadata.size);
    expect(initial.metadata.sensitivityLabelPresent).toBe(false);

    const versions = await appTransport.listVersions({ driveId, itemId }, 20);
    expect(versions.length).toBeGreaterThan(0);
    const providerVersion = await appTransport.downloadVersion({ driveId, itemId }, versions[0]!.id);
    expect(providerVersion.length).toBeGreaterThan(0);

    const acknowledged = await appTransport.replaceConditional({
      driveId,
      itemId,
      bytes: initial.bytes,
      expectedETag: initial.metadata.eTag,
    });
    expect(acknowledged.id).toBe(itemId);
    expect(acknowledged.eTag).not.toBe(initial.metadata.eTag);
    const readback = await appTransport.download({ driveId, itemId });
    expect(digest(readback.bytes)).toBe(digest(initial.bytes));
    expect(readback.metadata.eTag).toBe(acknowledged.eTag);

    await expect(appTransport.replaceConditional({
      driveId,
      itemId,
      bytes: initial.bytes,
      expectedETag: initial.metadata.eTag,
    })).rejects.toEqual(expect.objectContaining<Partial<MicrosoftGraphError>>({ kind: "conflict", status: 412 }));

    const delegatedAuth = await resolveMicrosoftDelegatedAuthContext({ tenantId, principalId: delegatedPrincipalId });
    const excel = new MicrosoftDelegatedExcelTransport(new MicrosoftGraphClient(delegatedAuth));
    const sessionId = await excel.createSession(driveId, itemId, true);
    let output: Record<string, unknown>;
    try {
      await excel.calculate(driveId, itemId, sessionId, "FullRebuild");
      output = await excel.readRange(driveId, itemId, worksheetId, range, sessionId);
    } finally {
      await excel.closeSession(driveId, itemId, sessionId);
    }
    expect(output!).toMatchObject({ values: expect.any(Array) });

    const externalId = `${driveId}/${itemId}`;
    let convergedCount = 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await syncSource({
        tenantId,
        integrationId,
        sourceScopeId,
        scope: `p3-office-live:${sourceScopeId}`,
        _correlationId: randomUUID(),
      });
      convergedCount = await withTenant(tenantId, (db) => db.execute<{ count: number }>(sql`
        SELECT count(*)::int count
          FROM finnor_os.external_ref_observations
         WHERE tenant_id=${tenantId}::uuid AND integration_id=${integrationId}::uuid
           AND source_scope_id=${sourceScopeId}::uuid AND external_id=${externalId}
           AND provider_version=${acknowledged.eTag}
      `).then((result) => Number(result.rows[0]?.count ?? 0)));
      if (convergedCount > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(convergedCount).toBe(1);
    await syncSource({
      tenantId,
      integrationId,
      sourceScopeId,
      scope: `p3-office-live:${sourceScopeId}`,
      _correlationId: randomUUID(),
    });
    const replayCount = await withTenant(tenantId, (db) => db.execute<{ count: number }>(sql`
      SELECT count(*)::int count
        FROM finnor_os.external_ref_observations
       WHERE tenant_id=${tenantId}::uuid AND integration_id=${integrationId}::uuid
         AND source_scope_id=${sourceScopeId}::uuid AND external_id=${externalId}
         AND provider_version=${acknowledged.eTag}
    `).then((result) => Number(result.rows[0]?.count ?? 0)));
    expect(replayCount).toBe(1);
  }, 300_000);
});
