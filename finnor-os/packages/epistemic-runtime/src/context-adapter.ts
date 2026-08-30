import type { OperatingContext, OperatingEvidenceKind, OperatingSourceRef } from "@finnor/shared-types";
import type {
  ConfidenceAssessment,
  EpistemicScope,
  EpistemicState,
  EvidenceKind,
  EvidenceRecord,
  EvidenceSource,
  ExistingTruthClass,
  InformationSensitivity,
  JsonValue,
  PropositionDefinition,
  SourceAuthority,
} from "./contracts";
import { EPISTEMIC_HEURISTIC_VERSION } from "./contracts";
import { appendEvidenceAndRecompute, createEvidenceRecord } from "./belief-update";
import { createEpistemicState } from "./state";
import { epistemicHash } from "./source-precedence";

export interface OperatingContextEvidenceBinding {
  proposition: PropositionDefinition;
  /** Dot path within the already assembled OperatingContext. No database reads occur. */
  path: string;
  source?: EvidenceSource;
  sensitivity?: InformationSensitivity;
  maxAgeMs?: number;
  evidenceRole?: EvidenceSource["role"];
}

function asJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items = value.map(asJson);
    return items.every((item) => item !== undefined) ? items as JsonValue[] : undefined;
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const converted = asJson(nested);
      if (converted !== undefined) result[key] = converted;
    }
    return result;
  }
  return undefined;
}

function readPath(root: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((value, segment) => {
    if (Array.isArray(value) && /^\d+$/.test(segment)) return value[Number(segment)];
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, root);
}

function confidence(source: EvidenceSource): ConfidenceAssessment {
  if (source.kind === "CANONICAL_DB") {
    return { level: "VERIFIED", basis: "DETERMINISTIC_SOURCE", heuristicVersion: EPISTEMIC_HEURISTIC_VERSION, reasonCodes: ["EXISTING_CANONICAL_SOURCE"] };
  }
  if (["ACTIVE_WORK", "EXPLICIT_USER_INPUT", "PROFILE", "SESSION", "PROVIDER_OBSERVATION", "COMPUTER_OBSERVATION"].includes(source.kind)) {
    return { level: "HIGH", basis: "SOURCE_ASSERTION", heuristicVersion: EPISTEMIC_HEURISTIC_VERSION, reasonCodes: ["AUDITED_EXISTING_SOURCE"] };
  }
  if (source.kind === "DOCUMENT") {
    return { level: "MEDIUM", basis: "SINGLE_OBSERVATION", heuristicVersion: EPISTEMIC_HEURISTIC_VERSION, reasonCodes: ["DOCUMENT_EVIDENCE"] };
  }
  return { level: "LOW", basis: "SINGLE_OBSERVATION", heuristicVersion: EPISTEMIC_HEURISTIC_VERSION, reasonCodes: ["SUPPORTING_CONTEXT_ONLY"] };
}

function truthClass(kind: OperatingEvidenceKind): ExistingTruthClass {
  return kind;
}

function sourceKind(kind: OperatingEvidenceKind, path: string): EvidenceKind {
  if (kind === "CANONICAL") return "CANONICAL_DB";
  if (kind === "WORK") return "ACTIVE_WORK";
  if (kind === "PROFILE") return "PROFILE";
  if (kind === "SESSION") return "SESSION";
  if (kind === "WEB") return "WEB_RESEARCH";
  return path.includes("document") ? "DOCUMENT" : "MEMORY";
}

function sourceAuthority(kind: EvidenceKind): SourceAuthority {
  switch (kind) {
    case "CANONICAL_DB": return "CANONICAL_OWNER";
    case "ACTIVE_WORK": return "WORK_LEDGER";
    case "EXPLICIT_USER_INPUT": return "USER_INTENT_OWNER";
    case "PROFILE": return "CONFIGURED_PROFILE";
    case "SESSION": return "CURRENT_SESSION";
    case "PROVIDER_OBSERVATION":
    case "COMPUTER_OBSERVATION": return "GOVERNED_OBSERVATION";
    case "DOCUMENT": return "DURABLE_EVIDENCE";
    case "MEMORY": return "SEMANTIC_MEMORY";
    case "WEB_RESEARCH": return "PUBLIC_RESEARCH";
    case "DERIVED": return "DERIVED_ONLY";
  }
}

function findOperatingSource(context: OperatingContext, path: string): OperatingSourceRef | undefined {
  const preferred = path.startsWith("canonicalSummaries") ? "CANONICAL"
    : path.startsWith("activeWork") || path.startsWith("memory.episodic") ? "WORK"
      : path.includes("profile") ? "PROFILE"
        : path.startsWith("memory.semantic") ? "MEMORY"
          : path.startsWith("memory.conversation") || path.startsWith("conversationContext") || path.startsWith("interactionContext") ? "SESSION"
            : path.startsWith("companyDirectory") || path.startsWith("identityAccess") || path.startsWith("integrationHealth") ? "CANONICAL"
              : undefined;
  return preferred ? context.sources.find((source) => source.kind === preferred) : undefined;
}

function inferredSource(context: OperatingContext, binding: OperatingContextEvidenceBinding): EvidenceSource {
  const existing = findOperatingSource(context, binding.path);
  const kind = sourceKind(existing?.kind ?? "SESSION", binding.path);
  return {
    kind,
    owner: existing?.source ?? `operating_context:${binding.path.split(".")[0] ?? "unknown"}`,
    ref: existing?.ref ?? `${context.assembledAt}:${binding.path}`,
    authority: sourceAuthority(kind),
    truthClass: truthClass(existing?.kind ?? "SESSION"),
    role: binding.evidenceRole ?? existing?.role ?? "context_only",
  };
}

function evidenceFromBinding(
  context: OperatingContext,
  scope: EpistemicScope,
  binding: OperatingContextEvidenceBinding,
): EvidenceRecord | undefined {
  const raw = readPath(context, binding.path);
  const value = asJson(raw);
  if (value === undefined || value === null) return undefined;
  const source = binding.source ? { ...binding.source } : inferredSource(context, binding);
  const operatingSource = findOperatingSource(context, binding.path);
  const observedAt = operatingSource?.asOf ?? context.assembledAt;
  return createEvidenceRecord({
    id: `evidence:${epistemicHash({ propositionId: binding.proposition.id, source, observedAt, value }).slice(0, 24)}`,
    propositionId: binding.proposition.id,
    tenantId: scope.tenantId,
    source,
    observedAt,
    validAt: observedAt,
    ingestedAt: context.assembledAt,
    value,
    confidence: confidence(source),
    freshness: {
      status: "FRESH",
      ...(binding.maxAgeMs === undefined ? {} : { maxAgeMs: binding.maxAgeMs }),
      reason: binding.maxAgeMs === undefined ? "Assembled current context; no stronger freshness SLA declared" : "Within binding freshness window at assembly",
    },
    sensitivity: binding.sensitivity ?? "TENANT_INTERNAL",
    provenance: { sourceRef: source.ref, parentEvidenceRefs: [], dependencyRefs: [...(binding.proposition.dependencyRefs ?? [])] },
    canonical: source.kind === "CANONICAL_DB",
  });
}

/** Pure adapter over the current OperatingContext. It creates no database, memory,
 * source, or query path and performs no I/O. */
export function epistemicStateFromOperatingContext(input: {
  context: OperatingContext;
  scope: EpistemicScope;
  bindings: readonly OperatingContextEvidenceBinding[];
  asOf?: string;
}): EpistemicState {
  if (input.context.tenant.id !== input.scope.tenantId) throw new Error("OperatingContext tenant does not match trusted epistemic scope");
  const state = createEpistemicState({
    scope: input.scope,
    asOf: input.asOf ?? input.context.assembledAt,
    propositions: input.bindings.map((binding) => binding.proposition),
  });
  const evidence = input.bindings.flatMap((binding) => {
    const record = evidenceFromBinding(input.context, input.scope, binding);
    return record ? [record] : [];
  });
  return appendEvidenceAndRecompute(state, evidence, input.asOf ?? input.context.assembledAt);
}

export interface SourceEvidenceInput {
  state: EpistemicState;
  propositionId: string;
  value: unknown;
  source: EvidenceSource;
  observedAt: string;
  validAt?: string;
  ingestedAt?: string;
  sensitivity?: InformationSensitivity;
  maxAgeMs?: number;
  parentEvidenceRefs?: string[];
  dependencyRefs?: string[];
  confidence?: ConfidenceAssessment;
}

export function evidenceFromExistingSource(input: SourceEvidenceInput): EvidenceRecord {
  const value = asJson(input.value);
  if (value === undefined) throw new Error("Existing source evidence must be JSON-compatible");
  return createEvidenceRecord({
    id: `evidence:${epistemicHash({ propositionId: input.propositionId, source: input.source, observedAt: input.observedAt, value }).slice(0, 24)}`,
    propositionId: input.propositionId,
    tenantId: input.state.scope.tenantId,
    source: { ...input.source },
    observedAt: input.observedAt,
    ...(input.validAt ? { validAt: input.validAt } : {}),
    ingestedAt: input.ingestedAt ?? input.state.asOf,
    value,
    confidence: input.confidence ?? confidence(input.source),
    freshness: { status: "FRESH", ...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs }), reason: "Observed through an existing audited source adapter" },
    sensitivity: input.sensitivity ?? "TENANT_INTERNAL",
    provenance: {
      sourceRef: input.source.ref,
      parentEvidenceRefs: [...(input.parentEvidenceRefs ?? [])],
      dependencyRefs: [...(input.dependencyRefs ?? [])],
      ...(input.source.kind === "DERIVED" ? { derivation: { ruleId: input.source.owner, version: "1" } } : {}),
    },
    canonical: input.source.kind === "CANONICAL_DB",
  });
}

export function canonicalOperationalQueryEvidence(input: Omit<SourceEvidenceInput, "source"> & {
  intent: string;
  tables: string[];
  executionRef?: string;
}): EvidenceRecord {
  return evidenceFromExistingSource({
    ...input,
    source: {
      kind: "CANONICAL_DB",
      owner: `operational_query:${input.intent}`,
      ref: input.executionRef ?? `canonical_postgres:${[...input.tables].sort().join(",")}:${input.observedAt}`,
      authority: "CANONICAL_OWNER",
      truthClass: "CANONICAL",
      role: "answer_evidence",
    },
  });
}

export function explicitUserInputEvidence(input: Omit<SourceEvidenceInput, "source"> & { inputRef: string }): EvidenceRecord {
  return evidenceFromExistingSource({
    ...input,
    source: {
      kind: "EXPLICIT_USER_INPUT",
      owner: "authenticated_user_input",
      ref: input.inputRef,
      authority: "USER_INTENT_OWNER",
      truthClass: "SESSION",
      role: "answer_evidence",
    },
  });
}

export function providerObservationEvidence(input: Omit<SourceEvidenceInput, "source"> & { observationRef: string }): EvidenceRecord {
  return evidenceFromExistingSource({
    ...input,
    source: {
      kind: "PROVIDER_OBSERVATION",
      owner: "source_truth_observation",
      ref: input.observationRef,
      authority: "GOVERNED_OBSERVATION",
      truthClass: "WORK",
      role: "answer_evidence",
    },
  });
}

export function computerObservationEvidence(input: Omit<SourceEvidenceInput, "source"> & { runRef: string }): EvidenceRecord {
  return evidenceFromExistingSource({
    ...input,
    source: {
      kind: "COMPUTER_OBSERVATION",
      owner: "computer_read_only_observation",
      ref: input.runRef,
      authority: "GOVERNED_OBSERVATION",
      truthClass: "WORK",
      role: "answer_evidence",
    },
  });
}

export function webResearchEvidence(input: Omit<SourceEvidenceInput, "source"> & { citationRef: string }): EvidenceRecord {
  return evidenceFromExistingSource({
    ...input,
    source: {
      kind: "WEB_RESEARCH",
      owner: "web_research",
      ref: input.citationRef,
      authority: "PUBLIC_RESEARCH",
      truthClass: "WEB",
      role: "answer_evidence",
    },
    sensitivity: input.sensitivity ?? "PUBLIC",
  });
}
