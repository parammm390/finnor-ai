/** Guarded finite source replay. No server, DB, Auth, grants or effects. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const target = resolve(root, "scope-z/phase-evidence/z3/implementation-20261026-17/run-affected.py");
const child = spawnSync("/usr/bin/flock", ["-w", "300",
  "/home/factory-user/repos/finnor-z-shared-heavy.lock", "/usr/bin/python3", target, ...process.argv.slice(2)], {
  cwd: root, env: { PATH: "/home/factory-user/repos/finnor-z-toolchains/node22/node_modules/.bin:/usr/bin:/bin",
    LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" }, stdio: "inherit", timeout: 600_000,
});
if (child.error) console.error(child.error.message);
process.exitCode = child.status ?? 1;
