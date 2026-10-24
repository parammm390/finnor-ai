// Generates exact preimage-bound coordinator patches for Z3 native integration.
// v2: migration renamed to postz_z3_viability.sql (Z0 lane precedent), adds the
// bundle-generator whitelist, regenerated migrations-bundle.ts (with a byte
// determinism baseline of the unpatched generator), and migration-head.ts.
// Every patch is verified twice: `git apply --check` in the real repo (preimage
// blob identity resolves) and actual GNU-patch application in a scratch tree
// hashed to the recorded postimage blob. Finally the patched scratch tree must
// regenerate the same bundle, proving patch-set/generator coherence.
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const repo = "/home/factory-user/repos/finnor-z3";
const outDir = join(repo, "scope-z/phase-evidence/z3/integration-patches");
const work = join(repo, "scope-z/phase-evidence/z3/build/patch-check");
const tsx = join(repo, "finnor-os/node_modules/.bin/tsx");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const blobId = (bytes) => execFileSync("git", ["hash-object", "--stdin"], { input: bytes }).toString().trim();

const edits = [
  {
    path: "finnor-os/scripts/bundle-migrations.ts",
    patch: "0001b-bundle-generator-whitelist.patch",
    replaces: [{
      find: `if(["postx_y4_confidential_economic_computation.sql","postx_y4_confidential_owner_consumption.sql","postx_y4_runtime_migration_order.sql","postz_z0_institution_application_bridge.sql"].includes(name))continue;`,
      with: `if(["postx_y4_confidential_economic_computation.sql","postx_y4_confidential_owner_consumption.sql","postx_y4_runtime_migration_order.sql","postz_z0_institution_application_bridge.sql","postz_z3_viability.sql"].includes(name))continue;`,
    }],
  },
  {
    path: "finnor-os/packages/db/migration-head.ts",
    patch: "0001d-migration-head.patch",
    replaces: [{
      find: `export const CURRENT_MIGRATION_HEAD = "postz_z0_institution_application_bridge.sql";`,
      with: `export const CURRENT_MIGRATION_HEAD = "postz_z3_viability.sql";`,
    }],
  },
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
  { path: "finnor-os/packages/db/migrations/postz_z3_viability.sql", payload: join(outDir, "postz_z3_viability.sql"), patch: "0001-postz-z3-migration.patch" },
  { path: "src/components/centropy/world/ViabilityPanel.tsx", payload: join(outDir, "ViabilityPanel.tsx"), patch: "0005b-viability-panel-file.patch" },
];

function applyEdits(text, spec) {
  let post = text;
  for (const insert of spec.inserts ?? []) {
    const first = post.indexOf(insert.after);
    if (first === -1 || post.indexOf(insert.after, first + 1) !== -1) throw Error(`anchor not unique: ${insert.after.slice(0, 60)}`);
    post = post.replace(insert.after, insert.after + "\n" + insert.add.join("\n"));
  }
  for (const sub of spec.replaces ?? []) {
    const first = post.indexOf(sub.find);
    if (first === -1 || post.indexOf(sub.find, first + 1) !== -1) throw Error(`find not unique: ${sub.find.slice(0, 60)}`);
    post = post.replace(sub.find, sub.with);
  }
  return post;
}

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

// --- Bundle postimage: determinism baseline, then patched regeneration.
const bundlePath = "finnor-os/packages/db/migrations-bundle.ts";
const bundlePre = readFileSync(join(repo, bundlePath));
const genSrc = readFileSync(join(repo, "finnor-os/scripts/bundle-migrations.ts"), "utf8");
const bundleScratch = join(work, "bundle-scratch");
for (const stage of ["baseline", "patched"]) {
  rmSync(bundleScratch, { recursive: true, force: true });
  mkdirSync(join(bundleScratch, "scripts"), { recursive: true });
  mkdirSync(join(bundleScratch, "packages/db"), { recursive: true });
  cpSync(join(repo, "finnor-os/packages/db/migrations"), join(bundleScratch, "packages/db/migrations"), { recursive: true });
  const generator = stage === "patched" ? applyEdits(genSrc, edits[0]) : genSrc;
  if (stage === "patched") {
    writeFileSync(join(bundleScratch, "packages/db/migrations/postz_z3_viability.sql"),
                  readFileSync(join(outDir, "postz_z3_viability.sql")));
  }
  writeFileSync(join(bundleScratch, "scripts/bundle-migrations.ts"), generator);
  execFileSync(tsx, [join(bundleScratch, "scripts/bundle-migrations.ts")], { stdio: "pipe" });
  const produced = readFileSync(join(bundleScratch, "packages/db/migrations-bundle.ts"));
  if (stage === "baseline") {
    if (!produced.equals(bundlePre)) {
      throw Error("bundle generator is not byte-deterministic against the committed bundle; refusing to synthesize a postimage");
    }
    console.log("baseline: generator reproduces committed bundle byte-identically");
  } else {
    const patch = unifiedDiff(bundlePath, bundlePre, produced);
    writeFileSync(join(outDir, "0001c-migrations-bundle.patch"), patch);
    manifest.push({ patch: "0001c-migrations-bundle.patch", path: bundlePath, kind: "modify",
      preimageBlob: blobId(bundlePre), postimageBlob: blobId(produced), sha256: sha256(Buffer.from(patch)) });
  }
}

for (const spec of edits) {
  const pre = readFileSync(join(repo, spec.path));
  const post = Buffer.from(applyEdits(pre.toString("utf8"), spec));
  const patch = unifiedDiff(spec.path, pre, post);
  writeFileSync(join(outDir, spec.patch), patch);
  manifest.push({ patch: spec.patch, path: spec.path, kind: "modify",
    preimageBlob: blobId(pre), postimageBlob: blobId(post), sha256: sha256(Buffer.from(patch)) });
}
for (const spec of newFiles) {
  const bytes = readFileSync(spec.payload);
  const patch = newFileDiff(spec.path, bytes);
  writeFileSync(join(outDir, spec.patch), patch);
  manifest.push({ patch: spec.patch, path: spec.path, kind: "add",
    preimageBlob: null, postimageBlob: blobId(bytes), payloadSha256: sha256(bytes), sha256: sha256(Buffer.from(patch)) });
}

// --- Verification: (a) git apply --check in the real repo, (b) GNU patch in a
// scratch tree with postimage blob equality, (c) the patched scratch tree's
// generator reproduces the same bundle.
const applyOrder = ["0001-postz-z3-migration.patch", "0001b-bundle-generator-whitelist.patch",
  "0001c-migrations-bundle.patch", "0001d-migration-head.patch", "0002-compute-contract.patch",
  "0003-worker-register.patch", "0004-company-brain-route.patch", "0005-mounted-work-panel.patch",
  "0005b-viability-panel-file.patch"];
const scratch = join(work, "tree");
rmSync(scratch, { recursive: true, force: true });
// The bundle coherence proof below regenerates from the whole migrations dir.
mkdirSync(join(scratch, "finnor-os/packages/db"), { recursive: true });
cpSync(join(repo, "finnor-os/packages/db/migrations"), join(scratch, "finnor-os/packages/db/migrations"), { recursive: true });
for (const entry of manifest) {
  if (entry.kind === "modify") {
    const target = join(scratch, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repo, entry.path), target);
  }
}
for (const name of applyOrder) {
  const entry = manifest.find((m) => m.patch === name);
  if (!entry) throw Error(`manifest missing ${name}`);
  execFileSync("git", ["apply", "--check", "-p1", join(outDir, name)], { cwd: repo });
  execFileSync("patch", ["-s", "-p1", "-d", scratch, "-i", join(outDir, name)]);
  const applied = readFileSync(join(scratch, entry.path));
  if (blobId(applied) !== entry.postimageBlob) throw Error(`postimage mismatch for ${entry.path}`);
  entry.appliedAndVerified = true;
}
execFileSync(tsx, [join(scratch, "finnor-os/scripts/bundle-migrations.ts")], { stdio: "pipe" });
const regenerated = readFileSync(join(scratch, "finnor-os/packages/db/migrations-bundle.ts"));
const bundleEntry = manifest.find((m) => m.patch === "0001c-migrations-bundle.patch");
if (blobId(regenerated) !== bundleEntry.postimageBlob) throw Error("patched scratch tree regenerates a different bundle");
console.log("coherence: patched tree regenerates the patched bundle byte-identically");

writeFileSync(join(outDir, "manifest.json"), JSON.stringify({
  schema: "finnor.z3.integration-patches.v1",
  baseCommit: "9f3edfd3b4c6758832c53139da0773218062191e",
  baseTree: "2dc4d5bc13d22853cf4dc9feb5f6ac7fbf6bb9c9",
  applyOrder,
  patches: applyOrder.map((name) => manifest.find((m) => m.patch === name)),
}, null, 2) + "\n");
console.log(JSON.stringify(manifest.map(({ patch, sha256: s, postimageBlob }) => ({ patch, sha256: s, postimageBlob })), null, 1));
