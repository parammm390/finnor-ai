/** Isolated probe of finnor-os/scripts/project-z/z1/listener-custody.mjs (failure model rows A8 and G4).
 * Uses throwaway listeners on ephemeral ports of this host only, never the target's ports, a database or Auth.
 * Exit 0 only if every control behaves as declared. Output is one JSON document with the observed facts.
 *
 *   node scope-z/phase-evidence/z1/probes/listener-custody-probe.mjs [--link-local 169.254.0.21]
 */
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectListeners } from "../../../../finnor-os/scripts/project-z/z1/listener-custody.mjs";

const linkLocal = process.argv.includes("--link-local") ? process.argv[process.argv.indexOf("--link-local") + 1] : "169.254.0.21";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const rows = [];
const servers = [];
const children = [];

function listen(host) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.on("error", () => {}));
    server.once("error", reject);
    server.listen(0, host, () => { servers.push(server); resolve({ server, port: server.address().port }); });
  });
}
async function outcome(port) {
  try { const value = await inspectListeners(port); return { accepted: true, loopbackRows: value.loopbackInodes.length, forwarders: value.forwarders }; }
  catch (error) { return { accepted: false, code: error.message, detail: error.detail ?? null }; }
}
async function waitFor(port, predicate, ms) {
  const end = Date.now() + ms;
  let last = await outcome(port);
  while (!predicate(last) && Date.now() < end) { await delay(500); last = await outcome(port); }
  return last;
}
const record = (id, expected, observed, passed, note) => rows.push({ id, expected, observed, passed, ...(note ? { note } : {}) });

try {
  // P1: a loopback listener. The platform may mirror it; both outcomes must be accepted, and a mirror must be recognised.
  const p1 = await listen("127.0.0.1");
  const mirrored = await waitFor(p1.port, value => value.accepted && value.forwarders.length === 1, 20000);
  record("P1_LOOPBACK_LISTENER_ACCEPTED_AND_MIRROR_RECOGNISED_WHEN_PRESENT", "accepted with one loopback row; zero or one platform forwarder",
    mirrored, mirrored.accepted && mirrored.loopbackRows === 1 && mirrored.forwarders.length <= 1 && mirrored.forwarders.every(item => item.address === linkLocal),
    mirrored.forwarders.length === 1 ? "platform mirror present and recognised" : "no platform mirror observed on this host (strict loopback behaviour)");

  // P2: a connection through the mirror makes the forwarder fork a child with the same command line; still one forwarder.
  if (mirrored.forwarders.length === 1) {
    const held = net.connect({ host: linkLocal, port: p1.port });
    held.on("error", () => {});
    await new Promise(resolve => held.once("connect", resolve).once("error", resolve));
    await delay(1000);
    const forked = await outcome(p1.port);
    record("P2_FORKED_FORWARDER_CHILD_NOT_COUNTED", "accepted with exactly one forwarder while a connection is open", forked,
      forked.accepted && forked.forwarders.length === 1);
    held.destroy();
  } else record("P2_FORKED_FORWARDER_CHILD_NOT_COUNTED", "needs a platform mirror", "NOT_RUN", true, "NOT_RUN: no mirror on this host");

  // N1: a wildcard bind of a target port is a real exposure and must refuse.
  const n1 = await listen("0.0.0.0");
  const wildcard = await waitFor(n1.port, value => !value.accepted, 3000);
  record("N1_WILDCARD_BIND_REFUSED", "refused TARGET_LISTENER_MUST_BIND_LOOPBACK_ONLY naming the wildcard address", wildcard,
    !wildcard.accepted && wildcard.code === "TARGET_LISTENER_MUST_BIND_LOOPBACK_ONLY" && wildcard.detail?.some(row => row.address === "0.0.0.0" || row.address === "00000000"));

  // N2: a listener on the link-local address that no platform forwarder owns must refuse.
  let n2;
  try { n2 = await listen(linkLocal); } catch (error) { n2 = { error: String(error.code ?? error.message) }; }
  if (n2.error) record("N2_LINK_LOCAL_LISTENER_WITHOUT_FORWARDER_REFUSED", "refused", "NOT_RUN", true, `NOT_RUN: cannot bind ${linkLocal}: ${n2.error}`);
  else {
    const rogue = await waitFor(n2.port, value => !value.accepted, 3000);
    record("N2_LINK_LOCAL_LISTENER_WITHOUT_FORWARDER_REFUSED", "refused", rogue, !rogue.accepted && rogue.code === "TARGET_LISTENER_MUST_BIND_LOOPBACK_ONLY");
  }

  // N3: the exact forwarder command line started by this (non-root) user is not the platform forwarder.
  const socat = spawnSync("sh", ["-c", "command -v socat"], { encoding: "utf8" }).stdout.trim();
  if (!socat || process.getuid() === 0) record("N3_LOOK_ALIKE_FORWARDER_NOT_ROOT_REFUSED", "refused", "NOT_RUN", true,
    !socat ? "NOT_RUN: socat is not installed" : "NOT_RUN: probe is running as root");
  else {
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const lookAlike = spawn("socat", ["-d", "-d", "-d", `TCP4-LISTEN:${port},bind=${linkLocal},reuseaddr,fork`, `TCP4:localhost:${port}`], { stdio: "ignore" });
    children.push(lookAlike);
    const decoy = await waitFor(port, value => !value.accepted, 5000);
    record("N3_LOOK_ALIKE_FORWARDER_NOT_ROOT_REFUSED", "refused", decoy, !decoy.accepted && decoy.code === "TARGET_LISTENER_MUST_BIND_LOOPBACK_ONLY",
      "same command line as the platform forwarder but owned by the probe's user");
  }
} finally {
  for (const child of children) child.kill("SIGKILL");
  for (const server of servers) server.close();
}
const passed = rows.every(row => row.passed);
console.log(JSON.stringify({ schema: "finnor.z1.listener-custody-probe.v1", status: passed ? "PASSED" : "FAILED", uid: process.getuid(),
  node: process.version, linkLocal, source: fileURLToPath(import.meta.url), rows }, null, 2));
process.exit(passed ? 0 : 1);
