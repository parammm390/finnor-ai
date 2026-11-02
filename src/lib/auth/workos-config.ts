import "server-only"

export function workosCallbackUrl(): URL {
  const value = process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI
  const clientId = process.env.WORKOS_CLIENT_ID
  const cookiePassword = process.env.WORKOS_COOKIE_PASSWORD
  if (!value || !clientId || !cookiePassword || cookiePassword.length < 32 || !process.env.WORKOS_ISSUER
    || process.env.WORKOS_COOKIE_DOMAIN) {
    throw new Error("WorkOS authentication is not configured.")
  }
  if ((process.env.FINNOR_ENVIRONMENT === "production" || process.env.VERCEL_ENV === "production")
    && !process.env.WORKOS_API_KEY?.startsWith("sk_live_")) throw new Error("Production authentication requires a production WorkOS key.")
  const url = new URL(value)
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/api/auth/callback"
    || url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("WorkOS callback configuration is invalid.")
  }
  return url
}
