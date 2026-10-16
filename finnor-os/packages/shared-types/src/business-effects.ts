export const BUSINESS_EFFECT_SCHEMA_VERSION = 1 as const;

export type BusinessEffectOperationClass =
  | "internal_draft"
  | "internal_write"
  | "operational_change"
  | "financial_write"
  | "external_side_effect"
  | "external_spend"
  | "batch_external"
  | "durable_workflow";

export type BusinessEffectVerificationState =
  | "not_started"
  | "verified"
  | "partially_verified"
  | "unverified"
  | "divergent"
  | "reconciliation_required";

export interface BusinessEffectRef {
  id: string;
  semanticHash: string;
  schemaVersion: typeof BUSINESS_EFFECT_SCHEMA_VERSION;
}

export interface BusinessEffectTarget {
  kind: "entity" | "party" | "resource";
  type: string;
  id: string;
  sourcePath: string;
}

export interface BusinessEffectBinding {
  selection: "fixed" | "policy_resolved";
  application?: string;
  provider?: string | null;
  tenantIntegrationId?: string;
  applicationAccountId?: string;
  authProfileId?: string;
  authProfileRef?: string;
  communicationIdentityId?: string;
}

export interface BusinessEffectStateSnapshot {
  target: Pick<BusinessEffectTarget, "kind" | "type" | "id">;
  /** Deliberately bounded business fields only; never credentials or unrestricted rows. */
  values: Record<string, unknown>;
  versionHash: string;
  observedAt: string;
}

export interface BusinessEffectPrecondition {
  kind: "exists" | "state_version" | "binding_version";
  target: Pick<BusinessEffectTarget, "kind" | "type" | "id">;
  expectedHash?: string;
  description: string;
}

export interface BusinessEffectSet {
  id: string;
  schemaVersion: typeof BUSINESS_EFFECT_SCHEMA_VERSION;
  semanticHash: string;
  scopeHash: string;
  source: {
    domainActionId: string;
    actionType: string;
    workId: string | null;
    objectiveStepId: string | null;
  };
  mode: "consequential";
  operation: {
    name: string;
    class: BusinessEffectOperationClass;
    external: boolean;
  };
  targets: BusinessEffectTarget[];
  bindings: BusinessEffectBinding[];
  preconditions: BusinessEffectPrecondition[];
  before: BusinessEffectStateSnapshot[];
  /** The approved business change. Provider routes and UI/browser primitives do not belong here. */
  delta: {
    operation: string;
    values: Record<string, unknown>;
  };
  expected: {
    observation: "canonical_state" | "provider_delivery" | "computer_state" | "workflow_completion" | "recorded_result";
    state: Record<string, unknown> | null;
  };
  exposure: { amount: number; currency: string } | null;
  authority: {
    capability: string;
    risk: "low" | "medium" | "high";
    policyId: string | null;
    policyVersion: number | null;
  };
  approval: {
    required: boolean;
    typedConfirmation: boolean;
    summary: string;
  };
  reversibility: {
    classification: "safely_reversible" | "compensatable" | "irreversible" | "unknown_provider_dependent";
    compensationCapability: string | null;
  };
  uncertainty: {
    unknownOutcome: "reconcile_before_retry";
    stalePrecondition: "block_and_recompile";
  };
  provenance: {
    compiler: "finnor_effect_compiler";
    compilerVersion: 1;
    compiledAt: string;
    replacementForEffectId: string | null;
    compensationForEffectId: string | null;
  };
}

export interface BusinessEffectVerification {
  state: BusinessEffectVerificationState;
  basis: string;
  checkedAt: string;
  observed?: Record<string, unknown>;
}
