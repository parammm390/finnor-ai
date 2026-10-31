import type { NextRequest } from "next/server"
import { z } from "zod"
import { ApiRequestError } from "@/lib/api/request"

type OAuthProvider = "google" | "microsoft-graph"
export type OAuthTransport = { provider: OAuthProvider; step: "start" | "callback"; callbackUrl: URL }

const GOOGLE_COOKIE = "finnor_google_oauth"
const StartBody = z.record(z.string(), z.unknown())

function browserOrigin(req: NextRequest): string {
  const canonical = req.nextUrl
  const host = req.headers.get("host")
  if (!host) return canonical.origin
  try {
    const candidate = new URL(`${canonical.protocol}//${host}`)
    const localName = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname) ? "localhost" : hostname
    // NextURL normalizes loopback hostnames to localhost. Cookies and registered
    // OAuth redirects must retain the browser's actual equivalent host.
    if (!candidate.username && !candidate.password && candidate.port === canonical.port
      && localName(candidate.hostname) === localName(canonical.hostname)) return candidate.origin
  } catch { /* An unrelated Host cannot replace Next's request origin. */ }
  return canonical.origin
}

export function oauthTransport(req: NextRequest, method: string, segments: string[]): OAuthTransport | null {
  const [family, provider, step] = segments
  if (segments.length !== 3 || family !== "connections" || provider !== "google" && provider !== "microsoft-graph") return null
  if (!(method === "POST" && step === "start" || method === "GET" && step === "callback")) return null
  return { provider, step, callbackUrl: new URL(`/api/centropy/connections/${provider}/callback`, browserOrigin(req)) }
}

export function oauthStartBody(input: unknown, transport: OAuthTransport): Record<string, unknown> {
  const parsed = StartBody.safeParse(input)
  if (!parsed.success) throw new ApiRequestError("Invalid connection request", 400)
  const redirectUri = parsed.data.redirectUri
  if (redirectUri !== undefined && redirectUri !== "" && redirectUri !== transport.callbackUrl.toString()) {
    throw new ApiRequestError("Connection redirect URI must use this browser's callback", 400)
  }
  return { ...parsed.data, redirectUri: transport.callbackUrl.toString() }
}

export function oauthRequestCookie(req: NextRequest, transport: OAuthTransport): string | null {
  if (transport.provider !== "google" || transport.step !== "callback") return null
  const cookies = (req.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(GOOGLE_COOKIE + "="))
  if (cookies.length === 0) return null
  if (cookies.length !== 1 || !new RegExp(`^${GOOGLE_COOKIE}=[A-Za-z0-9_-]{1,4096}$`).test(cookies[0]!)) {
    throw new ApiRequestError("Invalid connection state cookie", 400)
  }
  return cookies[0]!
}

export function oauthResponseHeaders(req: NextRequest, transport: OAuthTransport, upstream: Response, headers: Headers): void {
  if (transport.provider === "google") {
    const cookies = upstream.headers.getSetCookie().filter(cookie => cookie.startsWith(GOOGLE_COOKIE + "="))
    if (cookies.length > 1) throw new ApiRequestError("Invalid backend connection cookies", 502)
    for (const cookie of cookies) {
      const [pair = "", ...attributes] = cookie.split(";").map(part => part.trim())
      if (!new RegExp(`^${GOOGLE_COOKIE}=[A-Za-z0-9_-]{0,4096}$`).test(pair)) throw new ApiRequestError("Invalid backend connection cookie", 502)
      const maxAge = attributes.find(part => /^max-age=/i.test(part))?.split("=")[1]
      if (maxAge === undefined || !/^\d+$/.test(maxAge) || Number(maxAge) > 600) throw new ApiRequestError("Invalid backend connection cookie lifetime", 502)
      const secure = req.nextUrl.protocol === "https:" || attributes.some(part => part.toLowerCase() === "secure")
      headers.append("set-cookie", `${pair}; HttpOnly; SameSite=Lax; Path=${transport.callbackUrl.pathname}; Max-Age=${maxAge}${secure ? "; Secure" : ""}`)
    }
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    if (transport.step !== "callback" || upstream.status !== 303) throw new ApiRequestError("Unexpected backend connection redirect", 502)
    const location = upstream.headers.get("location")
    if (!location) throw new ApiRequestError("Backend connection redirect is missing", 502)
    let target: URL
    const allowedOrigins = new Set([transport.callbackUrl.origin])
    try {
      target = new URL(location, transport.callbackUrl.origin)
      const configured = process.env.CONSOLE_ORIGIN ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:3101")
      for (const origin of configured.split(",").map(value => value.trim()).filter(Boolean)) allowedOrigins.add(new URL(origin).origin)
    } catch { throw new ApiRequestError("Backend connection redirect is invalid", 502) }
    if (!allowedOrigins.has(target.origin) || target.pathname !== "/settings/connections" || target.username || target.password) {
      throw new ApiRequestError("Backend connection redirect is not allowed", 502)
    }
    headers.set("location", target.toString())
    headers.set("referrer-policy", "no-referrer")
  }
}
