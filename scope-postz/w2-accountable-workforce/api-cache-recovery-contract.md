# API compiler cache recovery

Failure observed before this change: the actual authenticated compensation episode
at commit 5350911a59ddc226af9e8f4475418732f7878ace reached the retained unknown
payment outcome, then Next 15.5.28 restarted at its memory threshold. The original
closing read failed with `fetch failed`; settlement was not established.

The API webpack hook applies its one-shot release memory cache to development as
well. That overrides Next's filesystem cache with zero in-memory generations and
its development cache eviction. Hypothesis: retaining the development defaults
will let the same finite episode continue without that restart. Alternatives are
a separate application retention problem or a transient compiler heap peak.

Verification uses the unchanged `run-compensation-pair.py --episode after-exact`
journey: actual Next HTTP, signed actors, ordinary database roles, the physical
worker, lost-response recovery, exact independent receipt join, single debit,
worker restart, and adverse receipt reopening. A transport failure remains a
failure. Keep the existing API heap, episode bounds, original business deadlines,
grants, acceptance bytes and failed-run evidence. No catch-and-retry wrapper,
memory watcher override, production-guard bypass, or direct route-handler host.

The existing coverage is the real financial-owner episode; an isolated mock of
the webpack callback would not prove that the episode survives. Retain the exact
source commit, inputs, API log, process exits and comparison report for reruns.

Installed package evidence: `next/dist/build/webpack-config.js` sets development
`maxMemoryGenerations: 0` and installs `MemoryWithGcCachePlugin`. The version 15
memory guide scopes the one-shot memory cache example to `!dev`:
https://nextjs.org/docs/15/app/guides/memory-usage
