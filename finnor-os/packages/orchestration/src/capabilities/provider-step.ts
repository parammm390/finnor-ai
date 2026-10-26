export type ProviderStep =
  | { status: "complete"; result: Record<string, unknown> }
  | { status: "waiting"; remoteState: Record<string, unknown>; delayMs: number }
  | { status: "not_dispatched"; remoteState: Record<string, unknown>; code: string }
  | { status: "unknown"; remoteState: Record<string, unknown>; code: string };
export interface ProviderCheckpoint {
  (state: Record<string, unknown>, event: "PROVIDER_DISPATCH" | "PROVIDER_ACCEPTED" | "PROVIDER_OBSERVED"): Promise<void>;
}
