import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { participantControlName, participantDealDenied } from "./participant-control";

const expected = {
  underwrite: { recurringEbitda: 20, priceMultiple: 12, enterpriseValueCap: 220, enterpriseValueGap: 20 },
  finance: { leverage: 5, debtCapacity: 105, headroom: 5 },
  operate: { grossSavings: 2.1, attributableOperatingProfit: 1.7, targetShortfall: 0.3 },
  monitor: { recurringEbitda: 18, priceMultiple: 13.33, enterpriseValueCap: 198, enterpriseValueGap: 42, leverage: 5.56, debtCapacity: 94.5, debtShortfall: 5.5 },
  exit: { aNetEquityProceeds: 178, bNetEquityProceeds: 170.5, proceedsGap: 7.5 },
} as const;

type Observation = {
  mode: string;
  attempts: Array<Record<string, unknown> & {
    stage: string;
    intake?: { status: number };
    artifact?: { calculations: Record<string, number> };
  }>;
};

export function grade(report: Observation) {
  const stages = { underwrite: "T0", finance: "T0", operate: "T2", monitor: "T3", exit: "T4" } as const;
  const economics = (Object.keys(stages) as Array<keyof typeof stages>).map(name => {
    const attempt = report.attempts.find(row => row.stage === stages[name] && row.intake);
    if (!attempt || report.mode !== "owner-control") return { name, verdict: "UNPROVEN", reason: "No positive stage execution." };
    const calculations = attempt.artifact?.calculations;
    if (!calculations) return { name, verdict: "FAIL", reason: "No persisted memo and calculation sheet found." };
    const mismatches = Object.entries(expected[name])
      .filter(([field, value]) => {
        const observed = calculations[field];
        const tolerance = field === "priceMultiple" || field === "leverage" ? 0.005 : 0.000001;
        return typeof observed !== "number" || !(Math.abs(observed - value) <= tolerance);
      })
      .map(([field, value]) => ({ field, expected: value, observed: calculations[field] ?? null }));
    return { name, verdict: mismatches.length ? "FAIL" : "UNPROVEN", mismatches, reason: "Arithmetic alone does not establish provenance, decision quality or authority." };
  });
  const participant = report.mode === "participant" ? report.attempts.find(row => row.stage === "T0") : undefined;
  const denialObserved = participantDealDenied(participant);
  return [...economics,
    ...(report.mode === "participant" ? [{
      name: participantControlName,
      verdict: denialObserved ? "PASS" : participant?.intake ? "FAIL" : "UNPROVEN",
      reason: denialObserved ? "Expected policy denial; no objective, jobs, actions or effects. This is not an associate submission pass."
        : "The expected participant role-boundary denial was not established.",
    }] : []),
    { name: "operate-baseline", verdict: "UNPROVEN", reason: "T1 event not exercised." },
    { name: "recover-and-respect-authority", verdict: "UNPROVEN", reason: "Replay, restart and memo supersession not exercised." },
    { name: "scoped-evidence-request", verdict: report.mode === "owner-denied-control" && report.attempts.some(row => row.intake?.status === 403) ? "FAIL" : "UNPROVEN", reason: "A generic denial does not establish a scoped B2/B7 evidence request." },
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("Provide the candidate observation JSON path.");
  const report: Observation = JSON.parse(await readFile(process.argv[2], "utf8"));
  const verdicts = grade(report);
  console.log(JSON.stringify(verdicts, null, 2));
  process.exitCode = report.mode === "participant"
    && verdicts.some(row => row.name === participantControlName && row.verdict === "PASS") ? 0 : 1;
}
