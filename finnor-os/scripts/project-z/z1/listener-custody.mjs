/** Listener custody for the Z1 native target ports. Node built-ins only, so the guard can use it before it
 * imports a database, browser, auth or product module.
 *
 * Every LISTEN row on a target port is classified. A loopback row must be the declared process's own (the
 * caller checks inode ownership). The hosted sandbox also mirrors each loopback listener onto its link-local
 * interface with a root-owned `socat`; that one row class is accepted only when the exact forwarder is found
 * and it is recorded. Any other non-loopback row refuses. */
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";

const LOOPBACK = new Set(["0100007F", "00000000000000000000000001000000"]);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
// /proc/net/tcp prints an IPv4 address as the host-order word, so the octets read backwards.
const dotted = hex => hex.match(/../g).reverse().map(pair => parseInt(pair, 16)).join(".");

export async function listenerRows(port) {
  const portHex = port.toString(16).padStart(4, "0").toUpperCase();
  const rows = [];
  for (const family of ["tcp", "tcp6"]) {
    const lines = (await readFile(`/proc/net/${family}`, "utf8")).trim().split("\n").slice(1);
    for (const line of lines) {
      const row = line.trim().split(/\s+/), [address, rowPort] = row[1].split(":");
      if (row[3] === "0A" && rowPort === portHex) rows.push({ family, address, inode: row[9] });
    }
  }
  return rows;
}

/** Root-owned `socat` listening parents for exactly this port and address that forward to `localhost` on the
 * same port. `fork` makes one child per accepted connection with the same command line, so a process whose
 * parent has that command line too is not counted. */
export async function platformForwarders(port, address) {
  const expected = Buffer.from(["socat", "-d", "-d", "-d", `TCP4-LISTEN:${port},bind=${address},reuseaddr,fork`,
    `TCP4:localhost:${port}`].join("\0") + "\0");
  const matches = new Map();
  for (const name of await readdir("/proc")) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const commandLine = await readFile(`/proc/${name}/cmdline`);
      if (!commandLine.equals(expected) || (await stat(`/proc/${name}`)).uid !== 0) continue;
      const fields = (await readFile(`/proc/${name}/stat`, "utf8")).split(") ").slice(1).join(") ").split(" ");
      matches.set(Number(name), { pid: Number(name), ppid: Number(fields[1]), startTicks: fields[19],
        commandLineSha256: digest(commandLine) });
    } catch { /* the process exited while /proc was scanned */ }
  }
  return [...matches.values()].filter(item => !matches.has(item.ppid))
    .map(({ pid, startTicks, commandLineSha256 }) => ({ pid, startTicks, commandLineSha256 }));
}

export async function inspectListeners(port) {
  const loopbackInodes = [], forwarders = [], refused = [];
  for (const row of await listenerRows(port)) {
    if (LOOPBACK.has(row.address)) { loopbackInodes.push(row.inode); continue; }
    const address = row.family === "tcp" ? dotted(row.address) : null;
    const owners = address && /^169\.254\.\d{1,3}\.\d{1,3}$/.test(address) ? await platformForwarders(port, address) : [];
    if (owners.length === 1) forwarders.push({ port, address, ...owners[0] });
    else refused.push({ port, family: row.family, address: address ?? row.address });
  }
  if (refused.length) throw Object.assign(new Error("TARGET_LISTENER_MUST_BIND_LOOPBACK_ONLY"), { detail: refused });
  return { loopbackInodes, forwarders };
}
