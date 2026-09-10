export type IcRecord = Record<string, unknown> & { id?: string };

export interface IcAggregation {
  inputHash: string;
  eligibleVoterIds: string[];
  effectiveVotes: Array<{ id: string; employeeId: string; choice: string; recordedAt: string }>;
  counts: { eligible: number; participating: number; approve: number; reject: number; abstain: number; defer: number; thresholdDenominator: number };
  quorum: { status: string; required: number; actual: number };
  threshold: { status: string; requiredApprovals: number | null; actualApprovals: number; rule: { kind: string } };
  process: { status: string; blockers: string[] };
  proposedOutcome: string | null;
}

export interface IcWorkspace {
  viewer: { employeeId: string | null };
  case: IcRecord & {
    id: string;
    dealId: string;
    investmentCaseId: string;
    state: string;
    version: number;
    voteSetVersion: number;
    votingBasisVersion: number | null;
    primaryUnderwritingRunId: string | null;
  };
  investmentCase: IcRecord & { id: string; title?: string; summary?: string | null; state?: string; version?: number };
  committee: { config: IcRecord; members: IcRecord[] };
  memo: IcRecord | null;
  deck: IcRecord | null;
  artifacts: { memo: IcRecord | null; deck: IcRecord | null };
  underwriting: {
    run: IcRecord & { id?: string; status?: string; validity?: string; resultHash?: string; modelVersionId?: string; scenarioId?: string | null; worldAt?: string };
    checks: IcRecord[];
    eligibleUnderPinnedPolicy: boolean;
    eligibilityBlockers: string[];
  } | null;
  questions: Array<IcRecord & { id: string; state?: string; version?: number; question?: string; answer?: string | null; substantiationStatus?: string; requiredBeforeVote?: boolean; requiredBeforeDecision?: boolean; sources: IcRecord[] }>;
  recommendations: IcRecord[];
  currentRecommendation: (IcRecord & { id?: string; revision?: number; outcome?: string; rationale?: string; memoId?: string; underwritingRunId?: string }) | null;
  votes: Array<IcRecord & { id: string; employeeId?: string; recommendationId?: string; choice?: string; rationale?: string | null; recordedAt?: string }>;
  dissents: Array<IcRecord & { id: string; employeeId?: string; rationale?: string; sources: IcRecord[] }>;
  conditions: Array<IcRecord & { id: string; title?: string; description?: string; conditionType?: string; state?: string; version?: number; ownerEmployeeId?: string; required?: boolean; evidenceRequired?: boolean; sources: IcRecord[] }>;
  decisionProposal: IcRecord | null;
  decision: (IcRecord & { title?: string; decision?: string; rationale?: string; state?: string; decidedAt?: string; supersedesDecisionId?: string | null }) | null;
  decisionProof: IcRecord | null;
  readiness: { votingEligible: boolean; decisionEligible: boolean; blockers: string[]; aggregation: IcAggregation | null };
  controls: Record<string, boolean>;
  controlBlockers: Record<string, string[]>;
  asOf: string;
}

export interface IcCaseSummary extends IcRecord {
  id: string;
  investmentCaseId: string;
  investmentCaseTitle?: string;
  investmentCaseSummary?: string | null;
  state?: string;
  version?: number;
  underwritingValidity?: string | null;
  recommendationOutcome?: string | null;
  finalDecisionId?: string | null;
  updatedAt?: string;
}

export function shortId(value: unknown, length = 10): string {
  const text = typeof value === "string" ? value : "";
  return text ? `${text.slice(0, length)}${text.length > length ? "…" : ""}` : "—";
}

export function readable(value: unknown): string {
  return String(value ?? "—").replaceAll("_", " ");
}

export function icStatusClass(value: unknown): string {
  const status = String(value ?? "");
  if (/DECIDED|READY|VALID|SUCCEEDED|SATISFIED|RESOLVED|APPROVE|QUORUM_MET|THRESHOLD_MET|PROCESS_ELIGIBLE|COMPLETE/i.test(status)) return "ic-pill good";
  if (/BLOCKED|INVALID|FAILED|REJECT|CONFLICT|STALE|MISSING|NOT_MET|INCOMPLETE|NON_CONVERGENT/i.test(status)) return "ic-pill bad";
  if (/VOTING|OPEN|PENDING|PREPARING|DEFER|ABSTAIN|UNKNOWN|WAIVED/i.test(status)) return "ic-pill warn";
  return "ic-pill";
}
