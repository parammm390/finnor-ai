import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFile, readdir, lstat, realpath } from "node:fs/promises";
import { resolve, join, relative, sep, dirname, isAbsolute } from "node:path";

const normalized = name => name.toLowerCase().replaceAll(/[-_.]+/g, "-");
const probe = `import sys,sysconfig,json,importlib.metadata as m,os
print(json.dumps({"version":sys.version.split()[0],"base":os.path.realpath(sys.base_prefix),"prefix":os.path.realpath(sys.prefix),"site":sysconfig.get_path("purelib"),"paths":[os.path.realpath(p) for p in sys.path],"packages":sorted((d.metadata["Name"],d.version) for d in m.distributions())}))`;
export async function packScientific({ backend, output, save, internalLink, checkBound }) {
  const result = {};
  for (const [name, environment, selector, version, lock] of [
    ["s3", ".w3-venv", "FINNOR_S3_PYTHON", "3.11.15", "scripts/postz/w3/requirements-s3.lock"],
    ["s5", ".w3-s5-venv", "FINNOR_S5_PYTHON", "3.12.13", "packages/epistemic-runtime/src/requirements-s5.txt"],
  ]) {
    checkBound();
    const runProbe = python => {
      const run = spawnSync(python, ["-I", "-B", "-c", probe], { encoding: "utf8", timeout: 30000,
        env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" }, maxBuffer: 1048576 });
      assert.equal(run.status, 0, "W3_SCIENTIFIC_IDENTITY_UNAVAILABLE:" + name + ":" + run.stderr);
      return JSON.parse(run.stdout);
    };
    // Invoke the declared venv entry, not its resolved base-interpreter link.
    const python = process.env[selector] ?? join(backend, environment, "bin/python");
    assert(isAbsolute(python) && dirname(python).endsWith(sep + "bin"),
      "W3_EXPLICIT_SCIENTIFIC_INTERPRETER_ENTRY_REQUIRED");
    const environmentRoot = await realpath(dirname(dirname(python)));
    const original = runProbe(python);
    assert.equal(original.version, version, "W3_EXACT_SCIENTIFIC_INTERPRETER_REQUIRED");
    const pinned = (await readFile(join(backend, lock), "utf8")).split("\n")
      .map(line => line.trim()).filter(line => line && !line.startsWith("#")).map(line => {
        const match = /^([A-Za-z0-9_.-]+)==([A-Za-z0-9.+-]+)$/.exec(line);
        assert(match, "W3_EXACT_SCIENTIFIC_REQUIREMENTS_REQUIRED");
        return [normalized(match[1]), match[2]];
      }).sort((a, b) => a[0].localeCompare(b[0]));
    const population = value => value.packages.map(([n, v]) => [normalized(n), v])
      .sort((a, b) => a[0].localeCompare(b[0]));
    assert.deepEqual(population(original), pinned, "W3_SCIENTIFIC_PACKAGE_POPULATION_DRIFT");
    const majorMinor = version.split(".").slice(0, 2).join(".");
    const destination = "finnor-os/scientific/" + name;
    const base = await realpath(original.base), site = await realpath(original.site);
    assert.equal(original.prefix, environmentRoot, "W3_EXPLICIT_SCIENTIFIC_ENVIRONMENT_REQUIRED");
    assert(site.startsWith(environmentRoot + sep), "W3_EXPLICIT_SCIENTIFIC_ENVIRONMENT_REQUIRED");
    async function copyTree(sourceRoot, directory, target, skipSite = false) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
        const path = join(directory, entry.name), next = target + "/" + entry.name;
        if (skipSite && relative(sourceRoot, path) === join("lib", "python" + majorMinor, "site-packages")) continue;
        const info = await lstat(path);
        if (info.isDirectory()) await copyTree(sourceRoot, path, next, skipSite);
        else if (info.isFile()) await save(next, await readFile(path), "SCIENTIFIC_RUNTIME", 0o444 | (info.mode & 0o111));
        else if (info.isSymbolicLink()) {
          const actual = await realpath(path);
          assert(actual.startsWith(sourceRoot + sep), "W3_EXTERNAL_SCIENTIFIC_LINK_REFUSED");
          const prefix = target.slice(0, target.length - relative(sourceRoot, directory).length).replace(/\/$/, "");
          await internalLink(next, prefix + "/" + relative(sourceRoot, actual));
        } else throw Error("W3_SCIENTIFIC_SPECIAL_FILE_REFUSED");
      }
    }
    await copyTree(base, base, destination, true);
    await copyTree(site, site, destination + "/lib/python" + majorMinor + "/site-packages");
    const entrypoint = destination + "/bin/python" + majorMinor;
    const installed = runProbe(join(output, entrypoint));
    assert.equal(installed.version, version);
    assert.equal(installed.base, resolve(output, destination), "W3_RELOCATED_SCIENTIFIC_BASE_REQUIRED");
    assert.equal(installed.prefix, installed.base, "W3_DONOR_VENV_PREFIX_REFUSED");
    assert(installed.paths.every(path => path.startsWith(installed.base + sep)), "W3_DONOR_SCIENTIFIC_IMPORT_PATH_REFUSED");
    assert.deepEqual(population(installed), pinned);
    result[name] = { version, entrypoint, requirements: "finnor-os/" + lock, packages: pinned,
      relocatedImportPathsOnly: true, donorEnvironmentRequiredAtRuntime: false };
  }
  return result;
}
