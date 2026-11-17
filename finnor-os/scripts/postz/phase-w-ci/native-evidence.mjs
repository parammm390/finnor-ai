/** Independent CI receipt checks and metadata-only public staging. Private
 * payloads are checked locally and never returned or copied into staging. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const engines = ["W1", "W2", "W3", "W4", "W5"];
// Independent expected values frozen before implementation, not derived from
// the producer's own receipt or a mutable runtime export.
const schemas = ["finnor.orchestration-policy-capsule.v1", "finnor.workforce-execution-program.v1",
  "finnor.real-world-service.v1", "finnor.market-validated-operating-program.v1", "finnor.organization-transformation-program.v1"];
const predicates = ["W049-W1-actual-capsule-native-consumption", "W049-W2-actual-workforce-native-consumption",
  "W049-W3-actual-service-native-consumption", "W049-W4-actual-market-native-consumption",
  "W049-W5-actual-organization-native-consumption", "W049-shared-business-original-custody"];
const classification = "CONTROLLED_DEV_SHARED_COMPANY_REAL_NATIVE_OWNERS";
const publicPaths = engines.map(engine => "integrated/" + engine.toLowerCase() + "/actual-native-output.json");
const uploadPaths = ["integrated/profile.json", "integrated/result.json", "integrated/native-consumption.json", ...publicPaths];
const outputKeys = ["engine", "schema", "tenantId", "principalId", "companyId", "workId", "workInputId", "requestId",
  "ref", "consumedBy", "privateEvidenceSha256", "qualification", "completeMonetaryCost", "independentProtectedCustody"];
const cleanupNames = ["owned-worker", "recipient", "authentication", "application-pool", "database-admin", "owned-postgres"];
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const opaque = value => typeof value === "string" && /^[A-Za-z0-9_:./-]{1,256}$/.test(value);
const digest = value => createHash("sha256").update(value).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const must = (condition, code) => {
  if (!condition) throw Object.assign(Error(code), { code });
};
const keys = (value, expected, code) => {
  must(object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort()), code);
};
const noQualification = value => {
  must(value.admitted === false && value.productionActive === false && value.fieldValidated === false,
    "PHASE_W_FALSE_QUALIFICATION_REQUIRED");
};

async function readArtifact(root, relative, privatePayload = false) {
  const parts = relative.split("/");
  must(parts.every(part => part && part !== "." && part !== ".."), "PHASE_W_FIXED_ARTIFACT_PATH_REQUIRED");
  let absolute = root;
  for (const [index, part] of parts.entries()) {
    absolute = join(absolute, part);
    const stat = await lstat(absolute);
    must(!stat.isSymbolicLink(), "PHASE_W_ARTIFACT_SYMLINK_REFUSED");
    if (index < parts.length - 1) must(stat.isDirectory(), "PHASE_W_ARTIFACT_PARENT_INVALID");
    else must(stat.isFile() && stat.nlink === 1, "PHASE_W_REGULAR_OWNED_ARTIFACT_REQUIRED");
  }
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat(), maximum = privatePayload ? 16 * 1024 * 1024 : 1024 * 1024;
    must(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= maximum, "PHASE_W_ARTIFACT_SIZE_BOUND");
    const bytes = Buffer.alloc(before.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await file.read(bytes, position, bytes.length - position, position);
      must(bytesRead > 0, "PHASE_W_ARTIFACT_TRUNCATED_DURING_READ");
      position += bytesRead;
    }
    const after = await file.stat(), current = await lstat(absolute);
    must(bytes.length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs
      && current.ino === before.ino && current.dev === before.dev && current.nlink === 1
      && current.isFile() && !current.isSymbolicLink(), "PHASE_W_ARTIFACT_CHANGED_DURING_READ");
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); }
    catch { must(false, "PHASE_W_ARTIFACT_JSON_INVALID"); }
    return { value, sha256: digest(bytes) };
  } finally { await file.close(); }
}

function checkProfile(profile) {
  keys(profile, ["schema", "requirements", "classification", "aggregateSeconds", "w3ObserverSeconds",
    "w1ProgrammeObserverSeconds", "rationale", "admitted", "productionActive", "fieldValidated"], "PHASE_W_PROFILE_FIELDS_INVALID");
  must(profile.schema === "finnor.w.integrated-owner-profile.v1" && profile.requirements === "FINNOR-POSTZ-W-PRD-1.0.0"
    && profile.classification === classification && profile.aggregateSeconds === 7200
    && profile.w3ObserverSeconds === 1200 && profile.w1ProgrammeObserverSeconds === 120,
  "PHASE_W_FROZEN_PROFILE_REQUIRED");
  must(typeof profile.rationale === "string" && profile.rationale.length > 0 && profile.rationale.length <= 1024,
    "PHASE_W_PROFILE_RATIONALE_REQUIRED");
  noQualification(profile);
}

export async function verifyNativeEvidence(output) {
  must(isAbsolute(output) && resolve(output) === output && await realpath(output) === output,
    "PHASE_W_CANONICAL_ABSOLUTE_OUTPUT_REQUIRED");
  must((await lstat(output)).isDirectory(), "PHASE_W_OUTPUT_DIRECTORY_REQUIRED");
  const hashes = new Map();
  const readPublic = async path => {
    const artifact = await readArtifact(output, path);
    hashes.set(path, artifact.sha256); return artifact.value;
  };
  const profile = await readPublic(uploadPaths[0]);
  const terminal = await readPublic(uploadPaths[1]);
  const consumption = await readPublic(uploadPaths[2]);
  checkProfile(profile);
  keys(terminal, ["schema", "status", "startedAt", "finishedAt", "elapsedMs", "exitCode", "profile", "scope",
    "outputs", "results", "cleanup", "completionGate", "admitted", "productionActive", "fieldValidated",
    "fullPrdW049Satisfied", "w050ThroughW053Satisfied"], "PHASE_W_TERMINAL_FIELDS_INVALID");
  must(terminal.schema === "finnor.w.integrated-native-e2e.v1" && terminal.status === "PASS_CONTROLLED_SHARED_COMPANY_NATIVE_OWNERS"
    && terminal.exitCode === 0, "PHASE_W_EXACT_NATIVE_TERMINAL_PASS_REQUIRED");
  must(isDeepStrictEqual(terminal.profile, profile), "PHASE_W_TERMINAL_PROFILE_MISMATCH");
  must(terminal.completionGate === "PHASE_W_RELEASE_BLOCKED" && terminal.fullPrdW049Satisfied === false
    && terminal.w050ThroughW053Satisfied === false, "PHASE_W_FULL_PRD_RELEASE_NOT_ESTABLISHED");
  noQualification(terminal);
  const date = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value));
  must(date(terminal.startedAt) && date(terminal.finishedAt) && Date.parse(terminal.finishedAt) >= Date.parse(terminal.startedAt)
    && Number.isFinite(terminal.elapsedMs) && terminal.elapsedMs >= 0 && terminal.elapsedMs < 7230000,
  "PHASE_W_ORIGINAL_AGGREGATE_AND_CLEANUP_BOUND_REQUIRED");
  keys(terminal.scope, ["tenantId", "principalId", "companyId", "originalServiceWorkId", "originalServiceWorkInputId"],
    "PHASE_W_CANONICAL_SCOPE_REQUIRED");
  must(Object.values(terminal.scope).every(uuid), "PHASE_W_CANONICAL_SCOPE_UUID_REQUIRED");
  must(Array.isArray(terminal.outputs) && isDeepStrictEqual(terminal.outputs.map(value => value?.engine), engines),
    "PHASE_W_EXACT_FIVE_NATIVE_OUTPUTS_REQUIRED");
  must(Array.isArray(terminal.results) && isDeepStrictEqual(terminal.results.map(value => value?.id), predicates),
    "PHASE_W_EXACT_SIX_NATIVE_PREDICATES_REQUIRED");
  for (const [index, result] of terminal.results.entries()) {
    keys(result, ["id", "status", "evidencePaths"], "PHASE_W_NATIVE_PREDICATE_FIELDS_INVALID");
    must(result.status === "PASS" && isDeepStrictEqual(result.evidencePaths,
      [index === 5 ? "integrated/native-consumption.json" : publicPaths[index]]), "PHASE_W_NATIVE_PREDICATE_EVIDENCE_REQUIRED");
  }
  keys(terminal.cleanup, ["status", "steps"], "PHASE_W_CLEANUP_FIELDS_INVALID");
  must(terminal.cleanup.status === "PASS" && Array.isArray(terminal.cleanup.steps)
    && isDeepStrictEqual(terminal.cleanup.steps.map(value => value?.name).sort(), [...cleanupNames].sort()),
  "PHASE_W_EXACT_OWNED_CLEANUP_REQUIRED");
  for (const step of terminal.cleanup.steps) {
    keys(step, ["name", "status"], "PHASE_W_SUCCESSFUL_CLEANUP_FIELDS_INVALID");
    must(step.status === "PASS", "PHASE_W_OWNED_CLEANUP_PASS_REQUIRED");
  }
  keys(consumption, ["schema", "status", "profileClassification", "scope", "outputs", "results", "originalCustody",
    "completeMonetaryCost", "independentProtectedCustody", "admitted", "productionActive", "fieldValidated"],
  "PHASE_W_CONSUMPTION_FIELDS_INVALID");
  must(consumption.schema === "finnor.w.integrated-native-consumption.v1" && consumption.status === "PASS_NATIVE_CONSUMPTION"
    && consumption.profileClassification === classification && isDeepStrictEqual(consumption.scope, terminal.scope)
    && isDeepStrictEqual(consumption.outputs, terminal.outputs) && isDeepStrictEqual(consumption.results, terminal.results),
  "PHASE_W_NATIVE_CONSUMPTION_WRAPPER_MISMATCH");
  noQualification(consumption);
  must(consumption.completeMonetaryCost === null && consumption.independentProtectedCustody === false,
    "PHASE_W_COST_AND_PROTECTED_CUSTODY_NOT_ESTABLISHED");
  must(Array.isArray(consumption.originalCustody)
    && isDeepStrictEqual(consumption.originalCustody.map(value => value?.engine), engines), "PHASE_W_EXACT_ORIGINAL_CUSTODY_REQUIRED");
  for (const [index, receipt] of terminal.outputs.entries()) {
    keys(receipt, [...outputKeys, "evidence"], "PHASE_W_PUBLIC_OUTPUT_RECEIPT_FIELDS_INVALID");
    must(receipt.engine === engines[index] && receipt.schema === schemas[index], "PHASE_W_EXPECTED_PRD_OUTPUT_SCHEMA_REQUIRED");
    for (const field of ["tenantId", "principalId", "companyId"]) {
      must(receipt[field] === terminal.scope[field], "PHASE_W_NATIVE_CANONICAL_BUSINESS_MISMATCH");
    }
    must([receipt.workId, receipt.workInputId, receipt.requestId].every(uuid), "PHASE_W_NATIVE_ORIGINAL_IDENTITIES_REQUIRED");
    if (receipt.engine === "W3") must(receipt.workId === terminal.scope.originalServiceWorkId
      && receipt.workInputId === terminal.scope.originalServiceWorkInputId, "PHASE_W_ORIGINAL_SERVICE_WORK_INPUT_MISMATCH");
    keys(receipt.ref, ["owner", "id", "version", "contentDigest"], "PHASE_W_IMMUTABLE_NATIVE_REF_FIELDS_INVALID");
    must(receipt.ref.owner === receipt.engine && opaque(receipt.ref.id) && opaque(receipt.ref.version)
      && sha(receipt.ref.contentDigest), "PHASE_W_IMMUTABLE_NATIVE_REF_REQUIRED");
    keys(receipt.consumedBy, ["owner", "evidenceSha256"], "PHASE_W_NATIVE_CONSUMER_FIELDS_INVALID");
    must(opaque(receipt.consumedBy.owner) && sha(receipt.consumedBy.evidenceSha256) && sha(receipt.privateEvidenceSha256),
      "PHASE_W_ACTUAL_NATIVE_CONSUMER_WITNESS_REQUIRED");
    must(receipt.qualification === "CONTROLLED_NATIVE_OWNER_CONSUMPTION_NOT_FIELD_OR_FULL_COST"
      && receipt.completeMonetaryCost === null && receipt.independentProtectedCustody === false,
    "PHASE_W_PUBLIC_OUTPUT_QUALIFICATION_INVALID");
    keys(receipt.evidence, ["path", "sha256"], "PHASE_W_OUTPUT_EVIDENCE_FIELDS_INVALID");
    must(receipt.evidence.path === publicPaths[index] && sha(receipt.evidence.sha256), "PHASE_W_FIXED_OUTPUT_EVIDENCE_PATH_REQUIRED");
    const actual = await readPublic(publicPaths[index]);
    keys(actual, outputKeys, "PHASE_W_PUBLIC_OUTPUT_FIELDS_INVALID");
    const { evidence, ...projection } = receipt;
    must(hashes.get(publicPaths[index]) === evidence.sha256 && isDeepStrictEqual(actual, projection),
      "PHASE_W_ACTUAL_PUBLIC_OUTPUT_HASH_OR_PROJECTION_MISMATCH");
    const privatePath = "integrated/" + receipt.engine.toLowerCase() + "/private-native-output.json";
    const captured = await readArtifact(output, privatePath, true);
    must(captured.sha256 === receipt.privateEvidenceSha256 && object(captured.value), "PHASE_W_PRIVATE_OUTPUT_HASH_MISMATCH");
    const privateOutput = captured.value;
    for (const field of ["engine", "schema", "tenantId", "principalId", "companyId", "workId", "workInputId", "requestId", "ref"]) {
      must(isDeepStrictEqual(privateOutput[field], receipt[field]), "PHASE_W_PRIVATE_NATIVE_IDENTITY_MISMATCH");
    }
    must(object(privateOutput.consumedBy) && privateOutput.consumedBy.owner === receipt.consumedBy.owner
      && Object.keys(privateOutput.consumedBy).length > 1
      && digest(JSON.stringify(privateOutput.consumedBy)) === receipt.consumedBy.evidenceSha256,
    "PHASE_W_PRIVATE_NATIVE_CONSUMPTION_WITNESS_MISMATCH");
    must(privateOutput.evidence !== null && typeof privateOutput.evidence === "object"
      && Object.keys(privateOutput.evidence).length > 0, "PHASE_W_PRIVATE_OWNER_OBSERVATION_REQUIRED");
    const custody = consumption.originalCustody[index];
    keys(custody, ["engine", "workId", "workInputId", "workStatus", "initialInstructionSha256", "originalInputSha256"],
      "PHASE_W_ORIGINAL_CUSTODY_FIELDS_INVALID");
    must(custody.engine === receipt.engine && custody.workId === receipt.workId && custody.workInputId === receipt.workInputId
      && opaque(custody.workStatus) && sha(custody.initialInstructionSha256) && sha(custody.originalInputSha256),
    "PHASE_W_ORIGINAL_WORK_INPUT_CUSTODY_MISMATCH");
  }
  return { classification, completionGate: "PHASE_W_RELEASE_BLOCKED", admitted: false, productionActive: false, fieldValidated: false,
    fullPrdW049Satisfied: false, w050ThroughW053Satisfied: false,
    files: uploadPaths.map(path => ({ path, sha256: hashes.get(path) })) };
}

export function requireNativeCISourceIdentity(source, expectedSha) {
  must(process.version === "v22.22.3", "PHASE_W_NATIVE_CI_NODE_PIN_MISMATCH");
  must(isAbsolute(source) && resolve(source) === source && realpathSync(source) === source
    && lstatSync(source).isDirectory(), "PHASE_W_NATIVE_CI_SOURCE_PATH_INVALID");
  const git = (...command) => execFileSync("git", ["-C", source, ...command], {
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  must(git("rev-parse", "--show-toplevel") === source, "PHASE_W_NATIVE_CI_SOURCE_ROOT_MISMATCH");
  must(git("rev-parse", "HEAD") === expectedSha, "PHASE_W_NATIVE_CI_SOURCE_SHA_MISMATCH");
  must(git("status", "--porcelain=v1", "--untracked-files=all") === "", "PHASE_W_NATIVE_CI_SOURCE_NOT_CLEAN");
  const hashFile = path => digest(readFileSync(path));
  return { sha: expectedSha, tree: git("rev-parse", expectedSha + "^{tree}"),
    rootLockSha256: hashFile(join(source, "package-lock.json")),
    backendLockSha256: hashFile(join(source, "finnor-os/package-lock.json")),
    node: process.version, nodeSha256: hashFile(process.execPath) };
}

export async function stageNativeEvidence({ output, typeOutput, staging, sourceSha, nativeOutcome, verifierOutcome, typesOutcome }) {
  must(typeof sourceSha === "string" && /^[a-f0-9]{40}$/.test(sourceSha), "PHASE_W_STAGING_SOURCE_SHA_INVALID");
  must(isAbsolute(staging) && resolve(staging) === staging
    && await realpath(dirname(staging)) === dirname(staging), "PHASE_W_STAGING_CANONICAL_PARENT_REQUIRED");
  for (const input of [output, typeOutput]) {
    must(isAbsolute(input) && resolve(input) === input && staging !== input
      && !staging.startsWith(input + "/") && !input.startsWith(staging + "/"), "PHASE_W_STAGING_INPUT_OVERLAP_REFUSED");
  }
  // Exclusive ownership is acquired before inspecting any producer data. Never
  // read, overwrite or clean a previous invocation's staging tree.
  await mkdir(staging, { mode: 0o700 });
  let type = null, verified = null;
  try {
    must(typesOutcome === "success" && await realpath(typeOutput) === typeOutput
      && (await lstat(typeOutput)).isDirectory(), "PHASE_W_STAGING_TYPES_NOT_ELIGIBLE");
    const candidate = await readArtifact(typeOutput, "report.json");
    must(candidate.value?.schema === "finnor.w3.bounded-full-context-typecheck.v1"
      && candidate.value.status === "PASS_COMPLETE_PROGRAM_DIAGNOSTICS", "PHASE_W_STAGING_TYPES_NOT_PASS");
    type = candidate;
  } catch { /* Only the constant failure projection is public. */ }
  if (type && nativeOutcome === "success" && verifierOutcome === "success") {
    try { verified = await verifyNativeEvidence(output); }
    catch { /* Never publish parser errors, partial results or original bytes. */ }
  }
  const native = {
    schema: "finnor.w.native-ci-public-staging.v1",
    status: verified ? "PASS_CONTROLLED_NATIVE_RECEIPTS" : "FAIL_CLOSED",
    sourceSha, classification, completionGate: "PHASE_W_RELEASE_BLOCKED",
    admitted: false, productionActive: false, fieldValidated: false,
    fullPrdW049Satisfied: false, w050ThroughW053Satisfied: false,
    files: verified ? verified.files.map(({ path, sha256 }) => ({ path, sha256 })) : [],
  };
  const types = {
    schema: "finnor.w.types-ci-public-staging.v1",
    status: type ? "PASS_COMPLETE_PROGRAM_DIAGNOSTICS" : "FAIL_CLOSED",
    sourceSha, originalReceiptSha256: type?.sha256 ?? null,
    qualification: "CONTROLLED_STATIC_TYPECHECK_ONLY",
  };
  for (const [path, receipt] of [["native-ci-public.json", native], ["types-ci-public.json", types]]) {
    await writeFile(join(staging, path), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  return { native, types };
}