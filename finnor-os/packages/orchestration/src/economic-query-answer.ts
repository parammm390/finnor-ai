import type { AnswerEnvelope, AnswerDisplayFact, OperationalQueryExecution } from "./fast-read-lane";

export function answerEconomicQuery(execution: OperationalQueryExecution): AnswerEnvelope | null {
  const result = execution.result;
  if (result.intent !== "company_revenue" && result.intent !== "stock_quote") return null;
  const outcome = result.economicRead;
  const facts: AnswerDisplayFact[] = [{ label: "Availability", value: outcome.availability }];
  let summary: string;
  if (outcome.intent === "company_revenue" && outcome.availability === "AVAILABLE") {
    const statement = outcome.statement;
    summary = `${outcome.companyName}'s ${statement.reportingStatus.toLowerCase()} ${statement.basis.toLowerCase()} revenue for the recorded accounting month was ${statement.currency} ${statement.amount}.`;
    facts.push({ label: "Legal entity", value: statement.companyId }, { label: "Accounting month", value: statement.monthId },
      { label: "Exact period", value: `${statement.periodStart} to ${statement.periodEnd} (end exclusive)` },
      { label: "Calendar / time zone", value: `${statement.calendarRef} / ${statement.timeZone}` },
      { label: "Basis", value: statement.basis }, { label: "Consolidation", value: statement.consolidationRef },
      { label: "Reporting status", value: statement.reportingStatus }, { label: "Source updated", value: statement.sourceUpdatedAt });
  } else if (outcome.intent === "stock_quote" && (outcome.availability === "CURRENT" || outcome.availability === "DELAYED")) {
    const quote = outcome.quote;
    summary = `The latest recorded ${outcome.availability === "DELAYED" ? "delayed " : ""}quote for ${quote.instrument.exchange}:${quote.instrument.symbol} is ${quote.instrument.currency} ${quote.price}, as of ${quote.providerTimestamp}. This is a read, not a trade.`;
    facts.push({ label: "Instrument", value: `${quote.instrument.exchange}:${quote.instrument.symbol}` },
      { label: "Provider timestamp", value: quote.providerTimestamp }, { label: "Market session", value: quote.marketSession },
      { label: "Declared source delay", value: `${quote.delaySeconds} seconds` }, { label: "Recorded provider", value: quote.providerRef },
      { label: "Display license", value: quote.license.reference }, { label: "Source valid until", value: quote.validUntil });
  } else if (outcome.intent === "stock_quote" && outcome.availability === "STALE") {
    const quote = outcome.lastKnown;
    summary = `No current quote is available. The last recorded quote for ${quote.instrument.exchange}:${quote.instrument.symbol} was ${quote.instrument.currency} ${quote.price} at ${quote.providerTimestamp}; it is stale.`;
    facts.push({ label: "Stale provider timestamp", value: quote.providerTimestamp }, { label: "Freshness", value: "Not a current price" });
  } else if ("reason" in outcome) {
    summary = outcome.reason;
  } else {
    throw new Error("Invalid economic read disposition.");
  }
  return { kind: "answer", intent: result.intent, readOnly: true, spokenSummary: summary,
    display: { title: result.intent === "company_revenue" ? "Recorded company revenue" : "Recorded stock quote", facts },
    evidence: outcome.witnesses.map(ref => ({ source: "evidence_source_versions", ref: ref.versionId, timestamp: ref.asOf, kind: "CANONICAL" as const })),
    asOf: outcome.observedAt, freshness: { status: outcome.availability === "STALE" ? "stale"
      : ["AVAILABLE", "CURRENT", "DELAYED"].includes(outcome.availability) ? "fresh" : "unknown", observedAt: outcome.observedAt }, query: execution };
}
