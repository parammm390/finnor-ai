// Product-safe voice persona attribution. Provider assistant ids are tenant account
// configuration and live only inside the resolved Vapi credential context.

export type VoicePersona = "main";

/** Safe product-facing keys carried in the durable causal envelope. These are not
 * provider assistant ids and are the only voice identity a read model may expose. */
export type VoiceAgentKey = "jarvis";

export const VOICE_AGENT_KEYS = ["jarvis"] as const satisfies readonly VoiceAgentKey[];

const AGENT_KEY_BY_PERSONA: Record<VoicePersona, VoiceAgentKey> = {
  main: "jarvis",
};

/** Maps only a validated, known persona to its safe product key. Unknown values
 * deliberately return undefined so a call cannot acquire an invented attribution. */
export function agentKeyForPersona(persona: string | undefined): VoiceAgentKey | undefined {
  if (!persona || !(persona in AGENT_KEY_BY_PERSONA)) return undefined;
  return AGENT_KEY_BY_PERSONA[persona as VoicePersona];
}
