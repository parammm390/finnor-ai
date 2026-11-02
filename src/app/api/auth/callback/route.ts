import { handleAuth } from "@workos-inc/authkit-nextjs"
import type { NextRequest } from "next/server"
import { workosCallbackUrl } from "@/lib/auth/workos-config"

export async function GET(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_FINNOR_AUTH_PROVIDER !== "workos") return new Response(null, { status: 404 })
  return handleAuth({
    baseURL: workosCallbackUrl().origin,
    returnPathname: "/centropy",
    onError: () => new Response("Sign-in could not be verified. Start sign-in again.", {
      status: 400, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
    }),
  })(request)
}
