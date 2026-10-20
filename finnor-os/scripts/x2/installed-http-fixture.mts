/** Runs the real built Next API. Authentication is supplied by the genuine
 * disposable identity fixture; no source-route wrapper or auth bypass. */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { AuthObservation } from "./authenticated-http-fixture.mts";

export interface InstalledApiIdentity {
  origin: string;
  serviceRoleKey: string;
  token(identity: "actor" | "other"): Promise<string>;
  observations(): readonly AuthObservation[];
}
export interface InstalledApiInput {
  runtimeRoot: string; privateDir: string; tenantId: string; actorId: string;
  databaseUrl: string; auth: InstalledApiIdentity;
  disposableSecretRoot: string;
  ownerEnvironment?: () => NodeJS.ProcessEnv;
}
export async function installedHttpFixture(input: InstalledApiInput) {
  if (!isAbsolute(input.runtimeRoot) || !isAbsolute(input.privateDir)
    || resolve(input.runtimeRoot) === resolve(input.privateDir)) throw Error("ISOLATED_INSTALLED_API_PATHS_REQUIRED");
  const runtime = resolve(input.runtimeRoot), backend = join(runtime, "finnor-os");
  const manifest = JSON.parse(await readFile(join(runtime, "../build-manifest.json"), "utf8"));
  if (manifest.runtime !== runtime || manifest.schema !== "finnor.x2.installed-asset-identity.v1")
    throw Error("COMPLETE_INSTALLED_API_BUILD_REQUIRED");
  const database = new URL(input.databaseUrl);
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !["127.0.0.1", "[::1]"].includes(database.hostname))
    throw Error("DISPOSABLE_LOOPBACK_API_DATABASE_REQUIRED");
  await mkdir(input.privateDir, { mode: 0o700 });
  const port = await new Promise<number>((yes, no) => {
    const server = createServer(); server.once("error", no); server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); no(Error("OWNED_API_PORT_REQUIRED")); return; }
      server.close(() => yes(address.port));
    });
  });
  const origin = "http://127.0.0.1:" + port;
  const observed = {
    get userRequests() { return input.auth.observations().filter(event => event.caller === "BACKEND_SDK" && event.event === "user").length; },
    get signatureRefusals() { return input.auth.observations().filter(event => event.caller === "BACKEND_SDK" && event.reason === "bad_jwt").length; },
    apiRequests: [] as Array<{ operation: string; status: number }>,
  };
  let child: ChildProcess | undefined, ordinal = 0, flush = Promise.resolve();
  let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
  let logFailure: unknown;
  async function start() {
    const launch = ++ordinal, log = join(input.privateDir, `api-${launch}.log`);
    await writeFile(log, "", { mode: 0o600, flag: "wx" });
    const ownerEnvironment = input.ownerEnvironment?.() ?? {};
    if (Object.hasOwn(ownerEnvironment, "AUTH_DEV_BYPASS")) throw Error("INSTALLED_AUTH_BYPASS_MUST_BE_ABSENT");
    let ready: () => void = () => {}, refused: (error: Error) => void = () => {}, output = "";
    const readiness = new Promise<void>((yes, no) => { ready = yes; refused = no; });
    const executable = join(backend, "node_modules/next/dist/bin/next");
    const arguments_ = [executable, "start", "--hostname", "127.0.0.1", "--port", String(port)];
    child = spawn(process.execPath, arguments_, { cwd: join(backend, "apps/api"), stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...ownerEnvironment,
        PATH: process.env.PATH, HOME: input.privateDir, TMPDIR: input.privateDir, LANG: "C", TZ: "UTC",
        NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", FINNOR_ENVIRONMENT: "staging",
        FINNOR_X2_PROFILE: "ordinary_disposable", FINNOR_X2_SOURCE_ROOT: runtime,
        FINNOR_X2_DISPOSABLE_SECRET_ROOT: input.disposableSecretRoot,
        FINNOR_TEST_MANAGED_EXTENSIONS: "omit", DATABASE_URL: input.databaseUrl,
        SECRETS_PROVIDER: "env", ALLOW_PLAINTEXT_ENV_SECRETS: "1",
        SUPABASE_URL: input.auth.origin, SUPABASE_SERVICE_ROLE_KEY: input.auth.serviceRoleKey,
        RATE_LIMIT_PER_MINUTE: "100000", RATE_LIMIT_IP_PER_MINUTE: "100000",
      } });
    child.once("error", refused);
    exit = new Promise(yes => child!.once("close", (code, signal) => {
      refused(Error("INSTALLED_API_EXITED_BEFORE_READINESS")); yes({ code, signal });
    }));
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (bytes: Buffer) => {
      flush = flush.then(() => appendFile(log, bytes)).catch(error => { logFailure ??= error; });
      output = (output + bytes.toString()).slice(-8192);
      if (/Ready in/.test(output)) ready();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([readiness, new Promise<void>((_, no) => {
        timer = setTimeout(() => no(Error("INSTALLED_API_READINESS_DEADLINE")), 30000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
    await writeFile(join(input.privateDir, `api-process-${launch}.json`), JSON.stringify({
      pid: child.pid, executable: process.execPath, argv: arguments_, nodeMode: "production",
      authorityEnvironment: "staging", applicationProfile: "ordinary_disposable", authBypassPresent: false,
      origin, buildId: manifest.buildId, log,
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const owned = child, timer = setTimeout(() => { if (owned.exitCode === null && owned.signalCode === null) owned.kill("SIGKILL"); }, 10000);
      try { owned.kill("SIGTERM"); await exit; } finally { clearTimeout(timer); }
    }
    await flush;
    if (logFailure) throw Error("INSTALLED_API_LOG_CUSTODY_FAILED");
  }
  try { await start(); } catch (error) { await stop(); throw error; }
  const call = async (operation: string, body: unknown, identity: "actor" | "other" | "anonymous" | "invalid" = "actor") => {
    const headers: Record<string, string> = { "content-type": "application/json", "x-tenant-id": input.tenantId,
      "x-user-id": input.actorId, "x-user-role": "owner" };
    if (identity !== "anonymous") {
      let token = await input.auth.token(identity === "other" ? "other" : "actor");
      if (identity === "invalid") {
        const pieces = token.split("."), signature = pieces[2]!;
        token = pieces.slice(0, 2).join(".") + "." + (signature[0] === "A" ? "B" : "A") + signature.slice(1);
      }
      headers.authorization = "Bearer " + token;
    }
    const response = await fetch(origin + "/api/company-brain/" + encodeURIComponent(operation), {
      method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15000),
    });
    observed.apiRequests.push({ operation, status: response.status });
    return { status: response.status, body: await response.json() as any };
  };
  return { origin, observed, call, restart: async () => { await stop(); await start(); }, close: stop };
}
