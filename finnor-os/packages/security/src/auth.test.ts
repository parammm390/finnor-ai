import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { verifyBearerToken } from "./auth";

beforeEach(() => {
  vi.stubEnv("FINNOR_AUTH_PROVIDER", "supabase");
  vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:12345");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "disposable-auth-test-key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fixtureToken = (expires: number) => [
  encode({ alg: "HS256", typ: "JWT" }),
  encode({ exp: expires, email: "owner@test.invalid" }),
  "AA",
].join(".");

it.each([401, 429, 503])("classifies a provider response of %s without accepting the caller", async (status) => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: "Refused" }), { status }));
  vi.stubGlobal("fetch", request);
  await expect(verifyBearerToken(fixtureToken(Math.floor(Date.now() / 1000) + 60)))
    .rejects.toMatchObject({ status: status === 401 ? 401 : 503 });
  expect(request).toHaveBeenCalledTimes(1);
});

it("does not report a failed auth transport as a denied identity", async () => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Fixture transport unavailable"));
  vi.stubGlobal("fetch", request);
  await expect(verifyBearerToken(fixtureToken(Math.floor(Date.now() / 1000) + 60)))
    .rejects.toMatchObject({ status: 503 });
  expect(request).toHaveBeenCalledTimes(1);
});

it("continues rejecting expired tokens without sending them to the provider", async () => {
  const request = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", request);
  await expect(verifyBearerToken(fixtureToken(Math.floor(Date.now() / 1000) - 60)))
    .rejects.toMatchObject({ status: 401 });
  expect(request).not.toHaveBeenCalled();
});
