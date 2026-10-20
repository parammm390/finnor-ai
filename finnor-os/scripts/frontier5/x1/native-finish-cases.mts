import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DigitalInstitutionProfile } from "../../../packages/private-equity/src/institution-program/contracts";
import { independentlyCheckInstitutionModel, type OriginalInstitutionEvidence } from "../../../packages/private-equity/src/institution-program/checker";
import { proposeInstitutionModel } from "../../../packages/private-equity/src/institution-program/reconstruction";

const load = <T,>(path: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")) as T;
const baseline = load<OriginalInstitutionEvidence>("./reference/native-input.json");
const profile = DigitalInstitutionProfile.parse(load<unknown>("../../../../scope-frontier5/x1-institutional-programme-compiler/profile.json"));
const copy = () => structuredClone(baseline);
const source = (input: OriginalInstitutionEvidence, id: string) => input.sources.find((item) => item.id === id)!;
const setRows = (input: OriginalInstitutionEvidence, id: string, rows: object[]) => {
  const item = source(input, id);
  item.rawUtf8 = JSON.stringify(rows);
  item.coverage.expectedObjectIds = rows.map((row) => (row as { transactionId?: string; receiptId?: string; taskId?: string }).transactionId
    ?? (row as { receiptId?: string }).receiptId ?? (row as { taskId?: string }).taskId!);
  item.coverage.readObjectIds = [...item.coverage.expectedObjectIds];
};
const checked = async (input: OriginalInstitutionEvidence) => {
  const candidate = await proposeInstitutionModel(input, profile);
  return { candidate, result: await independentlyCheckInstitutionModel(input, candidate, profile) };
};
{
  const { candidate } = await checked(baseline);
  for (const unmeasured of ["episodeHumanSeconds", "financialEpisodeUsd", "inheritedAggregateMemoryBytes",
    "nodePreconditionsOrDependencies", "clarificationRequests", "institutionDependencyNodes",
    "institutionDependencyEdges", "nativePlanNodes", "authorizedAcquisitionCalls",
    "concurrentSourceReads", "concurrentCompilerEpisodes"]) {
    assert.equal(candidate.limits[unmeasured], null, `${unmeasured} has no owner measurement`);
  }
}

// Observable contract: transaction occurrences are not mutually exclusive balance assertions.
// Credible regression: unequal transactions become contradictions. Boundary: original accounting guard.
{
  const input = copy();
  const item = source(input, "ledger-native");
  item.rawUtf8 += "txn-8,FIRM-100,20.00,USD,units,2026-09,posted,facility balance,2026-09-30T00:00:00.000Z,2026-10-01T00:00:00.000Z\n";
  item.coverage.expectedObjectIds.push("txn-8"); item.coverage.readObjectIds.push("txn-8");
  const { candidate, result } = await checked(input);
  assert.equal(result.disposition, "ACCEPTED_DEVELOPMENT", JSON.stringify(result));
  assert.equal(candidate.contradictions.length, 0);
}
{
  const input = copy(); const item = source(input, "ledger-native");
  item.rawUtf8 = "Transaction ID,Deal Number,Amount,Currency,Unit,Period,Accounting Basis,Account,Posted At,Available At,Balance Role,Accounting Relation ID\n"
    + ["opening,100.00", "movement,20.00", "closing,999.00"].map((entry, i) => {
      const [role, amount] = entry.split(",");
      return `txn-${i + 1},FIRM-100,${amount},USD,units,2026-09,posted,facility balance,2026-09-30T00:00:00.000Z,2026-10-01T00:00:00.000Z,${role},reconciliation-1\n`;
    }).join("");
  item.coverage.expectedObjectIds = ["txn-1", "txn-2", "txn-3"];
  item.coverage.readObjectIds = [...item.coverage.expectedObjectIds];
  const { result } = await checked(input);
  assert.equal(result.disposition, "REJECTED");
  if (result.disposition === "REJECTED") assert.equal(result.guard, "QUANTITY");
  item.rawUtf8 = item.rawUtf8.replace("999.00", "120.00");
  const valid = await checked(input);
  assert.equal(valid.result.disposition, "ACCEPTED_DEVELOPMENT", JSON.stringify(valid.result));
}
{
  const input = copy(); source(input, "ledger-native").rawUtf8 = source(input, "ledger-native").rawUtf8.replace("1250.00", "1250.0");
  const candidate = await proposeInstitutionModel(baseline, profile);
  const result = await independentlyCheckInstitutionModel(input, candidate, profile);
  assert.equal(result.disposition, "ACCEPTED_DEVELOPMENT", JSON.stringify(result));
}
// Ambiguity disables dependent claims, but retains all exact alternatives and independent duties.
{
  const input = copy(); input.canonical.entities.push({
    ref: "pe_deal:alternative@v1", entityType: "deal", registrationId: "FIRM-100", institutionId: input.institutionId,
  });
  const { candidate, result } = await checked(input);
  assert.equal(result.disposition, "ACCEPTED_DEVELOPMENT", JSON.stringify(result));
  assert.ok(candidate.unresolved?.some((item) => item.witness === "crm-native/opportunity-7"
    && item.alternatives.length === 2));
  assert.equal(candidate.obligations.length, 0);
  assert.ok(candidate.unresolved?.some((item) => item.witness === "work-native/task-7"));
  assert.ok(candidate.unresolved?.some((item) => item.witness === "mail-native/mail-7"));
}
{
  const input = copy(); source(input, "ledger-native").rawUtf8 = source(input, "ledger-native").rawUtf8
    .replace(",Unit,Period,", ",Period,").replace(",USD,units,2026", ",USD,2026");
  const { candidate, result } = await checked(input);
  assert.equal(result.disposition, "ACCEPTED_DEVELOPMENT", JSON.stringify(result));
  assert.ok(candidate.unresolved?.some((item) => item.witness === "ledger-native/txn-7"
    && item.reason.includes("UNIT")));
  assert.equal(candidate.obligations.length, 1);
}
{
  const input = copy();
  for (let i = 0; i < 8; i++) input.canonical.entities.push({
    ref: `pe_deal:alternative-${i}@v1`, entityType: "deal", registrationId: "FIRM-100", institutionId: input.institutionId,
  });
  await assert.rejects(() => proposeInstitutionModel(input, profile), /RECONSTRUCTION_BOUND/);
}
// A negative or quoted task is descriptive, not an affirmative mandate trigger.
for (const phrase of ["No evidence request needed", 'Customer wrote "evidence request needed"', "Maybe evidence request needed"]) {
  const input = copy(); setRows(input, "work-native", [{ taskId: "task-7", dealNumber: "FIRM-100",
    activity: phrase, state: "open", createdAt: "2026-10-10T08:00:00.000Z", availableAt: "2026-10-10T09:00:00.000Z" }]);
  const { candidate, result } = await checked(input);
  assert.equal(result.disposition, "ACCEPTED_DEVELOPMENT", `${phrase}: ${JSON.stringify(result)}`);
  assert.equal(candidate.obligations.length, 0, phrase);
}
// JSON numeric token is exact decimal evidence, not silently dropped by one reader.
{
  const input = copy(); setRows(input, "expense-native", [{ receiptId: "receipt-7", employeeNumber: "EMP-7",
    amount: 12, currency: "USD", unit: "units", period: "2026-10", basis: "reimbursable", account: "travel",
    postedAt: "2026-10-10T08:00:00.000Z", availableAt: "2026-10-10T09:00:00.000Z" }]);
  const { candidate, result } = await checked(input);
  assert.equal(result.disposition, "ACCEPTED_DEVELOPMENT", JSON.stringify(result));
  assert.equal(candidate.quantities.find((item) => item.recordId === "receipt-7")?.value, "12");
}
{
  const input = copy(); const item = source(input, "lender-native");
  const absent = await checked(input);
  assert.ok(absent.candidate.unresolved?.some((entry) => entry.witness === "lender-native/facility-7"
    && entry.reason.includes("AVAILABLE_AT")));
  item.rawUtf8 = item.rawUtf8.replace("<th>As Of</th>", "<th>As Of</th><th>Available At</th>")
    .replace("<td>2026-09-30T00:00:00.000Z</td>", "<td>2026-09-30T00:00:00.000Z</td><td>2026-10-01T00:00:00.000Z</td>");
  const { candidate, result } = await checked(input);
  assert.equal(result.disposition, "ACCEPTED_DEVELOPMENT", JSON.stringify(result));
  assert.equal(candidate.quantities.find((value) => value.sourceId === item.id)?.value, "1250.00");
}
// A partial equation does not invent a zero balance; the dependent claim
// retains the specific missing role while the independent task remains.
{
  const input = copy(); const item = source(input, "ledger-native");
  item.rawUtf8 = "Transaction ID,Deal Number,Amount,Currency,Unit,Period,Accounting Basis,Account,Posted At,Available At,Balance Role,Accounting Relation ID\n"
    + "txn-7,FIRM-100,100,USD,units,2026-09,posted,facility balance,2026-09-30T00:00:00.000Z,2026-10-01T00:00:00.000Z,opening,reconciliation-1\n";
  const { candidate, result } = await checked(input);
  assert.equal(result.disposition, "ACCEPTED_DEVELOPMENT", JSON.stringify(result));
  assert.ok(candidate.unresolved?.some((entry) => entry.witness === "accounting:reconciliation-1"
    && entry.reason.includes("movement") && entry.reason.includes("closing")));
  assert.equal(candidate.obligations.length, 1);
}
console.log("native finish independent predicates: accepted, unresolved, and intended guard reached");
