import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bytesHash, hash } from "./contracts";
const files = [
  "packages/shared-types/src/interventions.ts",
  "packages/epistemic-runtime/src/interventions.ts",
  "packages/governed-execution/src/dispatch-broker.ts",
  "packages/private-equity/src/real-world-service/contracts.ts",
  "packages/private-equity/src/real-world-service/boundaries.ts",
  "packages/private-equity/src/real-world-service/compiler.ts",
  "packages/private-equity/src/real-world-service/checker.ts",
  "packages/private-equity/src/real-world-service/projection.ts",
  "packages/private-equity/src/real-world-service/store.ts",
  "packages/private-equity/src/real-world-service/participants.ts",
  "packages/private-equity/src/real-world-service/consumer.ts",
  "packages/private-equity/src/real-world-service/worker.ts",
  "packages/private-equity/src/real-world-service/identity.ts",
  "packages/private-equity/src/real-world-service/meter.ts",
  "packages/private-equity/src/real-world-service/api.ts",
  "packages/private-equity/src/enterprise-obligations.ts",
  "packages/private-equity/src/enterprise-allocation.ts",
  "packages/private-equity/src/enterprise-control.ts",
  "packages/private-equity/src/enterprise-beliefs.ts",
  "packages/private-equity/src/obligation-contracts.ts",
  "packages/private-equity/src/allocation-store.ts",
  "packages/db/compute-contract.ts",
  "packages/db/migrations/0199_postz_w3_real_world_services.sql",
  "apps/worker/src/index.ts",
  "apps/api/app/api/real-world-services/[operation]/route.ts",
];
let loaded: string | undefined;
export async function serviceIdentity() {
  const sources = await Promise.all(files.map(async path => ({ path, sha256: bytesHash(await readFile(resolve(process.cwd(), path))) })));
  const methodDigest = hash(sources), checkerDigest = sources.find(f => f.path.endsWith("/checker.ts"))!.sha256;
  const runtimeDigest = hash({
    node: process.version, abi: process.versions.modules, platform: process.platform, architecture: process.arch,
    nodeSha256: bytesHash(await readFile(process.execPath)),
    lockSha256: bytesHash(await readFile(resolve(process.cwd(), "package-lock.json"))),
    profile: process.env.FINNOR_W3_PROFILE ?? "UNCONFIGURED",
  });
  const combined = hash({ methodDigest, checkerDigest, runtimeDigest });
  if (loaded && loaded !== combined) throw Error("W3_LOADED_SOURCE_CHECKER_OR_RUNTIME_CHANGED");
  loaded ??= combined;
  return { methodDigest, checkerDigest, runtimeDigest };
}
export function requireServiceProfile() {
  if (process.env.FINNOR_W3_PROFILE !== "ordinary_disposable" || process.env.FINNOR_ENVIRONMENT !== "staging"
    || process.env.NODE_ENV === "production") throw Error("W3_PROFILE_UNADMITTED");
}
/** Only the disposable profile has a service clock. Actual authentication,
 * consent, leases, authority and resource expiry continue to use real time. */
export function serviceNow(): number {
  const controlled = process.env.FINNOR_W3_CONTROLLED_NOW;
  if (!controlled) return Date.now();
  requireServiceProfile();
  const parsed = Date.parse(controlled);
  if (!Number.isFinite(parsed)) throw Error("W3_CONTROLLED_CLOCK_INVALID");
  return parsed;
}
