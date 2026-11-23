/** Actual Next standalone file custody. Sealing starts no server or Auth/DB.
 * Public/static assets come only from the same freshly built source target. */
import { createHash } from "node:crypto";
import { cp, readFile, writeFile, readdir, lstat, realpath, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, relative, sep } from "node:path";

const ensure = (condition, code) => { if (!condition) throw Error(code); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const distDir = ".next-x1-install", standalone = distDir + "/standalone";
export const mountedBuildContract = Object.freeze({
  schema: "finnor.project-z.z0.mounted-build-custody.v1",
  build: "ACTUAL_NEXT_STANDALONE_WITH_SAME_TARGET_PUBLIC_AND_STATIC_ASSETS",
  identity: "SOURCE_SNAPSHOT_POPULATION_BUILD_ID_PUBLIC_AUTH_RECEIPT_AND_COMPLETE_STANDALONE_BYTES",
  borrowedDependencies: false, serverStarted: false, authenticationExecuted: false,
});
async function readInputs(root) {
  ensure(root.startsWith("/") && await realpath(root) === root, "Z0_REAL_MOUNTED_BUILD_ROOT_REQUIRED");
  const snapshotBytes = await readFile(resolve(dirname(root), "source-snapshot.json"));
  const source = JSON.parse(snapshotBytes), publicBytes = await readFile(resolve(dirname(root), "frontend-public-auth-build.json"));
  const publicAuth = JSON.parse(publicBytes);
  ensure(source.runtime === root && /^[a-f0-9]{64}$/.test(source.sourcePopulationSha256 ?? "")
    && sha(JSON.stringify(source.files)) === source.sourcePopulationSha256
    && publicAuth.sourcePopulationSha256 === source.sourcePopulationSha256
    && publicAuth.authenticationExecuted === false
    && ["NOT_DELIVERED", "EXPLICIT_PUBLIC_BUILD_INPUT"].includes(publicAuth.state),
  "Z0_SOURCE_BOUND_MOUNTED_BUILD_INPUTS_REQUIRED");
  const buildId = (await readFile(resolve(root, distDir, "BUILD_ID"), "utf8")).trim();
  const required = JSON.parse(await readFile(resolve(root, distDir, "required-server-files.json")));
  const server = await readFile(resolve(root, standalone, "server.js"), "utf8");
  const serialized = server.match(/^const nextConfig = (.+)$/m);
  ensure(serialized && JSON.stringify({ ...JSON.parse(serialized[1]), distDir }) === JSON.stringify(required.config),
    "Z0_ACTUAL_STANDALONE_ENTRY_CONFIGURATION_MISMATCH");
  ensure(buildId === "z0-" + source.sourcePopulationSha256.slice(0, 16)
    && (await readFile(resolve(root, standalone, distDir, "BUILD_ID"), "utf8")).trim() === buildId
    && required.appDir === root && required.config.distDir === distDir && required.config.output === "standalone"
    && required.config.env?._sentryRelease === "z0-" + source.sourcePopulationSha256,
  "Z0_ACTUAL_MOUNTED_BUILD_SOURCE_IDENTITY_MISMATCH");
  const routeBytes = await readFile(resolve(root, distDir, "routes-manifest.json"));
  ensure(sha(routeBytes) === sha(await readFile(resolve(root, standalone, distDir, "routes-manifest.json"))),
    "Z0_STANDALONE_ROUTES_NOT_FROM_SAME_MOUNTED_BUILD");
  const routes = JSON.parse(routeBytes);
  const rules = routes.headers.filter(rule => rule.source === "/centropy/:path*");
  const policies = rules.flatMap(rule => rule.headers.filter(header => header.key.toLowerCase() === "content-security-policy"));
  ensure(rules.length === 1 && policies.length === 1, "Z0_ACTUAL_MOUNTED_WORK_CSP_REQUIRED");
  const connect = policies[0].value.split(";").map(value => value.trim().split(/\s+/))
    .filter(values => values[0] === "connect-src");
  ensure(connect.length === 1 && (publicAuth.state !== "EXPLICIT_PUBLIC_BUILD_INPUT"
    || connect[0].includes(publicAuth.authOrigin)), "Z0_COMPILED_MOUNTED_CSP_BLOCKS_EXPLICIT_DISPOSABLE_AUTH");
  return { source, publicAuth, sourceSnapshotSha256: sha(snapshotBytes),
    publicAuthBuildReceiptSha256: sha(publicBytes), buildId,
    compiledCspSha256: sha(policies[0].value) };
}
async function population(root) {
  const files = [], links = [], base = resolve(root, standalone);
  let totalBytes = 0;
  ensure(await realpath(base) === base, "Z0_REAL_STANDALONE_BUILD_REQUIRED");
  async function visit(directory) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, item.name), observed = await lstat(path), key = relative(root, path);
      if (observed.isDirectory()) await visit(path);
      else if (observed.isSymbolicLink()) {
        ensure((await realpath(path)).startsWith(base + sep), "Z0_BORROWED_STANDALONE_LINK_REFUSED");
        links.push({ path: key, target: await readlink(path) });
      } else {
        ensure(observed.isFile(), "Z0_STANDALONE_SPECIAL_FILE_REFUSED");
        const bytes = await readFile(path); totalBytes += bytes.length;
        files.push({ path: key, sha256: sha(bytes), bytes: bytes.length });
      }
      ensure(files.length + links.length <= 65536 && totalBytes <= 2 * 1024 ** 3,
        "Z0_STANDALONE_CUSTODY_FINITE_BOUND");
    }
  }
  await visit(base);
  for (const path of [distDir + "/BUILD_ID", distDir + "/required-server-files.json", distDir + "/routes-manifest.json"]) {
    ensure(await realpath(resolve(root, path)) === resolve(root, path), "Z0_MOUNTED_BUILD_METADATA_LINK_REFUSED");
    const bytes = await readFile(resolve(root, path)); totalBytes += bytes.length;
    files.push({ path, sha256: sha(bytes), bytes: bytes.length });
  }
  files.sort((a, b) => a.path.localeCompare(b.path)); links.sort((a, b) => a.path.localeCompare(b.path));
  return { files, links, totalBytes };
}
export async function sealMountedBuild(root) {
  const path = resolve(dirname(root), "mounted-frontend-build-custody.json");
  ensure(!existsSync(path), "Z0_NEW_MOUNTED_BUILD_SEAL_REQUIRED");
  const inputs = await readInputs(root);
  for (const [source, destination] of [[distDir + "/static", standalone + "/" + distDir + "/static"],
    ["public", standalone + "/public"]]) {
    if (source === "public" && !existsSync(resolve(root, source))) continue;
    ensure(!existsSync(resolve(root, destination)), "Z0_NEW_STANDALONE_ASSET_DESTINATION_REQUIRED");
    await cp(resolve(root, source), resolve(root, destination), { recursive: true, force: false, errorOnExist: true });
  }
  const actual = await population(root);
  const staticFile = actual.files.find(file => file.path.startsWith(standalone + "/" + distDir + "/static/chunks/")
    && file.path.endsWith(".js"));
  ensure(staticFile && actual.files.some(file => file.path === standalone + "/server.js"),
    "Z0_COMPLETE_STANDALONE_SERVER_AND_STATIC_ASSETS_REQUIRED");
  const receipt = { ...mountedBuildContract, sourcePopulationSha256: inputs.source.sourcePopulationSha256,
    sourceSnapshotSha256: inputs.sourceSnapshotSha256, publicAuthBuildReceiptSha256: inputs.publicAuthBuildReceiptSha256,
    compiledCspSha256: inputs.compiledCspSha256,
    buildId: inputs.buildId, distDir, standaloneRoot: standalone, entry: standalone + "/server.js",
    staticProbe: { path: "/_next/" + staticFile.path.slice((standalone + "/" + distDir + "/").length),
      sha256: staticFile.sha256, bytes: staticFile.bytes },
    filesPopulationSha256: sha(JSON.stringify(actual.files)), ...actual };
  await writeFile(path, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o444 });
  return validateMountedBuild(root);
}
export async function validateMountedBuild(root, manifest = null) {
  const bytes = await readFile(resolve(dirname(root), "mounted-frontend-build-custody.json"));
  const receipt = JSON.parse(bytes), inputs = await readInputs(root);
  ensure(receipt.schema === mountedBuildContract.schema
    && receipt.sourcePopulationSha256 === inputs.source.sourcePopulationSha256
    && receipt.sourceSnapshotSha256 === inputs.sourceSnapshotSha256
    && receipt.publicAuthBuildReceiptSha256 === inputs.publicAuthBuildReceiptSha256
    && receipt.compiledCspSha256 === inputs.compiledCspSha256
    && receipt.buildId === inputs.buildId && receipt.distDir === distDir
    && receipt.entry === standalone + "/server.js" && receipt.standaloneRoot === standalone
    && receipt.serverStarted === false && receipt.authenticationExecuted === false,
  "Z0_ACTUAL_MOUNTED_BUILD_SEAL_MISMATCH");
  const actual = await population(root);
  ensure(sha(JSON.stringify(actual.files)) === receipt.filesPopulationSha256
    && JSON.stringify(actual.files) === JSON.stringify(receipt.files)
    && JSON.stringify(actual.links) === JSON.stringify(receipt.links) && actual.totalBytes === receipt.totalBytes,
  "Z0_MOUNTED_STANDALONE_CLOSURE_CHANGED");
  const probe = actual.files.find(file => "/_next/" + file.path.slice((standalone + "/" + distDir + "/").length)
    === receipt.staticProbe?.path && file.path.startsWith(standalone + "/" + distDir + "/static/"));
  ensure(probe && probe.sha256 === receipt.staticProbe.sha256 && probe.bytes === receipt.staticProbe.bytes,
    "Z0_SEALED_MOUNTED_STATIC_PROBE_MISMATCH");
  if (manifest) ensure(manifest.frontend.mountedBuildCustody?.sha256 === sha(bytes)
    && manifest.frontend.buildId === receipt.buildId
    && manifest.source.snapshotPopulationSha256 === receipt.sourcePopulationSha256,
  "Z0_INSTALLED_MOUNTED_BUILD_SEAL_NOT_BOUND_TO_MANIFEST");
  return { sha256: sha(bytes), buildId: receipt.buildId, sourcePopulationSha256: receipt.sourcePopulationSha256,
    entry: receipt.entry, standaloneRoot: receipt.standaloneRoot, files: actual.files.length, links: actual.links.length,
    totalBytes: actual.totalBytes, staticProbe: receipt.staticProbe, compiledCspSha256: inputs.compiledCspSha256,
    publicAuthBuild: inputs.publicAuth };
}
