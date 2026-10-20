import type { EmployeeConversationContext, MemorySnapshot, TenantContext } from "@finnor/shared-types";
import { ensureSecretsLoaded, redactStructured } from "@finnor/security";
import { resolveProviderForPurpose, type LLMChannel, type LLMProvider } from "./llm";
import type { AnswerEnvelope } from "./fast-read-lane";
import { plannerShortTermContext } from "./planner-memory";
import type { PlanningCapabilityManifestEntry } from "./plugin-registry";

const GREETING = /^(?:hi|hello|hey|hiya|yo|good\s+(?:morning|afternoon|evening))[!.?,\s]*$/i;
const SOCIAL_TURN = /^(?:thanks?|thank\s+you|how\s+are\s+you|who\s+are\s+you|are\s+you\s+there|help)[!.?,\s]*$/i;
const CAPABILITY_TURN = /^(?:what(?: all)? can you (?:do|handle)(?: for me)?|what(?: all)? can you help me accomplish|what(?: all)? do you (?:do|handle|support)|how can you help(?: me)?|what can i ask(?: you)?|what are you able to do|help me accomplish)(?: across my business| for private equity| in detail)?$/i;
const CAPABILITY_LIST = /^(?:(?:list|show|explain)(?: me)? (?:all (?:of )?)?(?:your|finnor'?s|centropy'?s) (?:capabilities|features)|what are your (?:capabilities|features)|(?:tell|show) me everything you can do)$/i;
const REFINEMENT_WORDS = new Set("no actually please tell show give me like all the things precise thing be more specific list of them detail details in exactly everything each one and explain elaborate further every capability capabilities".split(" "));
const REFINEMENT_SUBJECT = /\b(?:all|everything|every|precise|specific|detail|details|elaborate|capability|capabilities)\b/i;

export interface ConversationTurnContext {
  conversationContext?: EmployeeConversationContext;
  instructionId?: string;
}

export type ConversationTurn = "social" | "capability_discovery";

function normalizedTurn(instruction: string): string {
  return instruction.trim().replace(/\s+/g, " ");
}

function capabilityText(instruction: string): string {
  // Users commonly prefix a capability question with a greeting. Strip only
  // that bounded conversational prefix; do not loosen the business-question
  // classifier for arbitrary leading prose.
  return instruction.replace(/^(?:hi|hello|hey|hiya|yo)[,!?\s]+/i, "")
    .replace(/[!.?,]+$/, "").trim();
}

function isCapabilityQuestion(instruction: string): boolean {
  const value = capabilityText(instruction);
  return CAPABILITY_TURN.test(value.replace(/^tell me\s+/i, "")) || CAPABILITY_LIST.test(value);
}

function isCapabilityRefinement(instruction: string): boolean {
  const value = instruction.toLowerCase().replace(/\ba[l]{3,}\b/g, "all").replace(/\bna+h+\b/g, "no");
  const words = value.replace(/[!.?,]+/g, " ").trim().split(/\s+/);
  return REFINEMENT_SUBJECT.test(value) && words.every(word => REFINEMENT_WORDS.has(word));
}

/** Only exact preceding user turns establish a topic. Assistant prose, semantic
 * matches and later concurrent submissions cannot turn a fragment into intent. */
export function classifyConversationTurn(instruction: string, options: ConversationTurnContext = {}): ConversationTurn | null {
  const value = normalizedTurn(instruction);
  if (!value || value.length > 500) return null;
  if (GREETING.test(value) || SOCIAL_TURN.test(value)) return "social";
  if (isCapabilityQuestion(value)) return "capability_discovery";
  if (!isCapabilityRefinement(value)) return null;
  const context = options.conversationContext;
  const current = context?.exactRecentMessages.find(message => message.role === "user" && message.instructionId === options.instructionId);
  if (!context || !current) return null;
  const preceding = context.exactRecentMessages.filter(message => message.role === "user" && message.threadId === current.threadId && message.sequence < current.sequence)
    .sort((a, b) => b.sequence - a.sequence);
  for (const message of preceding) {
    const previous = normalizedTurn(message.originalText);
    if (isCapabilityQuestion(previous)) return "capability_discovery";
    if (!isCapabilityRefinement(previous)) break;
  }
  return null;
}

export function isConversationalTurn(instruction: string, options: ConversationTurnContext = {}): boolean {
  return classifyConversationTurn(instruction, options) !== null;
}

export interface ConversationAnswerOptions extends ConversationTurnContext {
  channel?: LLMChannel;
  signal?: AbortSignal;
  deadlineAt?: number;
  deadlineMs?: number;
  capabilityManifest: readonly PlanningCapabilityManifestEntry[];
}

function capabilityAnswer(manifest: readonly PlanningCapabilityManifestEntry[], asOf: string): AnswerEnvelope {
  const facts = manifest.map(entry => ({
    label: entry.capability,
    value: `${entry.kind}; ${entry.modelProposable ? "agent-proposable" : "human-only"}; ${entry.available ? "registered" : "not registered for agent execution"}; authority=${entry.authorityRequirement}; references=${entry.requiredReferences.join(", ") || "none"}; ${entry.externalSideEffect ? "external side effect" : entry.reversibility}`,
  }));
  return {
    kind: "answer", intent: "conversation", readOnly: true,
    spokenSummary: [
      "These are the registered instruction capabilities for this workspace, including canonical reads, actions, event waits and outcome checks.",
      "Registration describes supported operations. Execution still requires current authority, valid references, applicable approvals and configured providers. Human-only decisions stay with the authorized human. This inventory does not establish live integration health or business results, and does not enumerate separate WORLD controls or native APIs.",
      ...facts.map(fact => `• ${fact.label}: ${fact.value}`),
    ].join("\n\n"),
    display: { title: "Registered instruction capabilities", facts },
    evidence: [{ source: "planning_capability_manifest", ref: "planningCapabilitiesForVertical", timestamp: asOf, kind: "CANONICAL" }],
    asOf, freshness: { status: "fresh", observedAt: asOf },
  };
}

export interface ConversationResponder {
  answer(
    instruction: string,
    ctx: TenantContext,
    memory: MemorySnapshot,
    opts: ConversationAnswerOptions,
  ): Promise<AnswerEnvelope>;
}

export class LLMConversationResponder implements ConversationResponder {
  private readonly providers = new Map<LLMChannel, LLMProvider>();

  constructor(private readonly provider?: LLMProvider, private readonly now: () => Date = () => new Date()) {}

  async answer(
    instruction: string,
    ctx: TenantContext,
    memory: MemorySnapshot,
    opts: ConversationAnswerOptions,
  ): Promise<AnswerEnvelope> {
    if (classifyConversationTurn(instruction, opts) === "capability_discovery") {
      return capabilityAnswer(opts.capabilityManifest, this.now().toISOString());
    }
    await ensureSecretsLoaded();
    const channel = opts.channel ?? "text";
    const provider = this.provider ?? this.providers.get(channel) ?? resolveProviderForPurpose("answer", channel);
    if (!this.provider) this.providers.set(channel, provider);

    const user = JSON.stringify(redactStructured({
      instruction,
      capabilities: opts.capabilityManifest,
      recentSession: plannerShortTermContext(instruction, memory.shortTerm),
    }));
    const spokenSummary = (await provider.complete({
      system: [
        "You are CENTROPY, the conversational command interface for Finnor's Private Equity operating system.",
        "Respond naturally and directly. A greeting should feel warm and useful, not like a status acknowledgement.",
        "For capability questions, summarize only the supplied registered capabilities as Private Equity and company-operating outcomes.",
        "Do not claim that an action ran or that a business fact is true unless it appears in recentSession. Never invent deal, company, closing, evidence, or integration data.",
        "If the request is unclear or cannot safely be acted on, ask one concise, useful follow-up question.",
        "Never reveal hidden reasoning or chain-of-thought. Return only the user-facing response, normally two to five sentences.",
      ].join("\n"),
      user,
      tenantId: ctx.tenantId,
      traceId: ctx.correlationId,
      purpose: "answer",
      channel,
      signal: opts.signal,
      deadlineAt: opts.deadlineAt,
      deadlineMs: opts.deadlineMs,
    })).trim();

    if (!spokenSummary) throw new Error("The conversational model returned an empty response");
    const asOf = this.now().toISOString();
    return {
      kind: "answer",
      intent: "conversation",
      readOnly: true,
      spokenSummary,
      display: { title: "CENTROPY", facts: [] },
      evidence: [{ source: "conversation_model", ref: provider.selectedProviderName ?? provider.name, timestamp: asOf, kind: "SESSION" }],
      asOf,
      freshness: { status: "fresh", observedAt: asOf },
    };
  }
}
