/** Local source packet only. No publication, history rewrite or authority grant. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, join, isAbsolute } from "node:path";

const backend = resolve(import.meta.dirname, "../../.."), root = dirname(backend);
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--output" && isAbsolute(args[1]), "W3_NEW_ABSOLUTE_PACKET_OUTPUT_REQUIRED");
const output = resolve(args[1]);
assert(!existsSync(output), "W3_PACKET_MUST_BE_NEW");
const git = (...args) => execFileSync("git", ["-C", root, ...args], { maxBuffer: 16777216, timeout: 30000 });
assert.equal(git("status", "--porcelain=v1", "-uall").toString().trim(), "", "W3_PACKET_REQUIRES_COMMITTED_CLEAN_SOURCE");
const commit = git("rev-parse", "HEAD").toString().trim(), tree = git("rev-parse", "HEAD^{tree}").toString().trim();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
await mkdir(output, { mode: 0o700 });
const archivePath = join(output, "source.tar.gz");
git("archive", "--format=tar.gz", "--output", archivePath, commit);
const archive = await readFile(archivePath), object = git("cat-file", "commit", commit);
await writeFile(join(output, "commit.object"), object, { flag: "wx", mode: 0o600 });
// The reused builder checks retained migration bytes against an older tree.
// Carry its exact finite object closure, not a donor repository or ancestry.
const builderPath = "finnor-os/scripts/frontier5/x1/build-development.mjs";
const builder = await readFile(join(root, builderPath));
const references = [...builder.toString().matchAll(/^const base = '([a-f0-9]{40})';$/gm)];
assert.equal(references.length, 1, "W3_EXACT_REUSED_BUILDER_REFERENCE_REQUIRED");
const historicalCommit = references[0][1], historicalTree = git("rev-parse", historicalCommit + "^{tree}").toString().trim();
function treeObjects(revision) {
  const objects = new Set([revision, git("rev-parse", revision + "^{tree}").toString().trim()]);
  for (const entry of git("ls-tree", "-r", "-t", "-z", revision).toString().split("\0")) {
    if (!entry) continue;
    const [, type, id] = entry.slice(0, entry.indexOf("\t")).split(" ");
    assert(["blob", "tree"].includes(type) && /^[a-f0-9]{40}$/.test(id), "W3_FINITE_REGULAR_BUILD_PREIMAGES_REQUIRED");
    objects.add(id);
  }
  return objects;
}
const sourceObjects = treeObjects(commit);
const additionalIds = [...treeObjects(historicalCommit)].filter(id => !sourceObjects.has(id)).sort();
assert(additionalIds.length > 0 && additionalIds.length <= 16384, "W3_BUILD_PREIMAGE_OBJECT_BOUND");
const ids = Buffer.from(additionalIds.join("\n") + "\n");
const descriptions = execFileSync("git", ["-C", root, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
  { input: ids, maxBuffer: 16777216, timeout: 30000 }).toString().trim().split("\n").map(line => {
    const [id, type, bytes] = line.split(" ");
    assert(/^[a-f0-9]{40}$/.test(id) && ["blob", "tree", "commit"].includes(type)
      && /^(0|[1-9][0-9]*)$/.test(bytes) && (type !== "commit" || id === historicalCommit));
    return { id, type, bytes: Number(bytes) };
  });
assert.deepEqual(descriptions.map(object => object.id), additionalIds);
assert(descriptions.reduce((sum, object) => sum + object.bytes, 0) <= 64 * 1024 * 1024, "W3_BUILD_PREIMAGE_BYTE_BOUND");
const pack = execFileSync("git", ["-C", root, "pack-objects", "--stdout", "--window=0", "--no-reuse-delta", "--no-reuse-object"],
  { input: ids, maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
await writeFile(join(output, "build-preimages.pack"), pack, { flag: "wx", mode: 0o600 });
const buildPrerequisites = {
  schema: "finnor.w3.build-preimages.v1",
  builder: { path: builderPath, sha256: hash(builder) },
  historical: { commit: historicalCommit, tree: historicalTree },
  pack: { path: "build-preimages.pack", bytes: pack.length, sha256: hash(pack) },
  objects: descriptions, deduplicatedAgainstSourceTree: true, parentHistoryIncluded: false,
};
const locks = await Promise.all(["package-lock.json", "finnor-os/package-lock.json"].map(async path =>
  ({ path, sha256: hash(await readFile(join(root, path))) })));
const body = {
  schema: "finnor.w3.source-preimage.v1", commit, tree,
  archive: { path: "source.tar.gz", bytes: archive.length, sha256: hash(archive) },
  commitObject: { path: "commit.object", bytes: object.length, sha256: hash(object) }, locks, buildPrerequisites,
  node: { version: process.version, binarySha256: hash(await readFile(process.execPath)), platform: process.platform, arch: process.arch },
  sourceOnly: true, installedVerification: false, protectedQualification: false, productionActive: false,
};
assert.equal(git("rev-parse", "HEAD").toString().trim(), commit);
assert.equal(git("status", "--porcelain=v1", "-uall").toString().trim(), "", "W3_PACKET_SOURCE_CHANGED");
await writeFile(join(output, "source.json"), JSON.stringify(body, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ schema: body.schema, commit, tree, output, sourceOnly: true }));
