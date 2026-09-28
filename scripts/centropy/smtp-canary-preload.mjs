import { createServer } from "node:net"
import { createServer as createHttpServer } from "node:http"
import { createRequire } from "node:module"
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { setEmailTransportForTesting } from "../../finnor-os/packages/tools/src/email.ts"
import { setSourceAdapterForTesting } from "../../finnor-os/packages/tools/src/source-adapters.ts"
import { sentMessageObservationTarget, sentMessageRecord } from "../../finnor-os/packages/tools/src/gmail-observation.ts"
import { assertDisposableDatabaseTarget } from "../../finnor-os/packages/db/production-target-guard.ts"

assertDisposableDatabaseTarget(process.env.DATABASE_URL, "CENTROPY loopback SMTP canary")
if (process.env.CENTROPY_SMTP_CANARY !== "1" || process.env.NODE_ENV === "production") throw new Error("SMTP capture is fixture-only")
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const stateDir = resolve(root, ".centropy-certification/atlas-temporal-clone/smtp")
const fixture = JSON.parse(readFileSync(resolve(stateDir, "../communication-fixture.json")))
if (fixture.fixtureOnly !== true || fixture.transport !== "loopback SMTP capture; not Gmail delivery") throw new Error("Authored communication fixture is missing")
mkdirSync(stateDir, { recursive: true, mode: 0o700 })
const nodemailer = createRequire(resolve(root, "finnor-os/package.json"))("nodemailer")
const server = createServer((socket) => {
  socket.setTimeout(20_000, () => socket.destroy())
  let pending = "", data = false, mime = [], from = "", recipients = []
  socket.write("220 centropy-certification.invalid SMTP capture\r\n")
  socket.on("data", (chunk) => {
    pending += chunk.toString("utf8")
    if (pending.length > 200_000) { socket.destroy(); return }
    for (;;) {
      const end = pending.indexOf("\r\n")
      if (end < 0) return
      const line = pending.slice(0, end); pending = pending.slice(end + 2)
      if (data) {
        if (line !== ".") { mime.push(line.startsWith("..") ? line.slice(1) : line); continue }
        const bytes = mime.join("\r\n") + "\r\n"
        const messageId = /^Message-ID:\s*(.+)$/im.exec(bytes)?.[1]?.trim()
        if (!messageId || !from.endsWith("@centropy-certification.invalid") || recipients.length !== 1 || recipients[0] !== "sarah@centropy-certification.invalid") { socket.write("550 Fixture envelope rejected\r\n"); data = false; continue }
        appendFileSync(resolve(stateDir, "accepted.jsonl"), JSON.stringify({ acceptedAt: new Date().toISOString(), from, recipients, messageId, mime: bytes, sha256: createHash("sha256").update(bytes).digest("hex"), fixtureOnly: true }) + "\n", { mode: 0o600 })
        data = false; mime = []
        socket.write(`250 2.0.0 accepted ${messageId}\r\n`)
      } else if (/^(EHLO|HELO)\b/i.test(line)) socket.write("250 centropy-certification.invalid\r\n")
      else if (/^MAIL FROM:/i.test(line)) { from = /^MAIL FROM:\s*<([^>]+)>/i.exec(line)?.[1] ?? ""; recipients = []; socket.write("250 Sender accepted\r\n") }
      else if (/^RCPT TO:/i.test(line)) { recipients.push(/^RCPT TO:\s*<([^>]+)>/i.exec(line)?.[1] ?? ""); socket.write("250 Recipient accepted\r\n") }
      else if (/^DATA$/i.test(line)) { data = true; mime = []; socket.write("354 End with dot\r\n") }
      else if (/^RSET$/i.test(line)) { from = ""; recipients = []; mime = []; socket.write("250 Reset\r\n") }
      else if (/^QUIT$/i.test(line)) { socket.end("221 Bye\r\n") }
      else if (/^NOOP$/i.test(line)) socket.write("250 OK\r\n")
      else socket.write("502 Unsupported capture command\r\n")
    }
  })
  socket.on("error", () => {})
})
if (process.env.CENTROPY_SMTP_CAPTURE_SERVER === "1") {
  await new Promise((ready, reject) => { server.once("error", reject); server.listen(3525, "127.0.0.1", ready) })
  const readback = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1:3526")
    if (request.method !== "GET" || url.pathname !== "/accepted-message") { response.writeHead(404).end(); return }
    const id = url.searchParams.get("messageId")
    const rows = (() => { try { return readFileSync(resolve(stateDir, "accepted.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) } catch { return [] } })()
    const matches = rows.filter((row) => row.messageId === id)
    response.setHeader("content-type", "application/json")
    response.setHeader("cache-control", "no-store")
    response.writeHead(matches.length === 1 ? 200 : matches.length === 0 ? 404 : 409).end(JSON.stringify(matches.length === 1 ? matches[0] : { error: "Exact captured message unavailable or ambiguous" }))
  })
  await new Promise((ready, reject) => { readback.once("error", reject); readback.listen(3526, "127.0.0.1", ready) })
}
setEmailTransportForTesting(nodemailer.createTransport({ host: "127.0.0.1", port: 3525, secure: false, ignoreTLS: true, connectionTimeout: 5_000, socketTimeout: 10_000 }))
setSourceAdapterForTesting("gmail", {
  provider: "gmail", scopes: ["sent_message_readback"], observationTarget: sentMessageObservationTarget,
  isTerminalObservation: (record) => record.data.sent === true,
  async readPage() { throw new Error("Canary supports only exact capture readback") },
  async readObject(objectType, externalId, context) {
    if (objectType !== "sent_message" || context.tenantId !== fixture.tenantId || context.integrationId !== "c0e00000-0000-4000-8000-000000000003" || context.config.fixtureOnly !== true) throw new Error("Canary readback scope mismatch")
    const response = await fetch(`http://127.0.0.1:3526/accepted-message?messageId=${encodeURIComponent(externalId)}`, { signal: AbortSignal.timeout(5_000), redirect: "error" })
    if (response.status === 404) return null
    if (!response.ok) throw new Error("Captured message readback is unavailable or ambiguous")
    const record = await response.json()
    if (record.fixtureOnly !== true || record.messageId !== externalId || record.sha256 !== createHash("sha256").update(record.mime).digest("hex")) throw new Error("Captured message hash or identity mismatch")
    const split = record.mime.indexOf("\r\n\r\n")
    if (split < 0) throw new Error("Captured MIME has no body")
    const headers = record.mime.slice(0, split).replace(/\r\n[ \t]+/g, " ")
    const header = (name) => new RegExp(`^${name}:\\s*(.+)$`, "im").exec(headers)?.[1]?.trim()
    let body = record.mime.slice(split + 4)
    if (header("Content-Transfer-Encoding")?.toLowerCase() === "quoted-printable") body = Buffer.from(body.replace(/=\r\n/g, "").replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), "latin1").toString("utf8")
    else if (header("Content-Transfer-Encoding")?.toLowerCase() === "base64") body = Buffer.from(body, "base64").toString("utf8")
    if (!header("Subject") || !header("To") || record.recipients.length !== 1 || record.recipients[0] !== header("To")) throw new Error("Captured recipient or content missing")
    const observed = sentMessageRecord(context, externalId, { sent: true, to: header("To"), subject: header("Subject"), body, observedAt: new Date().toISOString(), messageId: record.messageId })
    observed.provenance = { fixtureOnly: true, mechanism: "Independent loopback HTTP read of actual accepted SMTP MIME", mimeSha256: record.sha256 }
    observed.data.observationMeaning = "Loopback SMTP acceptance observed; real Gmail and recipient delivery are not established"
    return observed
  },
})
console.log("Fixture email transport connects only to 127.0.0.1:3525")
