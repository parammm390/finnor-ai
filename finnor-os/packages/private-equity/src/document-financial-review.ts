import { createHash } from "node:crypto";
import { loadArtifactIRSnapshot } from "@finnor/artifacts";
import { loadDocumentVersion } from "@finnor/data-platform";
import { withTenantTransaction } from "@finnor/db";
import type { SemanticIR } from "@finnor/ooxml";
import type { DocumentForecastSelection, FinancialDocumentReviewRoot, ReviewedFinancialDocuments } from "@finnor/shared-types";
import { authorize, principal, unavailable } from "./owner-context";
import { parseRegisteredFinancialDocument } from "./evidence-execution/documents-parser";
import { exactBinary, exactCompare } from "./evidence-execution/exact";
import { readPdfForecast } from "./evidence-execution/pdf-forecast";
import type { PeMutationContext } from "./types";

const MAX_DOCUMENTS = 6;
const MAX_DOCUMENT_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 4_000_000;
const MAX_ROWS_PER_DOCUMENT = 100;

interface CatalogEntry {
  id: string;
  title: string;
  versionId: string | null;
  format: string | null;
  origin: string | null;
  sha256: string | null;
  size: number | null;
  currentVersionBound: boolean;
}

function currentDocumentCut(ctx: PeMutationContext, root: FinancialDocumentReviewRoot, includeBytes: boolean, committeeCaseId: string | null, forecastTitle?: string) {
  const tenant = ctx.auth.tenantId;
  return withTenantTransaction(tenant, { userId: principal(ctx), isolation: "repeatable read", readOnly: true }, async (db, client) => {
    await authorize(ctx, root, committeeCaseId ? [{ type: "pe_ic_case", id: committeeCaseId }] : [], [], client);
    const company = root.entityType === "pe_deal"
      ? await client.query<{ id: string; name: string }>("SELECT target_organization_id::text AS id, name FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2", [tenant, root.entityId])
      : await client.query<{ id: string; name: string }>("SELECT id::text, name FROM finnor_os.external_organizations WHERE tenant_id=$1 AND id=$2", [tenant, root.entityId]);
    const target = company.rows[0];
    if (!target) throw unavailable();
    const { id: companyId, name: scopeName } = target;
    const subject = { entityType: "external_organization", entityId: companyId } as const;
    const catalog = (await client.query<CatalogEntry>(`
      WITH committee_documents AS (
        SELECT DISTINCT document_id
        FROM finnor_os.pe_document_links
        WHERE tenant_id=$1 AND deal_id=$3 AND entity_type='pe_ic_case' AND entity_id=$6::uuid
          AND link_role='governing' AND archived_at IS NULL
      ), bindings AS (
        SELECT DISTINCT bound.document_id, binding.version_id
        FROM finnor_os.artifact_bindings binding
        JOIN finnor_os.document_versions bound
          ON bound.tenant_id=binding.tenant_id AND bound.id=binding.version_id
        WHERE binding.tenant_id=$1 AND binding.target_kind='canonical_entity'
          AND (($6::uuid IS NULL AND ((binding.target_entity_type=$2 AND binding.target_id=$3)
            OR (binding.target_entity_type='external_organization' AND binding.target_id=$4)))
            OR ($6::uuid IS NOT NULL AND binding.target_entity_type='pe_ic_case' AND binding.target_id=$6
              AND bound.document_id IN (SELECT document_id FROM committee_documents)))
      )
      SELECT document.id::text, document.title, version.id::text AS "versionId",
        version.format, version.origin, version.byte_sha256 AS sha256, version.size_bytes::int AS size,
        EXISTS(SELECT 1 FROM bindings WHERE document_id=document.id AND version_id=version.id) AS "currentVersionBound"
      FROM (SELECT document_id FROM bindings UNION SELECT document_id FROM committee_documents) linked
      JOIN finnor_os.documents document ON document.tenant_id=$1 AND document.id=linked.document_id
      LEFT JOIN finnor_os.document_version_heads head ON head.tenant_id=$1 AND head.document_id=document.id
        AND head.kind='current' AND head.head_key='default'
      LEFT JOIN finnor_os.document_versions version ON version.tenant_id=$1 AND version.id=head.version_id
        AND version.document_id=document.id
      WHERE document.archived_at IS NULL
      ORDER BY document.id LIMIT $5
    `, [tenant, root.entityType, root.entityId, companyId, MAX_DOCUMENTS + 1, committeeCaseId])).rows;
    await authorize(ctx, subject, catalog.map(row => ({ type: "document", id: row.id })), [], client);
    const files: Array<{
      id: string; title: string; versionId: string; sha256: string; format: "xlsx" | "pdf"; bytes: Buffer; ir?: SemanticIR;
    }> = [];
    const gaps = new Set<string>();
    let remainingBytes = MAX_TOTAL_BYTES;
    if (!catalog.length) gaps.add("No current financial source documents were found for this scope.");
    if (catalog.length > MAX_DOCUMENTS) gaps.add("The review could not inspect the full set of bound documents within its limit.");
    if (!includeBytes) return { subject, scopeName, catalog, files, gaps };
    for (const source of catalog.slice(0, MAX_DOCUMENTS)) {
      if (forecastTitle !== undefined && (source.title !== forecastTitle || source.format !== "pdf")) continue;
      if (!source.versionId || !source.currentVersionBound) {
        gaps.add("Some bound documents have no current version linked to this scope.");
        continue;
      }
      if (source.origin !== "manual_upload" || (source.format !== "xlsx" && source.format !== "pdf")) {
        gaps.add("Some bound documents fall outside the supported uploaded workbook and text PDF profile.");
        continue;
      }
      if (!source.sha256 || !source.size || source.size > MAX_DOCUMENT_BYTES || source.size > remainingBytes) {
        gaps.add("Some document bytes exceed the review limit or are unavailable.");
        continue;
      }
      const loaded = await loadDocumentVersion(db, tenant, source.id, source.versionId);
      if (!loaded || loaded.bytes.length !== source.size) {
        gaps.add("Some current document bytes are unavailable.");
        continue;
      }
      remainingBytes -= source.size;
      const snapshot = forecastTitle === undefined ? null : await loadArtifactIRSnapshot(db, tenant, source.versionId);
      files.push({ id: source.id, title: source.title, versionId: source.versionId, sha256: source.sha256,
        format: source.format, bytes: loaded.bytes, ...(snapshot ? { ir: snapshot.ir } : {}) });
    }
    return { subject, scopeName, catalog, files, gaps };
  });
}

type Finding = ReviewedFinancialDocuments["findings"][number];
type SourceAssertion = Finding["assertions"][number];
type ComparisonKey = Omit<Finding, "spread" | "assertions">;

export async function reviewFinancialDocuments(
  ctx: PeMutationContext,
  root: FinancialDocumentReviewRoot,
  signal?: AbortSignal,
  committeeCaseId: string | null = null,
  forecast?: DocumentForecastSelection,
) {
  signal?.throwIfAborted();
  const cut = await currentDocumentCut(ctx, root, true, committeeCaseId, forecast?.title);
  const review = forecast ? reviewForecast(cut, forecast) : await reviewRegisteredFinancialTables(cut, signal);
  signal?.throwIfAborted();
  const current = await currentDocumentCut(ctx, root, false, committeeCaseId);
  const membership = JSON.stringify({ subject: cut.subject, catalog: cut.catalog });
  if (membership !== JSON.stringify({ subject: current.subject, catalog: current.catalog })) throw unavailable();
  const digest = createHash("sha256").update(membership).update(JSON.stringify(review)).digest("hex");
  return { review, digest, scopeName: current.scopeName };
}

type DocumentCut = Awaited<ReturnType<typeof currentDocumentCut>>;

function reviewForecast(cut: DocumentCut, selection: DocumentForecastSelection): ReviewedFinancialDocuments {
  const review: ReviewedFinancialDocuments = {
    status: "reviewed", coverage: "partial", documentsReviewed: 0, comparableGroups: 0, findings: [], gaps: [...cut.gaps],
  };
  const [file] = cut.files;
  const matchingDocuments = cut.catalog.filter(entry => entry.format === "pdf" && entry.title === selection.title);
  if (matchingDocuments.length !== 1 || !file) {
    review.gaps.push("Select one current, bound PDF by its exact title.");
    return review;
  }
  const ir = file.ir;
  if (ir?.schema !== "pdf-ir.v1" || ir.opaqueParts.pdf !== file.sha256
    || createHash("sha256").update(file.bytes).digest("hex") !== file.sha256) {
    review.gaps.push("The selected PDF has no verified text snapshot for the current version.");
    return review;
  }

  const [first, second] = selection.pages.map(page => readPdfForecast(ir, page, selection.year));
  review.gaps.push("Coverage is limited to the selected forecast tables and their definition footnotes.");
  if (!first || !second || first.vintage === second.vintage) {
    review.gaps.push("The two pages must show distinct forecast vintages with the same Adjusted EBITDA definition and fiscal year.");
    return review;
  }
  review.documentsReviewed = 1;
  if (first.definition !== second.definition) {
    review.gaps.push(`Adjusted EBITDA definition footnotes differ on PDF pages ${selection.pages.join(" and ")}.`);
    return review;
  }

  const sorted = exactCompare(first.value, second.value) <= 0 ? [first, second] as const : [second, first] as const;
  const toAssertion = ({ value, anchor, vintage }: NonNullable<typeof first>) => ({
    value, source: { documentId: file.id, versionId: file.versionId, sha256: file.sha256, title: file.title, vintage, anchor },
  });
  review.comparableGroups = 1;
  review.forecast = {
    year: selection.year, currency: selection.dollarCurrency, definition: first.definition,
    assertions: [toAssertion(sorted[0]), toAssertion(sorted[1])],
  };
  return review;
}

async function reviewRegisteredFinancialTables(cut: DocumentCut, signal?: AbortSignal): Promise<ReviewedFinancialDocuments> {
  const groups = new Map<string, { key: ComparisonKey; assertions: SourceAssertion[] }>();
  let documentsReviewed = 0;
  for (const file of cut.files) {
    signal?.throwIfAborted();
    let extraction: Awaited<ReturnType<typeof parseRegisteredFinancialDocument>>;
    try {
      extraction = await parseRegisteredFinancialDocument({
        bytes: file.bytes, digest: file.sha256, version: file.versionId, documentId: file.id, subject: cut.subject, format: file.format,
      });
    } catch {
      cut.gaps.add("Some documents do not have a readable registered financial table.");
      continue;
    }
    if (extraction.reasons.length || extraction.rows.length > MAX_ROWS_PER_DOCUMENT
      || extraction.rows.some(row => row.value.length > 128 || row.metricKey.length > 120
        || (row.semantics.unit === "currency" && !row.semantics.currencyCode))) {
      cut.gaps.add("Some financial tables are incomplete, exceed the review limit, or contain unverified values.");
      continue;
    }
    documentsReviewed++;
    const witnesses = new Map(extraction.witnesses.map(witness => [witness.id, witness]));
    for (const row of extraction.rows) {
      const witness = witnesses.get(row.witnessIds[0] ?? "");
      const anchor = witness?.anchor;
      const location = anchor?.sheet && anchor.cell ? { sheet: anchor.sheet, cell: anchor.cell }
        : anchor?.page && anchor.quote ? { page: anchor.page, quote: anchor.quote } : null;
      if (!location) throw new Error("Financial source anchor unavailable");
      const { periodStart, periodEnd, currencyCode, unit, frequency, calendar, consolidation, instrument } = row.semantics;
      const key = { metric: row.metricKey.trim(), periodStart, periodEnd, currency: currencyCode, unit, frequency, calendar, consolidation, instrument };
      const index = JSON.stringify({ ...key, metric: key.metric.toLowerCase() });
      const group = groups.get(index) ?? { key, assertions: [] };
      group.assertions.push({
        value: row.value, source: { documentId: file.id, versionId: file.versionId, sha256: file.sha256, title: file.title, anchor: location },
      });
      groups.set(index, group);
    }
  }
  signal?.throwIfAborted();
  const findings: Finding[] = [];
  let comparableGroups = 0;
  for (const { key, assertions } of groups.values()) {
    if (new Set(assertions.map(assertion => assertion.source.documentId)).size < 2) continue;
    comparableGroups++;
    assertions.sort((left, right) => exactCompare(left.value, right.value));
    const low = assertions[0], high = assertions.at(-1);
    if (low && high && low.value !== high.value) {
      findings.push({ ...key, spread: exactBinary("subtract", high.value, low.value), assertions });
    }
  }
  findings.sort((left, right) => left.metric.localeCompare(right.metric) || right.periodEnd.localeCompare(left.periodEnd));
  return {
    status: "reviewed", coverage: cut.gaps.size ? "partial" : "registered_sources", documentsReviewed,
    comparableGroups, gaps: [...cut.gaps], findings,
  };
}
