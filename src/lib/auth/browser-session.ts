import { z } from "zod"

const SessionSchema = z.object({
  user: z.object({ id: z.string().min(1), email: z.string().email().optional() }),
  access_token: z.string().min(1),
  expires_at: z.number().int().positive(),
})

export type BrowserSession = Pick<z.infer<typeof SessionSchema>, "user" | "access_token"> & { expires_at?: number }

export async function readWorkOSSession(signal: AbortSignal): Promise<z.infer<typeof SessionSchema> | null> {
  const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store", signal })
  if (!response.ok) throw new Error(response.status === 403
    ? "Your verified login must be linked to your existing FINNOR account."
    : "Sign-in is unavailable. Please try again.")
  const body = z.object({ session: SessionSchema.nullable() }).parse(await response.json())
  if (body.session && body.session.expires_at * 1000 <= Date.now()) throw new Error("Your session has expired. Sign in again.")
  return body.session
}
