/** The original 900-second campaign wall includes startup, all cases and closers. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchOwnedW2Campaign } from "./owned-campaign-supervisor.mts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const contract = JSON.parse(readFileSync(join(root,
  "scope-postz/w2-accountable-workforce/dynamic/native-recovery-contract.json"), "utf8"));
assert.equal(contract.wallSeconds, 900, "ORIGINAL_NATIVE_RECOVERY_WALL_REQUIRED");
await launchOwnedW2Campaign({
  root, body: fileURLToPath(new URL("./native-recovery-body.mts", import.meta.url)),
  evidenceBase: process.env.FINNOR_W2_EVIDENCE_ROOT ?? join(root, "artifacts/postz-w2/native-recovery"),
  prefix: "native-recovery-run-", bodyMilliseconds: contract.wallSeconds * 1000,
});
