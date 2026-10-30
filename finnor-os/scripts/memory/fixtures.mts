import { appendFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { LLMProvider } from "../../packages/tools/src/llm";

const Source = z.object({ id: z.string(), sequence: z.number(), role: z.enum(["user", "assistant"]), text: z.string() });
const Retained = z.object({ id: z.string(), subject: z.string(), statement: z.string(), supersededBy: z.string().nullable() });

/** Deterministic transport fixture; it makes no semantic-quality claim. */
export function captureMemoryProvider(onPrompt?: (prompt: { system: string; user: string }) => void): LLMProvider {
  return {
    name: "memory-e2e-capture", contextWindowTokens: 131072,
    qualificationIdentity: { transport: "custom", name: "memory-e2e-capture", revision: "v2" },
    async complete(options) {
      const prompt = { system: options.system, user: options.user };
      onPrompt?.(prompt);
      if (process.env.FINNOR_MEMORY_CAPTURE_FILE) await appendFile(process.env.FINNOR_MEMORY_CAPTURE_FILE, JSON.stringify(prompt) + "\n");
      const input: unknown = JSON.parse(options.user);
      if (options.system.startsWith("Extract an incremental")) {
        if (process.env.FINNOR_MEMORY_BEFORE_PUBLICATION_MARKER) {
          await writeFile(process.env.FINNOR_MEMORY_BEFORE_PUBLICATION_MARKER, JSON.stringify({ pid: process.pid, phase: "before_publication" }));
          await new Promise(() => undefined);
        }
        const data = z.object({ messages: z.array(Source), retainedItems: z.array(Retained) }).parse(input);
        return JSON.stringify({
          coveredMessageIds: data.messages.map(message => message.id), narrative: "Source-backed fixture navigation summary.",
          items: data.messages.map(message => {
            const payment = /Atlas payment terms/.test(message.text);
            const correction = payment && /correction/.test(message.text);
            const prior = data.retainedItems.filter(item => item.subject === "Atlas payment terms" && item.supersededBy === null);
            const priorSource = data.messages.find(item => item.sequence < message.sequence && /Atlas payment terms/.test(item.text));
            return {
              kind: message.role === "assistant" ? "assistant_proposal" : correction ? "correction" : "constraint",
              subject: payment ? "Atlas payment terms" : "Message " + message.id,
              statement: message.text.slice(0, 1200),
              sources: [{ messageId: message.id, quote: message.text.slice(0, 1200) }],
              supersedes: correction ? prior.map(item => item.id).concat(priorSource ? [priorSource.id] : []) : [],
            };
          }),
        });
      }
      if (options.system.startsWith("Independently review")) return JSON.stringify({ approved: true, issues: [] });
      if (options.purpose === "classification") return JSON.stringify({ terms: ["payment", "terms", "settlement", "Atlas"] });
      if (options.purpose === "planning") {
        const goal = z.object({ goal: z.object({ criteria: z.array(z.object({ id: z.string() })) }) }).safeParse(input);
        if (!goal.success) return JSON.stringify({ kind: "block", reason: "A human fact is required; accepted payment terms are 45 days.", recovery: "Supply the missing fact." });
        return JSON.stringify({ candidates: [{ version: 1, candidateKey: "memory-e2e", nodes: [
          { key: "ask", kind: "action", actionType: "clarification_request", payload: { question: "Which source should I use with the accepted 45-day payment terms?" }, supports: goal.data.goal.criteria.map(item => item.id) },
          ...goal.data.goal.criteria.map((item, index) => ({ key: "check_" + index, kind: "check", criterionId: item.id, dependsOn: ["ask"] })),
        ] }] });
      }
      return "I have recorded the requirement.";
    },
  };
}
