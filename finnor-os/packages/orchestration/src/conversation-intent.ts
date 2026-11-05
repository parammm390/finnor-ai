import { DocumentValuationAssumptionsSchema, type DocumentValuationAssumptions } from "@finnor/shared-types";

export const INFORMATIONAL_QUESTION = /^(?:(?:please\s+)?(?:how|what|which|where|when|who|is|are|do|does|did|can|could|would)\b|(?:please\s+)?(?:tell me|show(?:\s+me)?|pull\s+up|find|get|give me|list|summarize|explain)\b)|\?\s*$/i;
export const REQUESTED_WORK = /^(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:finish|complete|draft|share|assign|schedule|reschedule|continue|resume|prepare|build|analyze|review|calculate|reconcile|compare|create|update|delete|remove|send|email|call|approve|pay|execute|run|start)\b/i;

function unquotedInstruction(instruction: string): string {
  return instruction.replace(/"(?:\\.|[^"\\])*"|“[^”]*”|‘[^’]*’|`[^`]*`|(?<!\w)'(?:\\.|[^'\\])*'(?!\w)/g, " ");
}

function hasUnclassifiedAnalysisContinuation(value: string): boolean {
  if (!/\b(?:hypothetical|synthetic|supplied|given|following|assume|assuming|example)\b/i.test(value)) return false;
  const clauses = value.split(/(?:[.!?](?=\s|$)|;|\r?\n|,|\b(?:and(?: then)?|then|also|now|but)\s+)/i).slice(1);
  const scenario = /\b(?:hypothetical|synthetic)\b/i.test(value) && /\bexplanation only\b/i.test(value);
  for (const clause of clauses) {
    const text = clause.trim().replace(/^(?:(?:and|or|please)\s+)+/i, "");
    if (!text || /^(?:do\s+not|don['’]t|never)\b/i.test(text)) continue;
    if (/^(?:i|we)\s+(?:have(?:\s+not)?|haven['’]t|did(?:\s+not)?|didn['’]t)\s+(?:supplied|provided|included|specified)\b/i.test(text)) continue;
    if (/^(?:what|how|which|show|explain|calculate|compute|compare|analy[sz]e|assess|evaluate|estimate|apply|preserve|separate|identify|quantify|rank|state|note|include|list|consider)\b/i.test(text)) continue;
    if (/^(?:[+−-]?\d|[$€£]|USD\b|EUR\b|GBP\b|INR\b|JPY\b|CAD\b|AUD\b|CHF\b|SGD\b|HKD\b|CNY\b|AED\b|FY\d)/i.test(text)) continue;
    if (/^(?:a|an|the|this|these|those|both|all|each|same|neither|no|not|other|source|case|company|period|currency|unit|net|debt|fees?|transaction|entry|exit|multiple|equity|enterprise|sponsor|cash|total|revenue|EBITDA|margin|leverage|liabilities|funding|rollover|adjustments?|explanation|assumptions?|conditions?|financial|hypothetical|synthetic|supplied|unresolved|given|with|without|for)\b/i.test(text)) continue;
    if (scenario && /^(?:pay|receive)\b/i.test(text)) continue;
    return true;
  }
  return false;
}

export function hasRequestedBusinessEffect(instruction: string): boolean {
  const value = unquotedInstruction(instruction);
  const effects = value.matchAll(/(?:^|[.!?;:,\n]\s*|\b(?:and(?: then)?|then|also|now|but)\s+)(?:(?:please|however)\s+|(?:can|could|would|will)\s+you\s+|(?:I want|I'd like)\s+you\s+to\s+)*(?<verb>send|email|text|message|notify|call|create|record|update|set|delete|remove|cancel|approve|reject|pay|execute|finish|complete|draft|prepare|share|assign|schedule|reschedule|resolve|mark|waive|close|open|submit|publish|save|upload|export|attach|start|run|continue|resume)\b/gi);
  return [...effects].some(match => {
    // "Show activity for run, start and launch events" describes event names.
    // A comma within that noun list is not a new imperative to start Work.
    const prefix = value.slice(0, match.index);
    const suffix = value.slice(match.index + match[0].length);
    const namedEventList = /\b(?:for|about|of|between)\s+(?:run|start|launch)\s*$/i.test(prefix)
      && /^\s+and\s+(?:run|start|launch)(?:\s+events?)?\s*[?.!]?\s*$/i.test(suffix);
    if (namedEventList) return false;
    const scenarioCashFlow = match.groups?.verb?.toLowerCase() === "pay" && value[match.index] === ":"
      && /\b(?:example|scenario|case|cash flows?)\s*$/i.test(value.slice(0, match.index))
      && /\b(?:hypothetical|synthetic)\b/i.test(value) && /\bexplanation only\b/i.test(value);
    return !scenarioCashFlow;
  }) || hasUnclassifiedAnalysisContinuation(value);
}

/** Supplied examples are conditional analysis. Selecting a Deal adds context, not an execution request. */
export function isSuppliedAnalysisQuestion(instruction: string): boolean {
  const value = unquotedInstruction(instruction).replace(/\s+/g, " ").trim()
    .replace(/^(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?/i, "");
  return !hasRequestedBusinessEffect(instruction)
    && /^(?:what|how|which|explain|show|calculate|compute|compare|analy[sz]e|assess|evaluate|estimate)\b/i.test(value)
    && /\b(?:hypothetical|synthetic|supplied|given|following|assume|assuming|example)\b/i.test(value)
    && !/\b(?:search|look up|fetch|retrieve|latest|current market)\b/i.test(value);
}

export function isSuppliedFinancialCalculation(instruction: string): boolean {
  return isSuppliedAnalysisQuestion(instruction) && /\d/.test(instruction);
}

type DocumentReviewRequest = { kind: "comparison" } | { kind: "valuation"; assumptions: DocumentValuationAssumptions } | { kind: "invalid_valuation" };
const moneyScale = { thousand: "1000", million: "1000000", billion: "1000000000" } as const;
const magnitude = "[+-]?(?:\\d{1,3}(?:,\\d{3}){1,3}|\\d{1,12})(?:\\.\\d{1,4})?";
const financing = new RegExp(
  `^assume (?<debtCurrency>[A-Z]{3}) (?<debt>${magnitude})(?: (?<debtScale>thousand|million|billion))? net debt and (?<feeCurrency>[A-Z]{3}) (?<fees>${magnitude})(?: (?<feeScale>thousand|million|billion))? transaction fees,? with all equity funded by the sponsor and no rollover or other funding[.!]?$`, "i",
);

const money = `[A-Z]{3} ${magnitude}(?: (?:thousand|million|billion))?`;
const partialFinancing = new RegExp(
  `^assume (?:${money} net debt(?: and ${money} transaction fees)?|${money} transaction fees)[.!]?$`, "i",
);

export function parseDocumentReviewRequest(instruction: string): DocumentReviewRequest | null {
  const value = instruction.replace(/\s+/g, " ").trim();
  const forecast = /^(?:please )?compare FY ?(?<year>20\d{2}) adjusted EBITDA forecasts on PDF pages (?<first>\d{1,4}) and (?<second>\d{1,4}) of "(?<title>[^"\r\n]{1,240})" at (?<multiple>[+-]?\d+(?:\.\d+)?)\s*[x×] EV\/EBITDA,? treating \$ as (?<currency>[A-Z]{3})[.!?]?$/i.exec(value)?.groups;
  if (forecast) {
    const assumptions = DocumentValuationAssumptionsSchema.safeParse({
      entryMultiple: forecast.multiple,
      forecast: {
        title: forecast.title, pages: [Number(forecast.first), Number(forecast.second)],
        year: Number(forecast.year), dollarCurrency: forecast.currency?.toUpperCase(),
      },
    });
    return assumptions.success ? { kind: "valuation", assumptions: assumptions.data } : { kind: "invalid_valuation" };
  }
  if (/^(?:please )?(?:(?:identify|find|show)(?: me)? (?:the )?(?:conflicting financial (?:figures|numbers)|financial discrepancies)|which financial (?:figures|numbers) (?:conflict|disagree)) (?:across|in|between) (?:(?:this|the) (?:deal|company)['’]s|(?:these|the)) (?:source )?documents[?.!]?(?: (?:show both values and their sources|cite the source for each figure|include both values and their sources)\.?)?$/i.test(value)) {
    return { kind: "comparison" };
  }
  const [question, fundingClause, ...extra] = value.split(/ (?=assume )/i);
  if (!question || extra.length) return null;
  const valuation = /^(?:please )?(?:what is|show(?: me)?|quantify) (?:the )?valuation impact of (?:the )?conflicting EBITDA (?:across|in|between) (?:(?:this|the) (?:deal|company)['’]s|(?:these|the)) (?:source )?documents(?: for the year ended (?<yearEnd>\d{4}-\d{2}-\d{2}))?(?: at (?<multiple>[+-]?\d+(?:\.\d+)?)\s*[x×](?: EV\/EBITDA)?)?[?.!]?$/i.exec(question)?.groups;
  if (!valuation) return null;
  const supplied = fundingClause ? financing.exec(fundingClause)?.groups : undefined;
  if (fundingClause && !supplied && !partialFinancing.test(fundingClause)) return null;
  if (supplied && supplied.debtCurrency?.toUpperCase() !== supplied.feeCurrency?.toUpperCase()) return { kind: "invalid_valuation" };
  const scale = (word: string | undefined) => {
    const normalized = word?.toLowerCase();
    return normalized === "thousand" || normalized === "million" || normalized === "billion" ? moneyScale[normalized] : "1";
  };
  const assumptions = DocumentValuationAssumptionsSchema.safeParse({
    entryMultiple: valuation.multiple,
    periodEnd: valuation.yearEnd,
    ...(supplied ? { funding: {
      currency: supplied.debtCurrency?.toUpperCase(),
      netDebt: { magnitude: supplied.debt?.replaceAll(",", ""), scale: scale(supplied.debtScale) },
      fees: { magnitude: supplied.fees?.replaceAll(",", ""), scale: scale(supplied.feeScale) },
    } } : {}),
  });
  return assumptions.success ? { kind: "valuation", assumptions: assumptions.data } : { kind: "invalid_valuation" };
}

export function isDocumentFinancialReviewQuestion(instruction: string): boolean {
  return parseDocumentReviewRequest(instruction) !== null;
}

export function isReadOnlyConversationQuestion(instruction: string): boolean {
  const value = instruction.replace(/"(?:\\.|[^"\\])*"|“[^”]*”|‘[^’]*’|`[^`]*`|(?<!\w)'(?:\\.|[^'\\])*'(?!\w)/g, " ").replace(/\s+/g, " ").trim();
  if (REQUESTED_WORK.test(value)) return false;
  if (!INFORMATIONAL_QUESTION.test(value)) return false;
  if (/\b(?:and(?: then)?|then|also|now|please|(?:can|could|would) you)\s+(?:send|email|call|create|update|delete|approve|pay|execute|finish|complete|draft|share|assign|schedule|continue|resume)\b/i.test(value)) return false;
  if (/^(?:please\s+)?(?:what\s+(?:is\s+your\s+(?:understanding|interpretation)|do\s+you\s+(?:understand|remember))\s+(?:of|about|from)\b|(?:summarize|rephrase|translate|explain)\s+(?:this|the\s+(?:note|statement|message|passage))\b)/i.test(value)) return true;
  return /\b(?:did|have)\s+(?:i|we)\s+(?:say|tell|mention|specify|ask|discuss|establish|agree|decide)\b/i.test(value)
    || (/^(?:what|which|when|where|who)\b/i.test(value)
      && /\b(?:earlier|previously|remember|recall|last time|in this (?:chat|conversation)|we discussed)\b/i.test(value));
}
