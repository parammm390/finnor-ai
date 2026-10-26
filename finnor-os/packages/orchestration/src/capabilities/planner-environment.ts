import { createHash } from "node:crypto";
import { readFile, stat, realpath } from "node:fs/promises";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describeLLMRoute } from "@finnor/tools/llm";
import { CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";
import { z } from "zod";
import { capabilityDigest } from "./policy";

/** Pin the local proposal/evaluation implementation and resolved named route.
 * Provider-side model changes remain an external qualification boundary. */
async function readEnvironment(signal: AbortSignal) {
  const manifestUrl = new URL("./planner-replay-manifest.json", import.meta.url);
  if ((await stat(manifestUrl)).size > 262_144) throw new CapabilityEngineError("GEPA_PLANNER_REPLAY_MANIFEST_LIMIT_EXCEEDED");
  const manifest = z.object({ schema: z.literal("finnor.planner-replay-source-manifest.v1"), roots: z.array(z.string()), sources: z.array(z.object({
    file: z.string().refine(file => !file.startsWith("/") && !file.split("/").includes("..") && !file.includes("node_modules")),
    bytes: z.number().int().nonnegative().max(16 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict()).min(1).max(1024) }).strict().parse(JSON.parse(await readFile(manifestUrl, { encoding: "utf8", signal })));
  if (new Set(manifest.sources.map(source => source.file)).size !== manifest.sources.length || manifest.sources.reduce((total, source) => total + source.bytes, 0) > 16 * 1024 * 1024)
    throw new CapabilityEngineError("GEPA_PLANNER_REPLAY_MANIFEST_LIMIT_EXCEEDED");
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(16, manifest.sources.length) }, async () => {
    for (;;) {
      const source = manifest.sources[next++]; if (!source) return;
      signal.throwIfAborted();
      const path = await realpath(new URL(`../../../../${source.file}`, import.meta.url));
      if (relative(root, path).startsWith("..") || (await stat(path)).size !== source.bytes) throw new CapabilityEngineError("GEPA_PLANNER_REPLAY_MANIFEST_STALE");
      const bytes = await readFile(path, { signal });
      if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new CapabilityEngineError("GEPA_PLANNER_REPLAY_MANIFEST_STALE");
    }
  }));
  return { schema: "finnor.planner-candidate-environment.v2", manifestDigest: capabilityDigest(manifest), sources: manifest.sources, route: describeLLMRoute("planning", "background"), node: process.version };
}
export async function plannerCandidateEnvironment() {
  const signal = AbortSignal.timeout(5000);
  return Promise.race([readEnvironment(signal), new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new CapabilityEngineError("GEPA_PLANNER_REPLAY_MANIFEST_DEADLINE_EXCEEDED")), { once: true });
  })]);
}
export async function plannerCandidateEnvironmentDigest() { return capabilityDigest(await plannerCandidateEnvironment()); }
