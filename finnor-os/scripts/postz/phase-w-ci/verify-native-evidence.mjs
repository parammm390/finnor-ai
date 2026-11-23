import { appendFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requireNativeCISourceIdentity, verifyNativeEvidence } from "./native-evidence.mjs";

const must = (condition, code) => {
  if (!condition) throw Object.assign(Error(code), { code });
};
try {
  const args = process.argv.slice(2);
  must(args.length === 6 && args[0] === "--source" && args[2] === "--output" && args[4] === "--sha"
    && isAbsolute(args[1]) && isAbsolute(args[3]) && /^[a-f0-9]{40}$/.test(args[5]), "PHASE_W_NATIVE_CI_ARGUMENTS_INVALID");
  const source = resolve(args[1]), output = args[3], expectedSha = args[5];
  const identity = requireNativeCISourceIdentity(source, expectedSha);
  const verified = await verifyNativeEvidence(output);
  const receipt = { schema: "finnor.w.native-ci-evidence-verification.v1", status: "PASS_CONTROLLED_NATIVE_RECEIPTS",
    source: identity, ...verified };
  must(isDeepStrictEqual(identity, requireNativeCISourceIdentity(source, expectedSha)), "PHASE_W_NATIVE_CI_SOURCE_IDENTITY_CHANGED");
  const serialized = JSON.stringify(receipt);
  console.log(serialized);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    "### NativeControlledDEV receipt acceptance, not Phase W release\n\n```json\n" + serialized + "\n```\n");
} catch (error) {
  const code = typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
    ? error.code : "PHASE_W_NATIVE_CI_EVIDENCE_REFUSED";
  console.error(code);
  process.exitCode = 1;
}
