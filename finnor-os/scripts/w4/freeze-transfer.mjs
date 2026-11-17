/** Immutable local source handoff. Never stages, commits, pushes or installs. */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile, mkdir, copyFile, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
const backend = resolve(import.meta.dirname, "../.."), repo = dirname(backend), base = "cecec15d64fe8f8fb63a5a29b98979f978ba6138";
const output = process.argv[2], verification = process.argv[3], uiVerification = process.argv[4];
assert(output && isAbsolute(output) && verification && isAbsolute(verification)
  && uiVerification && isAbsolute(uiVerification), "W4_FROZEN_NEW_OUTPUT_AND_BOTH_VERIFICATIONS_REQUIRED");
await mkdir(output, { mode: 0o700 });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const git = args => {
  const p = spawnSync("git", ["-C", repo, ...args], { maxBuffer: 32 * 1024 * 1024 });
  assert.equal(p.status, 0, p.stderr.toString()); return p.stdout;
};
assert.equal(git(["rev-parse", "HEAD"]).toString().trim(), base, "W4_APPROVED_BASE_REQUIRED");
const walk = async directory => {
  const files = [];
  for (const d of await readdir(directory, { withFileTypes: true })) {
    const p = join(directory, d.name);
    if (d.isDirectory()) files.push(...await walk(p));
    else { assert(d.isFile(), "W4_SOURCE_HANDOFF_REFUSES_SYMLINK:" + p); files.push(relative(repo, p)) }
  }
  return files;
};
const shared = ["finnor-os/packages/private-equity/src/allocation-store.ts",
  "finnor-os/packages/governed-execution/src/dispatch-broker.ts",
  "finnor-os/scripts/bundle-migrations.ts", "finnor-os/packages/db/migrations-bundle.ts",
  "finnor-os/packages/db/migration-head.ts",
  "finnor-os/packages/private-equity/src/enterprise-obligations.ts", "finnor-os/packages/private-equity/src/index.ts",
  "finnor-os/packages/db/compute-contract.ts", "finnor-os/apps/worker/src/index.ts", "finnor-os/scripts/s5/owner-fixture.mts",
  "finnor-os/scripts/generate-openapi.ts", "finnor-os/openapi.json",
  "scripts/centropy/generate-capability-manifest.mjs", "scripts/centropy/generate-human-forms.mjs",
  "src/lib/centropy/capability-manifest.generated.json", "src/lib/centropy/human-forms.generated.json",
  "src/components/centropy/world/WorldWorkRecord.tsx", "src/components/centropy/world/WorldExplorer.tsx",
  "src/components/centropy/canvas/WorkforceParticipantWorkspace.tsx"];
const frontend = ["GrowthOperatingProgramPanel.tsx", "GrowthOwnerControls.tsx", "GrowthParticipantControls.tsx",
  "growth-program-contracts.ts"].map(name => "src/components/centropy/world/" + name);
const paths = [...new Set([
  ...await walk(join(backend, "packages/private-equity/src/demand-to-business")),
  ...await walk(join(backend, "apps/api/app/api/demand-to-business")),
  ...await walk(import.meta.dirname), "finnor-os/packages/db/migrations/0200_postz_w4_demand_to_business.sql",
  "finnor-os/packages/db/migrations/postz_w2_zz_participant_legacy_authority.sql", ...shared, ...frontend,
])].sort();
const report = JSON.parse(await readFile(join(verification, "report.json"), "utf8"));
assert.equal(report.status, "PASS_SCOPED_SEMANTIC_FULL_CONTEXT");
const uiReport = JSON.parse(await readFile(join(uiVerification, "report.json"), "utf8"));
assert.equal(uiReport.status, "PASS_SCOPED_SEMANTIC_FULL_CONTEXT");
const checkerSha256 = sha(await readFile(join(repo, "finnor-os/scripts/w4/typecheck.mjs")));
assert.equal(report.checkerSha256, checkerSha256);
assert.equal(uiReport.checkerSha256, checkerSha256);
const dirty = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]).toString()
  .split("\0").filter(Boolean).map(line => line.slice(3)).sort();
assert.deepEqual(dirty, paths, "W4_FREEZE_MUST_COVER_EVERY_MODIFIED_OR_UNTRACKED_SOURCE_FILE");
const rows = [];
for (const path of paths) {
  const bytes = await readFile(join(repo, path)), postimageSha256 = sha(bytes);
  const semantic = path.startsWith("finnor-os/") ? report.semanticTargets.find(t => "finnor-os/" + t.path === path)
    : uiReport.semanticTargets.find(t => t.path === path);
  if (/\.(?:ts|tsx|mts)$/.test(path)) assert.equal(semantic?.sha256, postimageSha256, "W4_CURRENT_SEMANTIC_SOURCE_CUT_REQUIRED:" + path);
  const present = git(["ls-tree", base, "--", path]).byteLength > 0;
  const baseBytes = present ? git(["cat-file", "blob", base + ":" + path]) : null;
  assert(shared.includes(path) === (baseBytes !== null), "W4_EXPECTED_NEW_OR_SHARED_FILE:" + path);
  const target = join(output, "overlay", path); await mkdir(dirname(target), { recursive: true });
  await copyFile(join(repo, path), target, constants.COPYFILE_EXCL);
  assert.equal(sha(await readFile(target)), postimageSha256, "W4_FROZEN_COPY_BYTE_MISMATCH");
  await chmod(target, 0o444);
  rows.push({ path, kind: baseBytes ? "SHARED_EXACT_HUNK" : "OWNED_NEW",
    baseSha256: baseBytes ? sha(baseBytes) : null, postimageSha256, bytes: bytes.length });
}
const patch = git(["diff", "--binary", base, "--", ...shared]);
await writeFile(join(output, "shared-files.patch"), patch, { flag: "wx", mode: 0o444 });
await copyFile(join(verification, "report.json"), join(output, "full-context-typecheck.json"), constants.COPYFILE_EXCL);
await chmod(join(output, "full-context-typecheck.json"), 0o444);
await copyFile(join(uiVerification, "report.json"), join(output, "frontend-full-context-typecheck.json"), constants.COPYFILE_EXCL);
await chmod(join(output, "frontend-full-context-typecheck.json"), 0o444);
const manifest = { schema: "finnor.w4.frozen-owner-transfer.v1", frozenAt: new Date().toISOString(), baseCommit: base,
  baseTree: git(["rev-parse", base + "^{tree}"]).toString().trim(), files: rows,
  sharedPatch: { path: "shared-files.patch", sha256: sha(patch) },
  verification: { path: "full-context-typecheck.json", sha256: sha(await readFile(join(verification, "report.json"))),
    status: report.status, sourceFilesLoaded: report.sourceFilesLoaded, targets: report.semanticTargets.length },
  frontendVerification: { path: "frontend-full-context-typecheck.json",
    sha256: sha(await readFile(join(uiVerification, "report.json"))), status: uiReport.status,
    sourceFilesLoaded: uiReport.sourceFilesLoaded, targets: uiReport.semanticTargets.length },
  claims: { nativePassed: false, mountedPassed: false, reconstructionPassed: false, fieldValidated: false,
    matrix16x8Passed: false, admissionGranted: false, productionActive: false },
  policy: "APPLY_NEW_FILES_AND_REVIEW_ISOLATED_SHARED_HUNKS_WITH_BASE_OR_ALREADY_APPLIED_POSTIMAGE_CHECKS_NEVER_COPY_A_CHANGING_TREE" };
const encoded = JSON.stringify(manifest, null, 2) + "\n";
await writeFile(join(output, "manifest.json"), encoded, { flag: "wx", mode: 0o444 });
await writeFile(join(output, "README.md"), [
  "# W4 frozen owner integration cut", "",
  "This is an incomplete engineering checkpoint, not W4 completion or native validation.",
  "The source overlay, per-file preimages/postimages and shared patch are frozen. Do not copy the mutable worktree.",
  "Apply new paths only when absent. For shared paths, compare the base SHA-256 or recognize the identical postimage, then review each isolated hunk.",
  "The optional metricKeyPrefix fixture change is the canonical integration-owned patch, not a second variant.",
  "The participant legacy-authority migration is the exact reviewed W2 prerequisite, not W4 authority expansion.",
  "Regenerate migrations-bundle.ts and migration-head.ts from the final union of SQL sources; do not overwrite peer additions with this local generated population.",
  "Regenerate OpenAPI, capability and human-form metadata from the final union of registered source operations; do not drop peer routes with a copied generated file.",
  "Use growthRecipient from the start of a combined W3/W4 chain. Keep one protected S6 ledger and the same issuer keys across hard restarts.",
  "Its default bind preserves genuine W3 .15/service_transition; W4 supplies explicit field/value/unit as the fourth argument.",
  "createNativeGrowthJourney(context).run() preserves context.work and context.companyId but creates an independent W4 grant.",
  "The context exposes genuine authenticated HTTP, actual upstream fixture support, actual production queue pump, the same recipient, admin fixture setup, and artifact writer.",
  "Generated S3 data, declared S4/S5 payoffs, synthetic customers and controlled accounting are never genuine market, causal or profit evidence.",
  "Both original backend and frontend project contexts passed complete scoped semantics for every owned/shared TypeScript target. See both unfiltered reports.",
  "Remaining gates: actual native smoke and physical recovery, named W033-W040, 16 structural families x 8 fresh cases, mounted privacy/currentness, separate reconstruction, external W039 field evidence.",
  "No commit, GitHub write, deployment, live migration, real buyer contact or production financial action is part of this cut.", "",
].join("\n"), { flag: "wx", mode: 0o444 });
for (const row of rows) assert.equal(sha(await readFile(join(repo, row.path))), row.postimageSha256, "W4_SOURCE_CHANGED_DURING_FREEZE:" + row.path);
console.log(JSON.stringify({ status: "FROZEN_INCOMPLETE_OWNER_CUT", output, manifestSha256: sha(encoded),
  files: rows.length, shared: shared.length, sourceBytes: rows.reduce((n, r) => n + r.bytes, 0), nativePassed: false }));
