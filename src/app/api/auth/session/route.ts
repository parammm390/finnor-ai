import { getWorkOS, withAuth } from "@workos-inc/authkit-nextjs"
import { decodeJwt } from "jose"
import { z } from "zod"
import { workosCallbackUrl } from "@/lib/auth/workos-config"

export async function GET() {
  if (process.env.NEXT_PUBLIC_FINNOR_AUTH_PROVIDER !== "workos") return new Response(null, { status: 404 })
  workosCallbackUrl()
  const { user, accessToken } = await withAuth()
  const headers = { "cache-control": "private, no-store", vary: "Cookie", "referrer-policy": "no-referrer" }
  if (!user || !accessToken) return Response.json({ session: null }, { headers })
  let currentUser
  try { currentUser = await getWorkOS().userManagement.getUser(user.id) }
  catch { return Response.json({ error: "Sign-in is temporarily unavailable." }, { status: 503, headers }) }
  const principal = z.string().uuid().safeParse(currentUser.externalId)
  if (currentUser.id !== user.id || !currentUser.emailVerified || !principal.success) {
    return Response.json({ error: "Your verified login must be linked to an existing FINNOR account." }, { status: 403, headers })
  }
  const { exp } = decodeJwt(accessToken)
  if (typeof exp !== "number") return Response.json({ session: null }, { status: 401, headers })
  return Response.json({ session: {
    user: { id: principal.data, email: currentUser.email }, access_token: accessToken, expires_at: exp,
  } }, { headers })
}
