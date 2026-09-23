# P4.T4 — Performance / accessibility / responsive certification

Root-level reports and screenshots cited below are available from [the legacy artifact index](../legacy-root-artifacts.md).

Date: 2026-08-09 (Asia/Kolkata)

## Result

The product path is certified for responsive containment, keyboard focus, reduced-motion state preservation, input feedback, CLS, console/runtime truth, and automated WCAG rule coverage. The strict Lighthouse score is not claimed because the bounded `npx lighthouse@11` probe did not resolve a sample in this environment. Headless Chromium also reports a stable 56.8–57.5 FPS compositor ceiling; that is recorded as `BLOCKED-ENV`, not rounded into a 58 FPS pass.

No Sev-1 or Sev-2 defect is open.

## Changes made during certification

- Rounded deterministic SVG orb geometry to remove a real SSR/client hydration mismatch.
- Made Thread Field motion class assignment hydration-safe.
- Added Escape/focus restoration for the mobile More-surface sheet and Work queue/inspector.
- Corrected the Household 360 index semantics/scroll focus after axe-core found real ARIA violations.
- Updated one stale responsive fixture assertion to match the intentional non-collapsible active causal block.

## Evidence

- `e2e/jarvis-p4-t4-certification.spec.ts`: 3/3; all six surfaces across 1440/768/390, reduced motion, overflow, runtime/console checks, focus restoration, input feedback, and frame sample.
- Selected regression set: 28/28 Playwright tests passed.
- `evidence/jarvis-p4-t4-v6/responsive-metrics.json`: 18 route/viewport measurements; zero overflow and zero unexpected page errors. Maximum observed CLS is 0.038 on the labelled fixture route; production `/jarvis` cold samples remain ≤0.00011.
- `evidence/jarvis-p4-t4-v6/keyboard-reduced-motion.json`: plan state preserved, Work Escape restores focus, More Escape restores focus, and field drift is suppressed.
- `evidence/jarvis-p4-t4-v6/interaction-frame-sample.json`: measured input feedback 79.4 ms; measured p95 FPS 56.8; strict 58 target recorded as unmet by the headless compositor.
- `evidence/jarvis-p4-t4-v6/a11y-axe.json`: axe-core WCAG 2A/2AA scan, 18 route/viewport runs, 0 violations after the Household 360 fix.
- `evidence/jarvis-p4-t4-v6/cold-performance.json`: ten fresh Chromium browser/context samples against the production build of `/jarvis` (five desktop, five mobile), no overflow, no unexpected runtime errors.
- `node scripts/contrast-audit.mjs`: `failedCount: 0`; all gated text checks pass. Decorative border checks remain non-gating by design.

## Production build measurement

`npm run build` passes. Next build reports `/jarvis` at 349 B route / 215 kB First Load JS (source-equivalent route-split metric, within the 250 kB target). The local `next start` server does not apply transfer compression, so browser resource totals are recorded separately in `cold-performance.json`; no compression claim is made for localhost.

The build emits the existing Sentry/APM ESM warning from `@sentry/server-utils`; it is non-fatal and was not widened or hidden.

## Bounded environment blockers

- Lighthouse: `npx lighthouse@11` did not resolve a sample within the bounded attempt; no Lighthouse performance or accessibility score is invented.
- FPS: five fresh browser samples were stable at 56.8–57.5 FPS on this headless Chromium compositor, including an idle route. The source/product path has no animation or runtime error on the measured surface. A headed/device run is the unblock condition for the strict 58 FPS target.
- Authenticated populated tenant proof remains the existing `BLOCKED-ENV` condition recorded in the v6 state ledger; no private fact or external action was simulated.

P4.T4 is closed with the above bounded, evidence-backed deviations. Next exact task: **P4.T5 — Production-shaped cut + final launch set**.
