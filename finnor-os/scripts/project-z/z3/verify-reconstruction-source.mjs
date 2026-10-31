// Bounded source/archive correspondence, not an install or native execution.
// Uses stdlib and an optional explicitly named original repository only.
import { readFileSync, writeFileSync, mkdirSync, lstatSync, readdirSync, statfsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { join, isAbsolute } from "node:path";

const arg = key => process.argv.find(a => a.startsWith(key + "="))?.slice(key.length + 1);
const reconstruction = arg("--reconstruction"), output = arg("--output"), original = arg("--original-repository");
if (![reconstruction, output].every(p => p && isAbsolute(p)) || original && !isAbsolute(original)) {
  throw Error("Absolute reconstruction, fresh output and optional original repository required");
}
mkdirSync(output, { recursive: false, mode: 0o700 });
const started = performance.now(), sha = b => createHash("sha256").update(b).digest("hex");
const blob = b => { const v = Buffer.from(b); return createHash("sha1").update(`blob ${v.length}\0`).update(v).digest("hex"); };
const read = p => readFileSync(p, "utf8"), json = p => JSON.parse(read(p));
const need = (condition, message) => { if (!condition) throw Error(message); };
const checks = [], failures = [];
let manifest, files = 0, archiveFiles = 0, canonicalSources = 0, originalFiles = 0, patches = 0;

function apply(before, patch, reverse = false) {
  const originalLines = before.split("\n"), result = [];
  let cursor = 0, seen = false, oldCount = 0, newCount = 0, oldUsed = 0, newUsed = 0;
  const close = () => need(!seen || oldUsed === oldCount && newUsed === newCount, "PATCH_HUNK_COUNTS_CHANGED");
  for (const line of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      close();
      const start = Math.max(0, Number(h[reverse ? 3 : 1]) - 1);
      need(start >= cursor, "PATCH_HUNK_ORDER_CHANGED");
      result.push(...originalLines.slice(cursor, start)); cursor = start;
      oldCount = Number(h[reverse ? 4 : 2] ?? 1); newCount = Number(h[reverse ? 2 : 4] ?? 1);
      oldUsed = 0; newUsed = 0; seen = true;
    } else if (seen && line.length) {
      let kind = line[0];
      need([" ", "-", "+"].includes(kind), "PATCH_FORMAT_UNSUPPORTED");
      if (reverse && kind !== " ") kind = kind === "-" ? "+" : "-";
      if (kind === " " || kind === "-") {
        need(originalLines[cursor] === line.slice(1), "PATCH_EXACT_CONTEXT_CHANGED");
        cursor++; oldUsed++;
      }
      if (kind === " " || kind === "+") { result.push(line.slice(1)); newUsed++; }
    }
  }
  close(); need(seen, "PATCH_HAS_NO_HUNKS");
  result.push(...originalLines.slice(cursor));
  return result.join("\n");
}

try {
  need(process.version === "v22.23.4", "PINNED_NODE_22_23_4_REQUIRED");
  const manifestBody = read(join(reconstruction, "manifest.json"));
  manifest = JSON.parse(manifestBody);
  need(manifest.schema === "finnor.z3.reconstruction-source.v3", "SOURCE_SCHEMA_CHANGED");
  const inventoryBody = read(join(reconstruction, "source-inventory.json"));
  const modesBody = read(join(reconstruction, "source-modes.json"));
  const inventory = JSON.parse(inventoryBody), modes = JSON.parse(modesBody), source = join(reconstruction, "source");
  const archive = readFileSync(join(reconstruction, "source.tar.gz"));
  need(sha(inventoryBody) === manifest.inventorySha256 && sha(modesBody) === manifest.modeInventorySha256
    && sha(archive) === manifest.archiveSha256, "DISTRIBUTION_IDENTITY_CHANGED");
  const paths = Object.keys(inventory);
  need(JSON.stringify(paths) === JSON.stringify(Object.keys(modes)) && paths.length === manifest.files, "INVENTORY_MEMBERSHIP_CHANGED");
  const bytes = new Map();
  for (const p of paths) {
    need(p && !p.startsWith("/") && !p.split("/").includes(".."), "UNSAFE_SOURCE_PATH");
    const stat = lstatSync(join(source, p)), body = readFileSync(join(source, p));
    need(stat.isFile() && (stat.mode & 0o777) === modes[p] && sha(body) === inventory[p], "SOURCE_OR_MODE_CHANGED:" + p);
    if (p.endsWith(".npmrc")) need(body.toString() === "legacy-peer-deps=false\n", "PRIVATE_NPM_POLICY");
    bytes.set(p, body); files++;
  }
  const walk = prefix => readdirSync(join(source, prefix), { withFileTypes: true }).flatMap(e => {
    const p = prefix ? prefix + "/" + e.name : e.name;
    need(!e.isSymbolicLink(), "SOURCE_SYMLINK:" + p);
    return e.isDirectory() ? walk(p) : [p];
  });
  need(JSON.stringify(walk("").sort()) === JSON.stringify([...paths].sort()), "UNDECLARED_OR_MISSING_SOURCE");
  checks.push("EXACT_REGULAR_SOURCE_MEMBERSHIP_CONTENT_AND_MODES");

  // Inspect the actual GNU tar payload, including long-name records, without
  // extracting another tree or consulting any dependency/Git object.
  const tar = gunzipSync(archive, { maxOutputLength: 512 * 1024 ** 2 }), archived = new Set();
  let longName = null;
  const field = (h, a, n) => h.subarray(a, a + n).toString("utf8").replace(/\0.*$/s, "");
  const octal = (h, a, n) => parseInt(field(h, a, n).trim() || "0", 8);
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(b => b === 0)) break;
    const size = octal(header, 124, 12), type = field(header, 156, 1);
    need(Number.isSafeInteger(size) && size >= 0 && offset + size <= tar.length, "ARCHIVE_SIZE_CHANGED");
    const body = tar.subarray(offset, offset + size); offset += Math.ceil(size / 512) * 512;
    if (type === "L") { longName = body.toString("utf8").replace(/\0.*$/s, ""); continue; }
    const prefix = field(header, 345, 155);
    const name = (longName ?? (prefix ? prefix + "/" : "") + field(header, 0, 100)).replace(/^\.\//, "").replace(/\/$/, "");
    longName = null;
    need(!name.startsWith("/") && !name.split("/").includes(".."), "UNSAFE_ARCHIVE_PATH");
    need(octal(header, 108, 8) === 0 && octal(header, 116, 8) === 0 && octal(header, 136, 12) === 0, "ARCHIVE_NOT_NORMALIZED");
    if (type === "5") { need(octal(header, 100, 8) === 0o755, "ARCHIVE_DIRECTORY_MODE_CHANGED"); continue; }
    need(type === "" || type === "0", "ARCHIVE_NONREGULAR_ENTRY");
    need(!archived.has(name) && inventory[name] === sha(body) && modes[name] === octal(header, 100, 8), "ARCHIVE_SOURCE_MISMATCH:" + name);
    archived.add(name); archiveFiles++;
  }
  need(archived.size === files, "ARCHIVE_MEMBERSHIP_CHANGED");
  checks.push("ACTUAL_ARCHIVE_MEMBERSHIP_CONTENT_AND_MODES");

  const prefix = "scope-z/phase-evidence/z3/", priorPath = prefix + "integration-patches/";
  const prior = json(join(source, priorPath, "manifest.json"));
  const packetFiles = paths.filter(p => p.endsWith("/manifest.json") && p.startsWith(prefix + "integration-corrections/"));
  const packetPath = packetFiles.find(p => inventory[p] === manifest.correctionManifestSha256);
  need(packetPath, "CORRECTION_PACKET_NOT_IN_ARCHIVE");
  const correction = json(join(source, packetPath)), packet = packetPath.slice(0, -"manifest.json".length);
  need(correction.priorNinePatchManifestSha256 === inventory[priorPath + "manifest.json"], "PRIOR_PACKET_CHANGED");
  const priorByPath = new Map(prior.patches.map(p => [p.path, p]));
  const correctionByPath = new Map(correction.requests.map(p => [p.path, p]));
  const tree = new Map();
  if (original) {
    const rows = execFileSync("git", ["-C", original, "ls-tree", "-rz", manifest.sourceHead], { encoding: "utf8", maxBuffer: 8 * 1024 ** 2 });
    for (const row of rows.split("\0").filter(Boolean)) {
      const [metadata, path] = row.split("\t"), [mode, kind, id] = metadata.split(" ");
      need(kind === "blob", "ORIGINAL_SOURCE_NOT_REGULAR:" + path);
      tree.set(path, { mode: parseInt(mode.slice(-3), 8), blob: id });
    }
    const actualTree = execFileSync("git", ["-C", original, "rev-parse", manifest.sourceHead + "^{tree}"], { encoding: "utf8" }).trim();
    need(actualTree === manifest.sourceHeadTree, "ORIGINAL_TREE_CHANGED");
  }
  for (const p of prior.patches) {
    const patchBody = bytes.get(priorPath + p.patch)?.toString();
    need(patchBody && sha(patchBody) === p.sha256, "PRIOR_PATCH_CHANGED:" + p.path);
    const next = correctionByPath.get(p.path);
    const after = next ? bytes.get(packet + next.beforeFile).toString() : bytes.get(p.path).toString();
    need(blob(after) === p.postimageBlob, "PRIOR_POSTIMAGE_CHANGED:" + p.path);
    const before = apply(after, patchBody, true);
    need(p.preimageBlob ? blob(before) === p.preimageBlob : before === "", "PRIOR_REVERSE_CORRESPONDENCE_CHANGED:" + p.path);
    if (original) need(p.preimageBlob ? tree.get(p.path)?.blob === p.preimageBlob : !tree.has(p.path), "ORIGINAL_PRIOR_PREIMAGE_CHANGED:" + p.path);
    patches++;
  }
  for (const p of correction.requests) {
    const before = bytes.get(packet + p.beforeFile)?.toString(), after = bytes.get(packet + p.afterFile)?.toString();
    const patchBody = bytes.get(packet + p.patchFile)?.toString();
    need(before !== undefined && after !== undefined && patchBody, "CORRECTION_BYTES_MISSING");
    need(sha(before) === p.beforeSha256 && blob(before) === p.beforeBlob
      && sha(after) === p.afterSha256 && blob(after) === p.afterBlob && sha(patchBody) === p.patchSha256
      && apply(before, patchBody) === after && inventory[p.path] === p.afterSha256
      && modes[p.path] === p.afterMode, "CORRECTION_CORRESPONDENCE_CHANGED:" + p.path);
    const predecessor = priorByPath.get(p.path);
    if (original) need(predecessor ? predecessor.postimageBlob === p.beforeBlob
      : tree.get(p.path)?.blob === p.beforeBlob && tree.get(p.path)?.mode === p.beforeMode, "ORIGINAL_CORRECTION_PREIMAGE_CHANGED:" + p.path);
    patches++;
  }
  if (original) {
    for (const p of paths) {
      if (priorByPath.has(p) || correctionByPath.has(p)) continue;
      need(tree.get(p)?.blob === blob(bytes.get(p)) && tree.get(p)?.mode === modes[p], "ORIGINAL_UNPATCHED_SOURCE_CHANGED:" + p);
      originalFiles++;
    }
    const canonical = [...tree.keys()].filter(p => /^(?:src\/|apps\/|finnor-os\/(?:packages|apps)\/)/.test(p)
      && /\.(?:[cm]?[jt]sx?|py|sql|json|css|scss|m)$/.test(p)
      && !p.split("/").some(x => x.startsWith(".") || x === "node_modules"));
    for (const p of canonical) need(bytes.has(p), "CANONICAL_PRODUCTION_SOURCE_OMITTED:" + p);
    canonicalSources = canonical.length;
    need(canonicalSources === manifest.canonicalProductionSourceCount, "CANONICAL_SOURCE_DENOMINATOR_CHANGED");
    checks.push("ORIGINAL_COMMIT_TREE_MODES_AND_ALL_CANONICAL_PRODUCTION_SOURCE");
  }
  checks.push("ALL_EXACT_PATCH_FORWARD_AND_REVERSE_CORRESPONDENCE");
  const approved = {
    [prefix + "build/cli.mjs"]: "43a3d180cf01602ccacfc01147d934a5f3a5a437f5767eccb1a1ce933bdaa4d7",
    "finnor-os/packages/epistemic-runtime/src/project-z/z3-viability/checker.py": "b71c0bec3be5eb1e6218e4b04a26bf07918a3f781e5712800a8ff061497e837e",
    [prefix + "frozen-public-cases-v2.json"]: "0f1cc6af5de3a006a8880c7550f65c1c0d56e00fdaf34bf8b388c7cbc1e726c6",
  };
  for (const [p, digest] of Object.entries(approved)) need(inventory[p] === digest && manifest.replayAssets[p] === digest, "APPROVED_REPLAY_ASSET_CHANGED:" + p);
  const reference = json(join(source, prefix, "runs/02-checker-hardening/report.json"));
  need(reference.status === "PASS" && reference.requests === 3892
    && reference.frozenDigest === "75434db94e19e24098d199b8c9eb0e7ec5ea102792ad2845f401ad07229a122b", "PUBLIC_REFERENCE_CHANGED");
  need(!manifest.sourceIncludesUncommittedCorrectionBytes, "UNCOMMITTED_SOURCE_NOT_FINAL");
  checks.push("APPROVED_REPLAY_ASSETS_AND_RETAINED_FINITE_REFERENCE_NOT_RERUN");
} catch (error) { failures.push(error.message); }
const disk = statfsSync(reconstruction);
const report = { schema: "finnor.z3.source-reconstruction-check.v1", status: failures.length ? "FAIL" : "PASS",
  sourceManifestSha256: sha(readFileSync(join(reconstruction, "manifest.json"))),
  sourceHead: manifest?.sourceHead, sourceHeadTree: manifest?.sourceHeadTree, files, archiveFiles,
  patches, originalFiles, canonicalSources, originalRepositoryUsedOnlyForCorrespondence: original ?? null,
  checks, failures, node: process.version, wallMs: Math.round(performance.now() - started),
  freeBytes: disk.bavail * disk.bsize, installRequiredFreeBytes: 4 * 1024 ** 3,
  dependenciesInstalled: false, dependenciesBorrowed: false, applicationBuildExecuted: false,
  publicReplayRerun: false, databaseActions: 0, nativeOwner: "NOT_RUN", installedNative: "NOT_RUN",
  protectedAdmission: "NOT_RUN", financialQualification: "NOT_RUN", money: null,
  meterGaps: ["isolated child CPU/RSS not measured", "USD unknown", "no native budgets or S6 observations obtained"] };
writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(report));
process.exitCode = failures.length ? 1 : 0;
