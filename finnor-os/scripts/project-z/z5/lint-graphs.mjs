import { ESLint } from "eslint";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./e2e-tools.mjs";
const file = process.argv[2];
if (!file || !path.isAbsolute(file)) throw Error("Exact owned integration manifest required");
const manifest = JSON.parse(await readFile(file, "utf8"));
const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: path.join(ROOT, "eslint.config.mjs") });
const results = process.argv[3] === "--affected" ? [] : await eslint.lintFiles(["src", "scripts"]);
for (const item of manifest.files.filter(f => f.path.startsWith("src/") || f.path.startsWith("scripts/"))) {
  const code = await readFile(path.join(ROOT, item.postimage), "utf8");
  results.push(...await eslint.lintText(code, { filePath: path.join(ROOT, item.path) }));
}
const formatter = await eslint.loadFormatter("stylish"); process.stdout.write(formatter.format(results));
const errors = results.reduce((n, r) => n + r.errorCount, 0), warnings = results.reduce((n, r) => n + r.warningCount, 0);
console.log(JSON.stringify({ schema: "finnor.z5.proposed-source-lint.v1", files: results.length, errors, warnings,
  patchSha256: manifest.patchSha256, sharedFilesWritten: 0, installedProof: false }));
process.exitCode = errors ? 1 : 0;
