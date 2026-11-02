import { getWorkOS, withAuth } from "@workos-inc/authkit-nextjs"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"
import { workosCallbackUrl } from "@/lib/auth/workos-config"

export async function POST(request: Request) {
  if (process.env.NEXT_PUBLIC_FINNOR_AUTH_PROVIDER !== "workos") return new Response(null, { status: 404 })
  const origin = workosCallbackUrl().origin
  if (request.headers.get("origin") !== origin) return new Response(null, { status: 403 })
  const { sessionId } = await withAuth()
  const store = await cookies()
  store.delete(process.env.WORKOS_COOKIE_NAME ?? "wos-session")
  for (const cookie of store.getAll()) {
    if (cookie.name === "wos-auth-verifier" || cookie.name.startsWith("wos-auth-verifier-")) store.delete(cookie.name)
  }
  const returnTo = `${origin}/centropy/login`
  const response = NextResponse.redirect(sessionId
    ? getWorkOS().userManagement.getLogoutUrl({ sessionId, returnTo }) : returnTo, 303)
  response.headers.set("cache-control", "no-store")
  response.headers.set("referrer-policy", "no-referrer")
  return response
}
