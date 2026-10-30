/** Explicit offline source provenance, never an owner execution receipt. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";

export function readIsolatedCoverageSourceMetadata(root) {
  const mode = process.env.FINNOR_Z2_ISOLATED_SOURCE_BUILD, expected = process.env.FINNOR_Z2_SOURCE_BUILD_METADATA_SHA256;
  if (mode === undefined && expected === undefined) return null;
  assert.equal(mode, "1", "Z2_ISOLATED_COVERAGE_METADATA_MODE");
  const path = join(root, ".z2-source-build.json");
  const metadata = lstatSync(path);
  assert(metadata.isFile() && !metadata.isSymbolicLink(), "Z2_ISOLATED_COVERAGE_METADATA_FILE");
  const bytes = readFileSync(path), sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256, expected, "Z2_ISOLATED_COVERAGE_METADATA_HASH");
  const value = JSON.parse(bytes);
  assert.equal(Object.keys(value).sort().join(","), ["baselineCoverageSha256", "baselineIndexSourceCommit",
    "executedProofIndex", "nativeOwnerExecuted", "protectedAdmission", "reobservedOriginalProofs", "schema", "sourceBaseCommit"].join(","));
  assert.equal(value.schema, "finnor.project-z.z2.isolated-source-build.v1");
  assert(/^[a-f0-9]{40}$/.test(value.sourceBaseCommit) && /^[a-f0-9]{40}$/.test(value.baselineIndexSourceCommit));
  assert(/^[a-f0-9]{64}$/.test(value.baselineCoverageSha256));
  assert(value.reobservedOriginalProofs === false && value.nativeOwnerExecuted === false && value.protectedAdmission === false);
  assert(Array.isArray(value.executedProofIndex) && value.executedProofIndex.length <= 10000);
  const paths = new Set();
  for (const row of value.executedProofIndex) {
    assert.equal(Object.keys(row).sort().join(","), "capturedAt,file,note,result,sha256");
    assert(typeof row.file === "string" && row.file.startsWith("docs/centropy/evidence/") &&
      /release-candidate-/.test(row.file) && /(proof|summary)\.json$/.test(row.file) &&
      row.file.length <= 2048 && !row.file.split("/").includes("..") && !paths.has(row.file));
    paths.add(row.file);
    assert(/^[a-f0-9]{64}$/.test(row.sha256));
    assert(row.result === null || typeof row.result === "string" && row.result.length <= 128);
    assert(row.capturedAt === null || typeof row.capturedAt === "string" && row.capturedAt.length <= 128);
    assert.equal(row.note, "Consult this proof's scope and limitations. A family proof does not certify every capability.");
  }
  return { ...value, sha256 };
}
