// Generates exact preimage-bound coordinator patches for Z3 native integration.
// Reads the committed preimage files, applies exact anchor insertions in memory,
// emits git-apply-compatible unified diffs, and records both blob identities.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const repo = "/home/factory-user/repos/finnor-z3";
const outDir = join(repo, "scope-z/phase-evidence/z3/integration-patches");
const work = join(repo, "scope-z/phase-evidence/z3/build/patch-check");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const blobId = (bytes) => execFileSync("git", ["hash-object", "--stdin"], { input: bytes }).toString().trim();

const edits = [
  {
    path: "finnor-os/packages/db/compute-contract.ts",
    patch: "0002-compute-contract.patch",
    inserts: [{
      after: `  run_programme_continuation_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "P7 ordinary source-bound continuation under the original P1 episode; no effect or resource authority."),`,
      add: [
        `  run_z3_viability_synthesis_v1: tenantFixed("INTERACTIVE", "reconcilable", "Z3 bounded public GR(1) viability synthesis with a separate independent checker process under the original Work, reservation and deadline; killed deliveries reconcile through durable claim fences, never automatic replay."),`,
        `  run_z3_viability_recovery_v1: tenantFixed("INTERACTIVE", "reconcilable", "Z3 explicit owner recovery replaying durable checkpoints only; a strictly higher session fence, no effect replay, no new authority and no budget renewal."),`,
      ],
    }],
  },
  {
    path: "finnor-os/apps/worker/src/index.ts",
    patch: "0003-worker-register.patch",
    inserts: [
      {
        after: `import {runProgrammeContinuationJob} from '@finnor/private-equity/src/live-recompilation/worker';`,
        add: [`import {runZ3ViabilityRecoveryJob,runZ3ViabilitySynthesisJob} from '@finnor/private-equity/src/project-z/z3-viability/worker';`],
      },
      {
        after: `  queue.register('run_programme_continuation_v1',runProgrammeContinuationJob,PRODUCTION_JOB_CONTRACTS.run_programme_continuation_v1);`,
        add: [
          `  queue.register('run_z3_viability_synthesis_v1',runZ3ViabilitySynthesisJob,PRODUCTION_JOB_CONTRACTS.run_z3_viability_synthesis_v1);`,
          `  queue.register('run_z3_viability_recovery_v1',runZ3ViabilityRecoveryJob,PRODUCTION_JOB_CONTRACTS.run_z3_viability_recovery_v1);`,
        ],
      },
    ],
  },
  {
    path: "finnor-os/apps/api/app/api/company-brain/[operation]/route.ts",
    patch: "0004-company-brain-route.patch",
    inserts: [
      {
        after: `import {handleContinuationOperation,CONTINUATION_OPERATIONS} from '@finnor/private-equity/src/live-recompilation/api';`,
        add: [`import {handleViabilityOperation,VIABILITY_OPERATIONS} from '@finnor/private-equity/src/project-z/z3-viability/api';`],
      },
      {
        after: `    if((CONTINUATION_OPERATIONS as readonly string[]).includes(route.operation)){const result=await handleContinuationOperation(ctx,route.operation,body);return response(result.body,result.status);}`,
        add: [`    if((VIABILITY_OPERATIONS as readonly string[]).includes(route.operation)){const result=await handleViabilityOperation(ctx,route.operation,body);return response(result.body,result.status);}`],
      },
    ],
  },
  {
    path: "src/components/centropy/world/WorldWorkRecord.tsx",
    patch: "0005-mounted-work-panel.patch",
    inserts: [
      {
        after: `import { ConfidentialComputationPanel } from "./ConfidentialComputationPanel"`,
        add: [`import { ViabilityPanel } from "./ViabilityPanel"`],
      },
      {
        after: "      {root ? <InteractionProtocolPanel key={`interaction:${workId}:${root.entityType}:${root.entityId}`} root={root} workId={workId} /> : null}",
        add: ["      {root ? <ViabilityPanel key={`viability:${workId}:${root.entityType}:${root.entityId}`} root={root} workId={workId} /> : null}"],
      },
    ],
  },
];

const newFiles = [
  { path: "finnor-os/packages/db/migrations/0199_z3_viability.sql", payload: join(outDir, "0199_z3_viability.sql"), patch: "0001-migration-0199-z3-viability.patch" },
  { path: "src/components/centropy/world/ViabilityPanel.tsx", payload: join(outDir, "ViabilityPanel.tsx"), patch: "0005b-viability-panel-file.patch" },
];

function unifiedDiff(path, pre, post) {
  const preFile = join(work, "pre"), postFile = join(work, "post");
  writeFileSync(preFile, pre);
  writeFileSync(postFile, post);
  let body;
  try {
    body = execFileSync("diff", ["-u", "--label", `a/${path}`, "--label", `b/${path}`, preFile, postFile], { encoding: "utf8" });
  } catch (error) {
    if (error.status !== 1 || !error.stdout) throw error;
    body = error.stdout;
  }
  return `diff --git a/${path} b/${path}\nindex ${blobId(pre)}..${blobId(post)} 100644\n${body}`;
}

function newFileDiff(path, bytes) {
  const postFile = join(work, "post");
  writeFileSync(postFile, bytes);
  let body;
  try {
    body = execFileSync("diff", ["-u", "--label", "/dev/null", "--label", `b/${path}`, "/dev/null", postFile], { encoding: "utf8" });
  } catch (error) {
    if (error.status !== 1 || !error.stdout) throw error;
    body = error.stdout;
  }
  return `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..${blobId(bytes)}\n${body}`;
}

mkdirSync(work, { recursive: true });
const manifest = [];
for (const spec of edits) {
  const pre = readFileSync(join(repo, spec.path));
  let post = pre.toString("utf8");
  for (const insert of spec.inserts) {
    const first = post.indexOf(insert.after);
    if (first === -1 || post.indexOf(insert.after, first + 1) !== -1) throw Error(`anchor not unique: ${insert.after.slice(0, 60)}`);
    post = post.replace(insert.after, insert.after + "\n" + insert.add.join("\n"));
  }
  const patch = unifiedDiff(spec.path, pre, Buffer.from(post));
  writeFileSync(join(outDir, spec.patch), patch);
  manifest.push({ patch: spec.patch, path: spec.path, kind: "modify",
    preimageBlob: blobId(pre), postimageBlob: blobId(Buffer.from(post)), sha256: sha256(Buffer.from(patch)) });
}
for (const spec of newFiles) {
  const bytes = readFileSync(spec.payload);
  const patch = newFileDiff(spec.path, bytes);
  writeFileSync(join(outDir, spec.patch), patch);
  manifest.push({ patch: spec.patch, path: spec.path, kind: "add",
    preimageBlob: null, postimageBlob: blobId(bytes), payloadSha256: sha256(bytes), sha256: sha256(Buffer.from(patch)) });
}

// Verification: apply every patch in a scratch tree and hash the results.
const scratch = join(work, "tree");
rmSync(scratch, { recursive: true, force: true });
for (const spec of edits) {
  const target = join(scratch, spec.path);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(repo, spec.path), target);
}
for (const entry of manifest) {
  // (a) Real-repo dry check: resolves and verifies the preimage blob identity.
  execFileSync("git", ["apply", "--check", "-p1", join(outDir, entry.patch)], { cwd: repo });
  // (b) Actual application in the scratch tree (GNU patch), hashed below.
  execFileSync("patch", ["-s", "-p1", "-d", scratch, "-i", join(outDir, entry.patch)]);
}
for (const entry of manifest) {
  const applied = readFileSync(join(scratch, entry.path));
  const actual = blobId(applied);
  if (actual !== entry.postimageBlob) throw Error(`postimage mismatch for ${entry.path}: ${actual}`);
  entry.appliedAndVerified = true;
}
writeFileSync(join(outDir, "manifest.json"), JSON.stringify({
  schema: "finnor.z3.integration-patches.v1",
  baseCommit: "9f3edfd3b4c6758832c53139da0773218062191e",
  baseTree: "2dc4d5bc13d22853cf4dc9feb5f6ac7fbf6bb9c9",
  applyOrder: manifest.map((m) => m.patch),
  patches: manifest,
}, null, 2) + "\n");
console.log(JSON.stringify(manifest.map(({ patch, sha256: s, postimageBlob }) => ({ patch, sha256: s, postimageBlob })), null, 1));
