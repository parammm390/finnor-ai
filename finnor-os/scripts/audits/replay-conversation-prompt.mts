/** Local, provider-free replay of the planner's actual model input. */
import { LLMConversationResponder, LLMPlanner, classifyInstructionRoute, createDefaultPluginRegistry, interpretOperationalQuery, isConversationalTurn, type LLMProvider } from "@finnor/orchestration";
import type { EmployeeConversationContext, MemorySnapshot, OperatingContext } from "@finnor/shared-types";

const tenantId = "11111111-1111-4111-8111-111111111111";
const employeeId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";
const now = "2026-10-29T00:00:00.000Z";
const memory: MemorySnapshot = { shortTerm: null, longTerm: null, semantic: [], episodic: [], patterns: null };

function context(messageChars: number): OperatingContext {
  const exactRecentMessages = Array.from({ length: 30 }, (_, index) => ({
    id: `44444444-4444-4444-8444-${String(index + 1).padStart(12, "0")}`,
    threadId,
    sequence: index + 1,
    role: index % 2 === 0 ? "assistant" as const : "user" as const,
    channel: "text" as const,
    originalText: `TURN_${index + 1}_MARKER ${"a".repeat(messageChars)}`,
    instructionId: null,
    workId: null,
    workInputId: null,
    outcomeRefs: [],
    createdAt: now,
  }));
  const conversationContext: EmployeeConversationContext = {
    version: 1,
    ownerEmployeeId: employeeId,
    thread: {
      id: threadId, title: "Prompt replay", summary: null, revision: 30,
      activeWorkId: null, activeObjectiveLoopId: null, lastActivityAt: now, createdAt: now,
    },
    exactRecentMessages,
    summary: null,
    olderRelevantMessages: [],
    personalMemories: [],
    zepFacts: [],
    resolution: {
      status: "none", originalInstruction: "Build an acquisition plan for Atlas.",
      resolvedReferences: [], candidates: [], unresolvedExpressions: [],
      clarificationQuestion: null, consequential: false, senderIdentityRef: null, provenance: [],
    },
  };
  return {
    version: 1, assembledAt: now,
    truthPrecedence: ["CANONICAL", "WORK", "PROFILE", "SESSION", "MEMORY", "WEB"],
    interactionPrecedence: [], interactionContext: null, conversationContext, personalMemory: [],
    tenant: {
      id: tenantId, companyName: "Atlas", timezone: "UTC",
      vertical: { tenantId, verticalKey: "private_equity", version: 1, effectiveFrom: now, sourceSystem: "local_replay", sourceRef: null },
      profile: { industry: null, niche: null, description: null, primaryGeographies: [], foundedYear: null, idealCustomerProfile: {}, businessFacts: {}, comparisonDefaults: {}, updatedAt: now },
    },
    employee: { userId: employeeId, employeeId, displayName: "Local replay", role: "owner", authorityRoles: ["owner"], profile: { title: null, profileFacts: {}, updatedAt: now } },
    activeWork: null,
    companyDirectory: { employee: null, teams: [], locations: [], reporting: { manager: null, reports: [], backups: [], assistants: [] }, currentWork: [], currentTasks: [], authorityRoles: [], referencedParties: [], sourceTables: [] },
    identityAccess: { communicationIdentities: [], applicationAccounts: [], authProfiles: [] },
    universalActions: null,
    referencedEntities: [], canonicalSummaries: [], epistemicWarnings: [],
    memory: { conversation: null, semantic: [], episodic: [] },
    integrationHealth: {},
    authority: { principal: employeeId, employeeId, revision: 1, roles: ["owner"] },
    sources: [], health: { status: "complete", missing: [], errors: [] },
  } as OperatingContext;
}

async function capture(messageChars: number) {
  let prompt: Record<string, unknown> | null = null;
  const provider: LLMProvider = {
    name: "local-capture",
    async complete(options) {
      prompt = JSON.parse(options.user) as Record<string, unknown>;
      return JSON.stringify({ candidates: [{ version: 1, candidateKey: "capture", nodes: [] }] });
    },
  };
  await new LLMPlanner(createDefaultPluginRegistry(), provider).plan(
    "Build an acquisition plan for Atlas.",
    { tenantId, userId: employeeId, employeeId, role: "owner" },
    memory,
    { operatingContext: context(messageChars) },
  );
  if (!prompt) throw new Error("The capturing provider was not called");
  const operatingContext = prompt.operatingContext as Record<string, unknown> | null;
  const serializedHistory = JSON.stringify(operatingContext?.conversationContext ?? null);
  return {
    messageChars,
    operatingContextChars: JSON.stringify(prompt.operatingContext).length,
    operatingContextKeys: Object.keys(operatingContext ?? {}),
    historyMarkersInModelInput: Array.from({ length: 30 }, (_, index) => index + 1).filter((number) => serializedHistory.includes(`TURN_${number}_MARKER`)),
    previousAssistantTurnRetained: serializedHistory.includes("TURN_29_MARKER"),
    currentUserHistoryEntryRetained: serializedHistory.includes("TURN_30_MARKER"),
  };
}

for (const messageChars of [40, 1200]) {
  process.stdout.write(`${JSON.stringify(await capture(messageChars))}\n`);
}

const recallQuestion = "What did I say about the integration earlier?";
const route = classifyInstructionRoute({
  instruction: recallQuestion,
  fastReadDecision: interpretOperationalQuery(recallQuestion),
  conversational: isConversationalTurn(recallQuestion),
});
let conversationalPrompt: Record<string, unknown> | null = null;
const conversationalProvider: LLMProvider = {
  name: "local-capture",
  async complete(options) {
    conversationalPrompt = JSON.parse(options.user) as Record<string, unknown>;
    return "I cannot determine that from this model input.";
  },
};
await new LLMConversationResponder(conversationalProvider).answer(
  recallQuestion,
  { tenantId, userId: employeeId, employeeId, role: "owner" },
  memory,
  { capabilityActionTypes: [] },
);
process.stdout.write(`${JSON.stringify({
  recallQuestionRoute: route.route,
  conversationalModelInput: conversationalPrompt,
})}\n`);
