/** Keep the entire native body, including imports and awaited startup, supervised. */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchOwnedW2Campaign } from "./owned-campaign-supervisor.mts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
await launchOwnedW2Campaign({
  root, body: fileURLToPath(new URL("./native-bound-body.mts", import.meta.url)),
  evidenceBase: process.env.FINNOR_W2_EVIDENCE_ROOT ?? join(root, "artifacts/postz-w2/native-bound"),
  prefix: "native-bound-run-", bodyMilliseconds: 1200000,
});
