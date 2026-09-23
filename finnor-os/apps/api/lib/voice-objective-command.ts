export type VoiceObjectiveCommand =
  | { command: "start" | "redirect"; objective: string }
  | { command: "inspect" | "interrupt" | "continue" | "cancel" };

/** Deliberately narrow spoken control grammar. Ambiguous language stays on the
 * ordinary instruction path; only an explicit reference to "objective" may control
 * Durable Work. This avoids turning a phrase such as "stop calling that customer"
 * into an interruption of unrelated business work. */
export function parseVoiceObjectiveCommand(input: string): VoiceObjectiveCommand | null {
  const value = input.replace(/\s+/g, " ").trim();
  const redirect = value.match(/^(?:(?:centropy|jarvis)[, ]+)?(?:redirect|change|revise)\s+(?:this\s+|the\s+)?objective\s+(?:to|:)\s+(.+)$/i);
  if (redirect?.[1]?.trim()) return { command: "redirect", objective: redirect[1].trim() };
  const start = value.match(/^(?:(?:centropy|jarvis)[, ]+)?(?:start|own|take on)\s+(?:this\s+|the\s+|an\s+)?objective(?:\s+to|\s*:)?\s+(.+)$/i);
  if (start?.[1]?.trim()) return { command: "start", objective: start[1].trim() };
  if (/^(?:(?:centropy|jarvis)[, ]+)?(?:interrupt|pause|stop)\s+(?:this\s+|the\s+)?objective[.!]?$/i.test(value)) return { command: "interrupt" };
  if (/^(?:(?:centropy|jarvis)[, ]+)?(?:cancel|end|abandon)\s+(?:this\s+|the\s+)?objective[.!]?$/i.test(value)) return { command: "cancel" };
  if (/^(?:(?:centropy|jarvis)[, ]+)?(?:continue|resume)\s+(?:this\s+|the\s+)?objective[.!]?$/i.test(value)) return { command: "continue" };
  if (/^(?:(?:centropy|jarvis)[, ]+)?(?:(?:inspect|show|check)\s+(?:this\s+|the\s+)?objective|what(?:'s| is)\s+(?:this\s+|the\s+)?objective(?:'s)?\s+status|what are you trying to achieve)[?!.]?$/i.test(value)) return { command: "inspect" };
  return null;
}
