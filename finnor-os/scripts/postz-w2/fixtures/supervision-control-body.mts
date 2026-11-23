/** Real process/filesystem controls only. No W2 business or PostgreSQL claim. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ownedCampaignBody, runOwnedClosers } from "../owned-campaign-supervisor.mts";

const owned = ownedCampaignBody(fileURLToPath(import.meta.url));
const output = owned.output, mode = process.env.FINNOR_W2_CONTROL_MODE;
const save = async (name: string, value: unknown) => {
  owned.requireClaim();
  await writeFile(join(output, name), JSON.stringify(value) + "\n", { mode: 0o600 });
};
await save("child.json", { pid: process.pid, parent: process.ppid, mode });
if (mode === "hang" || mode === "interrupt") {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (mode === "collision") {
  const end = Date.now() + 3000;
  while (true) {
    assert(Date.now() < end, "CONTROL_RELEASE_DEADLINE");
    try { await readFile(join(output, "release")); break }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
if (mode === "claim-tamper") {
  const path = join(output, ".owner.json"), claim = JSON.parse(await readFile(path, "utf8"));
  claim.token = "0".repeat(64);
  await writeFile(path, JSON.stringify(claim) + "\n", { mode: 0o600 });
  owned.requireClaim();
  throw Error("CHANGED_CLAIM_WAS_NOT_REFUSED");
}
if (mode === "leak") {
  const child = spawn(process.execPath, ["--max-old-space-size=64", "-e", "setInterval(()=>{},1000)"],
    { stdio: "ignore" });
  assert(child.pid);
  await save("leaked-child.json", { pid: child.pid });
  child.unref();
}
if (mode === "database-identity-mismatch") {
  const { mkdir } = await import("node:fs/promises");
  const directory = join(output, "owned-runtime/database");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "postmaster.pid"),
    `${process.env.FINNOR_W2_CONTROL_NEIGHBOR_PID}\n${directory}\n${Math.floor(Date.now() / 1000)}\n49187\n`,
    { mode: 0o600 });
}
if (mode === "missing-receipt") process.exit(0);
const cleanup = await runOwnedClosers([
  ["first", async () => { await save("first-closer.json", { attempted: true }); }],
  ["challenged", async () => {
    if (mode === "closer-throw") throw Object.assign(Error("CONTROL_PRIVATE_DETAIL_NOT_FOR_REPORT"), { code: "CONTROL_CLOSER_REFUSED" });
    if (mode === "closer-hang") {
      setInterval(() => {}, 1000).unref();
      await new Promise(() => {});
    }
  }],
  ["last", async () => { await save("last-closer.json", { attempted: true }); }],
], 100);
await save("report.json", { schema: "finnor.w2.process-control-body.v1",
  status: cleanup.status, cleanup, results: [{ id: mode, status: "PASS" }],
  qualification: "PROCESS_FILESYSTEM_CONTROL_NOT_NATIVE_W2" });
process.exit(mode === "nonzero" ? 7 : cleanup.status === "PASS" ? 0 : 1);
