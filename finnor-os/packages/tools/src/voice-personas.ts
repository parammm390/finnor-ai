// Product-safe voice persona attribution. Provider assistant ids are tenant account
// configuration and live only inside the resolved Vapi credential context.

export type VoicePersona = "main";

/** Safe product-facing keys carried in the durable causal envelope. These are not
 * provider assistant ids and are the only voice identity a read model may expose. */
export type VoiceAgentKey = "centropy";
