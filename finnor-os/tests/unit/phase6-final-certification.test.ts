import { describe, expect, it } from "vitest";
import {
  assertFinalCertificationIntegrity,
  createFinalCertification,
  FINAL_CERTIFICATION_GATE_KEYS,
  gateResult,
  reusableFinalCertification,
} from "../../scripts/release/certification-model";
import {
  evaluateGoldenBusinessSuite,
  GOLDEN_BUSINESS_JOBS,
  GOLDEN_JOB_DISTRIBUTION,
} from "../../scripts/release/golden-business-suite";

const sha = "a".repeat(64);
const gitSha = "b".repeat(40);
const distribution = { ...GOLDEN_JOB_DISTRIBUTION };

describe("Phase 6 final certification", () => {
  it("locks the exact 100-job distribution and truthful unconfigured status", () => {
    const suite = evaluateGoldenBusinessSuite();
    expect(GOLDEN_BUSINESS_JOBS).toHaveLength(100);
    expect(suite.distribution).toEqual(distribution);
    expect(suite.correctResolvePlan).toBe(100);
    expect(suite.correctEndToEnd).toBe(0);
    expect(suite.status).toBe("BLOCKED_CONFIG");
  });

  it("does not treat contract evidence as a requested-outcome assertion", () => {
    const job = GOLDEN_BUSINESS_JOBS[0]!;
    const suite = evaluateGoldenBusinessSuite({
      databaseEvidence: new Set([job.evidenceRef]),
    });
    const result = suite.jobs.find((candidate) => candidate.id === job.id)!;
    expect(result.resolvePlanCorrect).toBe(true);
    expect(result.endToEndCorrect).toBe(false);
    expect(result.status).toBe("BLOCKED_CONFIG");

    const wrong = evaluateGoldenBusinessSuite({
      databaseEvidence: new Set([job.evidenceRef]),
      observedOutcomes: new Map([[job.id, "DENIED" as const]]),
    }).jobs.find((candidate) => candidate.id === job.id)!;
    expect(wrong.status).toBe("FAIL");
    expect(wrong.observedOutcome).toBe("DENIED");
  });

  it("binds final identity to the current suite and rejects stale reuse", () => {
    const score = {
      totalJobs: 100,
      correctResolvePlan: 100,
      correctEndToEnd: 100,
      blockedResolvePlan: 0,
      blockedEndToEnd: 0,
      resolvePlanRate: 1,
      endToEndRate: 1,
      resolvePlanThreshold: 0.98,
      endToEndThreshold: 0.95,
      distribution,
    };
    const artifact = createFinalCertification({
      canonicalGitSha: gitSha,
      sourceTreeHash: sha,
      coreSourceTreeHash: sha,
      migration: { head: "0091_phase6_final_certification.sql", sourceHash: sha, schemaHash: sha },
      actionManifest: { count: 59, generatedHash: sha, sourceHash: sha, generatedPath: "docs/release/generated/action-manifest.json" },
      deployment: {
        contractHash: sha,
        contractSchemaVersion: 2,
        environment: "production",
        canonicalRemote: "origin",
        canonicalBranch: "main",
        components: [{ name: "api", provider: "vercel", projectOrResource: "api", version: "test", commitSha: gitSha, buildId: "test", status: "PASS" }],
        evidence: { apiKey: "must-not-persist", ok: true },
      },
      score,
      zeroTolerance: { status: "PASS", criticalFailures: [], safetyChecks: { receipts: "PASS" } },
      gates: FINAL_CERTIFICATION_GATE_KEYS.map((gate) => gateResult(gate, "PASS", { proof: gate })),
      certifiedAt: "2026-08-22T00:00:00.000Z",
    });
    expect(artifact.certificationId).toMatch(/^finalcert-[0-9a-f]{64}$/);
    expect((artifact.deployment.evidence as Record<string, unknown>).apiKey).toBe("[REDACTED]");
    expect(reusableFinalCertification([artifact], { canonicalGitSha: gitSha, sourceTreeHash: sha })).toEqual(artifact);
    assertFinalCertificationIntegrity(artifact);
    expect(reusableFinalCertification([artifact], { canonicalGitSha: "c".repeat(40), sourceTreeHash: sha })).toBeNull();
  });
});
