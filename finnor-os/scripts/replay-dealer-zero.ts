// B4.T3 staging/pre-release gate. A staging candidate exports the normalized receipts
// it produced for the same recorded synthetic day; this script compares that artifact
// with the recorded baseline and exits non-zero on behavioral drift. It does not
// manufacture a candidate or call providers.
import { readFileSync } from "node:fs";
import { diffNormalizedReceipts, type ReceiptLike } from "@finnor/orchestration";

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
