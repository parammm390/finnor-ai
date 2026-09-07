import { afterEach, describe, expect, it } from "vitest";
import { createSseGateway } from "../../apps/worker/src/sse/gateway";

const ENV_KEYS = [
  "FINNOR_WORKER_CAPABILITIES",
  "FINNOR_COMMIT_SHA",
  "FINNOR_BUILD_ID",
  "FINNOR_VERSION",
  "FINNOR_ENVIRONMENT",
  "FINNOR_RELEASE_SOURCE",
] as const;

const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("worker health contract", () => {
  it("proves realtime and configured worker capabilities", async () => {
    const commitSha = "a".repeat(40);
    process.env.FINNOR_WORKER_CAPABILITIES = "jobs,orchestration,computer,event-wake,connection-health,realtime,sse";
    process.env.FINNOR_COMMIT_SHA = commitSha;
    process.env.FINNOR_BUILD_ID = `finnor-${commitSha.slice(0, 12)}`;
    process.env.FINNOR_VERSION = `0.1.0+${commitSha.slice(0, 12)}`;
    process.env.FINNOR_ENVIRONMENT = "production";
    process.env.FINNOR_RELEASE_SOURCE = "github-actions";

    const server = createSseGateway();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not expose an address");

      const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
      const body = await response.json() as {
        ok?: boolean;
        realtime?: boolean;
        capabilities?: string[];
        release?: { commitSha?: string; buildId?: string; version?: string };
      };

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        realtime: true,
        capabilities: expect.arrayContaining(["jobs", "orchestration", "realtime", "sse"]),
        release: {
          commitSha,
          buildId: `finnor-${commitSha.slice(0, 12)}`,
          version: `0.1.0+${commitSha.slice(0, 12)}`,
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
