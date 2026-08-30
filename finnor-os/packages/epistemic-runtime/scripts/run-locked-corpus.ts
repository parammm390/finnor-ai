import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCKED_CORPUS, runLockedCorpus } from "../fixtures/locked-corpus";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<void> {
  const fixture = await readFile(resolve(packageRoot, "fixtures/locked-cases.json"));
  const fixtureSha256 = createHash("sha256").update(fixture).digest("hex");
  const results = await runLockedCorpus();
  const failed = results.filter((result) => !result.passed);
  const output = {
    status: failed.length === 0 ? "PASS" : "FAIL",
    version: LOCKED_CORPUS.version,
    fixedClock: LOCKED_CORPUS.fixedClock,
    fixedSeed: LOCKED_CORPUS.fixedSeed,
    cases: results.length,
    passed: results.length - failed.length,
    failed: failed.map((result) => ({ id: result.id, expected: result.expected, actual: result.actual })),
    fixtureSha256,
    liveExternalDependencies: 0,
  };
  console.log(JSON.stringify(output, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
