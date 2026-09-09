export const UNDERWRITING_FAILURE_CODES = [
  "MODEL_NOT_FOUND",
  "MODEL_VERSION_NOT_FOUND",
  "MODEL_SCHEMA_INVALID",
  "MODEL_SEMANTIC_HASH_MISMATCH",
  "INPUT_SEMANTIC_HASH_MISMATCH",
  "RESULT_SEMANTIC_HASH_MISMATCH",
  "MODEL_TOO_LARGE",
  "DUPLICATE_NODE",
  "MISSING_DEPENDENCY",
  "TYPE_MISMATCH",
  "UNIT_MISMATCH",
  "CURRENCY_MISMATCH",
  "PERIOD_MISMATCH",
  "INVALID_PERIOD",
  "PERIOD_LIMIT",
  "UNDECLARED_CYCLE",
  "INVALID_SOLVER_BLOCK",
  "NON_CONVERGENT",
  "MISSING_REQUIRED_INPUT",
  "UNKNOWN_INPUT",
  "STALE_INPUT",
  "CONFLICTING_INPUT",
  "UNSUPPORTED_INPUT",
  "INVALID_DECIMAL",
  "DECIMAL_LIMIT",
  "DIVIDE_BY_ZERO",
  "UNSUPPORTED_EXPRESSION",
  "AST_DEPTH_LIMIT",
  "SOURCES_USES_IMBALANCE",
  "OWNERSHIP_MISMATCH",
  "DEBT_ROLL_FORWARD_MISMATCH",
  "NEGATIVE_DEBT",
  "PAYDOWN_EXCEEDS_PRINCIPAL",
  "CASH_SWEEP_EXCEEDED",
  "REVOLVER_EXHAUSTED",
  "LIQUIDITY_SHORTFALL",
  "MODEL_UNSUPPORTED_MATURITY",
  "EXIT_METRIC_MISSING",
  "EXIT_BRIDGE_MISMATCH",
  "NEGATIVE_EXIT_EQUITY",
  "SPONSOR_CASH_FLOW_INVALID",
  "MOIC_UNDEFINED",
  "IRR_UNDEFINED",
  "IRR_AMBIGUOUS",
  "SCENARIO_INVALID_TARGET",
  "SCENARIO_LIMIT",
  "SENSITIVITY_LIMIT",
  "SENSITIVITY_PARTIAL_FAILURE",
  "RESULT_LIMIT",
  "UNSUPPORTED_CAPABILITY",
  "ARTIFACT_NOT_SPREADSHEET",
  "ARTIFACT_ANCHOR_CONFLICT",
  "ARTIFACT_VERSION_CONFLICT",
  "ARTIFACT_CALCULATION_STALE",
  "ARTIFACT_CALCULATION_UNKNOWN",
  "ARTIFACT_VALUE_UNSUPPORTED",
  "ARTIFACT_VALUE_MISMATCH",
  "IDEMPOTENCY_CONFLICT",
] as const;

export type UnderwritingFailureCode = (typeof UNDERWRITING_FAILURE_CODES)[number];

export class UnderwritingError extends Error {
  readonly name = "UnderwritingError";

  constructor(
    public readonly code: UnderwritingFailureCode,
    message: string = code,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export function fail(
  code: UnderwritingFailureCode,
  message?: string,
  details: Record<string, unknown> = {},
): never {
  throw new UnderwritingError(code, message ?? code, Object.freeze({ ...details }));
}

export function asUnderwritingFailure(error: unknown): {
  code: UnderwritingFailureCode;
  message: string;
  details: Readonly<Record<string, unknown>>;
} {
  if (error instanceof UnderwritingError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return {
    code: "MODEL_SCHEMA_INVALID",
    message: error instanceof Error ? error.message : "Unknown underwriting failure",
    details: {},
  };
}
