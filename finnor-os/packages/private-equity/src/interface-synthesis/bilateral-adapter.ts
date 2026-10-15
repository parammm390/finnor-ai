import { z } from "zod";
import type { BilateralSourceProfile, BilateralSourceRead } from "@finnor/shared-types";
import { BilateralSourceReadSchema } from "@finnor/shared-types";
import { canonical, digest } from "../../../governed-execution/src/canonical";
import { brokerPrivateFile, brokerResponseBytes } from "../../../governed-execution/src/broker-io";

const Credentials = z.object({
  schema: z.literal("finnor.bilateral-interface-credentials.v1"),
  credentialDomain: z.enum(["CANDIDATE_DIRECT_RECORD_READ_ONLY", "INDEPENDENT_ORIGINALS_READ_ONLY"]),
  profiles: z.array(z.object({
    profileId: z.string().uuid(), profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
    tokenPath: z.string().min(1), tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(64),
}).strict();
export async function interfaceCredential(path: string, domain: z.infer<typeof Credentials>["credentialDomain"], profileId: string, profileDigest: string) {
  const config = Credentials.parse(JSON.parse((await brokerPrivateFile(path)).toString("utf8")));
  const profile = config.profiles.find(p => p.profileId === profileId && p.profileDigest === profileDigest);
  if (!profile || config.credentialDomain !== domain) throw Error("P5_BILATERAL_EXACT_CREDENTIAL_DOMAIN_REQUIRED");
  const token = (await brokerPrivateFile(profile.tokenPath,undefined,8192)).toString("utf8").trim();
  if (!/^[\x21-\x7e]{16,4096}$/.test(token) || digest(token) !== profile.tokenDigest) throw Error("P5_BILATERAL_CREDENTIAL_IDENTITY_CHANGED");
  return token;
}
/** A single registered repeatable-read interface, never arbitrary producer HTTP
 * or a contact substitute. Live interfaces remain blocked pending qualification. */
export async function invokeBilateralInterface(source: BilateralSourceProfile, input: BilateralSourceRead, options: {
  configurationPath?: string; independent?: boolean; timeoutMs?: number;
} = {}) {
  const request = BilateralSourceReadSchema.parse(input), url = new URL(source.endpoint);
  if (source.environment !== "DEVELOPMENT" || process.env.NODE_ENV === "production" ||
    process.env.FINNOR_V1_PROFILE !== "ordinary_disposable" || url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash)
    throw Error("P5_BILATERAL_INTERFACE_DOMAIN_NOT_ADMITTED");
  if (digest(source) !== request.sourceProfileDigest || options.independent && request.operation !== "CHECK_ORIGINALS" ||
    !options.independent && request.operation === "CHECK_ORIGINALS") throw Error("P5_BILATERAL_LITERAL_READ_SCOPE_MISMATCH");
  const path = options.configurationPath ?? process.env.FINNOR_V1_SOURCE_CONFIG;
  if (!path) throw Error("P5_BILATERAL_READ_CREDENTIAL_UNAVAILABLE");
  const token = await interfaceCredential(path, options.independent ? "INDEPENDENT_ORIGINALS_READ_ONLY" : "CANDIDATE_DIRECT_RECORD_READ_ONLY", source.profileId, request.sourceProfileDigest);
  url.searchParams.set("request", Buffer.from(canonical(request)).toString("base64url"));
  const response = await fetch(url, {
    method: "GET", redirect: "error", headers: { authorization: "Bearer " + token, accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10000),
  });
  if (!response.ok || !response.body) throw Error("P5_BILATERAL_DIRECT_READ_UNAVAILABLE");
  const raw = await brokerResponseBytes(response,1048576);
  return { value: JSON.parse(raw.toString("utf8")) as unknown, transportDigest: digest(raw), bytes: raw.byteLength,
    interface: { adapter: source.adapterVersion, channel: source.channel, literalReadOperation: request.operation,
      sourceProfileDigest: request.sourceProfileDigest, recovery: source.recovery } };
}
