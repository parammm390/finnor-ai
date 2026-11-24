import { ZodError } from "zod"

function looksLikeDump(message: string): boolean {
  const text = message.trim()
  if (!text) return true
  if (text.startsWith("[") || text.startsWith("{")) return true
  return false
}

/**
 * Message safe to show a person. Schema failures and raw payloads fall back to
 * the caller's plain sentence; deliberate messages from the API client are kept.
 */
export function userMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback
  if (cause instanceof ZodError || cause.name === "ZodError") return fallback
  if (looksLikeDump(cause.message)) return fallback
  return cause.message
}
