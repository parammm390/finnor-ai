import { createHash } from "node:crypto";
import type {
  EvidenceKind,
  EvidenceRecord,
  EvidenceSource,
  ExistingTruthClass,
  JsonValue,
  PropositionSubject,
  SourceAuthority,
} from "./contracts";

/** Mirrors OPERATING_TRUTH_PRECEDENCE from @finnor/shared-types exactly. */
export const EXISTING_TRUTH_PRECEDENCE: readonly ExistingTruthClass[] = [
  "CANONICAL",
  "WORK",
  "PROFILE",
  "SESSION",
  "MEMORY",
  "WEB",
] as const;

export const EVIDENCE_KIND_TRUTH_CLASS: Readonly<Record<EvidenceKind, ExistingTruthClass>> = {
  CANONICAL_DB: "CANONICAL",
  ACTIVE_WORK: "WORK",
  EXPLICIT_USER_INPUT: "SESSION",
  PROFILE: "PROFILE",
  SESSION: "SESSION",
  MEMORY: "MEMORY",
  DOCUMENT: "MEMORY",
  /** These observations are useful only as governed Work/evidence records. If an
   * external owner is canonical for a field, the existing source-truth materializer
   * must first write the canonical database; P3 never promotes it itself. */
  PROVIDER_OBSERVATION: "WORK",
  COMPUTER_OBSERVATION: "WORK",
  WEB_RESEARCH: "WEB",
  DERIVED: "MEMORY",
};

const AUTHORITY_RANK: Readonly<Record<SourceAuthority, number>> = {
  CANONICAL_OWNER: 0,
  WORK_LEDGER: 1,
  GOVERNED_OBSERVATION: 2,
  CONFIGURED_PROFILE: 3,
  USER_INTENT_OWNER: 4,
  CURRENT_SESSION: 5,
  DURABLE_EVIDENCE: 6,
  SEMANTIC_MEMORY: 7,
  PUBLIC_RESEARCH: 8,
  DERIVED_ONLY: 9,
};

export function truthClassRank(kind: ExistingTruthClass): number {
  return EXISTING_TRUTH_PRECEDENCE.indexOf(kind);
}

export function sourceAuthorityRank(authority: SourceAuthority): number {
  return AUTHORITY_RANK[authority];
}

export function validateEvidenceSource(source: EvidenceSource): string[] {
  const errors: string[] = [];
  if (EVIDENCE_KIND_TRUTH_CLASS[source.kind] !== source.truthClass) {
    errors.push(`SOURCE_TRUTH_CLASS_MISMATCH:${source.kind}:${source.truthClass}`);
  }
  if (!source.owner.trim()) errors.push("SOURCE_OWNER_REQUIRED");
  if (!source.ref.trim()) errors.push("SOURCE_REF_REQUIRED");
  if (source.kind === "CANONICAL_DB" && source.authority !== "CANONICAL_OWNER") {
    errors.push("CANONICAL_SOURCE_AUTHORITY_REQUIRED");
  }
  if (source.kind !== "CANONICAL_DB" && source.authority === "CANONICAL_OWNER") {
    errors.push("NON_CANONICAL_SOURCE_CANNOT_CLAIM_CANONICAL_AUTHORITY");
  }
  return errors;
}

/** User input owns user intent/choice, but never becomes canonical business state.
 * Outside user-intent propositions the exact existing truth-class order wins. */
export function compareEvidenceAuthority(
  left: EvidenceRecord,
  right: EvidenceRecord,
  subject: PropositionSubject,
): number {
  if (subject.kind === "user_intent") {
    const leftIntent = left.source.authority === "USER_INTENT_OWNER" ? -1 : 0;
    const rightIntent = right.source.authority === "USER_INTENT_OWNER" ? -1 : 0;
    if (leftIntent !== rightIntent) return leftIntent - rightIntent;
  }
  const truth = truthClassRank(left.source.truthClass) - truthClassRank(right.source.truthClass);
  if (truth !== 0) return truth;
  const authority = sourceAuthorityRank(left.source.authority) - sourceAuthorityRank(right.source.authority);
  if (authority !== 0) return authority;
  const leftTime = Date.parse(left.validAt ?? left.observedAt);
  const rightTime = Date.parse(right.validAt ?? right.observedAt);
  if (leftTime !== rightTime) return rightTime - leftTime;
  return left.id.localeCompare(right.id);
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(",")}}`;
}

export function epistemicHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function equalJson(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function evidenceFingerprint(evidence: EvidenceRecord): string {
  return epistemicHash({
    id: evidence.id,
    propositionId: evidence.propositionId,
    tenantId: evidence.tenantId,
    source: evidence.source,
    observedAt: evidence.observedAt,
    validAt: evidence.validAt ?? null,
    ingestedAt: evidence.ingestedAt,
    value: evidence.value,
    confidence: evidence.confidence,
    freshness: evidence.freshness,
    sensitivity: evidence.sensitivity,
    provenance: evidence.provenance,
    canonical: evidence.canonical,
    supersedesEvidenceRefs: evidence.supersedesEvidenceRefs ?? [],
    immutable: evidence.immutable,
  });
}
