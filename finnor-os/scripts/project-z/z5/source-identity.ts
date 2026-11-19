/** No parent-Git adoption. Archive identity requires explicit exact membership. */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
export async function exactSourceHead(root: string) {
  try {
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (path.resolve(top) !== path.resolve(root)) throw Error("PARENT_GIT_FORBIDDEN");
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    if (process.env.FINNOR_Z5_DECLARED_RECONSTRUCTION !== "EXACT_MANIFEST") throw Error("Z5_EXPLICIT_ARCHIVE_MEMBERSHIP_REQUIRED");
    const manifest = JSON.parse(await readFile(path.join(root, "scope-z/phase-evidence/z5/reconstruction/source-manifest.json"), "utf8")) as {
      sourceHead: string; files: { path: string; sha256: string }[];
    };
    if (!/^[a-f0-9]{40}$/.test(manifest.sourceHead) || !Array.isArray(manifest.files)
      || new Set(manifest.files.map(f => f.path)).size !== manifest.files.length) throw Error("Z5_ARCHIVE_MEMBERSHIP_INVALID");
    for (const file of manifest.files) {
      if (path.isAbsolute(file.path) || file.path.split("/").includes("..")
        || createHash("sha256").update(await readFile(path.join(root, file.path))).digest("hex") !== file.sha256)
        throw Error("Z5_ARCHIVE_SOURCE_CHANGED");
    }
    return manifest.sourceHead;
  }
}
