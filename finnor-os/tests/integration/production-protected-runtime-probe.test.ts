import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const backend = fileURLToPath(new URL("../../", import.meta.url));
async function probe(args: string[], protectedCredential?: string) {
  const env = { ...process.env };
  delete env.VERCEL_API_AUTOMATION_BYPASS_SECRET;
  if (protectedCredential) env.VERCEL_API_AUTOMATION_BYPASS_SECRET = protectedCredential;
  const child = spawn(process.execPath, ["--import=" + join(backend, "node_modules/tsx/dist/loader.mjs"),
    "scripts/release/verify-p8-runtime-contract.ts", ...args], { cwd: backend, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (value) => { output += value; });
  child.stderr.on("data", (value) => { output += value; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, output };
}

it("keeps static mode credential-free and validates a protected route-shaped readiness fixture", async () => {
  const credential = "synthetic-local-fixture";
  let received = 0;
  let ready = true;
  const server = createServer((request, response) => {
    if (request.headers["x-vercel-protection-bypass"] !== credential) {
      response.writeHead(401, { "content-type": "application/json" }).end('{"ok":false}');
      return;
    }
    received++;
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({
      ok: ready,
      checks: {
        productAuthority: { ok: ready, detail: { state: ready ? "water_retired" : "preparing", activeProductVertical: "private_equity" } },
        runtimeEpoch: { ok: ready },
        runtimeRelease: { ok: ready },
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No fixture port");
    const args = ["--readiness-url", `http://127.0.0.1:${address.port}`];
    expect((await probe([])).code).toBe(0);
    expect((await probe(args)).code).toBe(1);
    expect(received).toBe(0);
    expect((await probe(args, credential)).code).toBe(0);
    expect(received).toBe(1);
    ready = false;
    expect((await probe(args, credential)).code).toBe(1);
    expect(received).toBe(2);
    const directory = process.env.FINNOR_PRODUCTION_PREFLIGHT_EVIDENCE_DIR
      ?? await mkdtemp(join(tmpdir(), "finnor-protected-probe-"));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "protected-runtime-probe.json"), JSON.stringify({
      schema: "finnor.protected-runtime-probe-proof.v1",
      inputs: { fixture: "isolated protected HTTP endpoint", routeShape: "/api/ready" },
      steps: ["Static without credential", "Protected missing credential", "Protected ready", "Protected wrong authority/epoch/release"],
      observed: { staticPassed: true, missingCredentialRefused: true, protectedReadyPassed: true, wrongRuntimeRefused: true },
      providerDeploymentProof: false,
      rerun: "npm --prefix finnor-os test -- --run tests/integration/production-protected-runtime-probe.test.ts",
    }, null, 2) + "\n");
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}, 60_000);
