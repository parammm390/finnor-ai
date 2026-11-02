import { getSignInUrl } from "@workos-inc/authkit-nextjs"
import { NextResponse, type NextRequest } from "next/server"
import { workosCallbackUrl } from "@/lib/auth/workos-config"

export async function GET(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_FINNOR_AUTH_PROVIDER !== "workos") return new Response(null, { status: 404 })
  workosCallbackUrl()
  const returnTo = request.nextUrl.searchParams.get("returnTo") ?? "/centropy"
  if (returnTo !== "/centropy" && returnTo !== "/jarvis") return new Response("Invalid return path", { status: 400 })
  const response = NextResponse.redirect(await getSignInUrl({ returnTo }))
  response.headers.set("cache-control", "no-store")
  response.headers.set("referrer-policy", "no-referrer")
  return response
}
