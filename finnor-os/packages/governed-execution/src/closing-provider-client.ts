import { brokerOrigin, brokerPrivateFile, brokerRequest, brokerToken } from "./broker-io";
/** Workers carry only exact native refs. The private provider token is held by the
 * separately launched broker, never by a worker/producer payload. */
export async function brokerCanonicalRequest(path: "/dispatch" | "/read", body: unknown): Promise<Record<string, unknown>> {
  const origin = process.env.FINNOR_V3_BROKER_ORIGIN, tokenPath = process.env.FINNOR_V3_BROKER_CLIENT_TOKEN_FILE;
  if (!origin || !tokenPath) throw Error("S6_CLOSING_BROKER_BINDING_UNAVAILABLE");
  const base = brokerOrigin(origin, process.env.NODE_ENV === "production" ? "PROTECTED" : "DISPOSABLE_TEST_AUTHORITY");
  const token = brokerToken(await brokerPrivateFile(tokenPath));
  const response = await brokerRequest(new URL(path, base), { method: "POST", token, body, deadlineAt: Date.now() + 10000 });
  if (response.status !== 200 || !response.body || typeof response.body !== "object") throw Error("S6_CLOSING_BROKER_CURRENT_DISPATCH_OR_OBSERVATION_UNAVAILABLE");
  return response.body;
}
