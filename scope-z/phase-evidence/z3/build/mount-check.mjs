// Post-apply mounted-Work frontend typecheck in a scratch mirror tree.
// The supervisor's postapply harness typechecked the patched backend and worker
// entry (exit 0) but its frontend leg failed on an unrelated pre-existing CSS
// module import because its staged program did not include next-env.d.ts (which
// carries Next's `declare module '*.module.css'`). This runner reproduces the
// fully patched frontend in /tmp with the same include surface as the root
// tsconfig and typechecks it with the repo's own tsc.
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/factory-user/repos/finnor-z3";
const PATCHDIR = join(REPO, "scope-z/phase-evidence/z3/integration-patches");
const LOG = join(REPO, "scope-z/phase-evidence/z3/build/mount-check.log");
const dir = mkdtempSync(join(tmpdir(), "z3-mount-check-"));
const lines = [];
const say = (s) => { lines.push(s); console.log(s); };
try {
  cpSync(join(REPO, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO, "next-env.d.ts"), join(dir, "next-env.d.ts"));
  // Type and package resolution must see the repo's installed tree, and the
  // frontend sources reach finnor-os packages via RELATIVE paths like
  // ../../../../finnor-os/packages/shared-types/src/... — so the mirror needs
  // the same sibling layout.
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"), "dir");
  symlinkSync(join(REPO, "finnor-os"), join(dir, "finnor-os"), "dir");
  for (const p of ["0005-mounted-work-panel.patch", "0005b-viability-panel-file.patch"]) {
    execFileSync("patch", ["-s", "-p1", "-d", dir, "-i", join(PATCHDIR, p)]);
  }
  say("patches 0005+0005b applied to scratch mirror");
  // Mirrors the root tsconfig compilerOptions (see /home/factory-user/repos/finnor-z3/tsconfig.json)
  // with include widened to the scratch mirror's next-env.d.ts.
  const tsconfig = {
    compilerOptions: {
      target: "ES2017", lib: ["dom", "dom.iterable", "esnext"], allowJs: true,
      skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true,
      module: "esnext", moduleResolution: "bundler", resolveJsonModule: true,
      isolatedModules: true, jsx: "react-jsx",
      types: ["node", "react", "react-dom", "playwright", "vitest/globals"],
      incremental: false,
      baseUrl: ".", paths: { "@/*": ["./src/*"] },
    },
    include: ["next-env.d.ts", "src/**/*.ts", "src/**/*.tsx"],
    exclude: ["node_modules"],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 1));
  const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" };
  const r = execFileSync(join(REPO, "node_modules/.bin/tsc"), ["-p", join(dir, "tsconfig.json")],
    { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  say("tsc exit=0");
  say(String(r).slice(0, 2000));
  writeFileSync(LOG, lines.join("\n") + "\n");
  console.log("MOUNT-CHECK PASS");
} catch (e) {
  say("tsc exit=" + (e.status ?? "?"));
  say(String(e.stdout ?? "") + String(e.stderr ?? ""));
  writeFileSync(LOG, lines.join("\n") + "\n");
  console.log("MOUNT-CHECK FAIL (see " + LOG + ")");
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
