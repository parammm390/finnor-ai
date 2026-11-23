/** Literal intake expectations written before economic-read intake implementation. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { interpretEconomicRead } from "../../packages/orchestration/src/economic-read-intake.ts";

const revenue = { intent: "company_revenue", company: { kind: "TENANT_DEFAULT" }, period: "LAST_COMPLETED_MONTH" };
const originals: Array<{ instruction: string; expected: unknown }> = [
  { instruction: "What was our revenue last month?", expected: revenue },
  { instruction: "Show last month's revenue.", expected: revenue },
  { instruction: "Ensure I know our last-month revenue before the deadline.", expected: revenue },
  { instruction: "What was our revenue last month so I can coordinate planning?", expected: revenue },
  { instruction: "What was last month's revenue? Do not spawn workers or create sandboxes.", expected: revenue },
  { instruction: "Read our revenue for the previous month, do not take any action.", expected: revenue },
  { instruction: "What is the current quote for $AAPL?", expected: { intent: "stock_quote", instrument: { kind: "SYMBOL", symbol: "AAPL" } } },
  { instruction: "Show the stock price for XNAS:AAPL.", expected: { intent: "stock_quote", instrument: { kind: "SYMBOL", symbol: "AAPL", exchange: "XNAS" } } },
  { instruction: "What's AAPL trading at? Do not trade.", expected: { intent: "stock_quote", instrument: { kind: "SYMBOL", symbol: "AAPL" } } },
  { instruction: "What was our revenue last month and then email the result to the vendor?", expected: null },
  { instruction: "Buy AAPL after checking its current stock quote.", expected: null },
  { instruction: "Every month, report revenue and send the report.", expected: null },
  { instruction: "Forecast next month's revenue.", expected: null },
  { instruction: "Restate last month's revenue to 200000.", expected: null },
  { instruction: "Investigate three competing stock data suppliers.", expected: null },
  { instruction: "What was last month's revenue at Unrelated Holdings?", expected: { ...revenue, company: { kind: "NAME", name: "Unrelated Holdings" } } },
  { instruction: "What was last month's revenue for Unrelated Holdings?", expected: { ...revenue, company: { kind: "NAME", name: "Unrelated Holdings" } } },
  { instruction: "What was last month's revenue of Unrelated Holdings?", expected: { ...revenue, company: { kind: "NAME", name: "Unrelated Holdings" } } },
  { instruction: "What was Unrelated Holdings's revenue last month?", expected: { ...revenue, company: { kind: "NAME", name: "Unrelated Holdings" } } },
  { instruction: "What was Unrelated Holdings revenue last month?", expected: { ...revenue, company: { kind: "NAME", name: "Unrelated Holdings" } } },
  { instruction: "What was our revenue last month at Unrelated Holdings?", expected: { ...revenue, company: { kind: "NAME", name: "Unrelated Holdings" } } },
  { instruction: "What was our cash revenue last month in EUR?", expected: { ...revenue, basis: "CASH", currency: "EUR" } },
  { instruction: "What was our accrual revenue last month in USD?", expected: { ...revenue, basis: "ACCRUAL", currency: "USD" } },
  { instruction: "What was our revenue last calendar month?", expected: { ...revenue, calendar: "CALENDAR" } },
  { instruction: "What was our revenue last fiscal month?", expected: { ...revenue, calendar: "FISCAL" } },
  { instruction: "Show our revenue last month. Message the board.", expected: null },
  { instruction: "Show our revenue last month. Call the board.", expected: null },
  { instruction: "Show our revenue last month. Remove the report.", expected: null },
  { instruction: "Show our revenue last month. Assign the report to the board.", expected: null },
  { instruction: "Show our revenue last month. Run the delivery.", expected: null },
  { instruction: "Show our revenue last month. Launch a worker.", expected: null },
  { instruction: "What was our revenue last month?\n- Do not create workers.\n- Send the report to the board.", expected: null },
  { instruction: "What was our revenue last month?\n- Do not create workers or spawn sandboxes.\n- Do not send the report.", expected: revenue },
  { instruction: "FYI, what is the stock price for W1 recorded company?", expected: { intent: "stock_quote", instrument: { kind: "NAME", name: "W1 recorded company" } } },
  { instruction: "FYI, what is the stock price for W1 recorded company in USD?", expected: { intent: "stock_quote", instrument: { kind: "NAME", name: "W1 recorded company" }, currency: "USD" } },
  { instruction: "What is W1 recorded company's stock price?", expected: { intent: "stock_quote", instrument: { kind: "NAME", name: "W1 recorded company" } } },
  { instruction: "Ensure I know W1 recorded company's stock price before the deadline.", expected: { intent: "stock_quote", instrument: { kind: "NAME", name: "W1 recorded company" } } },
  { instruction: "What was Change Healthcare's revenue last month?", expected: { ...revenue, company: { kind: "NAME", name: "Change Healthcare" } } },
  { instruction: "What was Oil and Change Holdings revenue last month?", expected: { ...revenue, company: { kind: "NAME", name: "Oil and Change Holdings" } } },
  { instruction: "What was last month's revenue for Change Healthcare?", expected: { ...revenue, company: { kind: "NAME", name: "Change Healthcare" } } },
  { instruction: "Change the report title. Show Change Healthcare's revenue last month.", expected: null },
  { instruction: "FYI, send W1 recorded company's stock price to the board.", expected: null },
  { instruction: "What is the stock price for W1 recorded company? Also $MSFT.", expected: null },
  { instruction: "What is XNAS:AAPL trading at?", expected: { intent: "stock_quote", instrument: { kind: "SYMBOL", symbol: "AAPL", exchange: "XNAS" } } },
  { instruction: "What is $AAPL trading at?", expected: { intent: "stock_quote", instrument: { kind: "SYMBOL", symbol: "AAPL" } } },
];
const results = originals.map(({ instruction, expected }) => {
  try {
    const actual = interpretEconomicRead(instruction);
    assert.deepEqual(actual, expected);
    return { instruction, expected, actual, status: "PASS" };
  } catch (error) {
    return { instruction, expected, status: "FAIL", error: error instanceof Error ? error.message : String(error) };
  }
});
const report = { schema: "finnor.postz.w1.read-intake-development.v1", nativeZeroActivation: "NOT_RUN",
  passed: results.filter(r => r.status === "PASS").length, failed: results.filter(r => r.status === "FAIL").length, results };
const output = resolve(process.argv[2] ?? "../scope-postz/w1-economic-orchestration/evidence/read-intake");
await mkdir(output, { recursive: true });
await writeFile(resolve(output, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.failed) process.exitCode = 1;
