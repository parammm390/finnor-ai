import { authkitMiddleware } from "@workos-inc/authkit-nextjs"
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server"

const workos = authkitMiddleware()

export function proxy(request: NextRequest, event: NextFetchEvent) {
  if (process.env.NEXT_PUBLIC_FINNOR_AUTH_PROVIDER !== "workos") return NextResponse.next()
  return workos(request, event)
}

export const config = { matcher: ["/api/auth/:path*"] }
