"use client"

// Browser-side Supabase client for real JARVIS login (Phase 1.3). Uses the
// publishable/anon key — safe to ship to the browser, unlike the secret key
// proxy-auth.ts uses server-side for the shared service account. Session storage
// and token refresh are entirely library-managed (localStorage + a background
// refresh timer) — no hand-rolled token handling here or anywhere downstream.
import type { SupabaseClient } from "@supabase/supabase-js"

const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim()
const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim()

let clientPromise: Promise<SupabaseClient> | null = null

/**
 * The real browser client is shared exactly as before, but the SDK is only
 * fetched when authentication is actually needed (session restoration or a
 * login/reset action). Public JARVIS preview therefore does not pay its cost
 * before rendering the non-authenticated Thread.
 */
export function getSupabaseBrowser(): Promise<SupabaseClient> {
  if (!clientPromise) {
    clientPromise = import("@supabase/supabase-js").then(({ createClient }) =>
      createClient(url, anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      }),
    )
  }
  return clientPromise
}
