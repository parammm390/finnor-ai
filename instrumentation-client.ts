// A2.T3: browser-side Sentry for the root Next.js app (finnorai.com — the only
// frontend, per hard rule #3). Mirrors finnor-os's observability.ts pattern: init()
// no-ops harmlessly without a DSN, so this ships inert until NEXT_PUBLIC_SENTRY_DSN is
// set (client code needs the NEXT_PUBLIC_ prefix to reach the browser bundle — DSNs
// aren't privileged secrets, see CENTROPY-CREDENTIALS-LEDGER.md).
import * as Sentry from "@sentry/browser";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
  tracesSampleRate: process.env.NEXT_PUBLIC_SENTRY_DSN ? 0.1 : 0,
});

export function onRouterTransitionStart(url: string, navigationType: string) {
  if (!Sentry.getClient()) return

  Sentry.addBreadcrumb({
    category: "navigation",
    message: `${navigationType} ${url}`,
    level: "info",
  })
}
