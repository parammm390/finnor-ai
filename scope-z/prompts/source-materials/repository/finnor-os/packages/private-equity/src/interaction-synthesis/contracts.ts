import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { q } from "./exact.js";

export const Y3_VERSION = "interaction-synthesis-v1";
export class InteractionFault extends Error {
  constructor(public readonly code: string, public readonly status = 422) { super(code); this.name = "InteractionFault"; }
}
export function fail(code: string, status = 422): never { throw new InteractionFault(code, status); }
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map(k => JSON.stringify(k) + ":" + canonical(record[k])).join(",") + "}";
  }
  return fail("Y3_NON_JSON_VALUE");
}
export const byteDigest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const digest = (value: unknown) => byteDigest(canonical(value));
export const ASSET_ROOT = resolve(process.env.FINNOR_Y3_ASSET_ROOT ?? dirname(fileURLToPath(import.meta.url)));
const profileBytes = readFileSync(resolve(ASSET_ROOT, "profile.json"));
export const PROFILE = Object.freeze(JSON.parse(profileBytes.toString()) as {
  maxModels: number; maxNodesPerModel: number; maxActions: number; maxProtocolControls: number;
  maxProtocolOptions: number; maxObservationsPerNode: number; maxRequestBytes: number;
  maxArtifactBytes: number; maxSearchSteps: number; maxArithmeticBits: number;
  maxProcessWallMs: number; maxProcessMemoryBytes: number; maxProcessOutputBytes: number;
  prescribedBehaviorGrid: string[]; protocol_horizon_and_deviation_classes: { maxInformationSetsPerParty: number };
});
export const PROFILE_DIGEST = byteDigest(profileBytes);
const text = z.string().min(1).max(256);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/)
  .refine(v => !["__proto__", "prototype", "constructor"].includes(v), "Y3_RESERVED_IDENTIFIER");
const rational = z.string().max(2500).refine(v => { try { q(v); return true; } catch { return false; } }, "Y3_EXACT_RATIONAL_REQUIRED");
export const RefSchema = z.object({
  owner: text, id: z.string().min(1).max(1024), version: text, contentDigest: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
export type Y3Ref = z.infer<typeof RefSchema>;
export const BasisSchema = z.object({
  unit: text, currency: z.string().regex(/^[A-Z]{3}$/).nullable(), timeBasis: text, owner: text,
  rounding: z.literal("EXACT"), sourceStatus: z.enum(["SUPPLIED_MODEL", "CANONICAL_OBSERVATION", "UNKNOWN"]),
  sourceRef: RefSchema
}).strict();
export const QuantitySchema = z.object({
  value: rational.nullable(), basis: BasisSchema, unknownReason: text.optional()
}).strict().superRefine((v, ctx) => {
  if (v.value === null && !v.unknownReason) ctx.addIssue({ code: "custom", message: "Y3_UNKNOWN_REASON_REQUIRED" });
});
const party = z.enum(["P0", "P1"]);
const recipient = z.enum(["P0", "P1", "PUBLIC"]);
const date = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const edge = z.object({ actionId: identifier, next: identifier }).strict();
const common = {
  id: identifier, date, state: z.tuple([z.union([z.literal(0), z.literal(1)]), z.union([z.literal(0), z.literal(1)])]),
  observations: z.array(z.object({
    key: identifier, value: z.string().max(4096), recipients: z.array(recipient).min(1).max(3)
  }).strict()).max(PROFILE.maxObservationsPerNode),
  resources: z.record(identifier, rational), payments: z.tuple([rational, rational]), liabilities: z.tuple([rational, rational])
};
export const NodeSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("CHANCE"), chanceRole: z.enum(["PRIOR", "TRANSITION", "SIGNAL"]),
    probabilityBasis: z.object({ population: text, conditioning: text, identificationRef: RefSchema }).strict(),
    edges: z.array(edge.extend({ probability: rational.nullable() }).strict()).min(1).max(PROFILE.maxActions) }).strict(),
  z.object({ ...common, kind: z.literal("DECISION"), participant: party,
    edges: z.array(edge).min(1).max(PROFILE.maxActions), informationSet: identifier.optional() }).strict(),
  z.object({ ...common, kind: z.literal("PROTOCOL"), controlId: identifier,
    edges: z.array(edge).min(1).max(PROFILE.maxProtocolOptions) }).strict(),
  z.object({ ...common, kind: z.literal("TERMINAL"), payoff: z.tuple([rational.nullable(), rational.nullable()]),
    ownerValue: rational.nullable() }).strict()
]);
export type Node = z.infer<typeof NodeSchema>;
export const ProblemSchema = z.object({
  schema: z.literal("finnor.interaction-problem.v1"), id: identifier, title: text,
  participants: z.tuple([
    z.object({ id: z.literal("P0"), principalId: z.string().uuid(), outsideOption: QuantitySchema }).strict(),
    z.object({ id: z.literal("P1"), principalId: z.string().uuid(), outsideOption: QuantitySchema }).strict()
  ]),
  dates: z.tuple([z.string().datetime({ offset: true }), z.string().datetime({ offset: true }), z.string().datetime({ offset: true })]),
  fixedOperatorRefs: z.array(RefSchema).min(1).max(64), actorModelRefs: z.array(RefSchema).min(1).max(64),
  quantityBasis: z.object({ utilities: z.tuple([BasisSchema, BasisSchema]), ownerValue: BasisSchema }).strict(),
  financialLimits: z.object({
    absolutePayments: z.tuple([QuantitySchema, QuantitySchema]),
    liabilities: z.tuple([QuantitySchema, QuantitySchema]),
    semantics: z.literal("SIGNED_NODE_SNAPSHOTS_NO_IMPLICIT_NETTING_OR_UTILITY_CONVERSION")
  }).strict(),
  observationRules: z.array(z.object({
    key: identifier, allowedRecipients: z.array(recipient).min(1).max(3), mandatoryByDate: date.nullable(),
    classification: z.enum(["SOURCED_FACT", "AUTHENTICATED_ASSERTION", "MODEL_RELATIVE_STATEMENT", "UNRESOLVED_CLAIM"]),
    sourceRef: RefSchema
  }).strict()).max(64),
  controls: z.array(z.object({
    id: identifier, kind: z.enum(["DISCLOSURE", "COMMUNICATION", "COMMITMENT_TIMING"]),
    options: z.array(identifier).min(1).max(PROFILE.maxProtocolOptions)
  }).strict()).max(PROFILE.maxProtocolControls),
  models: z.array(z.object({
    id: identifier, qualificationRef: RefSchema, root: identifier,
    nodes: z.array(NodeSchema).min(1).max(PROFILE.maxNodesPerModel)
  }).strict()).min(1).max(PROFILE.maxModels),
  resourceLimits: z.record(identifier, QuantitySchema),
  goal: z.object({ minimumOwnerValue: QuantitySchema, requireNontrivial: z.boolean() }).strict()
}).strict().superRefine((v, ctx) => {
  if (!(Date.parse(v.dates[0]) < Date.parse(v.dates[1]) && Date.parse(v.dates[1]) < Date.parse(v.dates[2])))
    ctx.addIssue({ code: "custom", message: "Y3_ORDERED_DATES_REQUIRED" });
  if (v.participants[0].principalId === v.participants[1].principalId)
    ctx.addIssue({ code: "custom", message: "Y3_DISTINCT_PRINCIPALS_REQUIRED" });
});
export type InteractionProblem = z.infer<typeof ProblemSchema>;
export type InteractionModel = InteractionProblem["models"][number];
export type InteractionCandidate = {
  schema: "finnor.interaction-candidate.v1"; problemDigest: string; profileDigest: string;
  policy: Record<string, string>; strategy: Record<string, Record<string, string>>;
  models: { modelId: string; beliefs: Record<string, Record<string, string>>;
    trembles: Record<string, Record<string, { order: number; coefficient: string }>> }[];
  objective: string; upperBound: string; nontrivial: boolean;
  [key: string]: unknown;
};
export type ConstructionResult = {
  status: "CANDIDATE" | "INCOMPLETE" | "INFEASIBLE" | "UNIDENTIFIED" | "UNSUPPORTED" | "UNKNOWN";
  candidate: InteractionCandidate | null; reasons: string[];
  search: { steps: number; policies: number; profiles: number; complete: boolean; [key: string]: unknown };
};
export type Check = {
  schema: "finnor.interaction-check.v1";
  status: "CHECKED" | "INFEASIBLE" | "REJECTED" | "UNKNOWN" | "INCOMPLETE";
  problemDigest?: string; candidateDigest?: string; profileDigest?: string; checkerDigest?: string; reason?: string;
  models?: unknown[]; maxRegret?: string; globalBeliefConsistency?: boolean; fullDeviationCoverage?: boolean;
  informationValid?: boolean; participationValid?: boolean; resourcesValid?: boolean; nontrivial?: boolean;
  counterstrategy?: unknown; wallMs?: number; cpuMs?: number; peakRssBytes?: number;
  protectedQualification: false; executionAuthorityGranted: false;
  [key: string]: unknown;
};
export type RuntimeIdentity = {
  profileDigest: string; producerDigest: string; checkerDigest: string; codeDigest: string;
  interpreter: { path: string; sha256: string | null }; sourcePins: { path: string; sha256: string }[];
};
