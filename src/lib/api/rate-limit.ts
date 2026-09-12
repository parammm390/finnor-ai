import crypto from "node:crypto"
import { NextResponse } from "next/server"

type Bucket = {
  count: number
  resetAt: number
}

type RateLimitOptions = {
  name: string
  limit: number
  windowMs: number
}

const buckets = new Map<string, Bucket>()

export function rateLimit(request: Request, options: RateLimitOptions) {
  const now = Date.now()
  cleanupBuckets(now)

  const key = buildKey(request, options.name)
  const existing = buckets.get(key)

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs })
    return null
  }

  existing.count += 1
  if (existing.count <= options.limit) return null

  const retrySeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
  return NextResponse.json(
    { error: "Too many requests. Please wait a moment and try again." },
    {
      status: 429,
      headers: {
        "retry-after": String(retrySeconds),
      },
    }
  )
}

// The key must not include any attacker-controlled header (a rotating
// User-Agent previously minted a fresh bucket per request, bypassing the
// limit entirely). IP hash only.
function buildKey(request: Request, name: string) {
  const ipHash = requestIpHash(request) || "no-ip"
  return `${name}:${ipHash}`
}

function requestIpHash(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for") || ""
  const realIp = request.headers.get("x-real-ip") || ""
  const ip = forwardedFor.split(",")[0]?.trim() || realIp.trim()
  return ip ? crypto.createHash("sha256").update(ip).digest("hex").slice(0, 32) : ""
}

function cleanupBuckets(now: number) {
  if (buckets.size < 500) return

  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key)
  }
}
