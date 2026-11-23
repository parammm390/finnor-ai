import assert from "node:assert/strict"
import { X509Certificate, createHash, createPrivateKey } from "node:crypto"
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { createServer, request as tlsRequest } from "node:https"
import { createServer as createSocket } from "node:net"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Loopback https front for the isolated Auth gateway. It holds no Auth secret:
// it terminates TLS with one declared self-signed certificate and forwards
// /auth/v1/* unchanged to the existing http gateway. The http gateway stays as is.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const pins = JSON.parse(readFileSync(join(root, "infra/deployment/project-z-verification-toolchain.json"), "utf8"))
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const certFile = option("cert")
const keyFile = option("key")
const state = option("state")
const port = Number(option("port"))
assert.ok(certFile && keyFile && state && [certFile, keyFile, state].every(isAbsolute), "Absolute --cert, --key and --state are required")
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535 && !Object.values(pins.ports).includes(port), "TLS_PORT_MUST_BE_UNPINNED")
assert.match(process.version, /^v22\./)
assert.ok(!existsSync(state), "State must be new; no automatic retry or reuse")
const upstreamPort = pins.ports.authGateway
const sha = body => createHash("sha256").update(body).digest("hex")

function ownedFile(path, privateFile) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    assert.ok(info.isFile() && info.uid === process.getuid() && info.size <= 64 * 1024, "TLS_FILE_OWNERSHIP")
    assert.equal(info.mode & (privateFile ? 0o077 : 0o022), 0, privateFile ? "TLS_KEY_MUST_BE_0600" : "TLS_CERT_MUST_NOT_BE_WRITABLE_BY_OTHERS")
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
const keyDirectory = dirname(keyFile)
const directory = lstatSync(keyDirectory)
assert.ok(directory.isDirectory() && directory.uid === process.getuid() && (directory.mode & 0o077) === 0, "TLS_KEY_DIRECTORY_MUST_BE_0700")
assert.equal(realpathSync(keyDirectory), keyDirectory, "TLS_KEY_DIRECTORY_MUST_NOT_USE_SYMLINKS")
assert.ok(!keyDirectory.startsWith(realpathSync(root) + "/"), "TLS_KEY_MUST_BE_OUTSIDE_THE_REPOSITORY")
const certBytes = ownedFile(certFile, false)
const keyBytes = ownedFile(keyFile, true)
const key = createPrivateKey(keyBytes)
// The certificate file doubles as the replay's NODE_EXTRA_CA_CERTS, so it must hold exactly one PEM block.
assert.equal(certBytes.toString("latin1").split("-----BEGIN ").length, 2, "TLS_CERT_FILE_MUST_HOLD_ONE_CERTIFICATE")
const cert = new X509Certificate(certBytes)
assert.ok(cert.checkPrivateKey(key), "TLS_KEY_DOES_NOT_MATCH_CERT")
assert.ok(!cert.ca && cert.subject === cert.issuer && cert.verify(cert.publicKey), "TLS_CERT_MUST_BE_SELF_SIGNED_LEAF")
assert.equal(cert.checkIP("127.0.0.1"), "127.0.0.1", "TLS_CERT_SAN_IP_127_0_0_1_REQUIRED")
assert.ok(Date.parse(cert.validFrom) <= Date.now() && Date.now() < Date.parse(cert.validTo), "TLS_CERT_NOT_CURRENT")
const spki = cert.publicKey.export({ type: "spki", format: "der" })

const probe = createSocket()
await new Promise((done, reject) => probe.once("error", reject).listen(port, "127.0.0.1", done))
await new Promise(done => probe.close(done))
const upstreamHealthy = await fetch(`http://127.0.0.1:${upstreamPort}/auth/v1/health`, { signal: AbortSignal.timeout(5000) })
  .then(response => response.ok).catch(() => false)
assert.ok(upstreamHealthy, "UPSTREAM_ISOLATED_AUTH_GATEWAY_NOT_HEALTHY")

mkdirSync(state, { mode: 0o700 })
const origin = `https://127.0.0.1:${port}`
const receipt = {
  schema: "finnor.project-z.isolated-auth-tls.v1", status: "STARTING", startedAt: new Date().toISOString(),
  origin, upstream: `http://127.0.0.1:${upstreamPort}`, forwardedPathPrefix: "/auth/v1/",
  certificateFile: certFile, certificateSha256: sha(certBytes), spkiSha256: sha(spki),
  spkiSha256Base64: Buffer.from(sha(spki), "hex").toString("base64"),
  validFrom: cert.validFrom, validTo: cert.validTo, subjectAltName: cert.subjectAltName,
  keyFile, keyPrinted: false, authBypass: false, phasesAccepted: [], pid: process.pid,
}
const save = () => writeFileSync(join(state, "state.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 })
save()
const server = createServer({ cert: certBytes, key: keyBytes, minVersion: "TLSv1.2" }, (incoming, outgoing) => {
  if (!incoming.url?.startsWith("/auth/v1/")) { outgoing.writeHead(404).end(); return }
  const upstream = request({
    host: "127.0.0.1", port: upstreamPort, method: incoming.method, path: incoming.url,
    headers: { ...incoming.headers, host: `127.0.0.1:${upstreamPort}` }, timeout: 10000,
  }, response => { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing) })
  upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end() })
  upstream.on("timeout", () => upstream.destroy())
  incoming.pipe(upstream)
})
server.requestTimeout = 15000
let stopping = false
function stop(code) {
  if (stopping) return
  stopping = true
  Object.assign(receipt, { status: code ? "FAILED_RETAINED_NO_AUTOMATIC_RETRY" : "STOPPED", stoppedAt: new Date().toISOString() })
  save()
  server.closeAllConnections()
  server.close(() => process.exit(code))
  setTimeout(() => process.exit(code), 3000).unref()
}
process.once("SIGTERM", () => stop(0))
process.once("SIGINT", () => stop(0))
try {
  await new Promise((done, reject) => server.once("error", reject).listen(port, "127.0.0.1", done))
  // Self-check trusts only the declared certificate, never the bundled or system roots.
  const selfCheck = await new Promise((done, reject) => {
    const check = tlsRequest(origin + "/auth/v1/health", { ca: certBytes, agent: false, timeout: 5000 }, response => {
      response.resume(); response.once("end", () => done(response.statusCode))
    })
    check.once("error", reject).once("timeout", () => check.destroy(new Error("TLS_SELF_CHECK_TIMEOUT"))).end()
  })
  assert.equal(selfCheck, 200, "TLS_SELF_CHECK_FAILED")
  Object.assign(receipt, { status: "READY_LOOPBACK_TLS_AUTH_FRONT", selfCheck: { trust: "DECLARED_CERTIFICATE_ONLY", status: selfCheck }, readyAt: new Date().toISOString() })
  save()
  console.log(JSON.stringify({ status: receipt.status, origin, certificateSha256: receipt.certificateSha256, spkiSha256: receipt.spkiSha256, state }))
} catch (error) {
  receipt.failure = /^[A-Z][A-Z0-9_]+$/.test(error?.message ?? "") ? error.message : error?.code ?? "TLS_FRONT_START_FAILED"
  console.error(receipt.failure)
  stop(1)
}
