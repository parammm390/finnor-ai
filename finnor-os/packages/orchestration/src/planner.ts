// Planner (§9): instruction + tenant policy context (RAG) + memory → DomainAction[].
// Only registered action_types are ever planned; unknown intents surface as such.

import { RetiredVerticalError, isRetiredWaterAction, type TenantContext, type MemorySnapshot, type DomainAction, type DomainPolicy, type OperatingContext } from "@finnor/shared-types";
import { withTenant, domainActions, domainPolicyRevisions } from "@finnor/db";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { LLMChannel, LLMProvider } from "./llm";
import { resolveProviderForPurpose } from "./llm";
import { plannerActionTypesForVertical, type PluginRegistry } from "./plugin-registry";
import { z } from "zod";
import { redactStructured, redactText, restoreTokens } from "@finnor/security";
import { groundEntitiesWithDb, buildCommandGraph } from "./compiler";
import { appendEpisode } from "@finnor/memory";
import { repairAction } from "./repair";
import type { RepairVerdict } from "./repair";
import { classifyReasoningTier, scoreCandidate } from "./tiering";
import type { ReasoningTier } from "@finnor/shared-types";
import { randomUUID } from "node:crypto";
import { validateDependencyIndexes } from "./plan-dag";
import { buildPlanningHealthContext } from "./planning-health";
import { plannerContinuationInstruction, plannerMemoryContext, plannerShortTermContext } from "./planner-memory";
import { clarificationContinuationAction, enforceExternalResearchRoute, safeReadFallbackForInstruction } from "./read-routing";
import { resolveCompetitorResearch } from "./research-context";
import { applyOperatingInteractionTargets } from "./interaction-targeting";

export { clarificationContinuationAction, enforceExternalResearchRoute, safeReadFallbackForInstruction } from "./read-routing";

const PlanSchema = z.object({
  actions: z.array(
    z.object({
      action_type: z.string(),
      payload: z.record(z.unknown()),
      reasoning: z.string().optional(),
      // Dependencies are indexes into earlier entries in this response, not DB ids.
      depends_on: z.array(z.number().int().nonnegative()).optional(),
    }),
  ),
});

const SecondCandidateSchema = z.object({
  action_type: z.string(),
  payload: z.record(z.unknown()),
});

const CHANNEL_AWARE_ANSWER_ACTIONS = new Set(["search_web"]);

export interface Planner {
  plan(
    instruction: string,
    tenantContext: TenantContext,
    memory: MemorySnapshot,
    opts?: PlannerOptions,
  ): Promise<DomainAction[]>;
}

export interface PlannerOptions {
  instructionId?: string;
  workId?: string;
  plannerAttemptId?: string;
  channel?: LLMChannel;
  signal?: AbortSignal;
  deadlineAt?: number;
  deadlineMs?: number;
  operatingContext?: OperatingContext;
}

const MAX_PLANNER_CONTEXT_CHARS = 24_000;

function boundedArray<T>(value: T[], limit: number): T[] {
  return value.slice(0, limit);
}

function boundPromptValue(value: unknown, maxChars: number): unknown {
  const serialized = JSON.stringify(value);
  if (serialized !== undefined && serialized.length <= maxChars) return value;
  if (maxChars < 16 || value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, Math.max(0, maxChars - 2));
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const remaining = maxChars - JSON.stringify(result).length - 2;
      if (remaining < 16) break;
      const bounded = boundPromptValue(item, remaining);
      const candidate = [...result, bounded];
      if (JSON.stringify(candidate).length > maxChars) break;
      result.push(bounded);
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const remaining = maxChars - JSON.stringify(result).length - key.length - 6;
    if (remaining < 16) break;
    const bounded = boundPromptValue(item, remaining);
    const candidate = { ...result, [key]: bounded };
    if (JSON.stringify(candidate).length > maxChars) break;
    result[key] = bounded;
  }
  return result;
}

function plannerOperatingContext(context: OperatingContext | undefined): Record<string, unknown> | null {
  if (!context) return null;
  const projection = {
    version: context.version,
    assembledAt: context.assembledAt,
    truthPrecedence: context.truthPrecedence,
    interactionPrecedence: context.interactionPrecedence,
    interactionContext: context.interactionContext,
    tenant: context.tenant,
    employee: context.employee,
    activeWork: context.activeWork,
    companyDirectory: context.companyDirectory,
    identityAccess: context.identityAccess,
    universalActions: context.universalActions,
    conversationContext: context.conversationContext,
    personalMemory: context.personalMemory,
    referencedEntities: context.referencedEntities,
    canonicalSummaries: context.canonicalSummaries,
    epistemicWarnings: context.epistemicWarnings,
    integrationHealth: context.integrationHealth,
    authority: context.authority,
    sources: context.sources.map(({ kind, source, asOf, role }) => ({ kind, source, asOf, role })),
    health: { status: context.health.status, missing: context.health.missing },
  };
  const safe = redactStructured(projection) as Record<string, unknown>;
  if (JSON.stringify(safe).length <= MAX_PLANNER_CONTEXT_CHARS) return safe;

  // Keep the planner's high-value identity/authority facts while bounding the
  // lower-priority directory, memory, and projection arrays. A giant context
  // must not consume the same eight-second LLM budget intended for reasoning.
  const compact = redactStructured({
    version: context.version,
    truthPrecedence: context.truthPrecedence,
    interactionPrecedence: context.interactionPrecedence,
    interactionContext: context.interactionContext,
    tenant: context.tenant,
    employee: context.employee,
    activeWork: context.activeWork,
    conversationContext: context.conversationContext,
    referencedEntities: boundedArray(context.referencedEntities, 12),
    canonicalSummaries: boundedArray(context.canonicalSummaries, 8),
    epistemicWarnings: boundedArray(context.epistemicWarnings ?? [], 20),
    integrationHealth: context.integrationHealth,
    authority: context.authority,
    sources: boundedArray(context.sources, 12).map(({ kind, source, asOf, role }) => ({ kind, source, asOf, role })),
    health: { status: context.health.status, missing: context.health.missing },
    contextBounded: true,
  }) as Record<string, unknown>;
  if (JSON.stringify(compact).length <= MAX_PLANNER_CONTEXT_CHARS) return compact;

  // A final minimal projection handles pathological tenant records without
  // slicing JSON mid-value or silently changing the requested instruction.
  return boundPromptValue(redactStructured({
    version: context.version,
    interactionContext: context.interactionContext,
    tenant: context.tenant,
    employee: context.employee,
    activeWork: context.activeWork,
    conversationContext: context.conversationContext,
    referencedEntities: boundedArray(context.referencedEntities, 4),
    canonicalSummaries: boundedArray(context.canonicalSummaries, 3),
    epistemicWarnings: boundedArray(context.epistemicWarnings ?? [], 8),
    authority: context.authority,
    sources: boundedArray(context.sources, 4).map(({ kind, source, asOf, role }) => ({ kind, source, asOf, role })),
    health: { status: context.health.status, missing: context.health.missing },
    contextBounded: true,
  }), MAX_PLANNER_CONTEXT_CHARS) as Record<string, unknown>;
}

export class LLMPlanner implements Planner {
  // Providers resolve lazily on first use so constructing an orchestrator never
  // requires LLM credentials (executor-only paths, tests, workers that never plan).
  private provider: LLMProvider | undefined;
  private routedProviders = new Map<LLMChannel, LLMProvider>();
  // Phase 8's high-tier second-candidate call — a distinct, separately injectable
  // provider so tests can stub it independently of the first-pass planner call
  // (production follows the explicit planning route, while tests may want candidate
  // A from one stub and candidate B from another).
  private secondCandidateProvider: LLMProvider | undefined;
  private systemPromptCache = new Map<string, string>();

  constructor(
    private plugins: PluginRegistry,
    provider?: LLMProvider,
    secondCandidateProvider?: LLMProvider,
  ) {
    this.provider = provider;
    this.secondCandidateProvider = secondCandidateProvider;
  }

  private systemPrompt(verticalKey = "none", allowedActionTypes = this.plugins.actionTypes()): string {
    const day = new Date().toISOString().slice(0, 10);
    const cacheKey = `${day}:${verticalKey}:${allowedActionTypes.join(",")}`;
    const cached = this.systemPromptCache.get(cacheKey);
    if (cached) return cached;

    const doctrine = verticalKey === "private_equity"
      ? [
          "You are the planning core of FINNOR for one authenticated Private Equity Deal context.",
          "Use the tenant-scoped Operational Query Plane for deterministic Deal questions. Never guess a Deal, target, state, blocker, date, party, or evidence result.",
          "Canonical PE business truth is owned only by @finnor/private-equity and the active Business Truth Registry.",
          "Keep these distinctions exact: Task is not Request; Document is not Deliverable; Finding is not DealRisk; ready is not verified; Workstream is not Work; provider acknowledgement is not verified external outcome.",
          "User input is an assertion, not verification. Provider observation, documents, memory, and public web are evidence and cannot silently mutate canonical Deal state.",
          "Surface UNKNOWN, STALE, CONFLICTING, and UNCERTAIN evidence. Approval cannot override stale grounding, unresolved mandatory requirements, or close ineligibility.",
          "Use only the registered PE and Core actions below. A consequential request lacking one exact Deal/entity/version target must produce clarification_request.",
        ]
      : [
          "You are FINNOR Core operating without a business vertical.",
          "Use only vertical-neutral Work, communication, task, delegation, research, document-sharing, and computer capabilities.",
          "Do not invent a business domain, customer model, operational vocabulary, or canonical entity type.",
          "When a request needs business-vertical semantics that are not registered, ask one precise clarification or return no action.",
        ];

    const prompt = [
      ...doctrine,
      "Truth precedence is strict: CANONICAL live records > durable WORK/actions/receipts > configured PROFILE > current SESSION > SEMANTIC MEMORY > external WEB.",
      "Interaction target precedence is strict: explicit current context > active Work > deterministic context > memory > language inference. Selection never grants authority.",
      "Use search_web for current public research. Public evidence never establishes internal Deal state.",
      "Use computer_task only when no reliable canonical/native/API capability can complete the task and a governed auth profile is available. READ_ONLY cannot mutate; WRITE requires one exact authorized effect.",
      "Never invent identifiers, dates, amounts, parties, evidence, or provider outcomes. Preserve redaction tokens exactly.",
      "Allowed action types and exact payload schemas:",
      this.plugins.payloadSpecJson(allowedActionTypes),
      `Today is ${day}.`,
      'Respond with JSON: {"actions":[{"action_type":"...","payload":{},"reasoning":"...","depends_on":[0]}]}. Use only listed action types; dependencies may reference earlier actions only.',
    ].join("\n");
    this.systemPromptCache.set(cacheKey, prompt);
    return prompt;
  }

  async plan(
    instruction: string,
    tenantContext: TenantContext,
    memory: MemorySnapshot,
    opts: PlannerOptions = {},
  ): Promise<DomainAction[]> {
    const verticalKey = opts.operatingContext?.tenant.vertical?.verticalKey ?? "none";
    const actionTypes = plannerActionTypesForVertical(this.plugins, verticalKey);
    const system = this.systemPrompt(verticalKey, actionTypes);
    const planningInstruction = plannerContinuationInstruction(instruction, memory.shortTerm);
    const isClarificationContinuation = planningInstruction !== instruction;
    const redactedInstruction = redactText(planningInstruction);
    // Health failures are not silently ignored: if the planner cannot inspect the
    // guard that prevents a known-open circuit from being planned through, it fails
    // before creating any action rather than guessing that the provider is healthy.
    const operatingHealth = opts.operatingContext?.integrationHealth;
    const integrationHealth = operatingHealth && Object.keys(operatingHealth).length > 0
      ? operatingHealth as unknown as Awaited<ReturnType<typeof buildPlanningHealthContext>>
      : await buildPlanningHealthContext(tenantContext.tenantId);
    const user = JSON.stringify({
      instruction: redactedInstruction.value,
      operatingContext: plannerOperatingContext(opts.operatingContext),
      integrationHealth,
      memory: {
        shortTerm: plannerShortTermContext(instruction, memory.shortTerm),
        recentEpisodes: isClarificationContinuation ? [] : redactStructured(memory.episodic.slice(0, 5)),
        // Phase 9 — ids/counts/rates only, no free text, safe to skip redaction.
        patterns: isClarificationContinuation ? null : memory.patterns,
      },
      memoryContext: plannerMemoryContext(isClarificationContinuation ? { ...memory, semantic: [] } : memory),
    });

    const channel = opts.channel ?? "text";
    let raw: string;
    const continuationAction = clarificationContinuationAction(instruction, planningInstruction, memory, actionTypes);
    const phase6Resolution = opts.operatingContext?.conversationContext?.resolution;
    const contextualResearch = opts.operatingContext
      ? resolveCompetitorResearch(planningInstruction, opts.operatingContext)
      : { route: "not_research" as const };
    if (phase6Resolution?.status === "clarification_required") {
      raw = JSON.stringify({ actions: [{
        action_type: "clarification_request",
        payload: {
          question: phase6Resolution.clarificationQuestion ?? "Which current target should I use?",
          missingFields: phase6Resolution.unresolvedExpressions,
          context: `No business effect was created because ${phase6Resolution.candidates.length} current candidate(s) matched.`,
        },
        reasoning: "Phase 6 deterministic reference/sender resolution failed closed before planning.",
      }] });
    } else if (continuationAction) {
      raw = JSON.stringify({ actions: [continuationAction] });
    } else if (contextualResearch.route === "clarification" || contextualResearch.route === "resolved") {
      raw = JSON.stringify({ actions: [contextualResearch.action] });
    } else try {
      const provider = this.provider ?? this.routedProviders.get(channel) ?? resolveProviderForPurpose("planning", channel);
      if (!this.provider) this.routedProviders.set(channel, provider);
      raw = await provider.complete({
        system,
        user,
        json: true,
        tenantId: tenantContext.tenantId,
        traceId: tenantContext.correlationId,
        purpose: "planning",
        channel,
        signal: opts.signal,
        deadlineAt: opts.deadlineAt,
        deadlineMs: opts.deadlineMs,
      });
    } catch (err) {
      // A planning-provider timeout must not take down an instruction whose
      // intent is provably read-only. The deterministic router can select only
      // the two registered read actions below; it can never manufacture a write,
      // approval, or execution. Keep every ordinary/mutating instruction fail-
      // closed so a provider outage can never become guessed business work.
      const fallback = safeReadFallbackForInstruction(redactedInstruction.value, actionTypes);
      if (!fallback) throw new Error(`Planner LLM call failed: ${(err as Error).message}`);
      raw = JSON.stringify({ actions: [{ ...fallback, reasoning: "Read-only public research routed safely after the planning provider was unavailable." }] });
    }

    let parsed: z.infer<typeof PlanSchema>;
    try {
      parsed = PlanSchema.parse(JSON.parse(raw));
    } catch {
      // Model returned malformed JSON — treat as "no plan", never guess.
      parsed = { actions: [] };
    }

    let valid = parsed.actions.filter((a) => actionTypes.includes(a.action_type));
    valid = enforceExternalResearchRoute(redactedInstruction.value, valid, actionTypes);

    if (valid.length === 0) {
      const fallback = safeReadFallbackForInstruction(redactedInstruction.value, actionTypes);
      if (fallback) valid = [fallback];
    }
    valid = applyOperatingInteractionTargets(valid, opts.operatingContext?.interactionContext);

    if (valid.length === 0) return [];
    // Invalid edges fail closed rather than silently becoming independent work.
    const dependencyIndexes = validateDependencyIndexes(valid.map((action) => ({ dependsOn: action.depends_on })));
    const planId = randomUUID();
    const planActionIds = valid.map(() => randomUUID());

    // Hoisted out of the transaction — restoreTokens has no DB dependency, this is a
    // trivial hoist, not a logic change (Phase 7).
    const restoredPayloads = valid.map((a) => {
      const payload = restoreTokens(a.payload, redactedInstruction.tokens);
      return CHANNEL_AWARE_ANSWER_ACTIONS.has(a.action_type) ? { ...payload, responseChannel: channel } : payload;
    });

    // A short, LLM-free pre-lookup: fetches the FULL policy row (not just
    // id/actionType/requiresConfirmation) because repairAction()'s payload
    // validation step below may call a plugin's validate(). Doing this now, before
    // any LLM call, means
    // the real insert transaction below can reuse this same map instead of
    // re-querying — no duplicated round trip.
    const policyByType = await withTenant(tenantContext.tenantId, async (db) => {
      const rows = await db
        .select()
        .from(domainPolicyRevisions)
        .where(
          and(
            eq(domainPolicyRevisions.tenantId, tenantContext.tenantId),
            inArray(domainPolicyRevisions.actionType, [...new Set(valid.map((a) => a.action_type))]),
            lte(domainPolicyRevisions.effectiveFrom, new Date()),
          ),
        )
        .orderBy(desc(domainPolicyRevisions.effectiveFrom), desc(domainPolicyRevisions.version));
      // Ordering makes the first revision for each type the policy effective now.
      return new Map(rows.filter((p, i, all) => all.findIndex((x) => x.actionType === p.actionType) === i).map((p) => [p.actionType, ({ ...p, id: p.policyId } as DomainPolicy)]));
    });

    // B2.T8: schema-invalid model output gets exactly one explicit repair attempt.
    // It is deliberately before tiering/second-candidate work, so an invalid draft
    // never receives a second, unrelated chance to slip through that would conceal
    // the original validation problem. If the repair cannot make it valid, abort the
    // plan loudly instead of persisting a row the executor is guaranteed to reject.
    const schemaRepair = await Promise.all(
      valid.map(async (action, index) => {
        const candidate = { actionType: action.action_type, payload: restoredPayloads[index]! };
        const plugin = this.plugins.resolve(candidate.actionType);
        const policy =
          policyByType.get(candidate.actionType) ??
          ({ id: "", tenantId: tenantContext.tenantId, actionType: candidate.actionType, policy: {}, requiresConfirmation: true, confirmationTemplate: null, version: 0 } satisfies DomainPolicy);
        const validation = plugin?.validate(candidate.actionType, candidate.payload, policy);
        if (plugin && validation?.valid) return { candidate, repaired: null as RepairVerdict | null, validationError: null as string | null };
        const validationError = !plugin ? `no plugin resolves ${candidate.actionType}` : validation?.errors.join("; ") || "payload failed validation";
        const verdict = await repairAction({
          instruction: redactedInstruction.value,
          candidate,
          reasoning: action.reasoning,
          allowedActionTypes: actionTypes,
          payloadSpec: this.plugins.payloadSpecJson(actionTypes),
          validationError,
          tenantId: tenantContext.tenantId,
          traceId: tenantContext.correlationId,
          channel,
          signal: opts.signal,
          deadlineAt: opts.deadlineAt,
          deadlineMs: opts.deadlineMs,
        });
        const repairedPlugin = verdict.repaired ? this.plugins.resolve(verdict.actionType) : undefined;
        const repairedPolicy =
          policyByType.get(verdict.actionType) ??
          ({ id: "", tenantId: tenantContext.tenantId, actionType: verdict.actionType, policy: {}, requiresConfirmation: true, confirmationTemplate: null, version: 0 } satisfies DomainPolicy);
        const repairedValidation = repairedPlugin?.validate(verdict.actionType, verdict.payload, repairedPolicy);
        if (!verdict.repaired || !repairedPlugin || !repairedValidation?.valid) {
          const finalError = !verdict.repaired ? verdict.reason : !repairedPlugin ? `no plugin resolves ${verdict.actionType}` : repairedValidation?.errors.join("; ") || "payload failed validation";
          throw new Error(`Schema repair failed for ${candidate.actionType} after one attempt: ${finalError}`);
        }
        return { candidate: { actionType: verdict.actionType, payload: verdict.payload }, repaired: verdict, validationError };
      }),
    );

    // Reasoning tier (Phase 8): pure classification, no DB/LLM — decides how much
    // extra reasoning depth each action gets below. requiresConfirmation and
    // compiledGraph are computed once here against the ORIGINAL action_type; the
    // insert transaction below recomputes compiledGraph against the FINAL (possibly
    // repaired) action_type, since a correction can change which command graph kind
    // applies.
    const tierInfo = valid.map((a, i) => {
      const policy = policyByType.get(a.action_type);
      const requiresConfirmation = policy?.requiresConfirmation ?? true;
      const compiledGraph = buildCommandGraph(a.action_type, requiresConfirmation);
      const amountThresholdUsd = (policy?.policy as { riskThresholds?: { amountUsd?: number } } | undefined)?.riskThresholds?.amountUsd;
      // Contextual competitor resolution is already a pure, fail-closed compile:
      // either one schema-valid clarification or one schema-valid read action. A
      // second model pass must not rewrite its missing fields or reintroduce guesses.
      const tier: ReasoningTier = contextualResearch.route !== "not_research" && valid.length === 1
        ? "low"
        : classifyReasoningTier({
            requiresConfirmation,
            compiledGraph,
            payload: schemaRepair[i]!.candidate.payload,
            amountThresholdUsd,
            actionType: a.action_type,
            openScanSignals: memory.patterns?.scanSignals ?? [],
          });
      return { tier, requiresConfirmation };
    });

    // High tier only: generate a second candidate per high-tier action, entirely
    // BEFORE any transaction opens (finding #2 — no LLM call may share a transaction).
    // Uses the planning route again, deliberately NOT the cheap repair model — this
    // tier exists specifically to spend more reasoning where stakes justify it.
    const highIndices = valid.map((_, i) => i).filter((i) => tierInfo[i]!.tier === "high");
    const secondCandidatePairs = await Promise.all(
      highIndices.map(async (i) => {
        const candidateB = await this.generateSecondCandidate(
          redactedInstruction.value,
          valid[i]!.action_type,
          restoredPayloads[i]!,
          actionTypes,
          tenantContext.tenantId,
          tenantContext.correlationId,
          channel,
          opts.signal,
          opts.deadlineAt,
          opts.deadlineMs,
        );
        return [i, candidateB] as const;
      }),
    );
    const secondCandidates = new Map(secondCandidatePairs);

    // Scoring requires grounding both candidates — a short, dedicated, non-final
    // withTenant call (no LLM in flight), separate from the real insert transaction
    // below. Deliberate, acceptable duplication: high-tier actions are rare by
    // design, and threading cached grounding across repair's potential payload
    // mutation would add real complexity for a case that almost never fires.
    const patternScoreFor = (_actionType: string, _payload: Record<string, unknown>): number | undefined => undefined;

    const winnerByIndex = new Map<number, { actionType: string; payload: Record<string, unknown> }>();
    const scoreByIndex = new Map<number, { scoreA: number; scoreB: number | null; winner: "A" | "B" }>();
    if (highIndices.length > 0) {
      await withTenant(tenantContext.tenantId, async (db) => {
        for (const i of highIndices) {
      const candidateA = schemaRepair[i]!.candidate;
          const candidateB = secondCandidates.get(i) ?? null;
          const groundedA = await groundEntitiesWithDb(db, tenantContext.tenantId, candidateA.payload);
          const scoreA = scoreCandidate({
            actionType: candidateA.actionType,
            groundedPayload: groundedA,
            patternScore: patternScoreFor(candidateA.actionType, candidateA.payload),
          });
          let scoreB: number | null = null;
          let winner: "A" | "B" = "A";
          if (candidateB) {
            const groundedB = await groundEntitiesWithDb(db, tenantContext.tenantId, candidateB.payload);
            scoreB = scoreCandidate({
              actionType: candidateB.actionType,
              groundedPayload: groundedB,
              patternScore: patternScoreFor(candidateB.actionType, candidateB.payload),
            });
            if (scoreB > scoreA) winner = "B";
          }
          winnerByIndex.set(i, winner === "B" ? candidateB! : candidateA);
          scoreByIndex.set(i, { scoreA, scoreB, winner });
        }
      });
    }

    // Per-action base candidate going into repair: low tier skips repair entirely
    // (restoring the original zero-overhead path for anything that doesn't require
    // confirmation at all — the one path Phase 7 alone would have made slightly
    // slower for every action). Medium tier is Phase 7's repair, unmodified. High
    // tier repair-passes the SCORING WINNER, never candidate A unconditionally —
    // two different failure modes (wrong pick vs. right pick, wrong payload detail).
    const baseCandidates = valid.map((a, i) => {
      const tier = tierInfo[i]!.tier;
      if (tier === "high") return winnerByIndex.get(i)!;
      return schemaRepair[i]!.candidate;
    });

    const repairVerdicts: Array<RepairVerdict | null> = await Promise.all(
      valid.map((a, i) => {
        if (tierInfo[i]!.tier === "low" || schemaRepair[i]!.repaired) return Promise.resolve(null);
        return repairAction({
          instruction: redactedInstruction.value,
          candidate: baseCandidates[i]!,
          reasoning: a.reasoning,
          allowedActionTypes: actionTypes,
          payloadSpec: this.plugins.payloadSpecJson(actionTypes),
          channel,
          signal: opts.signal,
          deadlineAt: opts.deadlineAt,
          deadlineMs: opts.deadlineMs,
        });
      }),
    );

    // A repaired candidate must still pass the TARGET plugin's own validate() before
    // it's accepted — repair.ts deliberately doesn't import PluginRegistry (avoid a
    // new coupling), so that check belongs here, one layer up.
    const repairedCandidates = valid.map((a, i) => {
      const verdict = repairVerdicts[i]!;
      if (!verdict) {
        // low tier — repair never ran, base candidate is the original draft as-is.
        return { actionType: baseCandidates[i]!.actionType, payload: baseCandidates[i]!.payload, verdict: null as RepairVerdict | null };
      }
      if (!verdict.repaired) {
        return { actionType: baseCandidates[i]!.actionType, payload: baseCandidates[i]!.payload, verdict };
      }
      const targetPlugin = this.plugins.resolve(verdict.actionType);
      const fallbackPolicy: DomainPolicy = {
        id: "",
        tenantId: tenantContext.tenantId,
        actionType: verdict.actionType,
        policy: {},
        requiresConfirmation: true,
        confirmationTemplate: null,
        version: 0,
      };
      const policy = policyByType.get(verdict.actionType) ?? fallbackPolicy;
      const validation = targetPlugin?.validate(verdict.actionType, verdict.payload, policy);
      if (targetPlugin && validation?.valid && actionTypes.includes(verdict.actionType)) {
        return { actionType: verdict.actionType, payload: verdict.payload, verdict };
      }
      // Discard the correction, keep the base candidate — but record exactly why,
      // never silently keep a broken correction and never silently drop the attempt.
      const reason = !targetPlugin
        ? `repair proposed "${verdict.actionType}" but no plugin resolves it — discarded`
        : `repair proposed ${verdict.actionType} but payload failed validation: ${validation?.errors.join("; ")}`;
      return {
        actionType: baseCandidates[i]!.actionType,
        payload: baseCandidates[i]!.payload,
        verdict: { ...verdict, repaired: false, actionType: baseCandidates[i]!.actionType, payload: baseCandidates[i]!.payload, reason },
      };
    });

    // The prompt receives active Core transport health. Exact runtime route
    // resolution remains the authoritative provider gate.
    const finalCandidates = repairedCandidates.map((candidate) => {
      if (candidate.actionType === "computer_task" && opts.operatingContext?.universalActions?.capabilities.computerExecutable !== true) {
        return {
          ...candidate,
          actionType: "clarification_request",
          payload: { question: "Which configured application capability should FINNOR use for this task?", missingFields: ["configuredApplicationCapability"], context: "Computer execution is not enabled for this tenant." },
          healthAdjustment: null,
        };
      }
      return { ...candidate, healthAdjustment: null };
    });

    if (finalCandidates.some((candidate) => isRetiredWaterAction(candidate.actionType))) {
      throw new RetiredVerticalError("water");
    }

    // B2.T2: forecast before persisting or gating. `PluginRegistry.simulate()` is
    // guaranteed no-write: five flagship plugins provide data-backed dry-runs and
    // every other plugin falls back to an explicitly limited schema prediction.
    const predictedReceipts = await Promise.all(
      finalCandidates.map(async (candidate) => {
        const policy =
          policyByType.get(candidate.actionType) ??
          ({
            id: "",
            tenantId: tenantContext.tenantId,
            actionType: candidate.actionType,
            policy: {},
            requiresConfirmation: true,
            confirmationTemplate: null,
            version: 0,
          } satisfies DomainPolicy);
        const simulation = await this.plugins.simulate(candidate.actionType, candidate.payload, policy);
        return { version: 1, actionType: candidate.actionType, simulation };
      }),
    );

    // One transaction, one batch insert — not 2N round trips. The policy lookup
    // itself already happened above (LLM-free, pre-repair); this reuses that map.
    const rows = await withTenant(tenantContext.tenantId, async (db) => {
      // Typed plan compiler (Phase 6, §6): grounds every id-shaped payload field
      // against the real table for this tenant, and tags each action with whether it
      // will execute as a single call or drive the durable multi-step runtime — using
      // this same open transaction, not a second one (see compiler.ts's own note on
      // groundEntitiesWithDb vs. compileAction).
      const compiled = await Promise.all(
        finalCandidates.map(async (c) => {
          const policy = policyByType.get(c.actionType);
          const requiresConfirmation = policy?.requiresConfirmation ?? true;
          return {
            groundedPayload: await groundEntitiesWithDb(db, tenantContext.tenantId, c.payload),
            compiledGraph: buildCommandGraph(c.actionType, requiresConfirmation),
          };
        }),
      );
      return db
        .insert(domainActions)
        .values(
          finalCandidates.map((c, i) => ({
            id: planActionIds[i]!,
            tenantId: tenantContext.tenantId,
            actionType: c.actionType,
            payload: c.payload,
            policyId: policyByType.get(c.actionType)?.id || null,
            policyVersion: policyByType.get(c.actionType)?.version ?? null,
            status: "draft" as const,
            groundedPayload: compiled[i]!.groundedPayload,
            compiledGraph: compiled[i]!.compiledGraph,
            planId,
            dependsOn: dependencyIndexes[i]!.map((dependency) => planActionIds[dependency]!),
            predictedReceipt: predictedReceipts[i]!,
            instructionId: opts.instructionId ?? null,
            workId: opts.workId ?? null,
            plannerAttemptId: opts.plannerAttemptId ?? null,
            initiatedBy: tenantContext.employeeId ?? (/^[0-9a-f-]{36}$/i.test(tenantContext.userId) ? tenantContext.userId : null),
          })),
        )
        .returning();
    });

    // appendEpisode does not require an open tenant transaction (critic-review.ts
    // calls it completely outside of any withTenant block). "repair" is logged only
    // when repair actually ran (medium/high tiers — low tier has no verdict to
    // report), unconditionally within those tiers whether or not anything changed,
    // mirroring critic-review.ts's own precedent. "reasoning_tier" is logged for
    // EVERY action, all tiers, always — the real, queryable "how often did repair
    // actually fire, and at what tier" signal later phases need.
    await Promise.all(
      rows.flatMap((row, i) => {
        const episodes: Array<Promise<void>> = [];
        const verdict = finalCandidates[i]!.verdict;
        const schemaVerdict = schemaRepair[i]!.repaired;
        if (schemaVerdict) {
          episodes.push(
            appendEpisode(
              tenantContext.tenantId,
              row.id,
              "schema_repair",
              { originalActionType: valid[i]!.action_type, originalPayload: restoredPayloads[i], validationError: schemaRepair[i]!.validationError },
              { repaired: true, actionType: schemaVerdict.actionType, payload: schemaVerdict.payload, reason: schemaVerdict.reason },
            ),
          );
        }
        if (verdict) {
          episodes.push(
            appendEpisode(
              tenantContext.tenantId,
              row.id,
              "repair",
              { originalActionType: valid[i]!.action_type, originalPayload: restoredPayloads[i] },
              {
                repaired: verdict.repaired,
                actionType: finalCandidates[i]!.actionType,
                payload: finalCandidates[i]!.payload,
                reason: verdict.reason,
                deterministicFlags: verdict.deterministicFlags,
              },
            ),
          );
        }
        const tier = tierInfo[i]!.tier;
        const score = scoreByIndex.get(i);
        episodes.push(
          appendEpisode(
            tenantContext.tenantId,
            row.id,
            "reasoning_tier",
            {},
            {
              tier,
              candidateBGenerated: tier === "high",
              scoreA: score?.scoreA ?? null,
              scoreB: score?.scoreB ?? null,
              winner: tier === "high" ? (score?.winner ?? "A") : "A",
            },
          ),
        );
        return episodes;
      }),
    );

    // Single multi-row INSERT ... RETURNING preserves the input order, so rows[i]
    // corresponds to valid[i]/finalCandidates[i] — safe to zip the LLM's reasoning
    // back in by index. `reasoning` stays the planner's own original narration —
    // never overwritten by the repair's reason, which lives only in the "repair"
    // episode above (draft narration vs. audit trail are different concerns).
    return rows.map((row, i) => ({
      id: row.id,
      tenantId: row.tenantId,
      actionType: row.actionType,
      payload: row.payload as Record<string, unknown>,
      policyId: row.policyId,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      workId: row.workId,
      plannerAttemptId: row.plannerAttemptId,
      initiatedBy: row.initiatedBy,
      authorityDecisionId: row.authorityDecisionId,
      authorityRevision: row.authorityRevision,
      authorityContext: row.authorityContext as Record<string, unknown>,
      reasoning: valid[i]?.reasoning,
      groundedPayload: row.groundedPayload as DomainAction["groundedPayload"],
      compiledGraph: row.compiledGraph as DomainAction["compiledGraph"],
    }));
  }

  /** High tier only (Phase 8): a second, independent candidate for a high-stakes
   *  action, using the explicit planning route — deliberately NOT the cheap repair
   *  model, since this tier exists specifically to spend more
   *  reasoning where stakes justify it. Same defensive malformed-JSON-safe-fallback
   *  pattern plan()'s own first call already uses: on any failure (network or
   *  parse), candidate B simply does not exist and scoring trivially picks A. */
  private async generateSecondCandidate(
    instruction: string,
    candidateAActionType: string,
    candidateAPayload: Record<string, unknown>,
    allowedActionTypes: string[],
    tenantId: string,
    traceId?: string,
    channel: LLMChannel = "text",
    signal?: AbortSignal,
    deadlineAt?: number,
    deadlineMs?: number,
  ): Promise<{ actionType: string; payload: Record<string, unknown> } | null> {
    const system = [
      "This is a HIGH-STAKES action — a multi-step workflow or a large dollar amount — worth a second, independent look before a human reviews it.",
      "You are given the operator instruction and a candidate action another pass already drafted.",
      `Required payload fields per action_type: ${this.plugins.payloadSpecJson(allowedActionTypes)}`,
      "Either confirm the candidate exactly as-is, or propose a meaningfully different alternative if you believe it better matches the instruction.",
      'Respond with ONLY this JSON: {"action_type":"...","payload":{...}}. If confirming, action_type/payload must equal the candidate exactly.',
    ].join("\n");
    const user = JSON.stringify(
      redactStructured({
        instruction,
        candidateActionType: candidateAActionType,
        candidatePayload: candidateAPayload,
      }),
    );
    try {
      this.secondCandidateProvider ??= resolveProviderForPurpose("planning", channel);
      const raw = await this.secondCandidateProvider.complete({ system, user, json: true, tenantId, traceId, purpose: "planning", channel, signal, deadlineAt, deadlineMs });
      const parsed = SecondCandidateSchema.parse(JSON.parse(raw));
      if (!allowedActionTypes.includes(parsed.action_type)) return null;
      return { actionType: parsed.action_type, payload: parsed.payload };
    } catch {
      return null;
    }
  }
}
