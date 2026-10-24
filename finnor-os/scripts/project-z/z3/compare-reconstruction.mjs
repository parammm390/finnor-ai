// Compares finite PUBLIC records semantically, not meter floats or verdict
// strings alone. It cannot promote source replay to native/protected evidence.
import { readFile, mkdir, writeFile, realpath, lstat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
const arg = key => process.argv.find(a => a.startsWith(key + "="))?.slice(key.length + 1);
const sourceRun = arg("--source-run"), installedRun = arg("--installed-run"), reconstruction = arg("--reconstruction"),
  installation = arg("--installation"), output = arg("--output");
if (![sourceRun, installedRun, reconstruction, installation, output].every(p => p && isAbsolute(p))) throw Error("Absolute source/installed/reconstruction/installation/output required");
await mkdir(output, { recursive: false });
const sha = b => createHash("sha256").update(b).digest("hex");
const canonical = v => v === null || typeof v !== "object" ? JSON.stringify(v)
  : Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]"
    : "{" + Object.keys(v).filter(k => k !== "metrics").sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
const readJson = async p => JSON.parse(await readFile(p, "utf8"));
const manifest = await readJson(join(reconstruction, "manifest.json"));
const before = await readJson(join(sourceRun, "report.json")), after = await readJson(join(installedRun, "report.json"));
const failures = [];
const installationReport = await readJson(join(installation, "report.json"));
if (installationReport.schema !== "finnor.z3.lock-installed-engineering.v2"
  || installationReport.sourceManifestSha256 !== sha(await readFile(join(reconstruction, "manifest.json")))
  || installationReport.lockfiles.root !== manifest.lockfiles.root
  || installationReport.lockfiles.backend !== manifest.lockfiles.backend
  || (await realpath(installedRun)) !== (await realpath(join(installation, "public")))) failures.push("OWN_INSTALL_SOURCE_OR_LOCK_RECEIPT_CHANGED");
for (const name of ["root-ci", "backend-ci", "native-load", "cli-build", "public-run", "boundary-run"]) {
  const step = installationReport.steps.find(s => s.name === name);
  if (!step || step.exitCode !== 0 || step.spawnError
    || sha(await readFile(join(installation, name + ".log"))) !== step.logSha256) failures.push("REAL_OWN_INSTALL_OR_REPLAY_NOT_OBSERVED:" + name);
}
if (installationReport.modules.some(m => !m.local)) failures.push("BORROWED_OR_MISSING_INSTALLED_MODULE");
const approved = { producer: "43a3d180cf01602ccacfc01147d934a5f3a5a437f5767eccb1a1ce933bdaa4d7",
  checker: "b71c0bec3be5eb1e6218e4b04a26bf07918a3f781e5712800a8ff061497e837e",
  node: "94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90",
  python: "e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f" };
for (const [name, expected] of Object.entries(approved)) {
  const asset = installationReport.assets[name];
  if (!asset || asset.sha256 !== expected || sha(await readFile(asset.path)) !== expected) failures.push("INSTALLED_APPROVED_ASSET_CHANGED:" + name);
}
const inventoryBody = await readFile(join(installation, "postbuild-source-inventory.json"));
if (sha(inventoryBody) !== installationReport.postbuildSourceInventorySha256) failures.push("POSTBUILD_INVENTORY_CHANGED");
const postbuild = JSON.parse(inventoryBody), originalInventory = await readJson(join(reconstruction, "source-inventory.json"));
const generated = new Set(["next-env.d.ts", "tsconfig.json", "finnor-os/apps/api/next-env.d.ts",
  "finnor-os/apps/api/tsconfig.json",
  "finnor-os/packages/private-equity/src/enterprise-applications/source-manifest.generated.ts",
  "finnor-os/packages/private-equity/src/policy-learning/source-manifest.generated.ts",
  "finnor-os/packages/private-equity/src/system-identification/source-manifest.generated.ts",
  "finnor-os/packages/private-equity/src/system-identification/core-child.generated.mjs",
  "finnor-os/packages/epistemic-runtime/src/strategic-response/source-manifest.generated.ts"]);
for (const [p, expected] of Object.entries(originalInventory)) {
  const actual = await readFile(join(reconstruction, "source", p));
  if (sha(actual) !== postbuild[p] || (await lstat(join(reconstruction, "source", p))).isSymbolicLink()
    || expected !== postbuild[p] && !generated.has(p)) failures.push("INSTALLED_SOURCE_CHANGED:" + p);
}
if (before.status !== "PASS" || after.status !== "PASS" || before.requests !== 3892 || after.requests !== 3892
  || before.frozenDigest !== after.frozenDigest || before.frozenDigest !== "75434db94e19e24098d199b8c9eb0e7ec5ea102792ad2845f401ad07229a122b") failures.push("FINITE_POPULATION_OR_REPORT_CHANGED");
if (sha(await readFile(join(reconstruction, "source-inventory.json"))) !== manifest.inventorySha256
  || sha(await readFile(join(reconstruction, "source.tar.gz"))) !== manifest.archiveSha256) failures.push("RECONSTRUCTION_ARCHIVE_CHANGED");
for (const p of ["node_modules", "finnor-os/node_modules"]) {
  const path = join(reconstruction, "source", p);
  if ((await lstat(path)).isSymbolicLink() || !(await realpath(path)).startsWith(await realpath(join(reconstruction, "source")) + "/")) failures.push("BORROWED_DEPENDENCIES");
}
const a = (await readFile(join(sourceRun, "records.ndjson"), "utf8")).trimEnd().split("\n");
const b = (await readFile(join(installedRun, "records.ndjson"), "utf8")).trimEnd().split("\n");
if (a.length !== 3892 || b.length !== a.length) failures.push("ORIGINAL_RECORD_DENOMINATOR_CHANGED");
const chain = createHash("sha256");
for (let i = 0; i < Math.min(a.length, b.length); i++) {
  const left = canonical(JSON.parse(a[i])), right = canonical(JSON.parse(b[i]));
  if (left !== right) failures.push("ORIGINAL_SEMANTIC_RECORD_CHANGED:" + i);
  chain.update(left + "\n");
}
const report = { schema: "finnor.z3.installed-public-comparison.v2", status: failures.length ? "FAIL" : "PASS",
  records: a.length, originalSemanticDigest: chain.digest("hex"), failures,
  sourceReportSha256: sha(await readFile(join(sourceRun, "report.json"))),
  installedReportSha256: sha(await readFile(join(installedRun, "report.json"))),
  reconstructionManifestSha256: sha(await readFile(join(reconstruction, "manifest.json"))),
  installationReportSha256: sha(await readFile(join(installation, "report.json"))),
  graphBuildStates: installationReport.steps.filter(s => /typecheck|build$|lint/.test(s.name))
    .map(s => ({ name: s.name, exitCode: s.exitCode, signal: s.signal })),
  generatedSourceDeltas: installationReport.generatedSourceDeltas,
  qualification: "SEPARATELY_LOCK_INSTALLED_PUBLIC_ENGINEERING_REPLAY_NOT_NATIVE_OWNER_RECONSTRUCTION",
  sourceNative: "NOT_RUN", installedNative: "NOT_RUN", protectedAdmission: "NOT_RUN",
  equippedIncrement: "NOT_RUN", financialQualification: "NOT_RUN", money: null };
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(report));
process.exitCode = failures.length ? 1 : 0;
