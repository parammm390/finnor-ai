import { z } from "zod";

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const FinancialDocumentReviewRootSchema = z.object({
  entityType: z.enum(["pe_deal", "external_organization"]),
  entityId: z.string().uuid(),
}).strict();
export type FinancialDocumentReviewRoot = z.infer<typeof FinancialDocumentReviewRootSchema>;

const Multiple = z.string().regex(/^\d{1,3}(?:\.\d{1,4})?$/)
  .refine(value => Number(value) > 0 && Number(value) <= 100);
const Magnitude = z.string().regex(/^[+-]?\d{1,12}(?:\.\d{1,4})?$/);
const Scale = z.enum(["1", "1000", "1000000", "1000000000"]);
const Currency = z.string().regex(/^[A-Z]{3}$/);
const PdfPage = z.number().int().min(1).max(1000);
const ForecastYear = z.number().int().min(2000).max(2099);
export const DocumentForecastSelectionSchema = z.object({
  title: z.string().trim().min(1).max(240),
  pages: z.tuple([PdfPage, PdfPage]).refine(([first, second]) => first !== second),
  year: ForecastYear,
  dollarCurrency: Currency,
}).strict();
export type DocumentForecastSelection = z.infer<typeof DocumentForecastSelectionSchema>;

export const DocumentValuationAssumptionsSchema = z.object({
  entryMultiple: Multiple,
  periodEnd: z.iso.date().optional(),
  forecast: DocumentForecastSelectionSchema.optional(),
  funding: z.object({
    currency: Currency,
    netDebt: z.object({ magnitude: Magnitude, scale: Scale }).strict(),
    fees: z.object({ magnitude: Magnitude.refine(value => !value.startsWith("-")), scale: Scale }).strict(),
  }).strict().optional(),
}).strict().refine(input => !input.forecast || (!input.periodEnd && !input.funding));
export type DocumentValuationAssumptions = z.infer<typeof DocumentValuationAssumptionsSchema>;

export const FinancialDocumentReviewReceiptSchema = z.object({
  version: z.literal(1),
  root: FinancialDocumentReviewRootSchema,
  digest: Sha256,
  valuation: DocumentValuationAssumptionsSchema.optional(),
}).strict();
export type FinancialDocumentReviewReceipt = z.infer<typeof FinancialDocumentReviewReceiptSchema>;

const DocumentSource = z.object({
  documentId: z.string().uuid(),
  versionId: z.string().uuid(),
  sha256: Sha256,
  title: z.string(),
  vintage: z.string().optional(),
  anchor: z.union([
    z.object({ sheet: z.string(), cell: z.string() }).strict(),
    z.object({ page: z.number().int().positive(), quote: z.string() }).strict(),
  ]),
}).strict();

const Assertion = z.object({
  value: z.string(),
  source: DocumentSource,
}).strict();

const ExactAmount = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const ForecastBasis = z.object({ year: ForecastYear, definition: z.string() }).strict();
const ForecastComparison = ForecastBasis.extend({
  currency: Currency,
  assertions: z.tuple([Assertion, Assertion]),
}).strict();
const ValuationNeedsInput = z.object({ status: z.literal("requires_input"), reason: z.string() }).strict();
const ValuationAmounts = z.object({
  status: z.literal("calculated"),
  scopeName: z.string(),
  entryMultiple: Multiple,
  currency: Currency,
  enterpriseValueSpread: ExactAmount,
  funding: z.discriminatedUnion("status", [
    ValuationNeedsInput,
    z.object({ status: z.literal("calculated"), netDebt: ExactAmount, fees: ExactAmount }).strict(),
  ]),
  cases: z.array(z.object({
    ebitda: ExactAmount,
    enterpriseValue: ExactAmount,
    source: DocumentSource,
    funding: z.object({ equityPrice: ExactAmount, sponsorCash: ExactAmount }).strict().nullable(),
  }).strict()).min(2),
}).strict();
const CalculatedDocumentValuation = z.union([
  ValuationAmounts.extend({
    periodStart: z.string().datetime({ offset: true }),
    periodEnd: z.string().datetime({ offset: true }),
    consolidation: z.string(),
    calendar: z.string(),
    instrument: z.string(),
  }).strict(),
  ValuationAmounts.extend({ forecast: ForecastBasis }).strict(),
]);
const DocumentValuation = z.union([CalculatedDocumentValuation, ValuationNeedsInput]);
export type DocumentValuation = z.infer<typeof DocumentValuation>;
export type CheckedDocumentValuation = z.infer<typeof CalculatedDocumentValuation>;

export const FinancialDocumentReviewSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("reviewed"),
    coverage: z.enum(["registered_sources", "partial"]),
    documentsReviewed: z.number().int().nonnegative(),
    comparableGroups: z.number().int().nonnegative(),
    gaps: z.array(z.string()),
    forecast: ForecastComparison.optional(),
    valuation: DocumentValuation.optional(),
    findings: z.array(z.object({
      metric: z.string(),
      periodStart: z.string().datetime({ offset: true }),
      periodEnd: z.string().datetime({ offset: true }),
      currency: z.string().nullable(),
      unit: z.string(),
      frequency: z.string(),
      calendar: z.string(),
      consolidation: z.string(),
      instrument: z.string(),
      spread: z.string(),
      assertions: z.array(Assertion).min(2),
    }).strict()),
  }).strict(),
  z.object({ status: z.literal("stale") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
]);
export type FinancialDocumentReview = z.infer<typeof FinancialDocumentReviewSchema>;
export type ReviewedFinancialDocuments = Extract<FinancialDocumentReview, { status: "reviewed" }>;

export function formatDocumentAmount(value: string, unit: string) {
  const [whole, decimals] = value.split(".");
  return `${unit} ${whole?.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${decimals ? "." + decimals : ""}`;
}

export function documentSourceLocation(anchor: z.infer<typeof DocumentSource>["anchor"]) {
  return "cell" in anchor ? `${anchor.sheet}!${anchor.cell}` : `page ${anchor.page}`;
}
