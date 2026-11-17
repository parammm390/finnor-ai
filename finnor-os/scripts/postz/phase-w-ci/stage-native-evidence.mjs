import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requireNativeCISourceIdentity, stageNativeEvidence } from "./native-evidence.mjs";

const must = (condition, code) => {
  if (!condition) throw Object.assign(Error(code), { code });
};
try {
  const args = process.argv.slice(2);
  const flags = ["--source", "--output", "--types-output", "--staging", "--sha",
    "--native-outcome", "--verifier-outcome", "--types-outcome"];
  must(args.length === flags.length * 2 && flags.every((flag, index) => args[index * 2] === flag)
    && [1, 3, 5, 7].every(index => isAbsolute(args[index])) && /^[a-f0-9]{40}$/.test(args[9]),
  "PHASE_W_PUBLIC_STAGING_ARGUMENTS_INVALID");
  const source = args[1], sourceSha = args[9];
  const before = requireNativeCISourceIdentity(source, sourceSha);
  const receipt = await stageNativeEvidence({ output: args[3], typeOutput: args[5], staging: args[7], sourceSha,
    nativeOutcome: args[11], verifierOutcome: args[13], typesOutcome: args[15] });
  must(isDeepStrictEqual(before, requireNativeCISourceIdentity(source, sourceSha)), "PHASE_W_PUBLIC_STAGING_SOURCE_CHANGED");
  // These outputs have one real consumer: the independent mandatory job verdict.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
    "native_status=" + receipt.native.status + "\ntypes_status=" + receipt.types.status + "\n");
  console.log(JSON.stringify({ schema: "finnor.w.public-ci-staging.v1", nativeStatus: receipt.native.status,
    typesStatus: receipt.types.status, source: before, admitted: false, productionActive: false, fieldValidated: false }));
} catch (error) {
  const code = typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
    ? error.code : "PHASE_W_PUBLIC_STAGING_REFUSED";
  console.error(code);
  process.exitCode = 1;
}
