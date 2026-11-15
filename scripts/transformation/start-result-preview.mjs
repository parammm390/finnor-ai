import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = resolve(process.argv[2]);
const output = join(evidence, "renderer");
const require = createRequire(join(root, "finnor-os/package.json"));
const { build } = require("esbuild");
const candidates = (await readdir(join(evidence, "owner-evidence"))).filter(path => /^world-scope-.*\.json$/.test(path));
if (candidates.length !== 1) throw new Error("One exact owner evidence artifact is required");
const source = join(evidence, "owner-evidence", candidates[0]);
const bytes = await readFile(source), record = JSON.parse(bytes);
const documentResult = record.observations.find(item => item.step === "document-review-owner")?.value.live.body.work;
const explanation = record.observations.find(item => item.step === "checked-financial-explanation" && item.value.response.body.answer?.analysis?.status === "checked")?.value.response.body.answer;
if (!documentResult && !explanation) throw new Error("No verified HTTP result found");
const answer = JSON.stringify(documentResult ?? {
  work: { status: "completed", updatedAt: explanation.asOf, finalOutcome: { kind: "answer", answer: explanation } },
});
await mkdir(output, { recursive: true });
await build({ entryPoints: [join(root, "scripts/transformation/result-preview.tsx")], outdir: output, bundle: true, minify: true, format: "esm", platform: "browser", jsx: "automatic", nodePaths: [join(root, "node_modules")], define: { "process.env.NODE_ENV": '"production"' }, logLevel: "warning" });
await writeFile(join(output, "inputs.json"), JSON.stringify({ qualification: "Actual AnswerCanvas renderer over saved signed HTTP result; not the full authenticated Next.js workspace", source, sourceSha256: createHash("sha256").update(bytes).digest("hex"), answerSha256: createHash("sha256").update(answer).digest("hex") }, null, 2));
const assets = { "/": ["text/html", Buffer.from('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FINNOR result verification</title><link rel="stylesheet" href="/preview.css"><div id="root"></div><script type="module" src="/preview.js"></script></html>')],
  "/answer.json": ["application/json", Buffer.from(answer)], "/preview.js": ["text/javascript", await readFile(join(output, "result-preview.js"))], "/preview.css": ["text/css", await readFile(join(output, "result-preview.css"))] };
const server = createServer((request, response) => {
  const asset = assets[request.url];
  if (!asset) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": asset[0], "cache-control": "no-store" }); response.end(asset[1]);
});
server.listen(3342, "127.0.0.1", () => console.log(JSON.stringify({ url: "http://127.0.0.1:3342", source, qualification: "renderer only" })));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
