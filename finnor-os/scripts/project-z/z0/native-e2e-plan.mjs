/** Closed independently specified obligations, not a model-generated oracle. */
const cases = [
  ...["HARNESS", "ECONOMIC", "CONFIDENTIAL"].map(owner => ({ id: `D1_${owner}_ORIGINAL`, family: "QUERY", outcome: "ORIGINAL_IDENTITY" })),
  ...["FOREIGN_TENANT", "FOREIGN_PRINCIPAL", "WRONG_WORK", "STALE_INPUT", "EXTRA_FIELD",
    "CONFLICTING_IDENTITY", "MISSING_OWNER"].map(reason => ({ id: `D1_REJECT_${reason}`, family: "QUERY", outcome: "REFUSED_NO_NEW_WORK" })),
  { id: "D2_COMPLETE_CANONICAL_INVENTORY", family: "INVENTORY", outcome: "EXACT_LITERAL_DENOMINATOR" },
  { id: "G1_USEFUL_ORIGINAL_OWNER", family: "LEARNING", outcome: "USEFUL_NATIVE_ARGUMENT_AND_INDEPENDENT_OWNER_ROW" },
  { id: "X2_STANDALONE_REMAINS_LAWFUL", family: "STANDALONE", outcome: "CHECKED_MODEL_NO_INSTITUTIONAL_SUBSTITUTION" },
  ...["UNSUPPORTED_MODEL", "INCOMPLETE_MODEL", "PRIVATE_REPLAY", "NO_ORIGINAL_PARENT", "BUDGET_EXHAUSTED",
    "DEADLINE_EXPIRED", "PENDING_LEARNING", "S6_UNKNOWN"].map(reason => ({ id: `G1_REJECT_${reason}`, family: "REFUSAL", outcome: "NO_NEW_LEARNED_OWNER_USE" })),
  ...["INTAKE", "CLAIM", "USE", "DISPATCH"].flatMap(stage =>
    ["RIGHTS", "SOURCE", "TERMS", "CODE", "CHECKER", "CONSUMER", "PARENT"].map(dependency =>
      ({ id: `CURRENT_${stage}_${dependency}`, family: "CURRENTNESS", stage, dependency, outcome: "ACTUAL_CHANGED_DEPENDENCY_REFUSED" }))),
  { id: "MOUNTED_ORIGINAL_WORK_RELOAD", family: "MOUNT", outcome: "AUTHENTICATED_ORIGINAL_IDS_AND_NO_PREDICTED_COMPLETION" },
  { id: "S5_S6_S7_ORIGINAL_ACCOUNTING", family: "ACCOUNTING", outcome: "SAME_PARENT_NO_RENEWAL_UNKNOWN_AND_PHYSICAL_COST" },
  ...["CLAIM", "ARTIFACT", "AMBIGUITY"].map(boundary =>
    ({ id: `RECOVERY_PHYSICAL_${boundary}`, family: "RECOVERY", boundary, outcome: "PHYSICAL_EXIT_RESTART_SAME_BUDGET_AND_NO_EFFECT_REPLAY" })),
];
export const nativePlan = Object.freeze({
  schema: "finnor.project-z.z0.native-e2e-plan.v1",
  phase: "Z0", cases, requiredTargets: ["SOURCE", "INSTALLED"],
  oracle: "PRECOMMITTED_ORIGINAL_STANDING_RULES_FULL_NATIVE_ROWS_LITERAL_INVENTORY_NOT_CANDIDATE_DERIVED",
  provisioning: "FORBIDDEN", fakeAuthOrOwnersOrDatabaseOrQueue: "FORBIDDEN",
  scientificIncrement: false, money: "UNKNOWN", qualificationWithoutAuthority: "NOT_RUN",
});
