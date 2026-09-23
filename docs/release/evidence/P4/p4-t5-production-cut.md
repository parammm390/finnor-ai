# P4.T5 — Production-shaped cut + final launch set

Root-level reports and screenshots cited below are available from [the legacy artifact index](../legacy-root-artifacts.md).

Date: 2026-08-09 (Asia/Kolkata)

## Deployment

- Provider: Vercel Production
- Deployment: `dpl_3c75YSdv86Mq2gitAXXh51C8utjR`
- Production alias: [https://finnorai.com](https://finnorai.com)
- Ready state: `READY`
- Build: Next.js production build completed successfully; `/jarvis` emitted 215 kB First Load JS source-equivalent.
- Existing non-blocking build note: Sentry server-utils reports the repository's ESM dependency warning. It did not fail the build or surface as a runtime page error.

## Live hard-reload smoke

`evidence/jarvis-p4-t5-v6/live-smoke.json` contains 18 isolated production checks: six JARVIS surfaces at 1440, 768, and 390 widths. Each check performed an initial navigation and an explicit hard reload.

| Gate | Result |
| --- | --- |
| Initial HTTP status | 18/18 = 200 |
| Hard-reload HTTP status | 18/18 = 200 |
| Horizontal overflow | 0/18 |
| Unexpected console/page errors | 0/18 |
| Unauthenticated boundary | Honest and visibly labelled |

Final live captures are in `evidence/jarvis-p4-t5-v6/`: Home, Work, Customers, Schedule, Money, Agents at 1440, plus Work at 390.

## Final frame set

- Twelve §18 Golden Frames were rerun after the P4 craft fixes: `evidence/jarvis-p3-t5-v6/`.
- The final set contains six visibly labelled fixture scene frames and six real unauthenticated/private boundaries; no tenant records, role facts, provider readiness, or action outcomes were invented.
- The 390 Work frame is `evidence/jarvis-p4-t5-v6/work-390.png`.
- The 390 My Day / Dispatch boundary remains `evidence/jarvis-p3-t5-v6/10-my-day-mobile-boundary-390x844.png`; it is the truthful unauthenticated technician boundary, not a fabricated populated route.

## Safety and authority

- No authenticated credentials were available in this environment.
- No live instruction was typed or submitted, and no external side effect was fired.
- Private data remains gated by the real authentication boundary; fixture captures are visibly labelled and used for geometry/signature-state evidence only.
- The final live proof is production-shaped and source-honest: route availability, reload integrity, responsive geometry, and unauthenticated truth are verified against `https://finnorai.com`.

## P4.T5 result

**GREEN — deployed and live-smoke verified.** P4.T6 remains the independent score and closure step. No numeric 98/100 claim is made in this task record.
