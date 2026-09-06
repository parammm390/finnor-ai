// Same-origin, non-buffering relay to the always-on worker SSE gateway. The browser
// sends its bearer token as a header; neither tokens nor tenant ids enter the URL.
export const runtime = "edge"

function configuredGateway(): URL | null {
  for (const value of [process.env.JARVIS_SSE_GATEWAY_URL, process.env.NEXT_PUBLIC_JARVIS_SSE_URL]) {
    const candidate = value?.trim()
    if (!candidate) continue
    try {
      const url = new URL(candidate)
      if (url.protocol === "http:" || url.protocol === "https:") return url
    } catch {
      // Keep the relay fail-closed for malformed deployment configuration.
    }
  }
  return null
}

const SSE_GATEWAY = configuredGateway()

export async function GET(req: Request): Promise<Response> {
  const authorization = req.headers.get("authorization")
  if (!authorization?.startsWith("Bearer ")) return Response.json({ error: "Sign in required" }, { status: 401 })
  if (!SSE_GATEWAY) {
    return Response.json({ error: "BLOCKED-CONFIG: JARVIS_SSE_GATEWAY_URL is not configured with a valid HTTP(S) URL" }, { status: 503 })
  }

  const headers: Record<string, string> = { authorization }
  const lastEventId = req.headers.get("last-event-id")
  if (lastEventId) headers["last-event-id"] = lastEventId
  try {
    const upstreamUrl = new URL("/events", SSE_GATEWAY)
    const upstream = await fetch(upstreamUrl, { headers, cache: "no-store" })
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    })
  } catch {
    return Response.json({ error: "Realtime gateway unavailable" }, { status: 503 })
  }
}
