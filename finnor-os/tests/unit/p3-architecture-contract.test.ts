import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EPISTEMIC_HEURISTIC_VERSION,
  EPISTEMIC_STATE_VERSION,
  EPISTEMIC_TRACE_VERSION,
  EVIDENCE_KIND_TRUTH_CLASS,
  EXISTING_TRUTH_PRECEDENCE,
} from "../../packages/epistemic-runtime/src/index";

const root = resolve(import.meta.dirname, "../..");
const contract = JSON.parse(readFileSync(resolve(root, "architecture/p3/epistemic-runtime-contract.json"), "utf8")) as Record<string, any>;
const audit = JSON.parse(readFileSync(resolve(root, "architecture/p3/pre-change-reference-inventory.json"), "utf8")) as Record<string, any>;
const corpus = JSON.parse(readFileSync(resolve(root, "architecture/p3/replay-corpus.json"), "utf8")) as Record<string, any>;
const gates = JSON.parse(readFileSync(resolve(root, "architecture/p3/hard-gates.json"), "utf8")) as {
  gates: Array<{ id: string; expected: number; evidence: Array<{ file: string; title: string }> }>;
};

describe("P3 Epistemic Runtime architecture contract", () => {
  it("locks explicit belief states, evidence taxonomy, exact P0 precedence, and separate canonical truth", () => {
    expect(EPISTEMIC_STATE_VERSION).toBe(1);
    expect(EPISTEMIC_TRACE_VERSION).toBe(1);
    expect(EPISTEMIC_HEURISTIC_VERSION).toBe("p3-information-value-v1");
    expect(contract.epistemicState).toMatchObject({
      version: 1,
      propositionStatuses: ["KNOWN", "UNKNOWN", "STALE", "CONFLICTING", "UNCERTAIN"],
      canonicalTruthSeparateFromBelief: true,
    });
    expect(contract.evidence.taxonomy).toEqual(Object.keys(EVIDENCE_KIND_TRUTH_CLASS));
    expect(contract.truthPrecedence.exactExistingOrder).toEqual(EXISTING_TRUTH_PRECEDENCE);
    expect(contract.truthPrecedence.lowerSourceCanOverrideCanonical).toBe(false);
  });

  it("locks typed read-only acquisition, safety-first scoring, bounded stopping, P2 monotonicity, and trace redaction", () => {
    expect(contract.informationActions).toMatchObject({
      kinds: ["READ", "RETRIEVE", "ASK", "INSPECT", "RESEARCH", "WAIT"],
      mutability: "READ_ONLY",
      vendorAgnosticSemantics: true,
    });
    expect(contract.decisionValue.ordering).toEqual([
      "safety_legality",
      "decision_relevance",
      "expected_uncertainty_reduction",
      "user_interruption",
      "latency",
      "cost",
      "privacy_failure",
    ]);
    expect(contract.stopAndBudget.budgets).toEqual(["maxActions", "maxUserInterruptions", "maxLatencyMs", "maxCostUnits", "deadline"]);
    expect(contract.p2Handoff.REJECTED).toContain("without acquisition or rerun");
    expect(contract.trace).toMatchObject({ redaction: "STRUCTURED_DECISIONS_ONLY" });
    expect(contract.trace.excludes).toContain("chain-of-thought");
  });

  it("records the exact current-head source audit and no parallel truth, memory, authority, or BusinessEffect owner", () => {
    expect(audit).toMatchObject({
      auditKind: "P3_PRE_CHANGE_CURRENT_HEAD_AUDIT",
      workspaceHeadAtAudit: "8fcd8a1cebcf92791047777c0d9c70e95fc7aad2",
      p3BaselineSha: "8fcd8a1cebcf92791047777c0d9c70e95fc7aad2",
      p2ClosureStatusAtAudit: "RUNNING_NO_P2_CLOSURE_PASS",
      p2LocalCertifiedShaAtAudit: "856c0cc370adc35490b18f9dc1d7244bcf46266f",
      reuseDecision: {
        newContextDatabase: false,
        newMemorySystem: false,
        newCanonicalTruthOwner: false,
        newAuthoritySystem: false,
        newBusinessEffectIdentity: false,
      },
    });
    expect(audit.exactOwners).toHaveLength(15);
  });

  it("locks all 20 zero-tolerance gates to executable evidence and the exact frozen corpus", () => {
    expect(gates.gates).toHaveLength(20);
    expect(new Set(gates.gates.map((gate) => gate.id)).size).toBe(20);
    for (const gate of gates.gates) {
      expect(gate.expected, gate.id).toBe(0);
      expect(gate.evidence.length, gate.id).toBeGreaterThan(0);
      for (const evidence of gate.evidence) {
        const evidencePath = resolve(root, evidence.file);
        if (!existsSync(evidencePath)) {
          // The pure P3 branch intentionally predates P2 closure. The final P3
          // certifier has no exception: it requires all prior-phase evidence after
          // reconciliation onto the certified P2 lineage.
          expect(["P0_invariant_regressions", "P1_invariant_regressions", "P2_invariant_regressions"]).toContain(gate.id);
          expect(audit.p2ClosureStatusAtAudit).toBe("RUNNING_NO_P2_CLOSURE_PASS");
          continue;
        }
        expect(readFileSync(evidencePath, "utf8"), `${gate.id}:${evidence.file}`).toContain(evidence.title);
      }
    }
    expect(corpus).toMatchObject({
      fixedClock: "2026-08-31T00:00:00.000Z",
      fixedSeed: 31082026,
      extensionCases: 24,
      fixtureSha256: "ce3632ddf4c3a004347d365361ae307d04257c22ba31672c5fea178ec70c42fc",
      liveExternalDependencies: 0,
    });
  });
});
