// Server-only. Mints and caches a real Supabase user session for the dedicated
// centropy-console@finnorai.com service account (owner role, tenant-scoped) so the
// /api/centropy/* proxy can call the finnor-os API with a genuine bearer token.
// Never imported by client code — no key here ever reaches the browser.

let cached: { token: string; refreshToken: string; expiresAt: number } | null = null

async function passwordLogin(): Promise<{ token: string; refreshToken: string; expiresAt: number }> {
  const url = process.env.FINNOR_OS_SUPABASE_URL
  const key = process.env.FINNOR_OS_SUPABASE_KEY
  const email = process.env.CENTROPY_SERVICE_EMAIL?.trim() || process.env.JARVIS_SERVICE_EMAIL?.trim()
  const password = process.env.CENTROPY_SERVICE_PASSWORD || process.env.JARVIS_SERVICE_PASSWORD
  if (!url || !key || !email || !password) {
    throw new Error("Centropy proxy auth is not configured")
  }
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Centropy proxy login failed: ${res.status}`)
  const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number }
  return { token: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000 }
}

async function refresh(refreshToken: string): Promise<{ token: string; refreshToken: string; expiresAt: number } | null> {
  const url = process.env.FINNOR_OS_SUPABASE_URL
  const key = process.env.FINNOR_OS_SUPABASE_KEY
  if (!url || !key) return null
  const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: key, "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
    cache: "no-store",
  })
  if (!res.ok) return null
  const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number }
  return { token: body.access_token, refreshToken: body.refresh_token, expiresAt: Date.now() + body.expires_in * 1000 }
}

/** Returns a valid bearer token for the centropy-console service account, refreshing as needed. */
export async function getServiceToken(): Promise<string> {
  const safetyMarginMs = 60_000
  if (cached && cached.expiresAt - safetyMarginMs > Date.now()) return cached.token
  if (cached) {
    const refreshed = await refresh(cached.refreshToken)
    if (refreshed) {
      cached = refreshed
      return cached.token
    }
  }
  cached = await passwordLogin()
  return cached.token
}
