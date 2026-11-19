/** Actual supported-CLI nonce binding plus independently pinned native OS facts. */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants, lstatSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

export const provenanceSchema = "finnor.w2.assigned-browser-provenance.v2";
export const provenanceSource = "ACTUAL_SUPPORTED_ASSIGNED_TARGET_NATIVE_OS_NONCE_BRIDGE_V1";
const hex = /^[a-f0-9]{64}$/, revision = /^[a-f0-9]{40}$/;
const sha = value => createHash("sha256").update(value).digest("hex");
const root = fileURLToPath(new URL("../../", import.meta.url));
const sourceNames = [
  "scripts/postz-w2/agent-browser-client.mjs",
  "scripts/postz-w2/browser-provenance-observer.mjs",
  "scripts/postz-w2/browser-owner-observer.m",
  "scripts/postz-w2/browser-campaign-coordinator.mjs",
  "scripts/postz-w2/cdp-browser.mjs",
  "scripts/postz-w2/run-cdp-native.mjs",
];
const processKeys = ["pid", "ppid", "uid", "pgid", "startSec", "startUsec", "executablePathSha256"];
const imageKeys = ["device", "inode", "bytes", "mode", "uid", "mtimeSec", "mtimeNsec", "ctimeSec", "ctimeNsec"];
const listenerKeys = ["pid", "fd", "portSha256", "addressClass", "state", "generation"];
const pinKeys = ["path", "sha256", "bytes", "mode"];
const toolNames = ["node", "agentBrowser", "browserObserver", "browserExecutable"];
const sameFields = (a, b, keys) => a && b && keys.every(key => a[key] === b[key]);
const sameLineage = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((row, i) => sameFields(row, b[i], processKeys));
const need = (value, code) => {
  if (value) return;
  const error = new Error("BROWSER_OBSERVER_REFUSED");
  error.observerCode = code;
  throw error;
};
const unknown = (env, binary) => ({
  schema: provenanceSchema, source: provenanceSource, status: "UNKNOWN",
  observedAt: new Date().toISOString(), binary,
  assignedEndpointSha256: sha(env.AGENT_BROWSER_CDP ?? ""),
  assignedSessionSha256: sha(env.AGENT_BROWSER_SESSION ?? ""),
  browser: { headed: "UNKNOWN", separatelyLaunched: "UNKNOWN" },
  predicates: {
    VISIBLE_EXTERNAL: { status: "UNKNOWN" },
    SESSION_TARGET_BOUND: { status: "UNKNOWN" },
    SEPARATE_LAUNCH_PROVEN: { status: "UNKNOWN" },
  },
  secretsOrRawEndpointRecorded: false, browserCommandIssued: false,
  navigationCommandIssued: false, browserLifecycleCommandIssued: false,
  qualificationScope: "BROWSER_PROVENANCE_ONLY",
  genuineHumanQualified: false, protectedQualification: false,
  nonlaunchingCommandGuaranteed: false, nativeObservationIssued: false,
  metadataObserved: false, nonceTitleWriteAttempted: false,
  cleanup: { status: "NOT_NEEDED" }, steps: [],
});

export function passiveAssignedBrowserProvenance({ env, binary }) {
  return { ...unknown(env, binary), source: "PASSIVE_NO_BROWSER_OR_NATIVE_QUERY",
    reason: "EXPLICIT_ACTIVE_OWNED_TARGET_AND_NATIVE_OBSERVATION_REQUIRED",
    childrenAttempted: { supportedCli: 0, native: 0 } };
}

async function noAliases(path) {
  need(typeof path === "string" && path.startsWith("/") && path.length <= 4096
    && !path.includes("\0") && resolve(path) === path, "CANONICAL_ABSOLUTE_PIN_PATH_REQUIRED");
  for (let component = path;; component = dirname(component)) {
    need(!(await lstat(component)).isSymbolicLink(), "PIN_SYMLINK_ANCESTRY_REFUSED");
    if (component === "/") break;
  }
}

export const requireCanonicalObserverPath = noAliases;

function allowedLocation(value) {
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1"
      && Number(url.port) >= 1024 && Number(url.port) <= 65535
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function directAssignedPort(value) {
  need(typeof value === "string", "DIRECT_LOCAL_ASSIGNED_ENDPOINT_REQUIRED");
  const match = /^(?:([1-9][0-9]{3,4})|http:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})\/?)$/.exec(value);
  const port = match ? Number(match[1] ?? match[2]) : 0;
  need(port >= 1024 && port <= 65535, "DIRECT_LOCAL_ASSIGNED_ENDPOINT_REQUIRED");
  return port;
}

export function requireCurrentPriorProof(prior) {
  need(prior?.schema === provenanceSchema && prior.source === provenanceSource
    && prior.status === "PASS", "ACTUAL_PREDECLARED_BROWSER_PROVENANCE_REQUIRED");
  const age = Date.now() - Date.parse(prior.observedAt);
  need(Number.isFinite(age) && age >= 0 && age <= 300000, "STALE_BROWSER_PROVENANCE_REFUSED");
  for (const name of ["VISIBLE_EXTERNAL", "SESSION_TARGET_BOUND", "SEPARATE_LAUNCH_PROVEN"])
    need(prior.predicates?.[name]?.status === "PASS", "COMPLETE_PRIOR_BROWSER_PREDICATES_REQUIRED");
  need(prior.browser?.headed === true && prior.browser.separatelyLaunched === true
    && prior.cleanup?.status === "PASS", "COMPLETE_PRIOR_BROWSER_CLEANUP_REQUIRED");
  need(prior.observerHost?.platform === "darwin" && prior.observerHost.topology === observerTopology
    && hex.test(prior.observerHost.bootSha256 ?? "")
    && prior.scope?.campaignPlatform === "darwin"
    && ["inputsSha256", "campaignOwnerSha256", "campaignNonceSha256", "jobOwnerSha256",
      "jobNonceSha256", "templateSha256", "executionGrantSha256", "harnessManifestSha256",
      "targetIdSha256", "locationSha256"].every(key => hex.test(prior.scope[key] ?? ""))
    && revision.test(prior.scope.sourceCommit ?? "") && revision.test(prior.scope.sourceTree ?? "")
    && exactKeys(prior.tools, toolNames) && toolNames.every(name => hex.test(prior.tools[name] ?? ""))
    && exactKeys(prior.sources, sourceNames) && sourceNames.every(name => hex.test(prior.sources[name] ?? ""))
    && prior.observerHost.campaignOwnerProcess && prior.observerHost.mountedJobOwnerProcess,
  "COMPLETE_CURRENT_CAMPAIGN_BROWSER_PROOF_REQUIRED");
}

export async function readPinnedPrivateObserverJson(file, expected, maximum = 1048576) {
  let handle;
  try {
    need(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 1048576,
      "FINITE_PRIVATE_OBSERVER_RECORD_BOUND_REQUIRED");
    need(hex.test(expected ?? ""), "EXACT_BROWSER_PROVENANCE_PIN_REQUIRED");
    await noAliases(file);
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true }), limit = maximum;
    need(before.isFile() && before.uid === BigInt(process.getuid())
      && Number(before.mode & 0o7777n) === 0o600 && before.size > 0n && before.size <= BigInt(limit),
    "PRIVATE_BOUNDED_REGULAR_BROWSER_PROOF_REQUIRED");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    for (;;) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      length += result.bytesRead;
      need(length <= limit, "BROWSER_PROOF_READ_BOUND");
      if (!result.bytesRead) break;
    }
    await noAliases(file);
    const after = await handle.stat({ bigint: true }), current = await lstat(file, { bigint: true });
    const keys = ["dev", "ino", "size", "mode", "uid", "mtimeNs", "ctimeNs"];
    need(keys.every(key => before[key] === after[key] && before[key] === current[key])
      && BigInt(length) === before.size && sha(bytes.subarray(0, length)) === expected,
    "EXACT_BROWSER_PROOF_BYTES_OR_IDENTITY_CHANGED");
    return { value: JSON.parse(bytes.subarray(0, length).toString("utf8")),
      pin: { path: file, sha256: expected, bytes: length, mode: 0o600 },
      identity: keys.map(key => String(before[key])).join(":") };
  } catch (error) {
    need(false, error.observerCode ?? "BROWSER_PROOF_READ_REFUSED");
  } finally { if (handle) await handle.close(); }
}

export async function readPinnedBrowserProof(file, expected) {
  return (await readPinnedPrivateObserverJson(file, expected)).value;
}

export function validateObservedBrowserProof(prior, current) {
  requireCurrentPriorProof(prior);
  if (current.status !== "PASS") return current;
  for (const key of ["schema", "source", "assignedEndpointSha256", "assignedSessionSha256"])
    need(prior[key] === current[key], "ASSIGNED_BROWSER_IDENTITY_CHANGED");
  need(sameFields(prior.binary, current.binary, ["path", "sha256"]), "SUPPORTED_BROWSER_BINARY_CHANGED");
  need(sameFields(prior.observerHost, current.observerHost, ["platform", "topology", "bootSha256"])
    && sameFields(prior.observerHost?.campaignOwnerProcess,
      current.observerHost?.campaignOwnerProcess, processKeys)
    && sameFields(prior.observerHost?.mountedJobOwnerProcess,
      current.observerHost?.mountedJobOwnerProcess, processKeys),
  "ACTUAL_OBSERVER_HOST_OR_CAMPAIGN_OWNER_BIRTH_CHANGED");
  for (const key of ["inputsSha256", "campaignOwnerSha256", "campaignNonceSha256",
    "jobOwnerSha256", "jobNonceSha256", "templateSha256", "executionGrantSha256",
    "campaignPlatform", "campaignOutputDevice", "campaignOutputInode", "jobOutputDevice", "jobOutputInode",
    "harnessManifestSha256", "sourceCommit", "sourceTree", "targetIdSha256", "locationSha256"])
    need(prior.scope?.[key] === current.scope?.[key], "BROWSER_CAMPAIGN_SOURCE_OR_TARGET_CHANGED");
  for (const [name, hash] of Object.entries(current.tools))
    need(prior.tools?.[name] === hash, "BROWSER_TOOL_POPULATION_CHANGED");
  for (const [name, hash] of Object.entries(current.sources))
    need(prior.sources?.[name] === hash, "BROWSER_SOURCE_POPULATION_CHANGED");
  const a = prior.observation, b = current.observation;
  need(a?.bootSha256 === b?.bootSha256 && a?.window?.id === b?.window?.id
    && sameFields(a?.process, b?.process, [...processKeys, "bundleIdentifier",
      "executableSha256", "appLaunchUnixMs"])
    && sameFields(a?.process?.mappedExecutable, b?.process?.mappedExecutable, imageKeys)
    && sameFields(a?.process?.endpointListener, b?.process?.endpointListener, listenerKeys)
    && sameLineage(a?.process?.lineage, b?.process?.lineage),
  "ACTUAL_BROWSER_PROCESS_BIRTH_WINDOW_OR_LAUNCH_CHANGED");
  return current;
}

export const observerTopology = "DARWIN_SAME_HOST_CAMPAIGN_AND_OBSERVER_V1";
export const observerCampaignReferences = Object.freeze({
  owner: Object.freeze(["FINNOR_W2_CAMPAIGN_OWNER", "FINNOR_W2_CAMPAIGN_OWNER_SHA256"]),
  jobOwner: Object.freeze(["FINNOR_W2_JOB_OWNER", "FINNOR_W2_JOB_OWNER_SHA256"]),
  harnessManifest: Object.freeze(["FINNOR_W2_HARNESS_MANIFEST", "FINNOR_W2_HARNESS_MANIFEST_SHA256"]),
  template: Object.freeze(["FINNOR_W2_BROWSER_OBSERVER_TEMPLATE", "FINNOR_W2_BROWSER_OBSERVER_TEMPLATE_SHA256"]),
  executionGrant: Object.freeze(["FINNOR_W2_BROWSER_OBSERVER_GRANT", "FINNOR_W2_BROWSER_OBSERVER_GRANT_SHA256"]),
});
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
const referenceNames = Object.keys(observerCampaignReferences);
const assignmentKeys = ["endpointSha256", "sessionSha256", "targetIdSha256", "locationSha256"];
const explicitEffects = ["NATIVE_READ_ONLY", "SUPPORTED_ASSIGNED_TARGET_METADATA",
  "OWNED_TWO_NONCE_TITLE_AND_RESTORE"];
const pinOnly = (row, path = row?.path) => ({
  path, sha256: row?.sha256, bytes: row?.bytes, mode: row?.mode,
});

export function prepareCampaignObserverInputs({ env, pins, records, remainingMs }) {
  need(process.platform === "darwin" && Number.isFinite(remainingMs)
    && remainingMs > 0 && remainingMs <= 120000, "CURRENT_DARWIN_CAMPAIGN_BUDGET_REQUIRED");
  for (const name of referenceNames) {
    const [fileKey, hashKey] = observerCampaignReferences[name], pin = pins?.[name];
    need(pin && pin.path === env[fileKey] && pin.sha256 === env[hashKey]
      && hex.test(pin.sha256) && Number.isSafeInteger(pin.bytes) && pin.bytes > 0
      && pin.bytes <= (["owner", "jobOwner"].includes(name) ? 4096 : 1048576)
      && pin.mode === 0o600, "INDEPENDENT_CURRENT_CAMPAIGN_REFERENCE_REQUIRED");
  }
  const { owner, jobOwner, harnessManifest: harness, template, executionGrant: grant } = records;
  const now = Date.now();
  need(exactKeys(owner, ["schema", "pid", "nonce", "output", "device", "inode",
    "platform", "uid", "createdAtUnixMs"])
    && owner.schema === "finnor.w2.campaign-output-owner.v2"
    && owner.platform === process.platform && owner.uid === process.getuid()
    && Number.isSafeInteger(owner.createdAtUnixMs) && owner.createdAtUnixMs > 0
    && now >= owner.createdAtUnixMs && now - owner.createdAtUnixMs <= 28800000,
  "ACTUAL_CURRENT_CAMPAIGN_PLATFORM_AND_CLAIM_REQUIRED");
  need(exactKeys(jobOwner, ["schema", "pid", "nonce", "output", "device", "inode"])
    && jobOwner.schema === "finnor.w2.job-output-owner.v1",
  "ACTUAL_CURRENT_MOUNTED_JOB_CLAIM_REQUIRED");
  for (const [claim, pin, basename] of [
    [owner, pins.owner, ".campaign-owner.json"], [jobOwner, pins.jobOwner, ".job-owner.json"],
  ]) need(hex.test(claim.nonce ?? "") && Number.isSafeInteger(claim.pid) && claim.pid > 1
    && claim.pid !== process.pid && Number.isSafeInteger(claim.device) && claim.device >= 0
    && Number.isSafeInteger(claim.inode) && claim.inode > 0
    && claim.output === dirname(pin.path) && pin.path === join(claim.output, basename),
  "ACTUAL_CANONICAL_CAMPAIGN_AND_JOB_CUSTODY_REQUIRED");
  need(owner.pid !== jobOwner.pid && jobOwner.output.startsWith(owner.output + "/"),
    "MOUNTED_JOB_MUST_BELONG_TO_THIS_CAMPAIGN");
  need(harness.schema === "finnor.w2.prelaunch-harness-freeze.v1"
    && revision.test(harness.source?.commit ?? "") && revision.test(harness.source?.tree ?? "")
    && Object.keys(harness.sources ?? {}).length === 41,
  "COMPLETE_CURRENT_CAMPAIGN_HARNESS_REQUIRED");
  need(exactKeys(template, ["schema", "topology", "browser", "assignment", "harnessManifestSha256"])
    && template.schema === "finnor.w2.browser-observer-template.v1"
    && template.topology === observerTopology && exactKeys(template.browser, ["bundleIdentifier"])
    && ["com.google.Chrome", "org.chromium.Chromium"].includes(template.browser.bundleIdentifier)
    && exactKeys(template.assignment, assignmentKeys)
    && assignmentKeys.every(key => hex.test(template.assignment[key] ?? ""))
    && template.harnessManifestSha256 === pins.harnessManifest.sha256,
  "EXACT_NON_PROOF_ASSIGNMENT_TEMPLATE_REQUIRED");
  need(env.AGENT_BROWSER_PIN_TAB === "1" && Boolean(env.FACTORY_DESKTOP_CDP_PORT)
    && typeof env.AGENT_BROWSER_CDP === "string" && typeof env.AGENT_BROWSER_SESSION === "string"
    && env.AGENT_BROWSER_SESSION.length > 0
    && template.assignment.endpointSha256 === sha(env.AGENT_BROWSER_CDP)
    && template.assignment.sessionSha256 === sha(env.AGENT_BROWSER_SESSION),
  "UNCHANGED_EXPLICIT_ASSIGNED_BROWSER_SCOPE_REQUIRED");
  directAssignedPort(env.AGENT_BROWSER_CDP);
  const issued = Date.parse(grant?.issuedAt), expires = Date.parse(grant?.expiresAt);
  need(exactKeys(grant, ["schema", "purpose", "topology", "campaignOutputSha256",
    "templateSha256", "harnessManifestSha256", "issuedAt", "expiresAt", "effects", "limits"])
    && grant.schema === "finnor.w2.browser-observer-execution-grant.v1"
    && grant.purpose === "EXPLICIT_BOUNDED_MOUNTED_OBSERVATION"
    && grant.topology === observerTopology && grant.campaignOutputSha256 === sha(owner.output)
    && grant.templateSha256 === pins.template.sha256
    && grant.harnessManifestSha256 === pins.harnessManifest.sha256
    && typeof grant.issuedAt === "string" && typeof grant.expiresAt === "string"
    && Number.isFinite(issued) && Number.isFinite(expires) && issued <= now
    && expires > issued && expires - issued <= 28800000
    && expires - now >= remainingMs + 1000
    && Array.isArray(grant.effects) && grant.effects.length === explicitEffects.length
    && [...grant.effects].sort().join("\n") === [...explicitEffects].sort().join("\n")
    && exactKeys(grant.limits, ["totalMs", "cleanupReserveMs", "nativeChildren", "supportedCliChildren"])
    && grant.limits.totalMs === 120000 && grant.limits.cleanupReserveMs === 15000
    && grant.limits.nativeChildren === 3 && grant.limits.supportedCliChildren === 10,
  "EXPLICIT_SCOPED_UNEXPIRED_BROWSER_EFFECT_GRANT_REQUIRED");
  const sources = {}, tools = {};
  for (const name of sourceNames) {
    const row = harness.sources[name];
    need(row && hex.test(row.sha256 ?? "") && Number.isSafeInteger(row.bytes)
      && row.bytes > 0 && row.bytes <= 1048576 && Number.isInteger(row.mode)
      && row.mode >= 0 && row.mode <= 0o777 && !(row.mode & 0o022),
    "EXACT_CURRENT_OBSERVER_SOURCE_FREEZE_REQUIRED");
    sources[name] = pinOnly(row, join(root, name));
  }
  for (const name of toolNames) {
    const row = harness.tools?.[name];
    need(row && typeof row.path === "string" && row.path.startsWith("/")
      && hex.test(row.sha256 ?? "") && Number.isSafeInteger(row.bytes)
      && row.bytes > 0 && row.bytes <= 536870912 && Number.isInteger(row.mode)
      && row.mode >= 0 && row.mode <= 0o777 && !(row.mode & 0o022) && Boolean(row.mode & 0o111),
    "EXACT_CURRENT_OBSERVER_TOOL_FREEZE_REQUIRED");
    tools[name] = pinOnly(row);
  }
  return {
    schema: "finnor.w2.browser-observer-inputs.v2",
    browser: { bundleIdentifier: template.browser.bundleIdentifier },
    assignment: Object.fromEntries(assignmentKeys.map(key => [key, template.assignment[key]])),
    campaign: {
      ...Object.fromEntries(referenceNames.map(name => [name, pinOnly(pins[name])])),
      binding: { platform: owner.platform, uid: owner.uid, creatorPid: owner.pid,
        createdAtUnixMs: owner.createdAtUnixMs, nonceSha256: sha(owner.nonce),
        outputDevice: owner.device, outputInode: owner.inode,
        jobCreatorPid: jobOwner.pid, jobNonceSha256: sha(jobOwner.nonce),
        jobOutputDevice: jobOwner.device, jobOutputInode: jobOwner.inode },
    },
    tools, sources,
  };
}

export async function observeAssignedBrowser({ env, binary, run, dom, inputReference, clock }) {
  const report = unknown(env, binary), started = clock?.started ?? performance.now(),
    wallStart = clock?.wallStart ?? Date.now();
  const identities = new Map();
  let cliChildren = 0, nativeChildren = 0, inputs, inputsPin, harness, owner, jobOwner, executionGrant, assignedPort;
  let original, marker, previousToken, mutationAttempted = false, observations, failure;
  const remaining = (cleanup = false) => {
    const left = 120000 - (performance.now() - started) - (cleanup ? 0 : 15000);
    need(left >= 1, "OBSERVER_TOTAL_DEADLINE");
    return Math.floor(left);
  };
  const stableClock = () => need(Math.abs(Date.now() - wallStart
    - (performance.now() - started)) <= 1000, "OBSERVER_WALL_CLOCK_CHANGED");
  const identity = info => [info.dev, info.ino, info.size, info.mode, info.uid,
    info.mtimeNs, info.ctimeNs].map(String).join(":");

  const readPin = async (pin, maximum, collect = false, cleanup = false, privateFile = false) => {
    remaining(cleanup);
    need(pin && hex.test(pin.sha256) && Number.isSafeInteger(pin.bytes)
      && pin.bytes > 0 && pin.bytes <= maximum && Number.isInteger(pin.mode)
      && pin.mode >= 0 && pin.mode <= 0o777 && !(pin.mode & 0o022),
    "COMPLETE_BOUNDED_FILE_PIN_REQUIRED");
    await noAliases(pin.path);
    const handle = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat({ bigint: true });
      need(before.isFile() && before.size === BigInt(pin.bytes)
        && Number(before.mode & 0o7777n) === pin.mode
        && (before.uid === 0n || before.uid === BigInt(process.getuid()))
        && (!privateFile || before.uid === BigInt(process.getuid()) && pin.mode === 0o600),
      "EXACT_REGULAR_FILE_METADATA_REQUIRED");
      const frozen = identities.get(pin.path);
      need(!frozen || frozen === identity(before), "OBSERVED_PIN_FILE_IDENTITY_CHANGED");
      const hash = createHash("sha256"), buffer = Buffer.alloc(262144), chunks = [];
      let count = 0;
      for (;;) {
        remaining(cleanup);
        const result = await handle.read(buffer, 0, buffer.length, count);
        if (!result.bytesRead) break;
        count += result.bytesRead;
        need(count <= pin.bytes, "PIN_FILE_GREW_DURING_READ");
        hash.update(buffer.subarray(0, result.bytesRead));
        if (collect) chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
      }
      await noAliases(pin.path);
      const after = await handle.stat({ bigint: true }), current = await lstat(pin.path, { bigint: true });
      need(count === pin.bytes && hash.digest("hex") === pin.sha256
        && identity(before) === identity(after) && identity(before) === identity(current),
      "EXACT_FILE_BYTES_OR_IDENTITY_CHANGED");
      identities.set(pin.path, identity(before));
      return collect ? Buffer.concat(chunks).toString("utf8") : undefined;
    } finally { await handle.close(); }
  };
  const readJson = async (pin, maximum, cleanup = false) =>
    JSON.parse(await readPin(pin, maximum, true, cleanup, true));

  const verifyPins = async (cleanup = false) => {
    await readPin(inputsPin, 1048576, false, cleanup, true);
    for (const name of referenceNames)
      await readPin(inputs.campaign[name], ["owner", "jobOwner"].includes(name) ? 4096 : 1048576,
        false, cleanup, true);
    for (const name of sourceNames)
      await readPin(inputs.sources[name], 1048576, false, cleanup);
    for (const name of toolNames)
      await readPin(inputs.tools[name], 536870912, false, cleanup);
    for (const claim of [owner, jobOwner]) {
      const directory = await lstat(claim.output, { bigint: true });
      need(directory.isDirectory() && !directory.isSymbolicLink()
        && directory.uid === BigInt(process.getuid()) && Number(directory.mode & 0o7777n) === 0o700
        && directory.dev.toString() === String(claim.device)
        && directory.ino.toString() === String(claim.inode), "ACTUAL_CAMPAIGN_OUTPUT_IDENTITY_CHANGED");
    }
    stableClock();
  };

  const verifyLiveBoundary = (cleanup = false) => {
    remaining(cleanup);
    for (const [file, frozen] of identities) {
      for (let component = file;; component = dirname(component)) {
        need(!lstatSync(component).isSymbolicLink(), "LIVE_PIN_SYMLINK_ANCESTRY_REFUSED");
        if (component === "/") break;
      }
      need(identity(lstatSync(file, { bigint: true })) === frozen, "LIVE_OBSERVER_FILE_IDENTITY_CHANGED");
    }
    for (const claim of [owner, jobOwner]) {
      const directory = lstatSync(claim.output, { bigint: true });
      need(directory.isDirectory() && directory.uid === BigInt(process.getuid())
        && Number(directory.mode & 0o7777n) === 0o700
        && directory.dev.toString() === String(claim.device)
        && directory.ino.toString() === String(claim.inode), "LIVE_CAMPAIGN_OUTPUT_IDENTITY_CHANGED");
    }
    need(Date.now() < Date.parse(executionGrant.expiresAt), "BROWSER_EFFECT_GRANT_EXPIRED");
    stableClock();
    remaining(cleanup);
  };

  const native = (phase, nonce) => {
    verifyLiveBoundary();
    need(nativeChildren < 3, "NATIVE_CHILD_POPULATION_BOUND");
    nativeChildren++;
    report.nativeObservationIssued = true;
    const before = Date.now();
    const result = spawnSync(inputs.tools.browserObserver.path, [], {
      input: JSON.stringify({ requesterPid: process.pid, phase, nonce, assignedPort,
        bundleIdentifier: inputs.browser.bundleIdentifier, executable: inputs.tools.browserExecutable }),
      encoding: "utf8", timeout: Math.min(8000, remaining()), maxBuffer: 131072,
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
    });
    need(!result.error && !result.signal && [0, 2].includes(result.status),
      "ACTUAL_NATIVE_OBSERVATION_FAILED");
    let value;
    try { value = JSON.parse(result.stdout); } catch { need(false, "ACTUAL_NATIVE_JSON_REQUIRED"); }
    need(value.schema === "finnor.w2.browser-owner-native-facts.v1",
      "ACTUAL_NATIVE_SCHEMA_REQUIRED");
    if (result.status !== 0 || value.status !== "OBSERVED")
      need(false, /^[A-Z0-9_]{1,100}$/.test(value.reason ?? "") ? value.reason : "NATIVE_OBSERVATION_UNKNOWN");
    need(value.phase === phase && hex.test(value.bootSha256)
      && Number.isFinite(value.startedAtUnixMs) && Number.isFinite(value.observedAtUnixMs)
      && value.startedAtUnixMs >= before - 1000 && value.observedAtUnixMs >= value.startedAtUnixMs
      && value.observedAtUnixMs <= Date.now() + 1000
      && Array.isArray(value.processes) && value.processes.length <= 8
      && value.requester?.pid === process.pid && Array.isArray(value.requesterLineage)
      && value.requesterLineage.length <= 32,
    "ACTUAL_NATIVE_SCOPE_IDENTITY_OR_FRESHNESS_REQUIRED");
    const creatorIndex = value.requesterLineage.findIndex(row => row.pid === owner.pid);
    const jobIndex = value.requesterLineage.findIndex(row => row.pid === jobOwner.pid);
    const creator = value.requesterLineage[creatorIndex], actualJob = value.requesterLineage[jobIndex];
    const creatorBirth = creator ? Number(creator.startSec) * 1000 + Number(creator.startUsec) / 1000 : NaN;
    need(jobIndex >= 1 && creatorIndex > jobIndex && creator.uid === process.getuid()
      && actualJob.uid === process.getuid() && Number.isFinite(creatorBirth)
      && creatorBirth <= owner.createdAtUnixMs + 1000,
    "ACTUAL_CURRENT_CAMPAIGN_AND_JOB_KERNEL_ANCESTRY_REQUIRED");
    if (phase === "challenge")
      need(value.nonceSha256 === sha(nonce), "ACTUAL_NATIVE_NONCE_MISMATCH");
    stableClock();
    report.metadataObserved = true;
    return value;
  };

  const commandLimits = (cleanup = false) => {
    verifyLiveBoundary(cleanup);
    need(cliChildren < 10, "SUPPORTED_BROWSER_CHILD_POPULATION_BOUND");
    cliChildren++;
    report.browserCommandIssued = true;
    return { timeoutMs: Math.min(cleanup ? 12000 : 8000, remaining(cleanup)), maxBuffer: 131072 };
  };
  const tabs = (nonce, cleanup = false) => {
    const value = run(["tab", "list"], undefined, commandLimits(cleanup));
    need(Array.isArray(value.data?.tabs) && value.data.tabs.length <= 256,
      "DOCUMENTED_TARGET_LIST_SCHEMA_UNAVAILABLE");
    const rows = value.data.tabs, seen = new Set();
    for (const row of rows) {
      need(typeof row.targetId === "string" && row.targetId.length > 0 && row.targetId.length <= 256
        && !seen.has(row.targetId), "UNIQUE_ACTUAL_TARGET_IDENTITIES_REQUIRED");
      seen.add(row.targetId);
    }
    const matches = rows.filter(row => sha(row.targetId) === inputs.assignment.targetIdSha256);
    need(matches.length === 1, "PREDECLARED_OWNED_TARGET_NOT_PRESENT");
    const row = matches[0];
    need(typeof row.url === "string" && row.url.length <= 2048 && allowedLocation(row.url)
      && sha(row.url) === inputs.assignment.locationSha256
      && rows.filter(other => other.url === row.url).length === 1,
    "EXACT_UNIQUE_OWNED_TARGET_LOCATION_REQUIRED");
    if (nonce) {
      const token = "finnor-w2-observer-" + nonce;
      need(row.title === token && rows.filter(other => other.title === token).length === 1,
        "UNIQUE_SUPPORTED_TARGET_NONCE_REQUIRED");
    }
    return { targetIdSha256: sha(row.targetId), locationSha256: sha(row.url), title: row.title };
  };
  const evaluate = (source, cleanup = false) => dom(source, commandLimits(cleanup));
  const selectWindow = value => {
    const found = [];
    for (const actual of value.processes) {
      need(actual.bundleIdentifier === inputs.browser.bundleIdentifier
        && actual.executableSha256 === inputs.tools.browserExecutable.sha256
        && actual.executablePathSha256 === sha(inputs.tools.browserExecutable.path)
        && actual.uid === process.getuid() && Number.isSafeInteger(actual.pid) && actual.pid > 1
        && /^[0-9]{1,12}$/.test(actual.startSec) && /^[0-9]{1,6}$/.test(actual.startUsec)
        && actual.mappedExecutable?.bytes === inputs.tools.browserExecutable.bytes
        && actual.mappedExecutable?.mode === inputs.tools.browserExecutable.mode
        && [0, process.getuid()].includes(actual.mappedExecutable?.uid)
        && actual.endpointListener?.pid === actual.pid
        && Number.isSafeInteger(actual.endpointListener?.fd) && actual.endpointListener.fd >= 0
        && actual.endpointListener.portSha256 === sha(String(assignedPort))
        && actual.endpointListener.addressClass === "EXACT_IPV4_LOOPBACK"
        && actual.endpointListener.state === "LISTEN"
        && /^[1-9][0-9]{0,19}$/.test(actual.endpointListener.generation)
        && Array.isArray(actual.lineage) && actual.lineage.length <= 32
        && sameFields(actual, actual.lineage[0], processKeys)
        && actual.lineage.at(-1)?.pid === 1 && Array.isArray(actual.windows),
      "ACTUAL_EXTERNAL_BROWSER_KERNEL_IDENTITY_REQUIRED");
      for (const window of actual.windows) {
        need(Number.isSafeInteger(window.id) && window.id > 0 && window.ownerPid === actual.pid
          && window.onScreen === true && window.layer === 0 && Number.isFinite(window.alpha)
          && window.alpha >= 0.95 && window.alpha <= 1 && window.intersectsActiveDisplay === true
          && window.titleMetadataAvailable === true, "ACTUAL_VISIBLE_NORMAL_BROWSER_WINDOW_REQUIRED");
        found.push({ process: actual, window });
      }
    }
    need(found.length === 1, "UNIQUE_NONCE_VISIBLE_EXTERNAL_WINDOW_REQUIRED");
    return found[0];
  };
  const sameBrowser = (a, b) => sameFields(a, b, [...processKeys, "bundleIdentifier",
    "executableSha256", "appLaunchUnixMs"]) && sameLineage(a.lineage, b.lineage)
    && sameFields(a.mappedExecutable, b.mappedExecutable, imageKeys)
    && sameFields(a.endpointListener, b.endpointListener, listenerKeys);

  try {
    need(Number.isFinite(started) && started <= performance.now()
      && Number.isFinite(wallStart) && wallStart <= Date.now() + 1000,
    "ORIGINAL_OBSERVER_CLOCK_REQUIRED");
    need(process.platform === "darwin", "SUPPORTED_NATIVE_OS_OBSERVER_UNAVAILABLE");
    need(env.AGENT_BROWSER_PIN_TAB === "1", "EXPLICIT_ASSIGNED_PIN_TAB_REQUIRED");
    const inputFile = inputReference?.path ?? env.FINNOR_W2_BROWSER_OBSERVER_INPUTS;
    const inputSha256 = inputReference?.sha256 ?? env.FINNOR_W2_BROWSER_OBSERVER_INPUTS_SHA256;
    need(inputFile?.startsWith("/") && hex.test(inputSha256 ?? ""),
      "INDEPENDENT_OBSERVER_INPUT_PIN_REQUIRED");
    await noAliases(inputFile);
    const info = await lstat(inputFile);
    inputsPin = { path: inputFile, sha256: inputSha256, bytes: info.size, mode: 0o600 };
    inputs = await readJson(inputsPin, 1048576);
    need(inputs.schema === "finnor.w2.browser-observer-inputs.v2",
      "CURRENT_CAMPAIGN_PRODUCED_OBSERVER_INPUT_REQUIRED");
    const records = {}, pins = {};
    for (const name of referenceNames) {
      const pin = inputs.campaign?.[name], [fileKey, hashKey] = observerCampaignReferences[name];
      need(pin?.path === env[fileKey] && pin?.sha256 === env[hashKey],
        "INDEPENDENT_CURRENT_CAMPAIGN_REFERENCE_REQUIRED");
      pins[name] = pin;
      records[name] = await readJson(pin, ["owner", "jobOwner"].includes(name) ? 4096 : 1048576);
    }
    owner = records.owner; jobOwner = records.jobOwner;
    harness = records.harnessManifest; executionGrant = records.executionGrant;
    const expected = prepareCampaignObserverInputs({ env, pins, records, remainingMs: remaining(true) });
    need(JSON.stringify(inputs) === JSON.stringify(expected),
      "EXACT_CURRENT_CAMPAIGN_PRODUCER_INPUT_REQUIRED");
    assignedPort = directAssignedPort(env.AGENT_BROWSER_CDP);
    need(inputs.tools.agentBrowser.path === binary.path
      && inputs.tools.agentBrowser.sha256 === binary.sha256
      && inputs.tools.node.path === await realpath(process.execPath),
    "ACTUAL_EXECUTING_NODE_AND_SUPPORTED_BROWSER_REQUIRED");
    await verifyPins();
    report.scope = { inputsSha256: inputsPin.sha256,
      campaignOwnerSha256: pins.owner.sha256, campaignNonceSha256: sha(owner.nonce),
      jobOwnerSha256: pins.jobOwner.sha256, jobNonceSha256: sha(jobOwner.nonce),
      templateSha256: pins.template.sha256, executionGrantSha256: pins.executionGrant.sha256,
      campaignPlatform: owner.platform, campaignOutputDevice: owner.device, campaignOutputInode: owner.inode,
      jobOutputDevice: jobOwner.device, jobOutputInode: jobOwner.inode,
      harnessManifestSha256: pins.harnessManifest.sha256,
      sourceCommit: harness.source.commit, sourceTree: harness.source.tree,
      targetIdSha256: inputs.assignment.targetIdSha256, locationSha256: inputs.assignment.locationSha256 };
    report.tools = Object.fromEntries(toolNames.map(name => [name, inputs.tools[name].sha256]));
    report.sources = Object.fromEntries(sourceNames.map(name => [name, inputs.sources[name].sha256]));
    const baseline = native("baseline");
    report.observerHost = { platform: process.platform,
      topology: observerTopology, bootSha256: baseline.bootSha256,
      campaignOwnerProcess: baseline.requesterLineage.find(row => row.pid === owner.pid),
      mountedJobOwnerProcess: baseline.requesterLineage.find(row => row.pid === jobOwner.pid) };
    need(baseline.processes.some(row => row.windows?.length > 0), "PREEXISTING_EXTERNAL_BROWSER_WINDOW_REQUIRED");
    report.steps.push({ name: "native-before-first-browser-command", status: "OBSERVED" });
    const initialTab = tabs();
    original = evaluate("return {href:location.href,title:document.title};");
    need(typeof original.href === "string" && allowedLocation(original.href)
      && sha(original.href) === inputs.assignment.locationSha256
      && typeof original.title === "string" && original.title.length <= 4096
      && initialTab.title === original.title, "EXACT_OWNED_DOCUMENT_BEFORE_TITLE_WRITE_REQUIRED");
    need(tabs().title === original.title, "SUPPORTED_OWNED_TARGET_CHANGED_BEFORE_TITLE_WRITE");
    marker = "__finnor_w2_observer_" + randomBytes(32).toString("hex");
    const challenges = [];
    for (let round = 0; round < 2; round++) {
      const nonce = randomBytes(32).toString("hex"), token = "finnor-w2-observer-" + nonce;
      const args = JSON.stringify({ marker, href: original.href, title: original.title, previousToken, token });
      mutationAttempted = true;
      report.nonceTitleWriteAttempted = true;
      const changed = evaluate(`
const a=${args};
if(location.href!==a.href) throw Error("OWNED_DOCUMENT_CHANGED");
let d=Object.getOwnPropertyDescriptor(window,a.marker);
if(a.previousToken===undefined){
  if(d||document.title!==a.title) throw Error("OWNED_TITLE_CHANGED");
  const value={href:a.href,title:a.title,token:a.token};
  Object.defineProperty(window,a.marker,{value,configurable:true});
}else{
  if(!d||!d.value||d.value.href!==a.href||d.value.title!==a.title
    ||d.value.token!==a.previousToken||document.title!==a.previousToken)
    throw Error("OWNED_OBSERVER_MARKER_CHANGED");
  d.value.token=a.token;
}
document.title=a.token;
return {href:location.href,title:document.title};`);
      previousToken = token;
      need(changed.href === original.href && changed.title === token, "ACTUAL_DOM_NONCE_WRITE_REQUIRED");
      const target = tabs(nonce), facts = native("challenge", nonce), selected = selectWindow(facts);
      const priorProcess = baseline.processes.find(row => sameBrowser(row, selected.process));
      need(priorProcess?.windows.some(row => row.id === selected.window.id)
        && baseline.bootSha256 === facts.bootSha256
        && sameLineage(baseline.requesterLineage, facts.requesterLineage),
      "PREEXISTING_BROWSER_BIRTH_WINDOW_AND_REQUESTER_REQUIRED");
      if (challenges.length)
        need(challenges[0].facts.bootSha256 === facts.bootSha256
          && sameBrowser(challenges[0].selected.process, selected.process)
          && challenges[0].selected.window.id === selected.window.id
          && challenges[0].nonceSha256 !== sha(nonce), "SECOND_INDEPENDENT_NONCE_IDENTITY_REQUIRED");
      challenges.push({ nonceSha256: sha(nonce), target, facts, selected });
      report.steps.push({ name: "independent-supported-and-native-nonce-" + (round + 1), status: "OBSERVED" });
    }
    observations = { baseline, challenges };
  } catch (error) {
    failure = error.observerCode ?? "OBSERVER_INPUT_OR_OBSERVATION_FAILED";
  } finally {
    if (mutationAttempted) {
      report.cleanup = { status: "UNKNOWN", titleRestored: false, markerRemoved: false };
      try {
        const args = JSON.stringify({ marker, href: original.href, title: original.title });
        const restored = evaluate(`
const a=${args},d=Object.getOwnPropertyDescriptor(window,a.marker);
if(location.href!==a.href||!d||!d.value||d.value.href!==a.href||d.value.title!==a.title
  ||document.title!==d.value.token) throw Error("KNOWN_OWNED_DOCUMENT_REQUIRED_FOR_RESTORE");
document.title=d.value.title;
if(document.title!==a.title) throw Error("ACTUAL_TITLE_RESTORATION_FAILED");
if(!delete window[a.marker]||Object.prototype.hasOwnProperty.call(window,a.marker))
  throw Error("ACTUAL_OBSERVER_MARKER_REMOVAL_FAILED");
return {restored:document.title===a.title,markerRemoved:true};`, true);
        need(restored.restored === true && restored.markerRemoved === true, "ACTUAL_TITLE_CLEANUP_REQUIRED");
        need(tabs(undefined, true).title === original.title, "SUPPORTED_RESTORED_TARGET_TITLE_REQUIRED");
        report.cleanup = { status: "PASS", titleRestored: true, markerRemoved: true };
      } catch (error) {
        report.cleanup.reason = error.observerCode ?? "KNOWN_OWNED_TITLE_RESTORATION_NOT_ESTABLISHED";
        failure ??= "BROWSER_TITLE_CLEANUP_NOT_ESTABLISHED";
      }
    }
  }

  try {
    if (inputs && inputsPin && owner && harness) await verifyPins(true);
    stableClock();
    remaining(true);
  } catch (error) { failure ??= error.observerCode ?? "OBSERVER_FINAL_PIN_CHECK_FAILED"; }
  report.elapsedMs = Math.ceil(performance.now() - started);
  report.childrenAttempted = { supportedCli: cliChildren, native: nativeChildren };
  report.completedAt = new Date().toISOString();
  report.observedAt = observations
    ? new Date(observations.challenges[1].facts.observedAtUnixMs).toISOString() : report.completedAt;
  if (failure || !observations || report.cleanup.status !== "PASS") {
    report.reason = failure ?? "COMPLETE_ACTUAL_BROWSER_OBSERVATION_REQUIRED";
    return report;
  }

  const { baseline, challenges } = observations, final = challenges[1];
  report.observation = { bootSha256: final.facts.bootSha256,
    process: final.selected.process, window: final.selected.window };
  // Do not retain other baseline windows or unrelated titles/target IDs.
  delete report.observation.process.windows;
  report.nonceChallenges = challenges.map(row => ({ nonceSha256: row.nonceSha256,
    targetIdSha256: row.target.targetIdSha256, observedAtUnixMs: row.facts.observedAtUnixMs,
    pid: row.selected.process.pid, windowId: row.selected.window.id }));
  report.predicates.VISIBLE_EXTERNAL = { status: "PASS", basis: "ACTUAL_PREEXISTING_NORMAL_ONSCREEN_PINNED_BROWSER_WINDOW" };
  report.predicates.SESSION_TARGET_BOUND = { status: "PASS",
    basis: "ACTUAL_BROWSER_OWNED_ASSIGNED_LISTENER_AND_TWO_SUPPORTED_TARGET_WINDOW_NONCES" };
  report.browser.headed = true;
  const actual = final.selected.process, launch = actual.appLaunchUnixMs;
  const birth = Number(actual.startSec) * 1000 + Number(actual.startUsec) / 1000;
  const age = baseline.startedAtUnixMs - launch;
  if (typeof launch === "number" && Number.isFinite(launch) && Number.isFinite(birth)
    && Math.abs(launch - birth) <= 2000 && age >= 0 && age <= 300000) {
    report.predicates.SEPARATE_LAUNCH_PROVEN = {
      status: "PASS", basis: "ACTUAL_LAUNCHSERVICES_DATE_KERNEL_BIRTH_EXECUTABLE_AND_LINEAGE",
      launchBirthDifferenceMs: Math.abs(launch - birth), baselineLaunchAgeMs: age };
    report.browser.separatelyLaunched = true;
    report.status = "PASS";
  } else {
    report.predicates.SEPARATE_LAUNCH_PROVEN = { status: "UNKNOWN",
      reason: launch === null ? "ACTUAL_LAUNCHSERVICES_DATE_UNAVAILABLE"
        : "FRESH_CONSISTENT_LAUNCHSERVICES_KERNEL_BASIS_NOT_ESTABLISHED" };
    report.reason = "SEPARATE_LAUNCH_NOT_ESTABLISHED_BY_THIS_SUPPORTED_PROFILE";
  }
  return report;
}
