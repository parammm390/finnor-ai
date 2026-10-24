import { createHash } from "node:crypto";

export const Z3_VERSION = "z3-public-gr1-v1" as const;
export const PROFILE = Object.freeze({ states: 256, outgoing: 8, assumptions: 2, goals: 2,
  memories: 4, product: 1024, inputBytes: 1_048_576, artifactBytes: 8_388_608,
  operations: 40_000_000, iterants: 65_536, deadlineMs: 10_000 });
export interface ArenaState {
  id: string; owner: "C" | "E"; observation: string; safe: boolean;
  remaining: number; unknown: string[];
}
export interface ArenaEdge {
  from: string; to: string; action: string; renewalRef: string | null; settlementRef: string | null;
}
export interface PublicArena {
  schema: "finnor.z3.public-arena.v1"; id: string;
  observationMode: "PUBLIC_PERFECT_INFORMATION"; states: ArenaState[]; edges: ArenaEdge[];
  initial: string[]; assumptions: string[][]; goals: string[][];
  resources: { capacity: number; maximum: number; obligationIds: string[];
    renewalRefs: string[]; settlementRefs: string[]; unknownOccupiesCapacity: true };
}
export interface OriginalBinding {
  tenantId: string; principalId: string; workId: string; workInputId: string; originalParentId: string;
  sourceRevision: string; rightsRevision: string; mandateDigest: string; observationDigest: string;
  resourceDigest: string; deadlineAt: string; codeDigest: string;
}
export interface Strategy {
  memories: Array<{ a: number; b: number }>; initial: number[];
  /** Global original edge index, -1 exactly at environment vertices. */
  actions: number[][]; updates: number[][];
}
export interface CompleteCandidate {
  schema: "finnor.z3.viability-candidate.v1"; version: typeof Z3_VERSION; disposition: "COMPLETE";
  arenaDigest: string; bindingDigest: string; safetyKernel: number[]; winningRegion: number[];
  certificate: { safety: string[]; gr1: string[] }; strategy: Strategy;
  ordinaryStatus: "WINNING" | "UNREALIZABLE";
  completeness: "COMPLETE_ORDINARY_REGION_NOT_COMPLETE_NONCONFLICTING_SYNTHESIS";
  metrics: { wallMs: number; operations: number; iterants: number; productVertices: number };
}
export interface IncompleteCandidate {
  schema: "finnor.z3.viability-candidate.v1"; version: typeof Z3_VERSION;
  disposition: "UNKNOWN" | "UNSUPPORTED"; reason: string;
  /** Null exactly when the raw input was not digestible JSON (e.g. transport
   * corruption); a null digest is a fail-closed absence of identity. */
  arenaDigest: string | null; bindingDigest: string | null;
  certificate: null; strategy: null; metrics: { wallMs: number; operations: number };
}
export type Candidate = CompleteCandidate | IncompleteCandidate;
export interface CheckReceipt {
  schema: "finnor.z3.independent-check.v1"; status: "VIABLE" | "UNREALIZABLE" | "UNKNOWN" | "REJECTED" | "UNSUPPORTED";
  reason: string; arenaDigest: string | null; bindingDigest: string | null; candidateDigest: string | null;
  ordinaryComplete: boolean; ordinaryStatus?: "WINNING" | "UNREALIZABLE";
  originalAssumptionsSatisfiable?: boolean; nonconflicting?: boolean;
  safety?: boolean; liveness?: boolean; reachable?: number; badSccs?: unknown[];
  metrics?: { wallMs: number; operations: number };
}
export interface SolverLimits { maxOperations?: number; deadlineMs?: number; maxIterants?: number }
export class ViabilityFault extends Error {
  constructor(readonly code: string) { super(code); this.name = "ViabilityFault"; }
}
export function fault(code: string): never { throw new ViabilityFault(code); }
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fault("Z3_NON_JSON_VALUE");
    return encoded;
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
}
export const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fault("Z3_OBJECT_REQUIRED");
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k))) fault("Z3_EXACT_SCHEMA_REQUIRED");
  return r;
}
function ident(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value)) fault("Z3_BOUNDED_PUBLIC_IDENTIFIER_REQUIRED");
  return value;
}
function integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) fault("Z3_INTEGER_BOUND");
  return value;
}
function list(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) fault("Z3_SET_BOUND");
  const result = value.map(ident);
  if (new Set(result).size !== result.length) fault("Z3_DUPLICATE_SET_MEMBER");
  return result;
}
export function parseBinding(value: unknown): OriginalBinding {
  const keys = ["tenantId", "principalId", "workId", "workInputId", "originalParentId", "sourceRevision",
    "rightsRevision", "mandateDigest", "observationDigest", "resourceDigest", "deadlineAt", "codeDigest"] as const;
  const r = record(value, keys);
  for (const key of keys) if (typeof r[key] !== "string" || !(r[key] as string).length || (r[key] as string).length > 256) fault("Z3_ORIGINAL_BINDING_REQUIRED");
  return r as unknown as OriginalBinding;
}
export function parseArena(value: unknown): PublicArena {
  if (Buffer.byteLength(canonical(value)) > PROFILE.inputBytes) fault("Z3_INPUT_BYTE_BOUND");
  const r = record(value, ["schema", "id", "observationMode", "states", "edges", "initial", "assumptions", "goals", "resources"]);
  if (r.schema !== "finnor.z3.public-arena.v1") fault("Z3_ARENA_VERSION");
  if (r.observationMode !== "PUBLIC_PERFECT_INFORMATION") fault("Z3_PARTIAL_OBSERVATION_UNSUPPORTED");
  ident(r.id);
  if (!Array.isArray(r.states) || !r.states.length || r.states.length > PROFILE.states) fault("Z3_STATE_BOUND");
  const states = r.states.map(value => {
    const s = record(value, ["id", "owner", "observation", "safe", "remaining", "unknown"]);
    ident(s.id); ident(s.observation);
    if (!["C", "E"].includes(s.owner as string) || typeof s.safe !== "boolean") fault("Z3_STATE_SEMANTICS");
    integer(s.remaining, 1_000_000_000); list(s.unknown, PROFILE.states);
    return s as unknown as ArenaState;
  });
  const ids = new Set(states.map(s => s.id));
  if (ids.size !== states.length || new Set(states.map(s => s.observation)).size !== states.length) fault("Z3_PARTIAL_OBSERVATION_UNSUPPORTED");
  const resources = record(r.resources, ["capacity", "maximum", "obligationIds", "renewalRefs", "settlementRefs", "unknownOccupiesCapacity"]);
  integer(resources.capacity, PROFILE.states); integer(resources.maximum, 1_000_000_000);
  const obligations = list(resources.obligationIds, PROFILE.states), renewals = list(resources.renewalRefs, PROFILE.states),
    settlements = list(resources.settlementRefs, PROFILE.states);
  if (resources.unknownOccupiesCapacity !== true) fault("Z3_UNKNOWN_CANNOT_RELEASE_CAPACITY");
  for (const state of states) if (state.remaining > (resources.maximum as number)
    || state.unknown.some(id => !obligations.includes(id)) || state.safe && state.unknown.length > (resources.capacity as number)) fault("Z3_ORIGINAL_RESOURCE_STATE");
  if (!Array.isArray(r.edges) || r.edges.length > PROFILE.states * PROFILE.outgoing) fault("Z3_EDGE_BOUND");
  const counts = new Map<string, number>(), actions = new Set<string>();
  for (const value of r.edges) {
    const edge = record(value, ["from", "to", "action", "renewalRef", "settlementRef"]);
    const from = ident(edge.from), to = ident(edge.to), action = ident(edge.action);
    if (!ids.has(from) || !ids.has(to)) fault("Z3_ORIGINAL_EDGE_COVERAGE");
    const key = JSON.stringify([from, action]);
    if (actions.has(key)) fault("Z3_AMBIGUOUS_ACTION");
    actions.add(key); counts.set(from, (counts.get(from) ?? 0) + 1);
    if (counts.get(from)! > PROFILE.outgoing) fault("Z3_OUTGOING_BOUND");
    if (edge.renewalRef !== null && !renewals.includes(ident(edge.renewalRef))) fault("Z3_UNADMITTED_RENEWAL");
    if (edge.settlementRef !== null && !settlements.includes(ident(edge.settlementRef))) fault("Z3_UNADMITTED_SETTLEMENT");
    const a = states.find(s => s.id === from)!, b = states.find(s => s.id === to)!;
    if (b.remaining > a.remaining && edge.renewalRef === null) fault("Z3_INVENTED_RESOURCE_RENEWAL");
    if (a.unknown.some(id => !b.unknown.includes(id)) && edge.settlementRef === null) fault("Z3_UNKNOWN_ERASED_WITHOUT_S6");
  }
  if (states.some(s => !counts.has(s.id))) fault("Z3_EXPLICIT_TOTALIZATION_REQUIRED");
  const initial = list(r.initial, PROFILE.states);
  if (!initial.length || initial.some(id => !ids.has(id))) fault("Z3_ORIGINAL_INITIAL_COVERAGE");
  for (const key of ["assumptions", "goals"] as const) {
    if (!Array.isArray(r[key]) || r[key].length > 2) fault("Z3_JUSTICE_BOUND");
    for (const values of r[key] as unknown[]) if (list(values, PROFILE.states).some(id => !ids.has(id))) fault("Z3_JUSTICE_COVERAGE");
  }
  return r as unknown as PublicArena;
}
export function parseLimits(value: SolverLimits = {}): Required<SolverLimits> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(k => !["maxOperations", "deadlineMs", "maxIterants"].includes(k))) fault("Z3_LIMIT_SCHEMA");
  const result = { maxOperations: value.maxOperations ?? PROFILE.operations,
    deadlineMs: value.deadlineMs ?? PROFILE.deadlineMs, maxIterants: value.maxIterants ?? PROFILE.iterants };
  for (const [key, limit] of Object.entries({ maxOperations: PROFILE.operations, deadlineMs: PROFILE.deadlineMs, maxIterants: PROFILE.iterants })) {
    integer(result[key as keyof typeof result], limit);
    if (result[key as keyof typeof result] < 1) fault("Z3_POSITIVE_LIMIT_REQUIRED");
  }
  return result;
}
