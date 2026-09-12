// Phase 1.4: security headers on the JARVIS app + its API proxy. CSP is deliberately
// permissive on connect-src/media-src/worker-src (https:/wss:/blob: rather than an
// enumerated allowlist) because the Voice Console's @vapi-ai/web SDK talks to
// infrastructure this repo doesn't control and can't safely enumerate without risking
// breaking live voice calls — the directives that matter most for THIS incident
// (object-src, frame-ancestors, base-uri, form-action) are still locked down.
const JARVIS_CSP = [
  "default-src 'self'",
  // Next's production runtime still needs inline bootstrap scripts. Daily's CSP-
  // compatible call machine is loaded from its own host when Vapi uses avoidEval.
  // Next's development client bundles use eval for source maps. Keep the production
  // policy eval-free, but allow dev hydration so browser QA can exercise JARVIS.
  `script-src 'self' 'unsafe-inline' https://*.daily.co blob:${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "script-src-attr 'none'",
].join("; ")

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
]

import { withSentryConfig } from "@sentry/nextjs"

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Release builds provide a commit-derived value. Keeping the Next build ID
  // deterministic makes the runtime release record independently checkable.
  generateBuildId: async () => process.env.FINNOR_BUILD_ID || process.env.VERCEL_GIT_COMMIT_SHA || null,
  async redirects() {
    return [
      {
        source: "/customers",
        destination: "/jarvis/deals",
        permanent: true,
      },
      {
        source: "/schedule",
        destination: "/jarvis/work",
        permanent: true,
      },
      {
        source: "/money",
        destination: "/jarvis/deals",
        permanent: true,
      },
      {
        source: "/jarvis/customers",
        destination: "/jarvis/deals",
        permanent: true,
      },
      {
        source: "/jarvis/schedule",
        destination: "/jarvis/work",
        permanent: true,
      },
      {
        source: "/jarvis/money",
        destination: "/jarvis/deals",
        permanent: true,
      },
      {
        source: "/jarvis/bridge",
        destination: "/jarvis",
        permanent: true,
      },
      {
        source: "/jarvis/classic",
        destination: "/jarvis",
        permanent: true,
      },
      {
        source: "/jarvis/next",
        destination: "/jarvis",
        permanent: true,
      },
      {
        source: "/jarvis/showtime",
        destination: "/jarvis",
        permanent: true,
      },
      {
        source: "/jarvis/stage",
        destination: "/jarvis",
        permanent: true,
      },
      {
        source: "/demo",
        destination: "/product",
        permanent: true,
      },
      {
        source: "/demo/:path*",
        destination: "/product",
        permanent: true,
      },
      {
        source: "/dashboard-demo",
        destination: "/product",
        permanent: true,
      },
      {
        source: "/resources/admissions-ai-glossary",
        destination: "/resources/operating-glossary",
        permanent: true,
      },
      {
        source: "/resources/dispatch-ai-glossary",
        destination: "/resources/operating-glossary",
        permanent: true,
      },
      {
        source: "/resources/missed-call-cost-calculator",
        destination: "/resources/operational-drag-estimator",
        permanent: true,
      },
      {
        source: "/resources/pilot-setup-checklist",
        destination: "/resources/deployment-readiness-checklist",
        permanent: true,
      },
    ]
  },
  async headers() {
    return [
      {
        source: "/jarvis/:path*",
        headers: [...SECURITY_HEADERS, { key: "Content-Security-Policy", value: JARVIS_CSP }],
      },
      {
        source: "/api/jarvis/:path*",
        headers: SECURITY_HEADERS,
      },
    ]
  },
}

// A2.T3: release-tagged Sentry (see sentry.{client,server,edge}.config.ts). Source-map
// upload only activates once SENTRY_AUTH_TOKEN/org/project are set — silent:true means
// it degrades to a no-op instead of failing the build in every env that doesn't have
// those yet (none currently do; Sentry error reporting itself doesn't need them).
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  widenClientFileUpload: false,
  telemetry: false,
})
