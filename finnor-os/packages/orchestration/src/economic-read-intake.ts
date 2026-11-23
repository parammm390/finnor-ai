import { EconomicReadRequestSchema, type EconomicReadRequest } from "@finnor/shared-types";
import { requestsPositiveInstructionEffect } from "./instruction-effects";

const month = /\b(?:last|previous|prior)[-\s]+(?:(calendar|fiscal)\s+)?month(?:['’]s)?\b/i;
const genericCompany = /^(?:our|my|the|our company|my company|the company|company)$/i;
const readLead = /^(?:(?:fyi[,:]?\s*)?(?:what(?:['’]s|\s+(?:was|is))?\s+|how\s+much(?:\s+(?:was|is))?\s+|(?:please\s+)?(?:show|tell|give|read|get)\s+(?:me\s+)?|(?:please\s+)?(?:ensure|make\s+sure)\s+(?:that\s+)?(?:I|we)\s+know\s+))/i;
const stop = String.raw`(?=\s+(?:(?:last|previous|prior)[-\s]+(?:(?:calendar|fiscal)\s+)?month|in\s+[A-Z]{3}\b|(?:and|but|then|also|before|without)\b)|[;?!\n]|$)`;
const nameCharacters = String.raw`[\p{L}\p{N}][\p{L}\p{N} '&().-]{0,1023}?`;
const quoteTime = String.raw`\b(?:forecast(?:s|ing|ed)?|predict(?:ion|ions|ing|ed)?|project(?:ion|ions|ing|ed)?|estimat(?:e|es|ed|ing|ion)|histor(?:y|ic|ical)|future|yesterday|tomorrow|was|were|(?:last|previous|prior|next)\s+(?:hour|day|week|month|quarter|year)s?|(?:\d+|one|two|three|an?)\s+(?:hour|day|week|month|year)s?\s+ago|(?:19|20)\d{2}(?:[-/]\d{1,2}){0,2})\b`;
type Subject = { name: string; span: readonly [number, number] };

function subject(match: RegExpExecArray | null): Subject | null {
  const raw = match?.[1];
  if (!match || !raw) return null;
  const name = (raw.trim() + " ").replace(readLead, "").trim().replace(/[.,]+$/, "");
  if (!name) return null;
  const start = match.index + match[0].lastIndexOf(raw) + raw.lastIndexOf(name);
  return { name, span: [start, start + name.length] };
}

function parsedRequest(value: unknown): EconomicReadRequest | null {
  const parsed = EconomicReadRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Original user text only. Unsupported compound requests never activate a read. */
export function interpretEconomicRead(instruction: string): EconomicReadRequest | null {
  const text = instruction.normalize("NFKC").trim();
  if (!text || text.length > 10_000) return null;
  const currency = /\bin\s+([A-Z]{3})\b/i.exec(text)?.[1]?.toUpperCase();
  if (/\brevenue\b/i.test(text) && month.test(text)
      && !/\b(?:forecast|estimate|predict|project|investigate)\b/i.test(text)) {
    // Explicit at/for/of wins over "last month's", which is a period, not an entity.
    const explicit = subject(new RegExp(String.raw`\brevenue(?:\s+(?:last|previous|prior)[-\s]+(?:(?:calendar|fiscal)\s+)?month(?:['’]s)?)?\s+(?:at|for|of)\s+(${nameCharacters})${stop}`, "iu").exec(text));
    const possessive = subject(new RegExp(String.raw`(${nameCharacters})['’]s\s+(?:(?:last|previous|prior)[-\s]+(?:(?:calendar|fiscal)\s+)?month(?:['’]s)?\s+)?(?:(?:cash|accrual)(?:[-\s]+basis)?\s+)?revenue\b`, "iu").exec(text));
    const preceding = subject(new RegExp(String.raw`(${nameCharacters})\s+(?:(?:cash|accrual)(?:[-\s]+basis)?\s+)?revenue\b`, "iu").exec(text));
    const candidate = explicit ?? possessive ?? preceding;
    // A period phrase captured by a possessive is not a named company. A present
    // explicit target is never discarded just because a period appears earlier.
    const periodOnly = candidate
      && /^(?:(?:our|my|the)\s+)?(?:last|previous|prior)[-\s]+(?:(?:calendar|fiscal)\s+)?month$/i.test(candidate.name)
      && (/^(?:our|my|the)\s+/i.test(candidate.name) || candidate.name === candidate.name.toLowerCase());
    const generic = !candidate || genericCompany.test(candidate.name) || periodOnly;
    const spans = !generic && candidate ? [candidate.span] : [];
    if (requestsPositiveInstructionEffect(text, spans)) return null;
    const selectorText = !generic && candidate
      ? text.slice(0, candidate.span[0]) + " ".repeat(candidate.span[1] - candidate.span[0]) + text.slice(candidate.span[1]) : text;
    if (!month.test(selectorText)) return null;
    const calendarWord = month.exec(selectorText)?.[1]?.toUpperCase();
    const revenueCurrency = /\bin\s+([A-Z]{3})\b/i.exec(selectorText)?.[1]?.toUpperCase();
    if (/\bcash\b/i.test(selectorText) && /\baccrual\b/i.test(selectorText)) return null;
    return parsedRequest({
      intent: "company_revenue",
      company: !generic && candidate ? { kind: "NAME", name: candidate.name } : { kind: "TENANT_DEFAULT" },
      period: "LAST_COMPLETED_MONTH",
      ...(/\bcash(?:[-\s]+basis)?\b/i.test(selectorText) ? { basis: "CASH" } : /\baccrual(?:[-\s]+basis)?\b/i.test(selectorText) ? { basis: "ACCRUAL" } : {}),
      ...(revenueCurrency ? { currency: revenueCurrency } : {}),
      ...(calendarWord ? { calendar: calendarWord === "CALENDAR" ? "CALENDAR" : "FISCAL" } : {}),
    });
  }
  if (!/\b(?:quote|stock price|share price|trading at)\b/i.test(text)
      || /\b(?:investigate|compare|research|suppliers|providers)\b/i.test(text)) return null;
  const named = subject(new RegExp(String.raw`\b(?:quote|stock price|share price)\s+(?:for|of|at)\s+(${nameCharacters})${stop}`, "iu").exec(text))
    ?? subject(new RegExp(String.raw`(${nameCharacters})['’]s\s+(?:current\s+)?(?:stock price|share price|quote)\b`, "iu").exec(text))
    ?? subject(new RegExp(String.raw`(${nameCharacters})\s+(?:currently\s+)?trading\s+at\b`, "iu").exec(text));
  const qualified = [...text.matchAll(/\b([A-Z0-9]{2,12}):([A-Z0-9][A-Z0-9.-]{0,15})\b/gi)];
  const tickers = [...text.matchAll(/\$([A-Za-z][A-Za-z0-9.-]{0,15})\b/g)];
  if (qualified.length + tickers.length > 1) return null;
  // An explicit issuer plus a different global ticker is not a request to
  // silently replace that issuer. Compound selectors need clarification.
  const selectedTicker = qualified[0] ?? tickers[0];
  if (named && selectedTicker
      && !(named.span[0] >= selectedTicker.index! && named.span[1] <= selectedTicker.index! + selectedTicker[0].length)) return null;
  const nearCue = /\b(?:what(?:['’]s|\s+is)?|show(?:\s+me)?|quote)\s+(?:the\s+)?([A-Z][A-Z0-9.-]{0,15})\s+(?:stock price|share price|quote|trading at)\b/.exec(text);
  const instrumentSpan = named?.span ?? (selectedTicker
    ? [selectedTicker.index!, selectedTicker.index! + selectedTicker[0].length] as const
    : nearCue ? [nearCue.index + nearCue[0].lastIndexOf(nearCue[1]!), nearCue.index + nearCue[0].lastIndexOf(nearCue[1]!) + nearCue[1]!.length] as const : null);
  const quoteSelector = instrumentSpan ? text.slice(0, instrumentSpan[0])
    + " ".repeat(instrumentSpan[1] - instrumentSpan[0]) + text.slice(instrumentSpan[1]) : text;
  // The typed quote owner supplies a current quote, not a forecast/history.
  // Protect actual issuer words, but not a trailing date/period swallowed by
  // a greedy issuer capture ("Apple tomorrow", "Apple next week").
  if (new RegExp(quoteTime, "i").test(quoteSelector)
      || named && new RegExp(String.raw`\s+(?:${quoteTime})[. ]*$`, "i").test(named.name)) return null;
  if (requestsPositiveInstructionEffect(text, named ? [named.span] : [])) return null;
  if (qualified[0]) return parsedRequest({ intent: "stock_quote",
    instrument: { kind: "SYMBOL", symbol: qualified[0][2]!.toUpperCase(), exchange: qualified[0][1]!.toUpperCase() }, ...(currency ? { currency } : {}) });
  if (tickers[0]) return parsedRequest({ intent: "stock_quote",
    instrument: { kind: "SYMBOL", symbol: tickers[0][1]!.toUpperCase() }, ...(currency ? { currency } : {}) });
  // The explicit subject is authoritative. Introductory FYI/ASAP/etc. is never
  // scanned as a competing global ticker.
  if (named) {
    const bareSymbol = /^[A-Z][A-Z0-9.-]{0,15}$/.test(named.name) && !["I", "USD", "EUR", "GBP", "JPY"].includes(named.name);
    return parsedRequest({ intent: "stock_quote", instrument: bareSymbol
      ? { kind: "SYMBOL", symbol: named.name } : { kind: "NAME", name: named.name }, ...(currency ? { currency } : {}) });
  }
  return nearCue ? parsedRequest({ intent: "stock_quote", instrument: { kind: "SYMBOL", symbol: nearCue[1] }, ...(currency ? { currency } : {}) }) : null;
}

/** The existing immutable input owns the full typed request, not an intent label. */
const typedPrefix = "Typed economic query v1: ";
export function economicReadInput(request: EconomicReadRequest): string {
  return typedPrefix + JSON.stringify(EconomicReadRequestSchema.parse(request));
}
export function economicReadForInput(instruction: string): EconomicReadRequest | null {
  if (!instruction.startsWith(typedPrefix)) return interpretEconomicRead(instruction);
  try { return parsedRequest(JSON.parse(instruction.slice(typedPrefix.length))); }
  catch { return null; }
}
