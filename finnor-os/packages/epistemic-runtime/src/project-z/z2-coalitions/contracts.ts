import { z } from "zod";
import limits from "./profile.json";
import type { InteractionCandidate, Check } from "../../../../private-equity/src/interaction-synthesis/contracts";
export { canonical, digest, byteDigest, fail } from "../../../../private-equity/src/interaction-synthesis/contracts";

export const Z2_VERSION = "z2-ex-ante-correlated-v1";
export const Z2_PRODUCT_LOCK = "61d9881ca8059d24d057d1e00d5436ef2059de7889ccd1fd2f92a630075bcebf";
export const LIMITS = Object.freeze(limits);
export type CoalitionDisposition = "CHECKED_CANDIDATE" | "COUNTEREXAMPLE" | "CHECKED_INFEASIBLE" |
  "INCOMPLETE" | "UNSUPPORTED" | "STALE" | "REVOKED" | "UNKNOWN";
export interface CoalitionMeters {
  wallMs: number; cpuMs: number; peakRssBytes: number; moneyUsd: null;
  humanSeconds: null; aggregatePeakMemoryBytes: null; status: "PARTIALLY_METERED";
}
export interface CoalitionConstruction {
  schema: "finnor.project-z.z2.construction.v1";
  status: "CANDIDATE" | "CHECKED_INFEASIBLE" | "INCOMPLETE" | "UNSUPPORTED";
  reason: string; problemDigest: string; profileDigest: string; candidate: InteractionCandidate | null;
  certificates: unknown[]; search: { complete: boolean; steps?: number; profiles?: number; policies?: number;
    coalitionChecks?: number; pivots?: number; [key: string]: unknown };
  counterstrategies?: unknown[]; infeasibility?: unknown; meters?: CoalitionMeters;
  processDigest?: string; protectedQualification?: false; executionAuthorityGranted?: false;
}
export interface CoalitionCheck {
  schema: "finnor.project-z.z2.check.v1"; status: CoalitionDisposition; reason: string;
  problemDigest?: string; constructionDigest?: string; candidateDigest?: string; profileDigest: string;
  processDigest?: string; nativeY3?: Check; coverage?: unknown;
  allModels?: boolean; allNonemptyCoalitions?: boolean; nativeFullSequentialAndCommonTremble?: boolean;
  meters?: CoalitionMeters; protectedQualification: false; executionAuthorityGranted: false;
}
export interface CoalitionRuntime {
  schema: "finnor.project-z.z2.runtime.v1"; digest: string; profileDigest: string;
  assets: { path: string; sha256: string }[]; python: { path: string; sha256: string };
  node: { version: string; sha256: string }; nativeProfileDigest: string;
}
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const ConstructionOutput = z.object({
  schema: z.literal("finnor.project-z.z2.construction.v1"),
  status: z.enum(["CANDIDATE", "CHECKED_INFEASIBLE", "INCOMPLETE", "UNSUPPORTED"]),
  reason: z.string(), problemDigest: hex, profileDigest: hex,
  candidate: z.record(z.unknown()).nullable(), certificates: z.array(z.unknown()),
  search: z.object({ complete: z.boolean() }).passthrough(),
  processDigest: hex, protectedQualification: z.literal(false), executionAuthorityGranted: z.literal(false)
}).passthrough();
export const CheckOutput = z.object({
  schema: z.literal("finnor.project-z.z2.check.v1"),
  status: z.enum(["CHECKED_CANDIDATE", "COUNTEREXAMPLE", "CHECKED_INFEASIBLE", "INCOMPLETE", "UNSUPPORTED", "STALE", "REVOKED", "UNKNOWN"]),
  reason: z.string(), profileDigest: hex, processDigest: hex,
  protectedQualification: z.literal(false), executionAuthorityGranted: z.literal(false)
}).passthrough();
