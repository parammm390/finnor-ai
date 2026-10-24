// A real self-contained source distribution, not a symlinked worktree. Installs
// are separate explicit commands, never an implicit DB/Auth/app launcher.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const arg = key => process.argv.find(a => a.startsWith(key + "="))?.slice(key.length + 1);
const output = arg("--output"), packet = arg("--packet");
if (!output || !packet || ![output, packet].every(isAbsolute)) throw Error("Fresh absolute --output and --packet required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const source = join(output, "source"); mkdirSync(source);
const sha = b => createHash("sha256").update(b).digest("hex");
const blob = b => { const v = Buffer.from(b); return createHash("sha1").update(`blob ${v.length}\0`).update(v).digest("hex"); };
const git = args => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const requiredEvidence = "scope-z/phase-evidence/z3/";
const names = [...new Set([...git(["ls-files", "-z"]).split("\0"),
  ...git(["ls-files", "--others", "--exclude-standard", "-z", "--",
    "finnor-os/scripts/project-z/z3", "finnor-os/packages/private-equity/src/project-z/z3-viability",
    "finnor-os/packages/orchestration/src/project-z/z3-viability", "scripts/project-z/z3",
    "scope-z/phase-evidence/z3/integration-corrections"]).split("\0")])].sort();
const included = names.filter(p => p && !p.split("/").some(x => x.startsWith(".") && x !== ".eslintrc.cjs"
  || ["node_modules", "test-results", "playwright-report", "coverage", "storage", "logs", "__pycache__"].includes(x))
  && !/(?:\.env|\.pem$|\.key$|(?:^|\/)credentials\.(?:json|ya?ml|ini|txt|md)$|credential-ledger)/i.test(p)
  && (p.startsWith("src/") || p.startsWith("public/") || p.startsWith("vendor/") || p.startsWith("e2e/")
    || p.startsWith("scripts/") || p.startsWith("finnor-os/") || p.startsWith("infra/")
    || ["AGENTS.md", "THIRD_PARTY_NOTICES.md", "package.json", "package-lock.json", "next-env.d.ts",
      "next.config.mjs", "tsconfig.json", "eslint.config.mjs", "playwright.config.ts", "vitest.config.ts",
      "postcss.config.mjs", "tailwind.config.ts", "components.json", "instrumentation.ts", "instrumentation-client.ts", ".eslintrc.cjs"].includes(p)
    || p === requiredEvidence + "frozen-public-cases-v2.json" || p.startsWith(requiredEvidence + "integration-patches/")
    || [requiredEvidence + "runs/02-checker-hardening/report.json",
      requiredEvidence + "runs/02-checker-hardening/records.ndjson"].includes(p)
    || p.startsWith(requiredEvidence + "integration-corrections/")));
const selected = new Set(included);
for (const p of names.filter(p => p.startsWith("finnor-os/packages/")
  && (/\.(?:ts|mts|m|sql)$/.test(p) || p.endsWith("/package.json"))
  && !p.split("/").some(x => x.startsWith(".") || x === "node_modules"))) {
  if (!selected.has(p)) throw Error("CANONICAL_PRODUCTION_SOURCE_OMITTED:" + p);
}
for (const p of included) {
  const stat = lstatSync(join(repo, p));
  if (!stat.isFile() || stat.size > 256 * 1024 * 1024) throw Error("NONREGULAR_OR_OVERSIZE_SOURCE:" + p);
  mkdirSync(dirname(join(source, p)), { recursive: true });
  copyFileSync(join(repo, p), join(source, p));
}
const applications = [];
const priorDir = join(repo, requiredEvidence, "integration-patches");
const prior = JSON.parse(readFileSync(join(priorDir, "manifest.json"), "utf8"));
for (const p of prior.patches) {
  const path = join(source, p.path);
  const before = p.preimageBlob ? readFileSync(path) : Buffer.alloc(0);
  if (p.preimageBlob && blob(before) !== p.preimageBlob) throw Error("PRIOR_SOURCE_PREIMAGE_CHANGED:" + p.path);
  const patchPath = join(priorDir, p.patch), patch = readFileSync(patchPath);
  if (sha(patch) !== p.sha256) throw Error("PRIOR_PATCH_IDENTITY_CHANGED");
  const log = execFileSync("patch", ["--batch", "--forward", "--fuzz=0", "-p1", "--directory", source, "--input", patchPath], { encoding: "utf8" });
  if (blob(readFileSync(path)) !== p.postimageBlob) throw Error("PRIOR_SOURCE_POSTIMAGE_CHANGED:" + p.path);
  applications.push({ path: p.path, patchSha256: sha(patch), exitCode: 0, log });
}
const correctionBody = readFileSync(join(packet, "manifest.json")), correction = JSON.parse(correctionBody);
for (const p of correction.requests) {
  const path = join(source, p.path), patchPath = join(packet, p.patchFile);
  if (sha(readFileSync(path)) !== p.beforeSha256 || sha(readFileSync(patchPath)) !== p.patchSha256) throw Error("CORRECTION_PREIMAGE_CHANGED:" + p.path);
  const log = execFileSync("patch", ["--batch", "--forward", "--fuzz=0", "-p1", "--directory", source, "--input", patchPath], { encoding: "utf8" });
  if (sha(readFileSync(path)) !== p.afterSha256) throw Error("CORRECTION_POSTIMAGE_CHANGED:" + p.path);
  applications.push({ path: p.path, patchSha256: p.patchSha256, exitCode: 0, log });
}
const paths = [...new Set([...included, ...prior.patches.map(p => p.path), ...correction.requests.map(p => p.path)])].sort();
const inventory = Object.fromEntries(paths.map(p => [p, sha(readFileSync(join(source, p)))]));
const inventoryBody = JSON.stringify(inventory, null, 2) + "\n";
writeFileSync(join(output, "source-inventory.json"), inventoryBody, { flag: "wx" });
execFileSync("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-czf",
  join(output, "source.tar.gz"), "-C", source, "."], { stdio: "pipe", maxBuffer: 1048576 });
const manifest = { schema: "finnor.z3.reconstruction-source.v2", sourceHead: git(["rev-parse", "HEAD"]).trim(),
  sourceHeadTree: git(["rev-parse", "HEAD^{tree}"]).trim(), branch: git(["branch", "--show-current"]).trim(),
  sourceIncludesUncommittedCorrectionBytes: git(["status", "--porcelain", "--untracked-files=all", "--",
    "finnor-os/packages/private-equity/src/project-z/z3-viability",
    "finnor-os/packages/orchestration/src/project-z/z3-viability", "finnor-os/scripts/project-z/z3",
    "scripts/project-z/z3", "scope-z/phase-evidence/z3/integration-corrections"]).trim().length > 0,
  authoritativeIdentity: "SOURCE_INVENTORY_AND_ARCHIVE_NOT_HEAD_ALONE",
  inventorySha256: sha(inventoryBody), archiveSha256: sha(readFileSync(join(output, "source.tar.gz"))),
  correctionManifestSha256: sha(correctionBody), files: paths.length, applications,
  lockfiles: { root: inventory["package-lock.json"], backend: inventory["finnor-os/package-lock.json"] },
  publicSourceReference: { path: requiredEvidence + "runs/02-checker-hardening",
    reportSha256: inventory[requiredEvidence + "runs/02-checker-hardening/report.json"],
    recordsSha256: inventory[requiredEvidence + "runs/02-checker-hardening/records.ndjson"],
    meaning: "RETAINED_PUBLIC_MATHEMATICAL_REFERENCE_NOT_NATIVE_SOURCE_PROOF" },
  excluded: ["Git objects", "node_modules", "dotenv files", "credentials/keys", "runtime user data", "historical bulky evidence"],
  dependenciesBorrowed: false, applicationOrDatabaseExecuted: false,
  nativeSource: "NOT_RUN", installedNative: "NOT_RUN", protectedAdmission: "NOT_RUN", financialQualification: "NOT_RUN" };
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ files: paths.length, inventorySha256: manifest.inventorySha256,
  archiveSha256: manifest.archiveSha256, appliedPatches: applications.length }));
