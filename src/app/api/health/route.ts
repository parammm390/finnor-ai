import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { serverEnv } from "@/lib/env"
import { getReleaseMetadata } from "@/lib/release"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const release = getReleaseMetadata("finnor-frontend")
  const supabase = await checkSupabase()
  const services = {
    pe_concierge_model: Boolean(serverEnv.groqApiKey || serverEnv.geminiApiKey),
    operating_review_persistence: supabase.reachable,
    operating_review_email: Boolean(serverEnv.gmailUser && serverEnv.gmailAppPassword),
  }

  return NextResponse.json({
    ok: true,
    services,
    supabase,
    release,
    checkedAt: new Date().toISOString(),
  })
}
async function checkSupabase() {
  const configured = Boolean(serverEnv.supabaseUrl && serverEnv.supabaseServiceRoleKey)
  if (!configured) {
    return { configured: false, reachable: false }
  }

  try {
    const client = createClient(serverEnv.supabaseUrl, serverEnv.supabaseServiceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
    const { error } = await client.from("leads").select("id").limit(1)

    if (error) {
      return {
        configured: true,
        reachable: false,
        error_code: error.code || "supabase_error",
        error_message: sanitizeSupabaseHealthMessage(error.message),
      }
    }

    return { configured: true, reachable: true }
  } catch {
    return { configured: true, reachable: false, error_code: "connection_failed" }
  }
}

function sanitizeSupabaseHealthMessage(message?: string) {
  return typeof message === "string"
    ? message.replace(/\s+/g, " ").trim().slice(0, 220)
    : ""
}
