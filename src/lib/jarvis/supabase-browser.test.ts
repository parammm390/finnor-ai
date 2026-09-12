import { afterEach, describe, expect, it, vi } from "vitest"

describe("JARVIS browser authentication configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it("fails closed with an actionable error when public Supabase settings are absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "")
    const auth = await import("./supabase-browser")
    expect(auth.isSupabaseBrowserConfigured()).toBe(false)
    await expect(auth.getSupabaseBrowser()).rejects.toThrow("JARVIS authentication is not configured for this deployment.")
  })
})
