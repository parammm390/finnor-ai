/** Real installed Next/glob preflight for the declared whole-owner source cut.
 * This checks build inputs, not native execution or protected artifact custody. */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import config from "../../../apps/api/next.config.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const api = resolve(root, "finnor-os/apps/api");
const base = "finnor-os/packages/private-equity/src/project-z/z1-shared-work/";
const output = process.argv[2];
if (!output || !isAbsolute(output) || process.env.FINNOR_Z1_PACKAGE_BUILD !== "1")
  throw Error("EXACT_SEPARATE_TRACE_PREFLIGHT_REPORT_REQUIRED");
const manifest = JSON.parse(await readFile(resolve(root, base + "installed-source-files.json"), "utf8"));
const patterns = config.outputFileTracingIncludes["/api/*"];
const require = createRequire(new URL("../../../package.json", import.meta.url));
const glob = require("next/dist/compiled/glob");
const observed = new Set();
for (let start = 0; start < patterns.length; start += 32) {
  await Promise.all(patterns.slice(start, start + 32).map(pattern => new Promise((resolvePattern, reject) =>
    glob(pattern.replaceAll("\\", "/"), { cwd: api, nodir: true, dot: true }, (error, files) => {
      if (error) return reject(error);
      for (const file of files) observed.add(resolve(api, file));
      resolvePattern();
    }))));
}
const expected = [...manifest.files.map(file => file.path), base + "installed-source.json", base + "installed-source-files.json"];
const missing = expected.filter(path => !observed.has(resolve(root, path)));
const report = { schema: "finnor.z1.trace-input-preflight.v1", status: missing.length ? "FAILED" : "PASSED",
  patterns: patterns.length, declaredFiles: expected.length, missingFiles: missing, databaseActions: 0,
  scope: "Actual installed Next 15 include normalization and glob resolution, not emitted trace or native owner execution." };
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ status: report.status, declaredFiles: expected.length, missingFiles: missing.length }));
if (missing.length) process.exitCode = 1;
