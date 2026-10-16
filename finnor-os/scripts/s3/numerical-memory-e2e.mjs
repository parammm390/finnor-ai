/** Actual Linux fork/exec accounting proof, written before the peak reader.
 * A large parent must not be attributed to its small numerical interpreter. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const python = process.env.FINNOR_S3_PYTHON, output = process.env.FINNOR_S3_MEMORY_EVIDENCE;
assert(python?.startsWith("/") && output?.startsWith("/"), "Explicit runtime and fresh absolute artifact path required");
assert.equal(process.platform, "linux", "This probe reproduces Linux exec accounting");
const script = fileURLToPath(new URL("../../packages/epistemic-runtime/src/intervention-numerics.py", import.meta.url));
const held = Buffer.alloc(640 * 1024 ** 2, 1);
const probe = spawnSync(python, ["-I", "-c", `
import importlib.util,json,resource,sys
s=importlib.util.spec_from_file_location("numerical_peak_probe",sys.argv[1])
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
actual=m.numerical_peak_rss_bytes()
print(json.dumps({"actualPeakBytes":actual,"inheritedPeakBytes":resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*1024,
 "basis":"LINUX_KERNEL_POST_EXEC_VMHWM_KIB_TO_BYTES"}))
`, script], { encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" } });
let observed;
try { observed = JSON.parse(probe.stdout); } catch { observed = null; }
const passed = probe.status === 0 && observed?.actualPeakBytes > 0
  && observed.actualPeakBytes <= 512 * 1024 ** 2 && observed.inheritedPeakBytes > 512 * 1024 ** 2;
const receipt = { schema: "finnor.s3.linux-exec-memory-e2e.v1", observedAt: new Date().toISOString(), passed,
  parentAllocationBytes: held.length, parentRssBytes: process.memoryUsage().rss, child: observed,
  boundBytes: 512 * 1024 ** 2, exit: probe.status, failure: probe.stderr, runtime: python, source: script,
  rerun: "FINNOR_S3_PYTHON=<absolute> FINNOR_S3_MEMORY_EVIDENCE=<fresh-json> node finnor-os/scripts/s3/numerical-memory-e2e.mjs" };
writeFileSync(resolve(output), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
assert(passed, "Post-exec numerical peak reader missing, malformed or outside unchanged bound: " + probe.stderr);
console.log(JSON.stringify({ passed, child: observed, artifact: output }));
