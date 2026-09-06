import type {
  ComputerAuthorizedEffect,
  ComputerProviderCapability,
  ComputerRunLimits,
  ComputerTaskInput,
} from "@finnor/shared-types";

export interface ComputerSessionAuth {
  /** Credential-sensitive provider profile handle. Never serialize. */
  profileId?: string;
  /** Credential-sensitive provider credential namespace. Never serialize. */
  namespace?: string;
}

export interface ComputerOriginPolicy {
  homeUrl: string;
  allowedOrigins: readonly string[];
  authOrigins: readonly string[];
}

export interface ComputerSessionRequest {
  tenantId: string;
  runId: string;
  auth: ComputerSessionAuth;
  mode: ComputerTaskInput["mode"];
  origins: ComputerOriginPolicy;
  limits: ComputerRunLimits;
}

/** Provider-internal session data. sessionRef/cdpUrl/liveViewUrl are credential-
 * sensitive operational handles and are excluded from every public projection. */
export interface ComputerProviderSession {
  sessionRef: string;
  /** Internal only; lets a recovered provider re-install the same mutation guard. */
  executionMode?: ComputerTaskInput["mode"];
  downloadLimitBytes?: number;
  cdpUrl?: string;
  liveViewUrl?: string;
}

export type ComputerLocator =
  | { kind: "role"; role: string; name: string; exact?: boolean }
  | { kind: "label"; label: string; exact?: boolean }
  | { kind: "text"; text: string; exact?: boolean }
  | { kind: "test_id"; testId: string }
  | { kind: "css"; selector: string };

export interface StructuredPageElement {
  id: string;
  role: string | null;
  name: string | null;
  text: string | null;
  disabled: boolean;
  inputKind: string | null;
  /** Safe layout geometry for bounded coordinate fallback; never includes values. */
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface StructuredPageObservation {
  url: string;
  title: string;
  text: string;
  elements: StructuredPageElement[];
  openPageUrls: string[];
}

/** Primitives are deliberately package-private to the Computer Runner. No business
 * planner schema imports this union. */
export type ComputerPrimitive =
  | { kind: "navigate"; url: string }
  | { kind: "click"; locator: ComputerLocator }
  | { kind: "type"; locator: ComputerLocator; text: string }
  | { kind: "press"; locator?: ComputerLocator; key: string }
  | { kind: "wait"; milliseconds: number }
  | { kind: "screenshot" }
  | { kind: "visual_click"; x: number; y: number }
  | { kind: "visual_type"; text: string }
  | { kind: "download"; filename?: string };

export interface ComputerPrimitiveResult {
  summary: string;
  pageUrl?: string;
  screenshot?: Uint8Array;
  download?: { filename: string; mimeType: string; bytes: Uint8Array };
}

export interface ComputerProviderCost {
  creditsUsed: number;
}

export interface ComputerProvider {
  readonly name: string;
  readonly capabilities: ReadonlySet<ComputerProviderCapability>;
  createSession(request: ComputerSessionRequest): Promise<ComputerProviderSession>;
  observe(session: ComputerProviderSession, origins: ComputerOriginPolicy): Promise<StructuredPageObservation>;
  perform(session: ComputerProviderSession, primitive: ComputerPrimitive, origins: ComputerOriginPolicy): Promise<ComputerPrimitiveResult>;
  cost(session: ComputerProviderSession): Promise<ComputerProviderCost>;
  release(session: ComputerProviderSession): Promise<void>;
}

export interface ComputerDecisionContext {
  task: ComputerTaskInput;
  observation: StructuredPageObservation;
  stepNumber: number;
  effectStatus: "none" | "pending" | "dispatching" | "succeeded" | "failed" | "unknown";
}

export type ComputerRunnerDecision =
  | { kind: "act"; summary: string; primitive: ComputerPrimitive }
  | { kind: "effect"; summary: string; effect: ComputerAuthorizedEffect; primitive: ComputerPrimitive }
  | { kind: "complete"; summary: string; result: Record<string, unknown>; evidenceText: string }
  | { kind: "block"; summary: string; reason: string; code: string };

/** This micro-planner chooses execution primitives only. It cannot change tenant,
 * actor, application, auth profile, business task, limits, or authorized effect. */
export interface ComputerDecisionEngine {
  decide(context: ComputerDecisionContext): Promise<ComputerRunnerDecision>;
}

export type ComputerRunTerminal =
  | { status: "succeeded"; result: Record<string, unknown> }
  | { status: "blocked" | "failed" | "timed_out" | "cancelled"; code: string; reason: string };

export class ComputerProviderError extends Error {
  constructor(
    readonly code: "provider_unavailable" | "session_lost" | "origin_blocked" | "read_only_mutation" | "limit_exceeded" | "capability_unavailable" | "provider_failure",
    message: string,
  ) {
    super(message);
    this.name = "ComputerProviderError";
  }
}
