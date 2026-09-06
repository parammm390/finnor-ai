// Retrieval-based soft context for active Core/Private Equity planning.

import { scanFindings, withTenant } from "@finnor/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { PatternContext, ScanSignal } from "@finnor/shared-types";

async function scanSignalsPattern(tenantId: string): Promise<ScanSignal[]> {
  return withTenant(tenantId, async (db) => {
    const rows = await db
      .select({
        scanType: scanFindings.scanType,
        severity: scanFindings.severity,
        summary: scanFindings.summary,
        createdAt: scanFindings.createdAt,
      })
      .from(scanFindings)
      .where(and(eq(scanFindings.tenantId, tenantId), isNull(scanFindings.digestedAt)))
      .orderBy(desc(scanFindings.createdAt))
      .limit(10);
    const now = Date.now();
    return rows.map((row) => ({
      scanType: row.scanType,
      severity: row.severity as ScanSignal["severity"],
      summary: row.summary,
      ageHours: (now - row.createdAt.getTime()) / 3_600_000,
    }));
  });
}

export async function buildPatternContext(tenantId: string): Promise<PatternContext> {
  return { scanSignals: await scanSignalsPattern(tenantId) };
}
