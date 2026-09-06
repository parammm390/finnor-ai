// GET /api/jarvis/stream?instructionId=... — jarvis-v3 P3.T10 (plan v3 §7.1 Stage
// 2). A DEDICATED, non-buffering relay to finnor-os's real
// GET /api/stream?instructionId= (P3.T9) — deliberately NOT handled by the
// catch-all proxy (src/app/api/jarvis/[...path]/route.ts), which `await
// upstream.text()`s the whole response before replying (verified at that file's
// own doForward, lines ~151-153) and hard-codes `content-type: application/json`.
// SSE through that path would hang until the (bounded, but real) upstream
// connection closes, then arrive as one buffered JSON-mislabeled blob — exactly
// what this file exists to avoid, by piping `upstream.body` straight through
// instead of ever materializing it.
//
// `runtime = "edge"` (this session's own binding): the Edge Runtime streams a
// Response body as it arrives rather than buffering it in a Node.js serverless
// invocation's own memory first, and Next.js's own file-based routing resolves
// this EXACT static path (`/api/jarvis/stream`) in preference to the sibling
// catch-all's `[...path]` dynamic segment — the catch-all is never even invoked
// for this path, verified by e2e/jarvis-stream-route.spec.ts's own assertion that
// this route's real content-type (text/event-stream) is what a live request
// actually gets back, not the catch-all's hard-coded application/json.

export const runtime = "edge"

const OS_API = process.env.NEXT_PUBLIC_OS_API_URL

export async function GET(req: Request): Promise<Response> {
  if (!OS_API) return Response.json({ error: "Jarvis proxy is not configured" }, { status: 500 })

  const incoming = new URL(req.url)
  const headerAuth = req.headers.get("authorization")
  // Tokens in URLs leak into access logs, browser history, telemetry, and referrer
  // surfaces. The browser transport uses authenticated streaming fetch, so this
  // relay accepts the Authorization header only.
  const bearer = headerAuth?.startsWith("Bearer ") ? headerAuth.slice("Bearer ".length) : null
  if (!bearer) return Response.json({ error: "Sign in required" }, { status: 401 })

  const instructionId = incoming.searchParams.get("instructionId")
  if (!instructionId) return Response.json({ error: "instructionId is required" }, { status: 400 })

  const upstreamUrl = new URL(`${OS_API}/api/stream`)
  upstreamUrl.searchParams.set("instructionId", instructionId)

  const headers: Record<string, string> = { authorization: `Bearer ${bearer}` }
  // Forwarded verbatim so a browser EventSource's own automatic Last-Event-ID
  // resume (P3.T9's own real resume point — instruction_events.seq itself) works
  // end-to-end through this relay, not just direct-to-backend.
  const lastEventId = req.headers.get("last-event-id")
  if (lastEventId) headers["last-event-id"] = lastEventId

  const upstream = await fetch(upstreamUrl.toString(), { headers, cache: "no-store" })

  // The one line this whole route exists for: pipe the real stream through,
  // never buffer it. Calling `.text()` (or `.json()`) here would defeat the
  // entire point — see this file's own header.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  })
}
