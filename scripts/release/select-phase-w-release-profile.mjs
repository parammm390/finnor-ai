import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parsePhaseWReleaseCandidate } from "./phase-w-release-profile.mjs";

const must = (condition, code) => {
  if (!condition) throw Object.assign(Error(code), { code });
};
try {
  const args = process.argv.slice(2);
  must(args.length === 4 && args[0] === "--source" && args[2] === "--sha"
    && isAbsolute(args[1]) && /^[a-f0-9]{40}$/.test(args[3]), "PHASE_W_RELEASE_SOURCE_ARGUMENTS_INVALID");
  const source = resolve(args[1]), expectedSha = args[3];
  must(realpathSync(source) === source && lstatSync(source).isDirectory(), "PHASE_W_RELEASE_SOURCE_PATH_INVALID");
  const git = (...command) => execFileSync("git", ["-C", source, ...command], {
    encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const requireSource = () => {
    must(git("rev-parse", "--show-toplevel").trim() === source, "PHASE_W_RELEASE_SOURCE_ROOT_MISMATCH");
    must(git("rev-parse", "HEAD").trim() === expectedSha, "PHASE_W_RELEASE_SOURCE_SHA_MISMATCH");
    must(git("status", "--porcelain=v1", "--untracked-files=all").trim() === "", "PHASE_W_RELEASE_SOURCE_NOT_CLEAN");
  };
  requireSource();
  const relative = "scope-postz/phase-w-ci/release-candidate.json";
  let path = source, markerExists = true;
  for (const component of relative.split("/")) {
    path = join(path, component);
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      markerExists = false; break;
    }
    must(!stat.isSymbolicLink(), "PHASE_W_RELEASE_MARKER_SYMLINK");
    if (component !== "release-candidate.json") must(stat.isDirectory(), "PHASE_W_RELEASE_MARKER_PARENT_INVALID");
    else must(stat.isFile() && stat.nlink === 1 && stat.size <= 4096, "PHASE_W_RELEASE_MARKER_FILE_INVALID");
  }
  const entry = git("ls-tree", "-z", expectedSha, "--", relative);
  let text;
  if (entry === "") {
    must(!markerExists, "PHASE_W_RELEASE_MARKER_NOT_COMMITTED");
  } else {
    must(entry.startsWith("100644 blob ") && entry.endsWith("\t" + relative + "\0"),
      "PHASE_W_RELEASE_MARKER_COMMITTED_MODE_INVALID");
    must(markerExists, "PHASE_W_RELEASE_MARKER_CHECKOUT_MISSING");
    const actual = readFileSync(join(source, relative));
    const committed = git("show", expectedSha + ":" + relative);
    must(actual.equals(Buffer.from(committed, "utf8")), "PHASE_W_RELEASE_MARKER_BYTES_MISMATCH");
    text = actual.toString("utf8");
  }
  const releaseProfile = parsePhaseWReleaseCandidate(text);
  requireSource();
  process.stdout.write("release_profile=" + releaseProfile + "\nsource_sha=" + expectedSha + "\n");
} catch (error) {
  const code = typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
    ? error.code : "PHASE_W_RELEASE_PROFILE_SELECTION_FAILED";
  console.error(code);
  process.exitCode = 1;
}
