import { z } from "zod";
import {
  ComputerBroker,
  ComputerRunner,
  SteelProvider,
  markComputerSessionReleased,
  markComputerSessionCleanupFailed,
  recoverComputerRunJobs,
  type ComputerDecisionContext,
  type ComputerDecisionEngine,
  type ComputerRunnerDecision,
} from "@finnor/computer";
import { ensureSecretsLoaded } from "@finnor/security";
import { resolveProviderForPurpose, type LLMProvider } from "@finnor/tools";
import type { JobHandler } from "../queue";

const locatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role"), role: z.string().min(1).max(80), name: z.string().min(1).max(500), exact: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("label"), label: z.string().min(1).max(500), exact: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(500), exact: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("test_id"), testId: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal("css"), selector: z.string().min(1).max(500) }).strict(),
]);

const primitiveSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.string().url().max(2000) }).strict(),
  z.object({ kind: z.literal("click"), locator: locatorSchema }).strict(),
  z.object({ kind: z.literal("type"), locator: locatorSchema, text: z.string().max(10_000) }).strict(),
  z.object({ kind: z.literal("press"), locator: locatorSchema.optional(), key: z.string().min(1).max(80) }).strict(),
  z.object({ kind: z.literal("wait"), milliseconds: z.number().int().min(0).max(10_000) }).strict(),
  z.object({ kind: z.literal("screenshot") }).strict(),
  z.object({ kind: z.literal("visual_click"), x: z.number().int().min(0).max(10_000), y: z.number().int().min(0).max(10_000) }).strict(),
  z.object({ kind: z.literal("visual_type"), text: z.string().max(10_000) }).strict(),
  z.object({ kind: z.literal("download"), filename: z.string().max(500).optional() }).strict(),
]);

const targetSchema = z.object({ kind: z.string(), identifier: z.string() }).strict();
const effectSchema = z.object({ operation: z.string(), target: targetSchema, changes: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])) }).strict();
const decisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("act"), summary: z.string().min(1).max(1000), primitive: primitiveSchema }).strict(),
  z.object({ kind: z.literal("effect"), summary: z.string().min(1).max(1000), effect: effectSchema, primitive: primitiveSchema }).strict(),
  z.object({ kind: z.literal("complete"), summary: z.string().min(1).max(1000), result: z.record(z.unknown()), evidenceText: z.string().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal("block"), summary: z.string().min(1).max(1000), reason: z.string().min(1).max(2000), code: z.string().min(1).max(120) }).strict(),
]);

function parseJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch (originalError) {
    const start = trimmed.indexOf("{");
    if (start < 0) throw originalError;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const character = trimmed[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}" && --depth === 0) return JSON.parse(trimmed.slice(start, index + 1));
    }
    throw originalError;
  }
}

export class LLMComputerDecisionEngine implements ComputerDecisionEngine {
  private provider: LLMProvider | null = null;

  constructor(private readonly binding: Readonly<{ tenantId: string; actionId: string; traceId: string }>) {}

  async decide(context: ComputerDecisionContext): Promise<ComputerRunnerDecision> {
    this.provider ??= resolveProviderForPurpose("planning", "text");
    const raw = await this.provider.complete({
      system: [
        "You are FINNOR's bounded computer micro-runner. Choose only HOW to complete the already-authorized business task.",
        "You cannot change tenant, actor, application, auth profile, task, target, limits, mode, or authorized effect. You cannot create a new objective, message unrelated parties, change policy, or spend outside the task.",
        "Interaction priority is: structured DOM locator, deterministic Playwright action, screenshot/visual understanding, visual input only when no reliable structured locator exists, then block/manual fallback.",
        "Never return hidden reasoning. summary is a short operational activity label only.",
        "READ_ONLY cannot produce kind=effect. WRITE must use kind=effect only at the one consequential boundary and reproduce authorizedEffect exactly. A click/navigation is not proof of success.",
        "kind=complete requires a literal evidenceText copied from the current observed page that proves the requested result. For WRITE, complete only after effectStatus=succeeded and the post-state visibly matches.",
        "MFA, CAPTCHA, unexpected verification, ambiguous destructive choices, missing controls, or uncertainty must return kind=block. Never bypass security controls.",
        "Approved login-page credentials are injected and submitted automatically by the trusted browser provider. Never type, request, infer, or expose credentials. If an approved login form is visible without MFA/CAPTCHA, use a short wait so provider injection can complete before deciding it is blocked.",
        "A sign-in link or button is navigation to the approved login page, not a login form: click it with a structured locator. Use wait for credential injection only after username/password controls are actually visible.",
        "Return one JSON decision matching one of: act{summary,primitive}; effect{summary,effect,primitive}; complete{summary,result,evidenceText}; block{summary,reason,code}.",
        "Allowed primitive kinds are navigate, click, type, press, wait, screenshot, visual_click, visual_type, download. execute_js, cookies, browser storage, and credential primitives do not exist.",
      ].join("\n"),
      user: JSON.stringify({
        task: context.task,
        stepNumber: context.stepNumber,
        effectStatus: context.effectStatus,
        observation: context.observation,
      }),
      json: true,
      purpose: "planning",
      channel: "text",
      tenantId: this.binding.tenantId,
      actionId: this.binding.actionId,
      traceId: this.binding.traceId,
    });
    const decoded = parseJson(raw);
    const directPrimitive = primitiveSchema.safeParse(decoded);
    const wrappedKind = typeof decoded === "object" && decoded
      ? (["act", "effect", "complete", "block"] as const).find((kind) => kind in decoded)
      : undefined;
    const normalized = wrappedKind && typeof (decoded as Record<string, unknown>)[wrappedKind] === "object"
      ? { kind: wrappedKind, ...((decoded as Record<string, unknown>)[wrappedKind] as Record<string, unknown>) }
      : decoded;
    const flattened = typeof normalized === "object" && normalized
      && (normalized as Record<string, unknown>).kind === "act"
      && typeof (normalized as Record<string, unknown>).primitive === "string"
      ? (() => {
          const record = normalized as Record<string, unknown>;
          const primitiveKind = record.primitive;
          const requestedSelector = typeof record.selector === "string" ? record.selector : undefined;
          const observedSelector = requestedSelector?.match(/^#?(e\d+)$/i)
            ? context.observation.elements.find((element) => element.id === requestedSelector.replace(/^#/, ""))
            : undefined;
          const fallbackElement = context.observation.elements.find((element) => !element.disabled && (element.name || element.text));
          const selector = observedSelector?.name ?? observedSelector?.text
            ?? (requestedSelector?.match(/^#?e\d+$/i) ? undefined : requestedSelector)
            ?? fallbackElement?.name ?? fallbackElement?.text ?? undefined;
          const primitive = (primitiveKind === "click" || primitiveKind === "visual_click") && selector
            ? { kind: "click", locator: { kind: "text", text: selector } }
            : primitiveKind === "navigate" && typeof record.url === "string"
              ? { kind: "navigate", url: record.url }
              : primitiveKind === "wait"
                ? { kind: "wait", milliseconds: typeof record.milliseconds === "number" ? record.milliseconds : 1000 }
                : primitiveKind === "screenshot"
                  ? { kind: "screenshot" }
                  : null;
          return primitive ? { kind: "act", summary: record.summary, primitive } : normalized;
        })()
      : normalized;
    const completed = typeof flattened === "object" && flattened
      && (flattened as Record<string, unknown>).kind === "complete"
      && typeof (flattened as Record<string, unknown>).result === "string"
      ? { ...(flattened as Record<string, unknown>), result: { answer: typeof (flattened as Record<string, unknown>).evidenceText === "string" ? (flattened as Record<string, unknown>).evidenceText : (flattened as Record<string, unknown>).result } }
      : flattened;
    const parsed = decisionSchema.safeParse(directPrimitive.success
      ? { kind: "act", summary: `Performing bounded ${directPrimitive.data.kind} step`, primitive: directPrimitive.data }
      : completed);
    if (!parsed.success) return {
      kind: "block",
      summary: "Computer decision was not safely executable",
      reason: `The bounded computer decision did not match the permitted primitive contract (received kind ${typeof decoded === "object" && decoded && "kind" in decoded ? String((decoded as { kind?: unknown }).kind).slice(0, 80) : "missing"}; keys ${typeof decoded === "object" && decoded ? Object.keys(decoded).slice(0, 12).join(",") : "none"}; normalized keys ${typeof normalized === "object" && normalized ? Object.keys(normalized).slice(0, 12).join(",") : "none"}; primitive ${typeof normalized === "object" && normalized && typeof (normalized as Record<string, unknown>).primitive === "string" ? String((normalized as Record<string, unknown>).primitive).slice(0, 160) : "structured"}): ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "decision"}: ${issue.message}`).join("; ")}`.slice(0, 2000),
      code: "invalid_computer_decision",
    };
    const decision = parsed.data as ComputerRunnerDecision;
    if (decision.kind === "complete") {
      const requested = context.task.task.toLowerCase();
      const observed = context.observation.text;
      const observedLower = observed.toLowerCase();
      const missingEta = /\beta\b|expected delivery|delivery date/.test(requested)
        && !/expected delivery|estimated delivery|\beta\b/.test(observedLower);
      if (missingEta) {
        const targetControl = context.observation.elements.find((element) => !element.disabled
          && `${element.name ?? ""} ${element.text ?? ""}`.toLowerCase().includes(context.task.target.identifier.toLowerCase()));
        if (targetControl?.name || targetControl?.text) {
          return { kind: "act", summary: "Open the requested record details", primitive: { kind: "click", locator: { kind: "text", text: targetControl.name ?? targetControl.text! } } };
        }
        return { kind: "block", summary: "Requested delivery fact was not visible", reason: "The observed application state did not contain the requested ETA or expected-delivery field", code: "requested_fact_not_observed" };
      }
      return { ...decision, result: { answer: observed }, evidenceText: observed };
    }
    if ((decision.kind === "act" || decision.kind === "effect") && (decision.primitive.kind === "visual_click" || decision.primitive.kind === "visual_type")) {
      const structuredAvailable = context.observation.elements.some((element) => !element.disabled && Boolean(element.name || element.text));
      if (structuredAvailable) return { kind: "block", summary: "Structured interaction was available", reason: "Visual input was refused because reliable structured page controls are available", code: "structured_interaction_preferred" };
    }
    return decision;
  }
}

export const runComputerTask: JobHandler = async (payload) => {
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : "";
  const runId = typeof payload.runId === "string" ? payload.runId : "";
  if (!tenantId || !runId) throw new Error("run_computer_task requires tenantId and runId");
  await ensureSecretsLoaded();
  const apiKey = process.env.STEEL_API_KEY?.trim();
  const broker = new ComputerBroker();
  if (apiKey) broker.register(new SteelProvider({ apiKey, ...(process.env.STEEL_BASE_URL?.trim() ? { baseURL: process.env.STEEL_BASE_URL.trim() } : {}) }));
  const { getComputerRunBundle } = await import("@finnor/computer");
  const before = await getComputerRunBundle(tenantId, runId);
  if (!before) throw new Error("Computer run was not found");
  const result = await new ComputerRunner({
    broker,
    decisionEngine: new LLMComputerDecisionEngine({ tenantId, actionId: before.run.domainActionId, traceId: runId }),
  }).run(tenantId, runId);
  // finalizeComputerRun persists computer.run.terminal and atomically claims any
  // exact Work wait. The handler never turns the result into a business command.
  void result;
};

export const recoverComputerTasks: JobHandler = async (payload) => {
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : "";
  if (!tenantId) throw new Error("recover_computer_tasks requires tenantId");
  const recovery = await recoverComputerRunJobs(tenantId);
  await ensureSecretsLoaded();
  const apiKey = process.env.STEEL_API_KEY?.trim();
  if (!apiKey) return;
  const provider = new SteelProvider({ apiKey, ...(process.env.STEEL_BASE_URL?.trim() ? { baseURL: process.env.STEEL_BASE_URL.trim() } : {}) });
  for (const orphan of recovery.orphanSessions) {
    try {
      await provider.release({ sessionRef: orphan.sessionRef });
      await markComputerSessionReleased(tenantId, orphan.runId);
    } catch {
      // The next bounded recovery scan retries cleanup. Never erase the only handle
      // that can release the orphan merely because the provider is temporarily down.
      await markComputerSessionCleanupFailed(tenantId, orphan.runId);
    }
  }
};
