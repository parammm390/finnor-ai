import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bytesHash, hash } from "./contracts";

const files = [
  "packages/shared-types/src/interventions.ts", "packages/epistemic-runtime/src/interventions.ts",
  "packages/governed-execution/src/dispatch-broker.ts",
  ...["contracts", "boundaries", "compiler", "checker", "projection", "store", "participants", "consumer", "worker", "identity", "meter", "api"]
    .map(name => `packages/private-equity/src/demand-to-business/${name}.ts`),
  "packages/private-equity/src/enterprise-obligations.ts", "packages/private-equity/src/enterprise-allocation.ts",
  "packages/private-equity/src/enterprise-control.ts", "packages/private-equity/src/enterprise-beliefs.ts",
  "packages/private-equity/src/obligation-contracts.ts", "packages/private-equity/src/allocation-store.ts",
  "packages/private-equity/src/index.ts",
  "packages/db/compute-contract.ts", "packages/db/migrations/0200_postz_w4_demand_to_business.sql",
  "apps/worker/src/index.ts", "apps/api/app/api/demand-to-business/[operation]/route.ts",
];
let loaded: string | undefined;
export async function growthIdentity() {
  const sources = await Promise.all(files.map(async path => ({ path,
    sha256: bytesHash(await readFile(resolve(process.cwd(), path))) })));
  const methodDigest = hash(sources), checkerDigest = sources.find(f => f.path.endsWith("/checker.ts"))!.sha256;
  const nodeHash = createHash("sha256");
  for await (const chunk of createReadStream(process.execPath)) nodeHash.update(chunk);
  const runtimeDigest = hash({ node: process.version, abi: process.versions.modules, platform: process.platform,
    architecture: process.arch, nodeSha256: nodeHash.digest("hex"),
    lockSha256: bytesHash(await readFile(resolve(process.cwd(), "package-lock.json"))),
    profile: process.env.FINNOR_W4_PROFILE ?? "UNCONFIGURED" });
  const combined = hash({ methodDigest, checkerDigest, runtimeDigest });
  if (loaded && loaded !== combined) throw Error("W4_LOADED_SOURCE_CHECKER_OR_RUNTIME_CHANGED");
  loaded ??= combined;
  return { methodDigest, checkerDigest, runtimeDigest };
}
export function requireGrowthProfile() {
  if (process.env.FINNOR_W4_PROFILE !== "ordinary_disposable" || process.env.FINNOR_ENVIRONMENT !== "staging"
    || process.env.NODE_ENV === "production") throw Error("W4_PROFILE_UNADMITTED");
}
/** The scenario clock never changes authentication, consent, SQL leases or grants. */
export function growthNow() {
  if (!process.env.FINNOR_W4_CONTROLLED_NOW) return Date.now();
  requireGrowthProfile();
  const now = Date.parse(process.env.FINNOR_W4_CONTROLLED_NOW);
  if (!Number.isFinite(now)) throw Error("W4_CONTROLLED_CLOCK_INVALID");
  return now;
}
