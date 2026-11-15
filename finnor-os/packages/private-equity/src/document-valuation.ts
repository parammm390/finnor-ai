import {
  documentSourceLocation, formatDocumentAmount,
  type CheckedDocumentValuation, type DocumentValuation, type DocumentValuationAssumptions, type ReviewedFinancialDocuments,
} from "@finnor/shared-types";
import { canonicalExact, exactBinary, exactCompare } from "./evidence-execution/exact";

function valueCases(assertions: ReviewedFinancialDocuments["findings"][number]["assertions"], multiple: string): CheckedDocumentValuation["cases"] {
  return assertions.map(({ value, source }) => ({
    ebitda: value, enterpriseValue: exactBinary("multiply", value, multiple), source, funding: null,
  }));
}

export function assessDocumentValuation(review: ReviewedFinancialDocuments, assumptions: DocumentValuationAssumptions, scopeName: string): DocumentValuation {
  const entryMultiple = canonicalExact(assumptions.entryMultiple);
  if (assumptions.forecast) {
    const forecast = review.forecast;
    if (!forecast) {
      return { status: "requires_input", reason: "Select two forecast pages with the same Adjusted EBITDA definition and fiscal year in a current bound PDF." };
    }
    const [low, high] = forecast.assertions;
    if (exactCompare(low.value, "0") <= 0 || exactCompare(high.value, "0") <= 0) {
      return { status: "requires_input", reason: "Both forecasts need positive Adjusted EBITDA for a comparable multiple sensitivity." };
    }
    const spread = exactBinary("subtract", high.value, low.value);
    return {
      status: "calculated", scopeName, entryMultiple, currency: forecast.currency,
      forecast: { year: forecast.year, definition: forecast.definition },
      enterpriseValueSpread: exactBinary("multiply", spread, entryMultiple),
      cases: valueCases(forecast.assertions, entryMultiple),
      funding: { status: "requires_input", reason: "Equity price and sponsor cash require a separate financing basis." },
    };
  }

  const eligible = review.findings.filter(finding => finding.metric.toUpperCase() === "EBITDA"
    && finding.frequency === "annual" && finding.unit === "currency"
    && (!assumptions.periodEnd || finding.periodEnd.slice(0, 10) === assumptions.periodEnd));
  const [finding] = eligible;
  if (!finding || !finding.currency) {
    return { status: "requires_input", reason: "The review found no conflicting annual EBITDA assertions on a comparable currency and accounting basis for the requested period." };
  }
  if (eligible.length !== 1) {
    return { status: "requires_input", reason: "More than one annual EBITDA basis is disputed. Specify the year-end date or narrow the source scope to one accounting basis." };
  }
  if (finding.assertions.some(assertion => exactCompare(assertion.value, "0") <= 0)) {
    return { status: "requires_input", reason: "At least one reported EBITDA is zero or negative. An EBITDA multiple does not provide a comparable entry valuation for these assertions." };
  }

  const currency = finding.currency;
  const cases = valueCases(finding.assertions, entryMultiple);
  let funding: CheckedDocumentValuation["funding"];
  if (!assumptions.funding) {
    funding = { status: "requires_input", reason: "Equity price and sponsor cash require explicit net debt, transaction fees and confirmation of all-sponsor equity funding with no rollover or other funding." };
  } else if (assumptions.funding.currency !== currency) {
    funding = { status: "requires_input", reason: "The financing assumptions use a different currency from EBITDA. Supply net debt and fees in the source currency." };
  } else {
    const { netDebt: debtInput, fees: feeInput } = assumptions.funding;
    const netDebt = exactBinary("multiply", debtInput.magnitude, debtInput.scale);
    const fees = exactBinary("multiply", feeInput.magnitude, feeInput.scale);
    const equityPrices = cases.map(item => exactBinary("subtract", item.enterpriseValue, netDebt));
    if (equityPrices.some(value => exactCompare(value, "0") < 0)) {
      funding = { status: "requires_input", reason: "At least one scenario implies a negative equity price. Confirm the transaction adjustments and funding treatment before estimating sponsor cash." };
    } else {
      for (const [index, item] of cases.entries()) {
        const equityPrice = equityPrices[index]!;
        item.funding = { equityPrice, sponsorCash: exactBinary("add", equityPrice, fees) };
      }
      funding = { status: "calculated", netDebt, fees };
    }
  }
  return { status: "calculated", scopeName, entryMultiple, currency, periodStart: finding.periodStart, periodEnd: finding.periodEnd,
    consolidation: finding.consolidation, calendar: finding.calendar, instrument: finding.instrument,
    enterpriseValueSpread: exactBinary("multiply", finding.spread, entryMultiple), funding, cases };
}

function markdownText(value: string) {
  return value.replace(/[\s\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/[\\|`*_\[\]<>#~]/g, "\\$&");
}

export function renderValuationDiligenceBrief(input: { valuation: CheckedDocumentValuation; review: ReviewedFinancialDocuments; asOf: string }) {
  const { valuation, review, asOf } = input;
  if ("forecast" in valuation) return renderForecastDiligenceBrief(valuation, review, asOf);
  const amount = (value: string) => formatDocumentAmount(value, valuation.currency);
  const funding = valuation.funding;
  const basis = [
    `Annual EBITDA for ${valuation.periodStart.slice(0, 10)} to ${valuation.periodEnd.slice(0, 10)}.`,
    `Accounting basis — ${markdownText(valuation.consolidation.replaceAll("_", " ").toLowerCase())}, ${markdownText(valuation.calendar.replaceAll("_", " ").toLowerCase())}, instrument ${markdownText(valuation.instrument)}.`,
    `Enterprise value = reported EBITDA × ${valuation.entryMultiple}.`,
    funding.status === "calculated"
      ? `Equity price = enterprise value less ${amount(funding.netDebt)} net debt. Sponsor cash = equity price plus ${amount(funding.fees)} fees. All equity is funded by the sponsor with no rollover or other funding.`
      : funding.reason,
  ];
  return [
    "# Valuation diligence brief", "", `Scope — ${markdownText(valuation.scopeName)}`, "", `Review recorded on ${asOf.slice(0, 10)}.`, "",
    "## Decision in front of the team", "",
    `The unresolved EBITDA basis moves implied enterprise value by **${amount(valuation.enterpriseValueSpread)}** at the supplied ${valuation.entryMultiple}× multiple.`,
    "Keep both cases open pending reconciliation of the earnings basis. These scenarios are conditional and do not establish a purchase price or an investment decision.", "",
    "## Entry scenarios", "",
    "| Source | Reported EBITDA | Implied enterprise value | Equity price | Sponsor cash |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...valuation.cases.map(({ source, ebitda, enterpriseValue, funding: row }) =>
      `| ${markdownText(source.title)} · ${markdownText(documentSourceLocation(source.anchor))} | ${amount(ebitda)} | ${amount(enterpriseValue)} | ${row ? amount(row.equityPrice) : "Pending"} | ${row ? amount(row.sponsorCash) : "Pending"} |`),
    "", "## Assumptions and calculation", "", ...basis.map(item => `- ${item}`),
    "", "## Evidence needed to close the difference", "",
    "1. Confirm that the reports cover the same company, period and accounting basis.",
    "2. Obtain a line-by-line bridge between the two EBITDA figures. Tie each adjustment to the underlying ledger or supporting schedule and record who confirmed it.",
    "3. Recalculate valuation using the reconciled basis. Confirm debt, fees and funding against the current funds flow before relying on sponsor cash.",
    "", "## Source record", "",
    ...valuation.cases.flatMap(({ source }) => [
      `- ${markdownText(source.title)} · ${markdownText(documentSourceLocation(source.anchor))}`,
      `  - Document \`${source.documentId}\`, version \`${source.versionId}\``,
      `  - SHA-256 \`${source.sha256}\``,
    ]),
    "", "## Coverage", "",
    `Reviewed ${review.documentsReviewed} readable documents in the registered financial table profile.`,
    ...review.gaps.map(gap => `- ${markdownText(gap)}`), "",
  ].join("\n");
}

function renderForecastDiligenceBrief(
  valuation: Extract<CheckedDocumentValuation, { forecast: unknown }>, review: ReviewedFinancialDocuments, asOf: string,
) {
  const amount = (value: string) => formatDocumentAmount(value, valuation.currency);
  return [
    "# Valuation diligence brief", "",
    `Scope — ${markdownText(valuation.scopeName)} · FY${valuation.forecast.year} management forecasts`, "",
    `Review recorded on ${asOf.slice(0, 10)}.`, "",
    "## Forecast sensitivity", "",
    `The selected forecast vintages imply a **${amount(valuation.enterpriseValueSpread)}** difference in enterprise value at ${valuation.entryMultiple}×.`,
    "These sensitivities use forecasts and a supplied multiple. A purchase price, financing decision or investment recommendation requires separate analysis.", "",
    "| Forecast vintage and location | Forecast Adjusted EBITDA | Implied enterprise value |",
    "| --- | ---: | ---: |",
    ...valuation.cases.map(({ source, ebitda, enterpriseValue }) =>
      `| ${markdownText(source.vintage ?? source.title)} · ${documentSourceLocation(source.anchor)} | ${amount(ebitda)} | ${amount(enterpriseValue)} |`),
    "", "## Basis and calculation", "",
    `- ${markdownText(valuation.forecast.definition)}`,
    `- The filing uses dollar signs. The request treats them as ${valuation.currency}.`,
    `- Implied enterprise value = forecast Adjusted EBITDA × ${valuation.entryMultiple}.`,
    "", "## Evidence needed before underwriting", "",
    "1. Obtain a bridge between the forecast vintages and assess the changes in assumptions and forecast risk.",
    "2. Confirm the currency, valuation multiple and financing terms for the transaction.",
    "", "## Source record", "",
    ...valuation.cases.flatMap(({ source }) => [
      `- ${markdownText(source.title)} · ${documentSourceLocation(source.anchor)}`,
      `  - Document \`${source.documentId}\`, version \`${source.versionId}\``,
      `  - SHA-256 \`${source.sha256}\``,
      ...("quote" in source.anchor ? [`  - Table row — ${markdownText(source.anchor.quote)}`] : []),
    ]),
    "", "## Coverage", "",
    ...review.gaps.map(gap => `- ${markdownText(gap)}`), "",
  ].join("\n");
}
