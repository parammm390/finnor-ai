/** Current-campaign input production and the mounted pre-start observation gate. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createAssignedClient } from "./agent-browser-client.mjs";
import { observerCampaignReferences, observerTopology, prepareCampaignObserverInputs,
  readPinnedPrivateObserverJson, requireCanonicalObserverPath, requireCurrentPriorProof
} from "./browser-provenance-observer.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const sha = value => createHash("sha256").update(value).digest("hex");
const need = (condition, code) => {
  if (condition) return;
  const error = new Error("BROWSER_CAMPAIGN_COORDINATOR_REFUSED");
  error.observerCode = code;
  throw error;
};

export async function observeMountedCampaign() {
  const env = { ...process.env }, clock = Object.freeze({
    started: performance.now(), wallStart: Date.now(),
  });
  const budget = () => {
    const elapsed = performance.now() - clock.started;
    need(Math.abs(Date.now() - clock.wallStart - elapsed) <= 1000, "CAMPAIGN_OBSERVER_CLOCK_CHANGED");
    const left = Math.floor(120000 - elapsed);
    need(left >= 1, "CAMPAIGN_OBSERVER_ORIGINAL_TOTAL_DEADLINE");
    return left;
  };
  const loaded = {}, pins = {}, records = {};
  let inputPin, proofPin, evidenceIdentity;
  try {
    need(process.platform === "darwin", "DARWIN_SAME_HOST_MOUNTED_OBSERVER_REQUIRED");
    for (const [name, [fileKey, hashKey]] of Object.entries(observerCampaignReferences)) {
      budget();
      loaded[name] = await readPinnedPrivateObserverJson(env[fileKey], env[hashKey],
        ["owner", "jobOwner"].includes(name) ? 4096 : 1048576);
      pins[name] = loaded[name].pin; records[name] = loaded[name].value;
    }
    const { owner, jobOwner } = records;
    need(jobOwner.pid === process.ppid, "ACTUAL_MOUNTED_JOB_MUST_BE_DIRECT_PARENT");
    need(jobOwner.output !== root && !jobOwner.output.startsWith(root + "/"),
      "PRIVATE_MOUNTED_JOB_OUTPUT_MUST_BE_OUTSIDE_SOURCE");
    const evidence = env.FINNOR_W2_EVIDENCE_ROOT;
    need(evidence === join(jobOwner.output, "campaign"), "EXACT_CURRENT_MOUNTED_EVIDENCE_OUTPUT_REQUIRED");
    const inputs = prepareCampaignObserverInputs({ env, pins, records, remainingMs: budget() });

    const verifyCustody = async () => {
      for (const claim of [owner, jobOwner]) {
        budget();
        await requireCanonicalObserverPath(claim.output);
        const directory = await lstat(claim.output, { bigint: true });
        need(directory.isDirectory() && !directory.isSymbolicLink()
          && directory.uid === BigInt(process.getuid()) && Number(directory.mode & 0o7777n) === 0o700
          && directory.dev.toString() === String(claim.device)
          && directory.ino.toString() === String(claim.inode), "CURRENT_CAMPAIGN_OR_JOB_CUSTODY_LOST");
      }
      for (const name of Object.keys(observerCampaignReferences)) {
        budget();
        const current = await readPinnedPrivateObserverJson(pins[name].path, pins[name].sha256,
          ["owner", "jobOwner"].includes(name) ? 4096 : 1048576);
        need(current.identity === loaded[name].identity, "CURRENT_CAMPAIGN_REFERENCE_IDENTITY_CHANGED");
      }
      if (evidenceIdentity) {
        await requireCanonicalObserverPath(evidence);
        const directory = await lstat(evidence, { bigint: true });
        need(directory.isDirectory() && directory.uid === BigInt(process.getuid())
          && Number(directory.mode & 0o7777n) === 0o700
          && directory.dev === evidenceIdentity.dev && directory.ino === evidenceIdentity.ino,
        "ORIGINAL_MOUNTED_EVIDENCE_DIRECTORY_CHANGED");
      }
    };
    const writePrivate = async (file, value) => {
      budget();
      const body = Buffer.from(JSON.stringify(value, null, 2) + "\n");
      need(body.length > 0 && body.length <= 1048576, "BOUNDED_PRIVATE_CAMPAIGN_RECORD_REQUIRED");
      await verifyCustody();
      await requireCanonicalObserverPath(resolve(file, ".."));
      let handle;
      try {
        handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600);
        const info = await handle.stat({ bigint: true });
        need(info.isFile() && info.uid === BigInt(process.getuid())
          && Number(info.mode & 0o7777n) === 0o600 && info.size === 0n,
        "NEW_PRIVATE_CAMPAIGN_RECORD_REQUIRED");
        await handle.writeFile(body);
        await handle.sync();
      } finally { if (handle) await handle.close(); }
      budget();
      await verifyCustody();
      return (await readPinnedPrivateObserverJson(file, sha(body))).pin;
    };

    inputPin = await writePrivate(join(jobOwner.output, "browser-observer-inputs-current.json"), inputs);
    const client = await createAssignedClient();
    budget();
    const proof = await client.observeProvenance({ inputReference: inputPin, clock });
    // Retain an actual UNKNOWN/failure receipt too. It never unlocks startup.
    await verifyCustody();
    await mkdir(evidence, { mode: 0o700 });
    evidenceIdentity = await lstat(evidence, { bigint: true });
    need(evidenceIdentity.isDirectory() && !evidenceIdentity.isSymbolicLink()
      && evidenceIdentity.uid === BigInt(process.getuid())
      && Number(evidenceIdentity.mode & 0o7777n) === 0o700,
    "NEW_PRIVATE_MOUNTED_EVIDENCE_DIRECTORY_REQUIRED");
    proofPin = await writePrivate(join(evidence, "browser-provenance-current.json"), proof);
    requireCurrentPriorProof(proof);
    need(proof.scope.inputsSha256 === inputPin.sha256
      && proof.scope.campaignOwnerSha256 === pins.owner.sha256
      && proof.scope.campaignNonceSha256 === inputs.campaign.binding.nonceSha256
      && proof.scope.jobOwnerSha256 === pins.jobOwner.sha256
      && proof.scope.jobNonceSha256 === inputs.campaign.binding.jobNonceSha256
      && proof.scope.templateSha256 === pins.template.sha256
      && proof.scope.executionGrantSha256 === pins.executionGrant.sha256
      && proof.scope.harnessManifestSha256 === pins.harnessManifest.sha256
      && proof.scope.campaignOutputDevice === owner.device && proof.scope.campaignOutputInode === owner.inode
      && proof.scope.jobOutputDevice === jobOwner.device && proof.scope.jobOutputInode === jobOwner.inode
      && proof.observerHost.platform === process.platform && proof.observerHost.topology === observerTopology
      && proof.observerHost.campaignOwnerProcess.pid === owner.pid
      && proof.observerHost.mountedJobOwnerProcess.pid === jobOwner.pid,
    "ACTUAL_FRESH_CURRENT_CAMPAIGN_BROWSER_GATE_REQUIRED");
    await verifyCustody();
    budget();
    return {
      client, proof,
      environment: Object.freeze({
        FINNOR_W2_BROWSER_OBSERVER_INPUTS: inputPin.path,
        FINNOR_W2_BROWSER_OBSERVER_INPUTS_SHA256: inputPin.sha256,
        FINNOR_W2_BROWSER_PROVENANCE: proofPin.path,
        FINNOR_W2_BROWSER_PROVENANCE_SHA256: proofPin.sha256,
      }),
    };
  } catch (error) {
    const code = /^[A-Z0-9_]{1,100}$/.test(error.observerCode ?? "")
      ? error.observerCode : "CAMPAIGN_INPUT_OR_OBSERVATION_GATE_FAILED";
    throw new Error("MOUNTED_BROWSER_GATE_REFUSED:" + code);
  }
}
