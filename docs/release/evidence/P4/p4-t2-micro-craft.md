# P4.T2 — Pixel-level micro-craft

Root-level screenshots cited in this historical report are available from [the legacy artifact index](../legacy-root-artifacts.md).

Date: 2026-08-08  
Status: CLOSED  
Sev-1 / Sev-2 introduced: 0

## Scope

This cut stayed within the existing v6 surfaces and source-backed truth boundaries. No new product feature, provider state, private row, or synthetic tenant fact was added.

- Added a late, surface-scoped craft pass in `src/components/jarvis/jarvis-theme.css` for desktop/mobile touch targets, human-facing label readability, visible keyboard focus, and shell-level consistency.
- Kept technical identifiers and ambient HUD micro-labels compact where they are intentionally part of the instrument-panel language; raised the operational labels, row facts, statuses, controls, and empty-state copy that users must read.
- Moved the development-only fixture badge into document flow in `src/components/jarvis/bridge/ThreadBridge.tsx`; this removes the overlap caused by the completed six-link command header without changing production/private layout.
- Hardened the Golden Frame boundary assertions in `e2e/jarvis-p3-t5-golden-frames.spec.ts` to assert the actual accessible status region rather than a brittle duplicate text locator.

## Evidence

The final rerun of `e2e/jarvis-p3-t5-golden-frames.spec.ts` passed 1/1 with one worker. The twelve refreshed PNGs in `evidence/jarvis-p3-t5-v6/` were manually reviewed after the fixture-flow correction:

- Home Ready, Listening, Plan, and Approval retain one coherent Command Canvas composition; the fixture badge is separated from the command header and no longer overlaps navigation.
- Home Working and Outcome retain the Causal Spine, approval, receipt, and evidence hierarchy with readable operational copy.
- Work, Customers, Schedule, and Money show their real unauthenticated boundaries without invented private records or raw payloads.
- My Day at 390px keeps the truthful Dispatch Field boundary and fixed five-item mobile navigation.
- Agents retains the governed five-channel Fleet rail, separate provider-level unavailable fact, and closed/no-fabrication inspector seam.

## Responsive and craft checks

- 1440px: all six surfaces have no horizontal overflow; Agents' body width is 1432px because of the scrollbar and remains within the viewport.
- 768px: all six surfaces remain within the viewport; Agents' body width is 760px because of the scrollbar.
- 390px: all six surfaces remain within the viewport; the scrollbar-bearing routes report 382px body width and no content overflow.
- Desktop controls/links meet the 44px interaction floor; mobile surface links meet 48px, the More close control meets 44px, and More-sheet links meet 48px.
- The 200%-equivalent narrow viewport pass is carried into the formal P4.T4 accessibility certification; no overflow or clipping was found in the fixed-width responsive passes.

## Verification

```text
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 npx playwright test e2e/jarvis-p3-t5-golden-frames.spec.ts --project=desktop-chromium --workers=1  # 1 passed
npx tsc --noEmit                                                                    # passed
npm run lint -- --no-cache                                                          # passed, 0 warnings
git diff --check                                                                    # passed
```

## Limitation

Authenticated populated private-frame proof and a live authenticated command-dock capture remain `BLOCKED-ENV`; the captured private states are the exact unauthenticated unavailable boundaries. This is carried forward to P4.T3/P4.T5 and is not presented as authenticated evidence.
