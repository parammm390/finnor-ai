// B4.T3 staging/pre-release gate. A staging candidate exports the normalized receipts
// it produced for the same recorded synthetic day; this script compares that artifact
// with the recorded baseline and exits non-zero on behavioral drift. It does not
// manufacture a candidate or call providers.
import { readFileSync } from "node:fs";

type ReceiptLike = {
  proposedAction?: unknown;
  expectedResult?: unknown;
  actualResult?: unknown;
  failure?: unknown;
  approval?: unknown;
  action?: unknown;
  expected?: unknown;
  actual?: unknown;
};

type NormalizedReceipt = { action: unknown; expected: unknown; actual: unknown; failure: unknown; approval: unknown };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  }
  return value ?? null;
}

function normalizeReceipt(receipt: ReceiptLike): NormalizedReceipt {
  return {
    action: canonical(receipt.proposedAction ?? receipt.action),
    expected: canonical(receipt.expectedResult ?? receipt.expected),
    actual: canonical(receipt.actualResult ?? receipt.actual),
    failure: canonical(receipt.failure),
    approval: canonical(receipt.approval),
  };
}

function diffNormalizedReceipts(baseline: ReceiptLike[], candidate: ReceiptLike[]) {
  const remaining = new Map<string, NormalizedReceipt[]>();
  for (const item of baseline.map(normalizeReceipt)) {
    const key = JSON.stringify(item);
    remaining.set(key, [...(remaining.get(key) ?? []), item]);
  }
  const added: NormalizedReceipt[] = [];
  for (const item of candidate.map(normalizeReceipt)) {
    const key = JSON.stringify(item);
    const matches = remaining.get(key);
    if (matches?.length) matches.pop();
    else added.push(item);
  }
  const removed = [...remaining.values()].flat();
  return { equal: added.length === 0 && removed.length === 0, added, removed };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required: supply the receipt artifact emitted by the baseline/candidate staging run`);
  return value;
}

function load(name: string): ReceiptLike[] {
  const value = required(name);
  const raw = value.startsWith("[") ? value : readFileSync(value, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${name} must be a JSON receipt array`);
  return parsed as ReceiptLike[];
}

const baseline = load("DEALER_ZERO_REPLAY_BASELINE");
const candidate = load("DEALER_ZERO_REPLAY_CANDIDATE");
const report = diffNormalizedReceipts(baseline, candidate);
console.log(JSON.stringify({ gate: "dealer-zero-replay", ...report }, null, 2));
if (!report.equal) process.exitCode = 1;
