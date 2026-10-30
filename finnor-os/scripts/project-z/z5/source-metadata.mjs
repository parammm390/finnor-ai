/** Only the existing catalogue auditor's display-only Git metadata seam.
 * Uses verified declared archive membership, never parent Git or new objects. */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exactSourceHead } from "./source-identity.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
if (process.argv[1] === path.join(root, "scripts/centropy/audit-capability-coverage.mjs")) {
  if (process.env.FINNOR_Z5_DECLARED_RECONSTRUCTION !== "EXACT_MANIFEST") throw Error("EXPLICIT_METADATA_RECONSTRUCTION_REQUIRED");
  const manifest = JSON.parse(await readFile(path.join(root, "scope-z/phase-evidence/z5/reconstruction/source-manifest.json"), "utf8"));
  const head = await exactSourceHead(root);
  if (head !== manifest.sourceHead) throw Error("EXACT_DECLARED_METADATA_HEAD_REQUIRED");
  const exec = childProcess.execFileSync;
  childProcess.execFileSync = function(file, args, options) {
    if (file === "git" && args?.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD"
      && path.resolve(options?.cwd ?? ".") === root) {
      process.stderr.write(JSON.stringify({ schema: "finnor.z5.explicit-archive-metadata.v1",
        sourceHead: head, sourceTree: manifest.sourceTree, metadataSource: "VERIFIED_DECLARED_MANIFEST_NOT_GIT_OBSERVATION",
        parentGitAdopted: false, auditPredicatesChanged: false }) + "\n");
      return options?.encoding ? head + "\n" : Buffer.from(head + "\n");
    }
    return exec.call(this, file, args, options);
  };
  syncBuiltinESMExports();
}
