/** Disposable owner-intent transport only. Never establishes protected authority. */
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../../packages/governed-execution/src/protocol";
import { createEconomicLedger } from "../s7/ledger-fixture.mts";

export async function createCapitalOwnerDeliveryFixture(endpoint: string, deadline: number) {
  const directory = await mkdtemp(join(tmpdir(), "finnor-v4-owner-transport-"));
  const root = generateKeyPairSync("ed25519"), origin = generateKeyPairSync("ed25519");
  const rootPublic = root.publicKey.export({ type: "spki", format: "pem" }).toString();
  const configPath = join(directory, "transport.json"), signerPath = join(directory, "origin.pem"),
    tokenPath = join(directory, "transport.token"), token = randomBytes(32).toString("hex");
  await writeFile(signerPath, origin.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(tokenPath, token, { mode: 0o600 });
  const validAfter = new Date(Date.now() - 1000).toISOString(), validUntil = new Date(deadline).toISOString();
  async function install(policy: unknown) {
    const temporary = join(directory, randomUUID() + ".json");
    await writeFile(temporary, JSON.stringify({ policy,
      signature: sign(null, Buffer.from(canonical(policy)), root.privateKey).toString("base64") }), { mode: 0o600 });
    await rename(temporary, configPath);
    process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG = configPath;
    process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT = rootPublic;
  }
  // An unmatched disposable route keeps the installed process configuration
  // valid until the exact S7 fixture owner is enrolled. It cannot send real data.
  await install({ schema: "finnor.s6.owner-transport-policy.v1", domain: "DISPOSABLE_TEST_AUTHORITY",
    validAfter, validUntil, routes: [{ semanticOwner: "S7", tenantId: randomUUID(), principalId: randomUUID(),
      rightsRefs: ["unmatched-disposable-owner"], originKeys: [{ id: "fixture-origin",
        publicKey: origin.publicKey.export({ type: "spki", format: "pem" }).toString(), validAfter, validUntil, revoked: false }],
      originSigner: { keyId: "fixture-origin", path: signerPath }, tokenPath,
      tokenSha256: createHash("sha256").update(token).digest("hex"), ledger: { endpoint,
        acceptedReceipts: [{ signerPublicKey: rootPublic, releaseId: "unmatched-disposable-owner",
          verifierDigest: "0".repeat(64), policyDigest: "0".repeat(64) }] }, requestTimeoutMs: 1000, leaseMs: 3000 }] });
  let ledger: Awaited<ReturnType<typeof createEconomicLedger>> | undefined;
  return {
    environment: { FINNOR_S6_OWNER_TRANSPORT_CONFIG: configPath, FINNOR_S6_OWNER_TRANSPORT_ROOT: rootPublic },
    async enrol(f: { tenant: string; principal: string; workId: string }) {
      if (ledger) throw Error("Only the original scoped S7 fixture may enroll");
      ledger = await createEconomicLedger(f.tenant, f.principal, randomUUID(), { rightsRef: "capital-work:" + f.workId });
      const native = JSON.parse(await readFile(join(ledger.root, "transport.json"), "utf8"));
      const routes = native.policy.routes.filter((route: any) => route.semanticOwner === "S7" && route.purpose === "OWNER");
      if (routes.length !== 1) throw Error("Exact disposable S7 owner route required");
      await install({ ...native.policy, validUntil, routes });
      return { domain: "DISPOSABLE_TEST_AUTHORITY", sourceDigests: ledger.before,
        originalWorkId: f.workId, actualSeparateLedger: true, protectedReceipt: null };
    },
    async stop() { await ledger?.stop(); },
  };
}
