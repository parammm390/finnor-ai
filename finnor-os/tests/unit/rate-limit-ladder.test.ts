import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, setRateLimitRedisForTesting } from "../../apps/api/lib/rate-limit";

describe("rate-limit degradation ladder", () => {
  afterEach(() => { setRateLimitRedisForTesting(undefined); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  it("uses Redis first and applies its fixed-window limit", async () => {
    let count = 0; const expire = vi.fn();
    setRateLimitRedisForTesting({ incr: async () => ++count, pexpire: expire });
    await expect(checkRateLimit("redis-first", 1)).resolves.toBe(true);
    await expect(checkRateLimit("redis-first", 1)).resolves.toBe(false);
    expect(expire).toHaveBeenCalledTimes(1);
  });
  it("survives a Redis outage with an alerting in-memory fallback", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setRateLimitRedisForTesting({ incr: async () => { throw new Error("down"); }, pexpire: async () => undefined });
    await expect(checkRateLimit(`fallback-${Date.now()}`, 1)).resolves.toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Redis unavailable"), "down");
  });
  it("fails closed instead of using process memory during a production outage", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setRateLimitRedisForTesting({ incr: async () => { throw new Error("down"); }, pexpire: async () => undefined });
    await expect(checkRateLimit(`production-fail-closed-${Date.now()}`, 100)).resolves.toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("failed closed"), "down");
  });
});
