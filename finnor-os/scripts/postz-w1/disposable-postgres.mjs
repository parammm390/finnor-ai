/** Exact, fixture-owned PG custody. No discovery or deletion of peer scratch. */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const owners = new Set();
const require = createRequire(import.meta.url);
const packageEntry = require.resolve(`@embedded-postgres/${process.platform}-${process.arch}`);
const pgCtl = realpathSync(join(dirname(packageEntry), "../native/bin/pg_ctl"));
const under = (parent, path) => {
  const suffix = relative(parent, path);
  return suffix !== "" && suffix !== ".." && !suffix.startsWith(".." + sep) && !isAbsolute(suffix);
};
function livePostgres(directory) {
  const result = spawnSync("/bin/ps", ["-axww", "-o", "pid=,uid=,stat=,command="],
    { encoding: "utf8", timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw Error("OWNED_POSTGRES_PROCESS_CUT_UNAVAILABLE");
  return result.stdout.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || Number(match[2]) !== process.getuid() || match[3].startsWith("Z")) return [];
    const command = match[4];
    if (!/(^|\/)(postgres|initdb)(\s|$)/.test(command)) return [];
    // The registered directory comes from mkdtemp, never from a loose name glob.
    if (![directory, realpathSync(dirname(directory)) + sep + directory.split(sep).at(-1)]
      .some(path => command.includes("-D " + path + " ") || command.endsWith("-D " + path) ||
        command.includes("--pgdata=" + path + " ") || command.endsWith("--pgdata=" + path))) return [];
    return [{ pid: Number(match[1]), kind: /(^|\/)initdb(\s|$)/.test(command) ? "initdb" : "postgres" }];
  });
}

export function ownDisposablePostgres(scratch, databaseDirectory = scratch, receiptPath) {
  const directory = realpathSync(scratch), temporary = realpathSync(tmpdir());
  if (!under(temporary, directory) || !/^(finnor-(w1|p1)-|p5-native-db-)/.test(directory.split(sep).at(-1)))
    throw Error("EXACT_NEW_DISPOSABLE_TEMP_DIRECTORY_REQUIRED");
  const database = resolve(directory, relative(resolve(scratch), resolve(databaseDirectory)));
  if (database !== directory && !under(directory, database)) throw Error("OWNED_DATABASE_PATH_ESCAPE");
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid())
    throw Error("REGULAR_OWNED_DISPOSABLE_DIRECTORY_REQUIRED");
  // initdb requires an empty cluster directory. Keep custody beside that
  // directory when scratch itself is the PG data directory.
  const marker = database === directory ? directory + ".w1-owner.json" : join(directory, ".w1-disposable-owner.json");
  const identity = { schema: "finnor.w1.disposable-postgres-owner.v1", id: randomUUID(),
    directory, databaseDirectory: database, uid: stat.uid, dev: stat.dev, ino: stat.ino, ownerPid: process.pid };
  writeFileSync(marker, JSON.stringify(identity) + "\n", { flag: "wx", mode: 0o600 });
  let complete = false, instance;
  let observation = { ...identity, status: "NOT_CLEANED", clusterStopped: false, directoryRemoved: false };
  const save = () => {
    if (receiptPath) writeFileSync(receiptPath, JSON.stringify(observation, null, 2) + "\n", { mode: 0o600 });
  };
  const cleanup = () => {
    if (complete) return observation;
    try {
      if (!existsSync(directory)) throw Error("OWNED_SCRATCH_DISAPPEARED_WITHOUT_CLEANUP");
      const current = lstatSync(directory);
      if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino ||
          JSON.stringify(JSON.parse(readFileSync(marker, "utf8"))) !== JSON.stringify(identity))
        throw Error("OWNED_SCRATCH_IDENTITY_CHANGED");
      if (existsSync(database) && realpathSync(database) !== database)
        throw Error("OWNED_DATABASE_SYMLINK_REFUSED");
      const before = livePostgres(database);
      observation.processesBefore = before;
      // Interrupt an in-progress initdb before deleting its output. Its parent
      // is already in finally/exit and must not continue initialization.
      for (const child of before.filter(row => row.kind === "initdb")) {
        try { process.kill(child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
      if (before.some(row => row.kind === "postgres")) {
        const stopped = spawnSync(pgCtl, ["-D", database, "-m", "immediate", "-w", "-t", "3", "stop"],
          { encoding: "utf8", timeout: 4000, maxBuffer: 16384 });
        observation.stop = { exitCode: stopped.status, signal: stopped.signal, error: stopped.error?.code ?? null };
      }
      const remaining = livePostgres(database);
      observation.remainingProcesses = remaining;
      if (remaining.length) throw Error("OWNED_POSTGRES_STILL_RUNNING");
      observation.clusterStopped = true;
      // Prevent the package's non-idempotent exit hook waiting on an already
      // emitted ChildProcess exit event. No package bytes are modified.
      if (instance) instance.process = undefined;
      const open = spawnSync(process.platform === "linux" ? "/usr/bin/lsof" : "/usr/sbin/lsof", ["-t", "+D", directory],
        { encoding: "utf8", timeout: 4000, maxBuffer: 65536 });
      if (open.error || ![0, 1].includes(open.status)) throw Error("OWNED_SCRATCH_OPEN_FILE_CUT_UNAVAILABLE");
      observation.openPids = [...new Set(open.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
      if (observation.openPids.length) throw Error("OWNED_SCRATCH_HAS_OPEN_FILES");
      rmSync(directory, { recursive: true, force: false });
      if (database === directory) unlinkSync(marker);
      observation.directoryRemoved = !existsSync(directory);
      if (!observation.directoryRemoved) throw Error("OWNED_SCRATCH_NOT_REMOVED");
      observation.status = "PASS";
      observation.completedAt = new Date().toISOString();
      complete = true; owners.delete(owner);
      save();
      return observation;
    } catch (error) {
      observation = { ...observation, status: "FAIL", failure: String(error), completedAt: new Date().toISOString() };
      process.exitCode = 1;
      try { save(); } catch (saveError) { observation.receiptFailure = String(saveError); }
      throw error;
    }
  };
  const owner = { cleanup, get observation() { return observation; },
    attach(value) {
      instance = value;
      value.options.databaseDir = database;
      // Every exit-hook call is now idempotent and includes enclosing scratch.
      value.stop = async () => cleanup();
      return value;
    } };
  owners.add(owner); save();
  return owner;
}

/** Try every closer even if an earlier one rejects or never settles. */
export async function closeDisposablePostgres(owner, closers = []) {
  const failures = [];
  for (const close of closers) {
    let timer;
    try {
      await Promise.race([Promise.resolve().then(close), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("DISPOSABLE_RESOURCE_CLOSE_TIMEOUT")), 5000);
      })]);
    } catch (error) { failures.push(error); }
    finally { clearTimeout(timer); }
  }
  try { owner?.cleanup(); } catch (error) { failures.push(error); }
  if (failures.length) {
    process.exitCode = 1;
    throw new AggregateError(failures, "DISPOSABLE_RESOURCE_CLEANUP_FAILED");
  }
  return owner?.observation;
}

function emergencyCleanup() {
  let failed = false;
  for (const owner of [...owners]) try { owner.cleanup(); } catch { failed = true; }
  return failed;
}
// embedded-postgres' async-exit-hook finishes beforeExit with process.exit(0),
// even when the owner has already selected a nonzero process.exitCode.
// Finalizers above are awaited by the drivers; this last synchronous custody
// boundary must preserve their actual failure rather than manufacture success.
process.prependOnceListener("beforeExit", () => {
  const failed = emergencyCleanup();
  process.exit(failed ? Number(process.exitCode) || 1 : Number(process.exitCode) || 0);
});
process.prependOnceListener("exit", code => { if (emergencyCleanup()) process.exitCode = code || 1; });
for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]]) {
  process.prependOnceListener(signal, () => {
    emergencyCleanup();
    process.exit(code);
  });
}
