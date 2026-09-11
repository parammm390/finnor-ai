import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IC_CASE_STATES,
  IC_CASE_TRANSITIONS,
  IC_CONDITION_STATES,
  IC_METRICS,
  IC_QUESTION_STATES,
  IC_RECOMMENDATION_OUTCOMES,
  IC_VOTE_CHOICES,
  PE_ENTITY_TYPES,
} from "@finnor/private-equity";
import {
  PRIVATE_EQUITY_ACTION_SCHEMAS,
  PRIVATE_EQUITY_ACTION_TYPES,
} from "../../packages/domain-plugins/private-equity/schemas";
import {
  EXECUTABLE_ACTION_COUNT,
  PRIVATE_EQUITY_ACTION_COUNT,
  PRIVATE_EQUITY_ACTION_HARDENING_SPEC,
} from "../../scripts/release/action-hardening-spec";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

function filesUnder(path: string): string[] {
  const absolute = resolve(ROOT, path);
  return readdirSync(absolute).flatMap((name) => {
    const child = resolve(absolute, name);
    return statSync(child).isDirectory()
      ? filesUnder(`${path}/${name}`)
      : [child];
  });
}

const P5_PLANNER_ACTIONS = [
  "open_ic_case",
  "begin_ic_preparation",
  "select_ic_memo_version",
  "select_ic_underwriting_run",
  "create_ic_question",
  "attach_ic_question_evidence",
  "request_ic_memo_review",
  "satisfy_ic_condition",
  "prepare_ic_decision_proposal",
] as const;

const HUMAN_ONLY = [
  "record_ic_vote",
  "record_ic_dissent",
  "open_ic_voting",
  "close_ic_voting",
  "waive_ic_question",
  "waive_ic_condition",
  "finalize_ic_decision",
] as const;

describe("P5 PE Actions + Investment Committee static contract", () => {
  it("freezes the exact ICCase state vocabulary and explicit transitions", () => {
    expect(IC_CASE_STATES).toEqual([
      "DRAFT", "PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN", "READY_FOR_VOTE", "VOTING",
      "CONDITIONS_PENDING", "DECIDED", "WITHDRAWN", "SUPERSEDED", "BLOCKED",
    ]);
    expect(IC_CASE_TRANSITIONS.DRAFT).toEqual(["PREPARING", "WITHDRAWN"]);
    expect(IC_CASE_TRANSITIONS.DECIDED).toEqual(["SUPERSEDED"]);
    expect(IC_CASE_TRANSITIONS.WITHDRAWN).toEqual([]);
    expect(IC_CASE_TRANSITIONS.SUPERSEDED).toEqual([]);
  });

  it("freezes Question, Condition, Vote and Recommendation semantics", () => {
    expect(IC_QUESTION_STATES).toEqual(["OPEN", "ANSWERED", "RESOLVED", "WAIVED", "SUPERSEDED"]);
    expect(IC_CONDITION_STATES).toEqual(["PROPOSED", "ACTIVE", "SATISFIED", "WAIVED", "FAILED", "SUPERSEDED"]);
    expect(IC_VOTE_CHOICES).toEqual(["APPROVE", "REJECT", "ABSTAIN", "DEFER"]);
    expect(IC_RECOMMENDATION_OUTCOMES).toEqual(["INVEST", "DECLINE", "DEFER", "INVEST_WITH_CONDITIONS", "CONTINUE_DILIGENCE"]);
  });

  it("registers exactly 9 P5 planner-safe actions and keeps sovereign attestations human-only", () => {
    expect(PRIVATE_EQUITY_ACTION_TYPES.slice(0, P5_PLANNER_ACTIONS.length)).toEqual(P5_PLANNER_ACTIONS);
    expect(P5_PLANNER_ACTIONS.every((action) => action in PRIVATE_EQUITY_ACTION_SCHEMAS)).toBe(true);
    expect(HUMAN_ONLY.every((action) => !PRIVATE_EQUITY_ACTION_TYPES.includes(action as never))).toBe(true);
    expect(PRIVATE_EQUITY_ACTION_COUNT).toBe(24);
    expect(PRIVATE_EQUITY_ACTION_HARDENING_SPEC).toHaveLength(24);
    expect(EXECUTABLE_ACTION_COUNT).toBe(41);
  });

  it("rejects tenant and actor selectors from every P5 planner schema", () => {
    for (const action of P5_PLANNER_ACTIONS) {
      const schema = PRIVATE_EQUITY_ACTION_SCHEMAS[action];
      expect(Object.keys(schema.shape)).not.toEqual(expect.arrayContaining(["voterId", "actorId", "tenantId", "memberId"]));
    }
  });

  it("adds only process-state entity types and does not add an IC Decision owner", () => {
    for (const type of ["pe_ic_case", "pe_ic_memo", "pe_ic_question", "pe_ic_recommendation", "pe_ic_vote", "pe_ic_dissent", "pe_ic_condition", "pe_ic_decision_proposal"]) {
      expect(PE_ENTITY_TYPES).toContain(type);
    }
    expect(PE_ENTITY_TYPES).not.toContain("pe_ic_decision" as never);
    expect(PE_ENTITY_TYPES).not.toContain("investment_decision" as never);
  });

  it("keeps P1 recordDecision/finalizeDecision as the sole finalization mutation owner", () => {
    const source = read("packages/private-equity/src/ic-repository.ts");
    expect(source).toMatch(/recordDecisionTx\(client, decisionCtx/);
    expect(source).toMatch(/finalizeDecisionTx\(client, decisionCtx/);
    expect(source).not.toMatch(/INSERT\s+INTO\s+finnor_os\.pe_decisions/i);
  });

  it("creates no duplicate IC Evidence, Artifact, Work, policy or underwriting store", () => {
    const migration = read("packages/db/migrations/0127_pe_actions_ic_runtime.sql");
    expect(migration).not.toMatch(/CREATE TABLE\s+finnor_os\.(?:ic_evidence|ic_documents|ic_work|ic_policies|ic_underwriting|ic_decisions)\b/i);
    expect(migration).toContain("REFERENCES finnor_os.document_versions");
    expect(migration).toContain("REFERENCES finnor_os.underwriting_runs");
    expect(migration).toContain("REFERENCES finnor_os.decision_receipts");
  });

  it("enforces exact P5 table tenancy, forced RLS and least-privilege history mutation", () => {
    const migration = read("packages/db/migrations/0127_pe_actions_ic_runtime.sql");
    const tables = [...migration.matchAll(/CREATE TABLE finnor_os\.(pe_ic_[a-z_]+)/g)].map((match) => match[1]!);
    expect(new Set(tables).size).toBe(13);
    for (const table of new Set(tables)) expect(migration).toContain(`'${table}'`);
    expect(migration).toContain("ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY");
    expect(migration).toContain("ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY");
    expect(migration).toMatch(/REVOKE UPDATE ON[\s\S]*pe_ic_votes/);
    expect(migration).toContain("REVOKE DELETE ON finnor_os.%I FROM finnor_app");
    expect(migration).toMatch(/'pe_ic_votes'[\s\S]*CREATE TRIGGER immutable_ic_history/);
  });

  it("derives Vote and Dissent identity from authenticated canonical employee context", () => {
    const repository = read("packages/private-equity/src/ic-repository.ts");
    const migration = read("packages/db/migrations/0127_pe_actions_ic_runtime.sql");
    const api = read("apps/api/lib/ic.ts");
    expect(repository).toContain("const actorId = canonicalActor(bound)");
    expect(migration).toContain("current_setting('app.pe_actor',true)");
    const voteSchema = api.slice(api.indexOf("export const IcVoteSchema"), api.indexOf("export const IcDissentSchema"));
    expect(voteSchema).not.toMatch(/voterId|memberId|actorId|tenantId/);
    expect(api).toContain("Deliberately no voterId/memberId/actorId/tenantId");
  });

  it("exposes 30 typed routes with a separate authenticated Vote endpoint and no generic PATCH", () => {
    const routes = filesUnder("apps/api/app/api/private-equity/ic").filter((path) => path.endsWith("route.ts"));
    expect(routes).toHaveLength(30);
    expect(routes.some((path) => path.endsWith("/votes/route.ts"))).toBe(true);
    const routeSource = routes.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(routeSource).not.toMatch(/export async function PATCH/);
    expect(routeSource).not.toMatch(/voterId|memberId/);
    expect(routeSource).toMatch(/recordIcVote/);
  });

  it("publishes every P5 route in OpenAPI and the authorization matrix", () => {
    const openapi = JSON.parse(read("openapi.json")) as { paths: Record<string, unknown> };
    const paths = Object.keys(openapi.paths).filter((path) => path.startsWith("/api/private-equity/ic/"));
    expect(paths).toHaveLength(30);
    expect(paths).toContain("/api/private-equity/ic/cases/{id}/votes");
    expect(paths).toContain("/api/private-equity/ic/cases/{id}/decision-proof");
    const matrix = read("docs/authz-matrix.md");
    for (const path of paths) expect(matrix).toContain(path.replace(/\{([^}]+)\}/g, ":$1"));
  });

  it("renders a semantic IC Workspace without raw JSON finance or Decision panels", () => {
    const workspace = read("apps/console/components/ic/IcWorkspaceClient.tsx");
    expect(workspace).toMatch(/Memo and Deck/);
    expect(workspace).toMatch(/Question → Evidence → Work/);
    expect(workspace).toMatch(/Authenticated human attestation/);
    expect(workspace).toMatch(/P1 owns the canonical investment Decision/);
    expect(workspace).not.toMatch(/JSON\.stringify\(workspace|<pre>/);
  });

  it("enforces the certified hard limits in both database and API/domain boundaries", () => {
    const migration = read("packages/db/migrations/0127_pe_actions_ic_runtime.sql");
    expect(migration).toMatch(/member limit exceeded \(50\)/);
    expect(migration).toMatch(/open Question limit exceeded \(100\)/);
    expect(migration).toMatch(/active Condition limit exceeded \(50\)/);
    expect(migration).toMatch(/Recommendation revision limit exceeded \(20\)/);
    expect(migration).toMatch(/Memo\/Deck revision limit exceeded \(20\)/);
    expect(migration).toMatch(/source-link limit exceeded \(100\)/);
  });

  it("exposes the exact metadata-only P5 telemetry contract", () => {
    expect(IC_METRICS).toEqual([
      "ic_cases_opened",
      "ic_case_transition_failures",
      "ic_questions_open",
      "ic_required_questions_blocking",
      "ic_question_waivers",
      "ic_recommendation_revisions",
      "ic_voting_sessions",
      "ic_votes_recorded",
      "ic_vote_conflicts",
      "ic_ineligible_vote_attempts",
      "ic_dissents_recorded",
      "ic_quorum_failures",
      "ic_threshold_failures",
      "ic_conditions_active",
      "ic_condition_waivers",
      "ic_decision_finalizations",
      "ic_decision_finalization_failures",
      "pe_action_grounding_failures",
      "pe_action_authority_failures",
      "pe_action_verification_failures",
      "pe_action_recovery_attempts",
    ]);
    const telemetry = read("packages/private-equity/src/ic-telemetry.ts");
    expect(telemetry).toContain('subsystem: "pe_investment_committee"');
    expect(telemetry).not.toMatch(/memoText|questionAnswer|voteRationale|dissentRationale|evidenceContent|financialValue/);
  });
});
