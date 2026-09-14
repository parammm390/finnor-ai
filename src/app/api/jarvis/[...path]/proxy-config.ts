/** Stable proxy timeout contract shared by the route and its contract tests.
 * Keeping these constants outside the route module avoids Next.js treating them
 * as unsupported route exports while still making the boundary testable. */
// Company Brain and canonical Work reads can cross several persisted projections.
// A cold API process has been measured completing those reads just beyond 10s; a
// 10s proxy cutoff therefore converted a real upstream 200 into a false UNAVAILABLE.
// Keep the boundary bounded, but allow one honest cold-start compilation window.
export const JARVIS_PROXY_READ_TIMEOUT_MS = 20_000
// Durable approvals can synchronously cross the planner/executor boundary and take
// just over 30s on a cold worker. Keep the proxy alive long enough to return the
// committed receipt instead of manufacturing a client-visible timeout after the
// action has already succeeded.
export const JARVIS_PROXY_WRITE_TIMEOUT_MS = 60_000
