import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const KERNEL = path.join(ROOT, "finnor-os/packages/epistemic-runtime/src/project-z/z5-institution-linker/kernel.ts");
export const CHECKER = path.join(path.dirname(KERNEL), "checker.py");
export const hash = value => createHash("sha256").update(value).digest("hex");
export const load = async file => JSON.parse(await readFile(file, "utf8"));
export async function evidenceDirectory(directory) {
  if (!directory || !path.isAbsolute(directory) || path.resolve(directory) !== directory)
    throw Error("EXPLICIT_FRESH_OWNED_EVIDENCE_DIRECTORY_REQUIRED");
  const base = await realpath(path.join(ROOT, "scope-z/phase-evidence/z5"));
  const parent = await realpath(path.dirname(directory)), relative = path.relative(base, path.join(parent, path.basename(directory)));
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw Error("EXPLICIT_FRESH_OWNED_EVIDENCE_DIRECTORY_REQUIRED");
  await mkdir(directory, { recursive: false, mode: 0o700 });
  return directory;
}
export const save = (file, body) => writeFile(file, JSON.stringify(body, null, 2) + "\n", { flag: "wx", mode: 0o600 });
export function run(executable, args, input, timeoutMs = 40000) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd: ROOT,
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    const started = performance.now();
    let stdout = "", stderr = "", bounded = false;
    const timer = setTimeout(() => { bounded = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", b => { stdout += b; if (Buffer.byteLength(stdout) > 32 * 1024 * 1024) { bounded = true; child.kill("SIGKILL"); } });
    child.stderr.on("data", b => { stderr += b; if (Buffer.byteLength(stderr) > 65536) { bounded = true; child.kill("SIGKILL"); } });
    child.on("error", e => { stderr += e.code ?? e.name; });
    child.on("close", (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, stdout, stderr,
      bounded, wallMs: performance.now() - started }); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}
export const producer = input => run(process.execPath, ["--experimental-strip-types", "--max-old-space-size=384", KERNEL], input);
export const checker = (input, certificate) => run("/usr/bin/python3", ["-I", "-B", CHECKER], { input, certificate });
export async function fixture(id) {
  const dir = path.join(ROOT, "scope-z/phase-evidence/z5/frozen"), registration = await load(path.join(dir, "registration.json"));
  const entry = registration.entries.find(e => e.id === id);
  if (!entry) throw Error("UNREGISTERED_ORIGINAL_CASE");
  const bytes = await readFile(path.join(dir, entry.path));
  if (hash(bytes) !== entry.sha256) throw Error("FROZEN_CASE_CHANGED");
  return JSON.parse(bytes);
}
