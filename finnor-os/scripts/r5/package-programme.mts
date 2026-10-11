import { build, version } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const base = "finnor-os/packages/epistemic-runtime/src/coalition-programme-search/";
if (version !== "0.25.12") throw Error("Pinned compiler version differs");
const built = await build({ absWorkingDir: root, entryPoints: [base + "programme-child.ts"],
  bundle: true, write: false, metafile: true, platform: "node", format: "esm", target: "node22",
  legalComments: "none", charset: "utf8" });
const bytes = built.outputFiles[0]!.contents;
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const sources = await Promise.all(Object.keys(built.metafile!.inputs).sort().map(async path =>
  ({ path, sha256: hash(await readFile(join(root, path))) })));
const manifest = Buffer.from(JSON.stringify({ schema: "finnor.r5.packaged-programme.v1",
  compiler: { name: "esbuild", version }, moduleSha256: hash(bytes), sources }, null, 2) + "\n");
for (const [file, data] of [["programme.mjs", bytes], ["programme-manifest.json", manifest]] as const) {
  const path = join(root, base, file);
  if (process.argv.includes("--check")) {
    if (!(await readFile(path)).equals(Buffer.from(data))) throw Error("Packaged programme source drift: " + file);
  } else await writeFile(path, data, { mode: 0o644 });
}
console.log(JSON.stringify({ status: "PASS", moduleSha256: hash(bytes), sources: sources.length }));
