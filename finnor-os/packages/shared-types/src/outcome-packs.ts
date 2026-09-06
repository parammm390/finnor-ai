import type { BusinessEffectOperationClass } from "./business-effects";
import type { CanonicalEntityRef } from "./company-graph";
import type { ObjectiveSuccessCondition } from "./objectives";

export const OUTCOME_PACK_CONTRACT_VERSION = 1 as const;
export const OUTCOME_PACK_AUTONOMY_MODES = ["shadow", "approval", "autopilot"] as const;
export type OutcomePackAutonomyMode = (typeof OUTCOME_PACK_AUTONOMY_MODES)[number];

export const OUTCOME_PACK_IDS = [
  "deal_to_verified_closing_readiness",
  "deal_request_resolution",
  "critical_deal_dependency_resolution",
  "general_operator_objective",
] as const;
export type OutcomePackId = (typeof OUTCOME_PACK_IDS)[number];

export type OutcomeCertificationLevel = "deterministic" | "chaos" | "sandbox" | "live_provider" | "production";
export type OutcomeCertificationStatus = "LOCAL_PASS" | "SANDBOX_PASS" | "LIVE_TEST_PASS" | "BLOCKED_CONFIG" | "NOT_CERTIFIED" | "SUSPENDED";

export interface OutcomePackCapabilityRequirement {
  capability: string;
  required: boolean;
  maxSourceLagMs: number | null;
  acceptedModes: Array<"real" | "sandbox" | "emulator">;
}

export interface OutcomePackSlo {
  metric: string;
  comparison: "eq" | "gte" | "lte";
  threshold: number;
  unit: "count" | "ratio" | "milliseconds" | "seconds";
  critical: boolean;
  rationale: string;
}

export interface OutcomePackDefinition {
  contractVersion: typeof OUTCOME_PACK_CONTRACT_VERSION;
  id: OutcomePackId;
  version: number;
  title: string;
  objectiveClass: string;
  supportedTenantPrerequisites: string[];
  requiredCapabilities: OutcomePackCapabilityRequirement[];
  allowedEffectClasses: BusinessEffectOperationClass[];
  permanentlyApprovalRequiredEffectClasses: BusinessEffectOperationClass[];
  authorityRequirements: string[];
  approvalBoundaries: string[];
  recoveryPaths: string[];
  compensationCapabilities: string[];
  irreversibilityBoundaries: string[];
  evidenceRequirements: string[];
  terminalBlockedConditions: string[];
  verificationRules: string[];
  slos: OutcomePackSlo[];
  dependencyVersions: {
    effectCompiler: number;
    objectiveController: number;
    autonomySemantics: number;
    sourceTruth: number;
    verification: number;
  };
}

export interface OutcomePackStartBinding {
  packId: OutcomePackId;
  packVersion: number;
  mode: OutcomePackAutonomyMode;
  objective: string;
  subjectRefs: CanonicalEntityRef<string>[];
  successCondition: ObjectiveSuccessCondition;
  input: Record<string, unknown>;
  certificationFingerprint: string;
}

export interface OutcomePackGrantScope {
  effectClasses: BusinessEffectOperationClass[];
  resources: Array<{ type: string; ids?: string[] }>;
  principal: string;
  providers: Array<{ provider: string; applicationAccountId?: string }>;
  maxAmountUsd: number | null;
  maxRisk: "low" | "medium" | "high";
  validFrom: string;
  expiresAt: string;
  policyVersion: number | null;
  authorityRevision: number;
  certificationFingerprint: string;
  reviewAfter: string;
}

export interface AutonomyGateResult {
  eligible: boolean;
  outcome: "shadow_only" | "approval_required" | "autopilot_allowed" | "blocked" | "not_pack_work";
  reasonCodes: string[];
  grantId: string | null;
  packId: OutcomePackId | null;
  packVersion: number | null;
  mode: OutcomePackAutonomyMode | null;
  certificationFingerprint: string | null;
  evaluatedAt: string;
}

export interface OutcomeTrustMetrics {
  totalRuns: number;
  verifiedRuns: number;
  verificationCoverage: number;
  verifiedEffectCoverage: number;
  verifiedSuccessRate: number;
  divergentEffects: number;
  divergenceRate: number;
  rejectedActions: number;
  humanRejectionRate: number;
  uncertainOutcomes: number;
  duplicateConsequentialEffects: number;
  policyOrAuthorityViolations: number;
  compensationCount: number;
  manualEscalations: number;
  recoveryRate: number;
}

export interface OutcomeAutonomyReadiness {
  state: "UNCERTIFIED" | "SHADOW_ELIGIBLE" | "APPROVAL_CERTIFIED" | "AUTOPILOT_ELIGIBLE" | "SUSPENDED";
  eligible: boolean;
  gates: Array<{ code: string; passed: boolean; observed: number | string | boolean | null; required: number | string | boolean }>;
  metrics: OutcomeTrustMetrics;
  evaluatedAt: string;
}
