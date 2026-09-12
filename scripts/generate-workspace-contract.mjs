import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRelative = "finnor-os/apps/api/lib/workspace-config.ts";
const outputRelative = "src/components/jarvis/lib/workspace-config.generated.ts";
const source = await readFile(path.join(root, sourceRelative), "utf8");
const hash = createHash("sha256").update(source).digest("hex");
const output = [
  "// GENERATED FILE — DO NOT EDIT.",
  `// Source: ${sourceRelative}`,
  `// Source SHA-256: ${hash}`,
  "",
  source.trimEnd(),
  "",
  `export const WORKSPACE_CONTRACT_SOURCE = ${JSON.stringify(sourceRelative)} as const;`,
  `export const WORKSPACE_CONTRACT_SHA256 = ${JSON.stringify(hash)} as const;`,
  "",
].join("\n");

const outputPath = path.join(root, outputRelative);
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== output) {
    process.stderr.write("Workspace contract drift: run npm run workspace:generate\n");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, output, "utf8");
  process.stdout.write(`${outputRelative} <= ${sourceRelative} (${hash})\n`);
}
