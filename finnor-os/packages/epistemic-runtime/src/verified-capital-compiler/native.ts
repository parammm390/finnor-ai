import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalSerialize, d, FinnorDecimal, FINNOR_DECIMAL_POLICY, round, semanticHash,
  UNDERWRITING_ENGINE_VERSION, UNDERWRITING_MODEL_SCHEMA_VERSION,
} from "../../../underwriting/src/index";
import type { R6NativeIdentity } from "../../../shared-types/src/decision-proof";

/** This allowlist is independently repeated and checked by checker.py. */
export const R6_NATIVE_PATHS = Object.freeze([
  "finnor-os/packages/underwriting/package.json",
  ...["canonical", "compiler", "decimal", "errors", "executor", "index", "periods",
    "result", "snapshot", "standard-lbo", "returns", "types", "returns-v2"].map(
    name => `finnor-os/packages/underwriting/src/${name}.ts`,
  ),
]);
export const R6_CHECKER_PATH =
  "finnor-os/packages/epistemic-runtime/src/verified-capital-compiler/checker.py";
export const R6_LBO_V2_CHECKER_PATH =
  "finnor-os/packages/epistemic-runtime/src/verified-capital-compiler/lbo-v2-checker.py";
export const R6_LBO_V2_CHECKER_DEPENDENCIES = Object.freeze([
  R6_CHECKER_PATH,
  "finnor-os/packages/epistemic-runtime/src/verified-capital-compiler/lbo-obligation-checker.py",
]);
const PRODUCER_PATHS = [
  ...["contracts.ts", "compiler.ts", "checker.ts", "native.ts", "membership.ts", "index.ts"].map(
    name => `finnor-os/packages/epistemic-runtime/src/verified-capital-compiler/${name}`,
  ),
  "finnor-os/packages/private-equity/src/r6/verified-capital-compiler.ts",
  "finnor-os/packages/shared-types/src/decision-proof.ts",
  "finnor-os/packages/shared-types/src/certified-state-reduction.ts",
  "finnor-os/packages/shared-types/src/evidence-execution.ts",
  "finnor-os/packages/shared-types/src/experiments.ts",
];

/** The native clone is exported and mutable. A constant is not a live runtime
 * pin. Refuse a changed configuration; never reset another owner's settings. */
export function assertR6NativeNumericPolicy(): void {
  if (FinnorDecimal.precision !== 34 || FinnorDecimal.rounding !== 6
    || FinnorDecimal.minE !== -100 || FinnorDecimal.maxE !== 100
    || FinnorDecimal.toExpNeg !== -100 || FinnorDecimal.toExpPos !== 100
    || round("2.345", 2) !== "2.34" || round("2.355", 2) !== "2.36") {
    throw new Error("Live native Decimal precision/rounding/exponent configuration changed; no R6 proof is applicable");
  }
}

export function r6Sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The actual module instance must be the native interpreter's Decimal source.
 * A version string alone is not a runtime pin or conformance proof. */
export async function captureR6NativeIdentity(options: {
  repositoryRoot: string;
  dependencyRoot: string;
  nativeReturnMethod?: "decimal34_horner_npv_v2";
}): Promise<R6NativeIdentity> {
  const root = resolve(options.repositoryRoot);
  if (options.nativeReturnMethod !== undefined && options.nativeReturnMethod !== "decimal34_horner_npv_v2") {
    throw new Error("Native return method/checker selection is not enrolled");
  }
  const deps = resolve(options.dependencyRoot);
  const actual = JSON.parse(await readFile(join(deps, "decimal.js/package.json"), "utf8")) as { version: string };
  const lockBytes = await readFile(join(root, "finnor-os/package-lock.json"));
  const lock = JSON.parse(lockBytes.toString("utf8")) as { packages: Record<string, { version: string }> };
  if (actual.version !== lock.packages["node_modules/decimal.js"]?.version) {
    throw new Error("Actual native decimal dependency does not match the sealed lock");
  }
  const modulePath = join(deps, "decimal.js/decimal.mjs");
  const actualModule = await import(pathToFileURL(modulePath).href) as { default: new (value: string) => object };
  if (!(d("1") instanceof actualModule.default)) {
    throw new Error("Declared Decimal module is not the instance used by the native underwriting interpreter");
  }
  if (canonicalSerialize(FINNOR_DECIMAL_POLICY) !== canonicalSerialize({
    precision: 34, rounding: "ROUND_HALF_EVEN", maxInputCharacters: 128, maxAbsoluteExponent: 100,
  })) throw new Error("Native Decimal policy changed; requalification is required");
  const sourcePins = await Promise.all(R6_NATIVE_PATHS.map(async path => ({
    path, sha256: r6Sha256(await readFile(join(root, path))),
  })));
  const producerPins = await Promise.all(PRODUCER_PATHS.map(async path => ({
    path, sha256: r6Sha256(await readFile(join(root, path))),
  })));
  assertR6NativeNumericPolicy();
  return {
    schema: "finnor.r6.native-semantics.v1",
    engineVersion: UNDERWRITING_ENGINE_VERSION,
    irSchema: UNDERWRITING_MODEL_SCHEMA_VERSION,
    decimalPolicy: { precision: 34, rounding: "ROUND_HALF_EVEN", maxInputCharacters: 128, maxAbsoluteExponent: 100 },
    sourcePins,
    dependencyLockDigest: `sha256:${r6Sha256(lockBytes)}`,
    decimalModuleDigest: `sha256:${r6Sha256(await readFile(modulePath))}`,
    decimalPackageVersion: actual.version,
    checkerDigest: `sha256:${r6Sha256(await readFile(join(root,
      options.nativeReturnMethod ? R6_LBO_V2_CHECKER_PATH : R6_CHECKER_PATH)))}`,
    ...(options.nativeReturnMethod ? {
      nativeReturnMethod: options.nativeReturnMethod,
      checkerDependencyPins: await Promise.all(R6_LBO_V2_CHECKER_DEPENDENCIES.map(async path => ({
        path, sha256: r6Sha256(await readFile(join(root, path))),
      }))),
    } : {}),
    producerDigest: semanticHash(producerPins),
  };
}
