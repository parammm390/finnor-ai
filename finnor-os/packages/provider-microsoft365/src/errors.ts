export type MicrosoftGraphErrorKind =
  | "auth"
  | "permission"
  | "not_found"
  | "conflict"
  | "resync_required"
  | "throttled"
  | "provider_down"
  | "invalid_response"
  | "blocked_config";

export class MicrosoftGraphError extends Error {
  constructor(
    readonly kind: MicrosoftGraphErrorKind,
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    readonly providerCode?: string,
    readonly innerCode?: string,
    readonly requestId?: string,
    readonly recoveryUrl?: string,
  ) {
    super(message);
    this.name = "MicrosoftGraphError";
  }
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1_000), 24 * 60 * 60_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.min(date - now, 24 * 60 * 60_000));
}

export function isTranscriptSpeakerAttributionError(error: unknown): boolean {
  return error instanceof MicrosoftGraphError
    && error.status === 403
    && error.innerCode === "SpeakerAttributionNotAllowed";
}

export function isTranscriptAccessDisabled(error: unknown): boolean {
  return error instanceof MicrosoftGraphError
    && error.status === 403
    && error.innerCode === "GraphAccessToTranscriptsDisabled";
}
