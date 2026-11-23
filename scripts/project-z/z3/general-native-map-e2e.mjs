/** Guarded finite source replay. No server, DB, Auth, grants or effects. */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, dirname, isAbsolute } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const backend = resolve(root, "finnor-os");
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const inputs = option("inputs"), output = option("output");
if (!inputs || !output || !isAbsolute(inputs) || !isAbsolute(output)) throw Error("ABSOLUTE_INPUTS_AND_OUTPUT_REQUIRED");
// Run in place: owned modules read sibling source relative to their own URL,
// so a relocated bundle does not replay this tree.
const loader = createRequire(resolve(backend, "package.json")).resolve("tsx");
const child = spawnSync("/usr/bin/flock", ["-w", "300", "/home/factory-user/repos/finnor-z-shared-heavy.lock",
  "/usr/bin/taskset", "-c", "0,1", process.execPath, `--import=${loader}`,
  resolve(backend, "scripts/project-z/z3/general-native-e2e.mts"), `--inputs=${inputs}`, `--output=${output}`], {
  cwd: backend, env: { PATH: dirname(process.execPath) + ":/usr/bin:/bin", LANG: "C.UTF-8",
    NODE_OPTIONS: "--max-old-space-size=4096", TSX_DISABLE_CACHE: "1" }, stdio: "inherit", timeout: 600_000,
});
if (child.error) console.error(child.error.message);
process.exitCode = child.status ?? 1;
