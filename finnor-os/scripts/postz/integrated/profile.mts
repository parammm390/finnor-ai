/** Frozen aggregate observer, separate from every engine's original budget. */
export const INTEGRATED_PROFILE = {
  schema: "finnor.w.integrated-owner-profile.v1",
  requirements: "FINNOR-POSTZ-W-PRD-1.0.0",
  classification: "CONTROLLED_DEV_SHARED_COMPANY_REAL_NATIVE_OWNERS",
  aggregateSeconds: 7200, w3ObserverSeconds: 1200, w1ProgrammeObserverSeconds: 120,
  rationale: "Five 1200-second owner-observer allowances plus 1200 seconds for controlled setup and cleanup; no engine business deadline or resource grant is renewed.",
  admitted: false, productionActive: false, fieldValidated: false,
} as const;

export const NATIVE_OUTPUT_SCHEMAS = {
  W1: "finnor.orchestration-policy-capsule.v1",
  W2: "finnor.workforce-execution-program.v1",
  W3: "finnor.real-world-service.v1",
  W4: "finnor.market-validated-operating-program.v1",
  W5: "finnor.organization-transformation-program.v1",
} as const;

export const NATIVE_CONSUMPTION_PREDICATES = {
  W1: "W049-W1-actual-capsule-native-consumption",
  W2: "W049-W2-actual-workforce-native-consumption",
  W3: "W049-W3-actual-service-native-consumption",
  W4: "W049-W4-actual-market-native-consumption",
  W5: "W049-W5-actual-organization-native-consumption",
} as const;

export const ORIGINAL_CUSTODY_PREDICATE = "W049-shared-business-original-custody";
