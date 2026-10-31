/** Linux process-local donor denial around the real emitted installed journey.
 * Host executables/browser assets are explicit prerequisites, never admission.
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";

export function runConfinedInstalled({ installation, output, denied, kind = "INSTALLED_NATIVE" }) {
  assert.equal(process.platform, "linux", "W3_LINUX_CONFINEMENT_REQUIRED_NO_UNCONFINED_FALLBACK");
  assert(isAbsolute(installation) && isAbsolute(output));
  installation = realpathSync(installation);
  assert(!existsSync(output), "W3_INSTALLED_NEW_OUTPUT_REQUIRED");
  assert(Array.isArray(denied) && denied.length > 0 && denied.length <= 32);
  assert(denied.every(entry => isAbsolute(entry.root) && isAbsolute(entry.probe)));
  const descriptorBytes = readFileSync(join(installation, "finnor-os/w3-development-installation.json"));
  const descriptor = JSON.parse(descriptorBytes);
  assert.equal(descriptor.schema, "finnor.w3.development-installation.v1");
  assert.equal(descriptor.productionActive, false);
  assert(["INSTALLED_NATIVE", "SCIENTIFIC_CLOSURE"].includes(kind));
  mkdirSync(output, { mode: 0o700 });
  const nativeOutput = join(output, kind === "INSTALLED_NATIVE" ? "native" : "scientific-closure");
  const config = {
    schema: "finnor.w3.linux-confinement.v1", kind, denied,
    output: join(output, "confinement"), installation,
    descriptorSha256: createHash("sha256").update(descriptorBytes).digest("hex"),
    cwd: join(installation, "finnor-os"), node: realpathSync(process.execPath),
    command: [realpathSync(process.execPath), "--import=tsx", "scripts/postz/w3/" +
      (kind === "INSTALLED_NATIVE" ? "native.mts" : "scientific-closure.mjs"),
      ...(kind === "INSTALLED_NATIVE" ? ["--installation", installation, "--output", nativeOutput] : [])],
  };
  const input = join(output, "confinement-input.json");
  writeFileSync(input, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const started = Date.now();
  const child = spawnSync("/usr/bin/python3",
    ["-I", "-B", join(installation, "finnor-os/scripts/postz/w3/confine-linux.py"), input],
    { cwd: config.cwd, env: { ...process.env, W3_CLOSURE_INSTALLATION: installation,
        W3_CLOSURE_OUTPUT: nativeOutput, W3_CLOSURE_DESCRIPTOR_SHA256: config.descriptorSha256 },
      stdio: "inherit", timeout: kind === "INSTALLED_NATIVE" ? 1200000 : 180000 });
  const report = {
    schema: "finnor.w3.confined-installed-command.v1", kind, descriptorSha256: config.descriptorSha256,
    exitCode: child.status, signal: child.signal, elapsedMs: Date.now() - started,
    nativeOutput, confinementReceipt: join(config.output, "confinement.json"),
    unconfinedFallback: false, productionActive: false, protectedQualification: false,
  };
  writeFileSync(join(output, "command-result.json"), JSON.stringify(report, null, 2) + "\n",
    { flag: "wx", mode: 0o600 });
  assert.equal(child.status, 0, "W3_CONFINED_INSTALLED_COMMAND_FAILED");
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  assert(args.length === 6 && args[0] === "--installation" && args[2] === "--output" && args[4] === "--denied"
    && isAbsolute(args[1]) && isAbsolute(args[3]) && isAbsolute(args[5]), "W3_INSTALLED_ABSOLUTE_INPUTS_REQUIRED");
  console.log(JSON.stringify(runConfinedInstalled({
    installation: args[1], output: args[3], denied: JSON.parse(readFileSync(args[5], "utf8")),
  })));
}
