// A5.T2 route inventory: route.ts is the authoritative inventory, so a new endpoint
// cannot quietly escape review. This is intentionally a source-level complement to
// tenant-isolation.test.ts (real RLS role) and anonymous-401-enumeration.test.ts
// (actual handler calls): it proves every route has a declared boundary before a test
// author can forget to add it to either hand-written list.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const API_ROOT = join(process.cwd(), "apps/api/app/api");

function routes(dir = API_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routes(path);
    return entry.isFile() && entry.name === "route.ts" ? [path] : [];
  });
}

const EXPLICIT_BOUNDARIES: Record<string, RegExp> = {
  "admin/migrate/route.ts": /ADMIN_SECRET/,
  "health/route.ts": /export async function GET/,
  // OAuth redirects cannot carry the console JWT. The one-time, tenant-bound state
  // plus the HttpOnly PKCE cookie are consumed atomically by completeGoogleConnection.
  "connections/google/callback/route.ts": /completeGoogleConnection/,
  // Microsoft admin-consent callbacks carry one-time, tenant/profile-bound state;
  // completion atomically consumes it and verifies the returned directory before
  // any tenant work. No browser/query tenant identifier is used as authority.
  "connections/microsoft-graph/callback/route.ts": /completeMicrosoftGraphAdminConsent/,
  // Deployment readiness exposes aggregate component status only, never tenant data.
  "ready/route.ts": /MIGRATION_HEAD/,
  // Public deployment metadata only; contains no tenant or user data.
  "release/route.ts": /getReleaseMetadata/,
  "webhooks/esign/route.ts": /verifyDocusignSignature/,
  "webhooks/ghl/route.ts": /verifyGhlSignature/,
  "webhooks/marketing/route.ts": /verifySharedSecret/,
  // Graph sends no console JWT. The handler verifies the subscription secret
  // against the stored hash and matches directory/resource before tenant work.
  // microsoft365-webhook.test.ts exercises forged and cross-tenant envelopes.
  "webhooks/microsoft-graph/route.ts": /verifySubscriptionClientState\(notification\.clientState, row\.client_state_hash\)/,
  "webhooks/payment/route.ts": /verifyPaymentSignature/,
  "webhooks/vapi/route.ts": /verifyTimestampedHmacSignature/,
  "workflows/runs/\[id\]/cancel/route.ts": /makeRunControlRoute/,
  "workflows/runs/\[id\]/escalate/route.ts": /makeRunControlRoute/,
  "workflows/runs/\[id\]/pause/route.ts": /makeRunControlRoute/,
  "workflows/runs/\[id\]/resume/route.ts": /makeRunControlRoute/,
  "workflows/runs/\[id\]/retry/route.ts": /makeRunControlRoute/,
};

describe("A5 tenant/auth boundary inventory", () => {
  it("enumerates every API route and requires an explicit boundary for each", () => {
    const discovered = routes().map((path) => relative(API_ROOT, path)).sort();
    expect(discovered.length).toBeGreaterThan(0);

    for (const route of discovered) {
      const source = readFileSync(join(API_ROOT, route), "utf8");
      // P5 IC routes use the shared handleIcGet/handleIcPost boundary; those
      // wrappers resolve requireIcContext -> requireContext before invoking a
      // domain operation. Recognize that named audited boundary explicitly.
      const expected = EXPLICIT_BOUNDARIES[route] ?? /requireContext|handleIc(?:Get|Post)/;
      expect(source, `${route} has no explicit auth/tenant boundary; add requireContext or an audited exception`).toMatch(expected);
    }
  });

  it("keeps the shared IC route wrappers anchored to requireContext", () => {
    const helper = readFileSync(join(process.cwd(), "apps/api/lib/ic.ts"), "utf8");
    expect(helper).toMatch(/requireIcContext[\s\S]*requireContext\(req\)/);
    expect(helper).toMatch(/handleIcPost[\s\S]*requireIcContext\(req\)/);
    expect(helper).toMatch(/handleIcGet[\s\S]*requireIcContext\(req\)/);
  });

  it("has no stale exception: every exception is a real route", () => {
    const discovered = new Set(routes().map((path) => relative(API_ROOT, path)));
    expect(Object.keys(EXPLICIT_BOUNDARIES).filter((route) => !discovered.has(route))).toEqual([]);
  });
});
