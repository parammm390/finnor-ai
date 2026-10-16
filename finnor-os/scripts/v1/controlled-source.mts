/** Fixture administrator custody, not a producer or a protected S8 evaluator.
 * Keys never leave this process. Original interest follows actual SMTP bytes. */
import { createServer as httpServer } from "node:http";
import { createServer as smtpServer, type Socket } from "node:net";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  BilateralSourceReadSchema, BilateralTermsSchema, type BilateralCompanyRecord,
  type BilateralReply, type SignedBilateralReply, type SignedBilateralSnapshot, type SignedBilateralTransport,
} from "@finnor/shared-types";
import { canonical, digest } from "../../packages/governed-execution/src/canonical";
import { closingCanonical, closingDigest } from "../../packages/private-equity/src/closing/compiler";

if (!process.send || process.env.NODE_ENV !== "test" || !process.argv[2]) throw Error("SEPARATE_OWNED_SOURCE_REQUIRED");
const directory = process.argv[2], sourceKey = generateKeyPairSync("ed25519"), people = new Map<string, ReturnType<typeof generateKeyPairSync>>();
const publicPem = (key: ReturnType<typeof generateKeyPairSync>) => key.publicKey.export({ type: "spki", format: "pem" }).toString();
const signed = <T,>(body: T, key = sourceKey) => ({ body, signature: sign(null, Buffer.from(canonical(body)), key.privateKey).toString("base64") });
const controls = z.object({
  tenantId: z.string().uuid(), principalId: z.string().uuid(), buyerId: z.string().uuid(), companyId: z.string().uuid(),
  personId: z.string().uuid(), senderId: z.string().uuid(), sender: z.string().endsWith("@bilateral-fixture.invalid"),
  recipient: z.string().endsWith("@bilateral-fixture.invalid"), legalName: z.string(), expiresAt: z.string(),
  profileDigest: z.string(), candidateToken: z.string(), checkerToken: z.string(),
  mode: z.enum(["positive", "role", "identity-conflict", "wrong-buyer", "stale-interest", "generic-response", "wrong-terms",
    "out-of-bounds", "unknown-fit", "contradicted-fit", "already-active", "preexisting-process", "unresolved-origination",
    "incomplete-pipeline", "refusal", "unknown-transport", "no-response"]),
  acknowledgmentDelayMs: z.number().int().min(0).max(10000).default(0),
}).strict();
type Controls = z.infer<typeof controls>;
type Original = { config: Controls; snapshot: SignedBilateralSnapshot; events: SignedBilateralReply[]; transport: SignedBilateralTransport[] };
const configs = new Map<string, Controls>(), originals = new Map<string, Original>();
const calls: Array<Record<string, unknown>> = [], accepted: Array<Record<string, unknown>> = [], sockets = new Set<Socket>();
let loiConfig: { tenant: string; actorId: string; token: string; profiles: Array<{ id: string; digest: string }>; validUntil: string } | undefined;
function witness(record: string, fields: string[], scope: string[], value: unknown, at: string) {
  return { issuer: "Independent synthetic registry", system: "Fixture-administered original records", recordOrParticipantId: record,
    authenticatedChannel: "SEPARATE_SIGNED_LOOPBACK_ORIGINAL", exactFields: fields, authorityScope: scope,
    observedAt: at, effectiveAt: at, revision: "1", integrityWitness: digest(value) };
}
function snapshot(config: Controls, request: z.infer<typeof BilateralSourceReadSchema>): SignedBilateralSnapshot {
  const at = new Date().toISOString(), role = config.mode === "role" ? "BROKER" : "OWNER";
  const identityStatus = config.mode === "identity-conflict" ? "CONFLICTED" : "ESTABLISHED";
  const origination = config.mode === "preexisting-process" ? "PREEXISTING_PROCESS" : config.mode === "unresolved-origination" ? "UNRESOLVED" : "NO_KNOWN_PROCESS_AT_CUT";
  const fact = config.mode === "unknown-fit" ? null : config.mode === "contradicted-fit" ? "500" : "2500000";
  const representationActivities = role === "OWNER" ? ["CONSIDER_NONBINDING_TRANSACTION"] : [];
  const objectives = { majoritySaleConsidered: true, minimumRetainedBps: 2000, proposedManagementContinuityRequested: true,
    earliestClosingAt: null, latestClosingAt: null };
  const company: BilateralCompanyRecord = {
    companyId: config.companyId, legalName: config.legalName, identityStatus, counterpartyId: config.personId, role,
    representationActivities,
    companySource: witness(config.companyId, ["identity"], ["ESTABLISH_COMPANY_IDENTITY"],
      { companyId: config.companyId, legalName: config.legalName, identityStatus }, at),
    roleSource: witness(config.personId, ["role"], ["ESTABLISH_REPRESENTATION"],
      { companyId: config.companyId, counterpartyId: config.personId, role, representationActivities }, at),
    facts: { annualRevenueMinor: fact },
    factSources: { annualRevenueMinor: witness(config.companyId + ":revenue", ["annualRevenueMinor"], ["ESTABLISH_PRELIMINARY_FIELD"],
      { companyId: config.companyId, field: "annualRevenueMinor", value: fact, observedAt: at, revision: "1" }, at) },
    ownerObjectives: { ...objectives, source: witness(config.personId + ":objectives", ["objectives"], ["STATE_OWNER_OBJECTIVES"], objectives, at) },
    priorRelationshipEvidence: [], origination,
    originationEvidence: witness(config.companyId + ":process", ["origination"], ["ESTABLISH_PROCESS_AT_CUT"],
      { companyId: config.companyId, origination, priorRelationshipEvidence: [] }, at),
    participantPublicKeyPem: publicPem(people.get(config.personId)!),
  };
  const entries = config.mode === "already-active" ? [{ companyId: config.companyId, buyerEntityId: config.buyerId,
    canonicalOpportunityId: null, state: "qualified" }] : [];
  return signed({ schema: "finnor.bilateral-source-snapshot.v1", tenantId: config.tenantId, buyerEntityId: config.buyerId,
    mandateDigest: request.mandateDigest, eligibleCompanyIds: request.eligibleCompanyIds, universeDefinition: request.universeDefinition,
    knowledgeCut: at, companies: [company], sourceProfileDigest: config.profileDigest, expiresAt: config.expiresAt,
    pipeline: { coveredCompanyIds: [config.companyId], coveredBuyerEntityIds: [config.buyerId], authoritative: true,
      completeAuthorizedVisibility: config.mode !== "incomplete-pipeline", entries,
      source: witness("firm-pipeline:" + config.tenantId, ["pipeline"], ["COMPLETE_FIRM_PIPELINE"], entries, at) },
  } as SignedBilateralSnapshot["body"]);
}
function decodeMime(mime: string) {
  const split = mime.indexOf("\r\n\r\n");
  if (split < 0) throw Error("PHYSICAL_MIME_BODY_REQUIRED");
  const headers = mime.slice(0, split).replace(/\r\n[ \t]+/g, " ");
  const header = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "im").exec(headers)?.[1]?.trim();
  let body = mime.slice(split + 4);
  if (header("Content-Transfer-Encoding")?.toLowerCase() === "quoted-printable")
    body = Buffer.from(body.replace(/=\r\n/g, "").replace(/=([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))), "latin1").toString("utf8");
  else if (header("Content-Transfer-Encoding")?.toLowerCase() === "base64") body = Buffer.from(body, "base64").toString("utf8");
  return { from: header("From"), to: header("To"), subject: header("Subject"), messageId: header("Message-ID"), body: body.replace(/\r\n/g, "\n").replace(/\n$/, "") };
}
async function acceptMail(from: string, recipients: string[], mime: string) {
  const message = decodeMime(mime);
  const correlation = /Programme ([a-f0-9-]{36}); candidate ([a-f0-9-]{36}); action ([a-f0-9-]{36}); terms revision (\d+); terms digest ([a-f0-9]{64})\./.exec(message.body);
  const termsLine = /^Exact proposed terms \(amounts in currency minor units, not rounded execution amounts\): (.+)$/m.exec(message.body);
  if (!correlation || !termsLine || !message.subject || !message.messageId) throw Error("PHYSICAL_EXACT_MESSAGE_CORRELATION_REQUIRED");
  const [, programmeId, candidateId, actionId, revision, termsDigest] = correlation;
  const original = originals.get(programmeId!);
  if (!original) throw Error("PHYSICAL_ORIGINAL_PROGRAMME_REQUIRED");
  const config = original.config, terms = BilateralTermsSchema.parse(JSON.parse(termsLine[1]!)), now = new Date().toISOString();
  if (from !== config.sender || message.from !== from || recipients.length !== 1 || recipients[0] !== config.recipient ||
    message.to !== config.recipient || digest(terms) !== termsDigest || terms.companyId !== config.companyId || terms.buyerEntityId !== config.buyerId)
    throw Error("PHYSICAL_FROZEN_ENVELOPE_OR_TERMS_MISMATCH");
  const capture = { tenantId: config.tenantId, programmeId, candidateId, actionId, envelopeFrom: from, recipients, ...message,
    acceptedAt: now, mimeDigest: digest(mime), literalTransport: "LOOPBACK_SMTP_ACCEPTANCE_ONLY" };
  await appendFile(join(directory, "accepted.jsonl"), JSON.stringify(capture) + "\n", { mode: 0o600 });
  accepted.push(capture);
  original.transport.push(signed({
    schema: "finnor.bilateral-transport-observation.v1", tenantId: config.tenantId, programmeId: programmeId!,
    actionId: actionId!, companyId: config.companyId, participantId: config.personId, communicationIdentityId: config.senderId,
    provider: "gmail", contract: "DEVELOPMENT_SMTP_ACCEPTANCE_V1", meaning: "TRANSPORT_ACCEPTANCE_NOT_INTEREST_OR_RECIPIENT_DELIVERY",
    recipientAddressDigest: digest(config.recipient), senderAddressDigest: digest(config.sender),
    subjectDigest: digest(message.subject), bodyDigest: digest(message.body), outcome: "ACCEPTED",
    providerMessageRef: message.messageId, observedAt: now, expiresAt: config.expiresAt,
  }));
  const isConfirmation = message.subject.startsWith("Bilateral confirm ");
  if (config.mode !== "no-response") {
    let replyTerms = terms, kind: BilateralReply["kind"] = isConfirmation ? "INTEREST" : "COUNTERPROPOSAL";
    if (!isConfirmation) {
      replyTerms = { ...terms, controlShareBps: 6500, retainedShareBps: 3500, managementParticipationBps: 500 };
      if (config.mode === "out-of-bounds") replyTerms = { ...replyTerms, controlShareBps: 9500, retainedShareBps: 500 };
    }
    if (config.mode === "refusal") kind = "REFUSAL";
    if (isConfirmation && config.mode === "wrong-terms") replyTerms = { ...terms, controlShareBps: 6400, retainedShareBps: 3600 };
    const buyer = isConfirmation && config.mode === "wrong-buyer" ? randomUUID() : config.buyerId;
    const observedAt = isConfirmation && config.mode === "stale-interest" ? new Date(Date.now() - 3600000).toISOString() : new Date().toISOString();
    const replyDigest = digest(replyTerms);
    const body: BilateralReply = {
      schema: "finnor.bilateral-participant-event.v1", eventId: randomUUID(), tenantId: config.tenantId, programmeId: programmeId!,
      companyId: config.companyId, participantId: config.personId, buyerEntityId: buyer,
      channel: "AUTHENTICATED_DIRECT_RECORD_AND_PARTICIPANT_HTTP", actionId: actionId!, termsDigest: replyDigest, revision: Number(revision),
      kind, statement: kind === "REFUSAL" ? "No. Do not contact me again."
        : kind === "INTEREST" ? config.mode === "generic-response" ? "Thank you. I am happy to network."
          : `I confirm interest in considering the nonbinding transaction with buyer ${buyer} on terms ${replyDigest}.`
        : "I would consider a 65% majority sale, retaining 35%, with 5% management participation and the proposed continuity condition.",
      terms: kind === "REFUSAL" ? null : replyTerms,
      nextStep: kind === "INTEREST" ? { kind: "DILIGENCE_MEETING", agreedAt: observedAt,
        scheduledAt: new Date(Date.now() + 86400000).toISOString(), description: "Permitted preliminary diligence meeting, not a commitment." } : null,
      observedAt, expiresAt: config.expiresAt, direct: true,
    };
    original.events.push(signed(body, people.get(config.personId)!));
  }
  process.send!({ type: "accepted", programmeId, actionId, messageId: message.messageId });
  return { delayMs: config.acknowledgmentDelayMs, messageId: message.messageId };
}
const smtp = smtpServer(socket => {
  sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => undefined);
  socket.setTimeout(20000, () => socket.destroy());
  let pending = "", data = false, lines: string[] = [], from = "", recipients: string[] = [], processing = false, size = 0;
  socket.write("220 bilateral-fixture.invalid owned SMTP\r\n");
  async function consume() {
    if (processing) return;
    processing = true;
    try {
      for (;;) {
        const end = pending.indexOf("\r\n"); if (end < 0) break;
        const line = pending.slice(0, end); pending = pending.slice(end + 2);
        if (data) {
          if (line !== ".") { lines.push(line.startsWith("..") ? line.slice(1) : line); continue; }
          data = false;
          try {
            const result = await acceptMail(from, recipients, lines.join("\r\n") + "\r\n");
            if (result.delayMs) await new Promise(yes => setTimeout(yes, result.delayMs));
            socket.write("250 2.0.0 accepted " + result.messageId + "\r\n");
          } catch (error) {
            process.send!({ type: "physical-refusal", predicate: (error as Error).message });
            socket.write("550 Physical fixture predicate rejected\r\n");
          }
          lines = []; size = 0;
        } else if (/^(EHLO|HELO)\b/i.test(line)) socket.write("250 bilateral-fixture.invalid\r\n");
        else if (/^MAIL FROM:/i.test(line)) { from = /^MAIL FROM:\s*<([^>]+)>/i.exec(line)?.[1] ?? ""; recipients = []; socket.write("250 Sender\r\n"); }
        else if (/^RCPT TO:/i.test(line)) { recipients.push(/^RCPT TO:\s*<([^>]+)>/i.exec(line)?.[1] ?? ""); socket.write("250 Recipient\r\n"); }
        else if (line === "DATA") { data = true; lines = []; socket.write("354 End with dot\r\n"); }
        else if (line === "RSET") { lines = []; recipients = []; size = 0; socket.write("250 Reset\r\n"); }
        else if (line === "QUIT") { socket.end("221 Bye\r\n"); break; }
        else if (line === "NOOP") socket.write("250 OK\r\n");
        else socket.write("502 Unsupported owned SMTP command\r\n");
      }
    } finally { processing = false; if (pending.includes("\r\n")) void consume(); }
  }
  socket.on("data", chunk => { pending += chunk.toString("utf8"); size += chunk.length;
    if (size > 262144) { socket.destroy(); return; } void consume(); });
});
const http = httpServer(async (req, res) => {
  res.setHeader("content-type", "application/json"); res.setHeader("cache-control", "no-store");
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/loi-attest") {
      if (!loiConfig || req.headers.authorization !== "Bearer " + loiConfig.token) throw Error("LOI_SEPARATE_SCOPE_REQUIRED");
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16384) throw Error("LOI_REQUEST_BOUND"); }
      const { request, document: encoded } = JSON.parse(raw), bytes = Buffer.from(encoded, "base64");
      const document = JSON.parse(bytes.toString("utf8")), original = originals.get(document.programmeId);
      const interest = original?.events.at(-1)?.body;
      if (!original || interest?.kind !== "INTEREST" || document.schema !== "finnor.development-loi.v1"
          || document.companyId !== original.config.companyId || document.buyerId !== original.config.buyerId
          || document.opportunityId !== request.opportunityId || document.workId !== request.workId
          || document.workInputId !== request.expectedWorkInputId || document.investmentCaseId !== request.investmentCaseId
          || document.dealId !== request.deal.id
          || canonical(document.terms) !== canonical(interest.terms)
          || document.signedAt !== request.loi.signedAt
          || Date.parse(document.signedAt) > Date.now()
          || createHash("sha256").update(bytes).digest("hex") !== request.loi.documentDigest
          || !loiConfig.profiles.some(p => p.id === request.profileId && p.digest === request.expectedProfileDigest)
          || Date.parse(loiConfig.validUntil) <= Date.now()) throw Error("LOI_ACTUAL_ORIGINAL_AND_BYTES_REQUIRED");
      const body = { schema: "finnor.signed-loi-attestation.v1", purpose: "SIGNED_LOI_PROMOTION",
        environment: "DEVELOPMENT", tenantId: loiConfig.tenant, requestDigest: closingDigest(request),
        issuerId: "independent-loi-source", actorId: loiConfig.actorId, professionalScope: "signed-loi",
        channel: "separate-owned-loi-http", status: "CONFIRMED", observedAt: new Date().toISOString(),
        validUntil: loiConfig.validUntil };
      calls.push({ operation: "SIGNED_LOI_PROMOTION", programmeId: document.programmeId, requestDigest: body.requestDigest,
        documentDigest: request.loi.documentDigest, at: body.observedAt });
      res.end(JSON.stringify({ ...body, signature: sign(null, Buffer.from(closingCanonical(body)), sourceKey.privateKey).toString("base64") }));
      return;
    }
    if (req.method !== "GET" || url.pathname !== "/originals") throw Error("ORIGINAL_LITERAL_READ_ONLY");
    const encoded = url.searchParams.get("request");
    if (!encoded || encoded.length > 16384) throw Error("ORIGINAL_REQUEST_BOUND");
    const request = BilateralSourceReadSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    const config = configs.get(request.sourceProfileDigest), independent = request.operation === "CHECK_ORIGINALS";
    if (!config || req.headers.authorization !== "Bearer " + (independent ? config.checkerToken : config.candidateToken) ||
      request.tenantId !== config.tenantId || request.principalId !== config.principalId || request.buyerEntityId !== config.buyerId ||
      canonical(request.eligibleCompanyIds) !== canonical([config.companyId])) throw Error("ORIGINAL_INDEPENDENT_CREDENTIAL_AND_SCOPE_REQUIRED");
    calls.push({ programmeId: request.programmeId, operation: request.operation, independent, at: new Date().toISOString() });
    let original = originals.get(request.programmeId);
    if (!original) {
      if (request.operation !== "SNAPSHOT") throw Error("ORIGINAL_FROZEN_SNAPSHOT_REQUIRED");
      original = { config, snapshot: snapshot(config, request), events: [], transport: [] }; originals.set(request.programmeId, original);
    }
    if (original.snapshot.body.mandateDigest !== request.mandateDigest ||
      original.snapshot.body.sourceProfileDigest !== request.sourceProfileDigest) throw Error("ORIGINAL_FROZEN_BINDING_CHANGED");
    if (request.operation === "SNAPSHOT") res.end(JSON.stringify(original.snapshot));
    else if (request.operation === "EVENTS") res.end(JSON.stringify({ events: original.events }));
    else if (request.operation === "CHECK_ORIGINALS") res.end(JSON.stringify({
      snapshot: original.snapshot, events: original.events, transport: original.transport,
    }));
    else {
      const found = original.transport.find(t => t.body.actionId === request.actionId);
      if (!found) throw Error("ORIGINAL_PHYSICAL_MESSAGE_NOT_OBSERVED");
      res.end(JSON.stringify(config.mode === "unknown-transport" ? signed({ ...found.body, outcome: "UNKNOWN" as const }) : found));
    }
  } catch (error) { res.writeHead(403); res.end(JSON.stringify({ code: (error as Error).message })); }
});
const listen = (server: typeof smtp | typeof http) => new Promise<number>((yes, no) => {
  server.once("error", no); server.listen(0, "127.0.0.1", () => {
    const a = server.address(); if (!a || typeof a === "string") { no(Error("OWNED_SOURCE_PORT_REQUIRED")); return; } yes(a.port);
  });
});
const smtpPort = await listen(smtp), httpPort = await listen(http);
process.send({ type: "ready", smtpPort, origin: "http://127.0.0.1:" + httpPort, publicKeyPem: publicPem(sourceKey),
  custody: "SEPARATE_FIXTURE_ADMINISTRATOR_NOT_PROTECTED_DOMAIN_CUSTODY" });
process.on("message", (message: any) => {
  try {
    if (message.type === "configure") {
      const config = controls.parse(message.config);
      if (configs.has(config.profileDigest)) throw Error("ORIGINAL_ADMINISTRATOR_PROFILE_ALREADY_FROZEN");
      people.set(config.personId, generateKeyPairSync("ed25519")); configs.set(config.profileDigest, config);
      process.send!({ id: message.id, configured: true });
    } else if (message.type === "configure-loi") {
      if (loiConfig) throw Error("LOI_ORIGINAL_SCOPE_ALREADY_FROZEN");
      loiConfig = z.object({ tenant: z.string().uuid(), actorId: z.string().uuid(), token: z.string().min(24),
        profiles: z.array(z.object({ id: z.string(), digest: z.string().length(64) }).strict()).min(1).max(4),
        validUntil: z.string().datetime() }).strict().parse(message.config);
      process.send!({ id: message.id, configured: true });
    } else if (message.type === "inspect") process.send!({ id: message.id, accepted, calls,
      originals: [...originals].map(([programmeId, original]) => ({ programmeId, snapshot: original.snapshot, events: original.events, transport: original.transport })) });
    else if (message.type === "late-refusal") {
      const original = originals.get(message.programmeId), previous = original?.events.at(-1)?.body;
      if (!original || !previous) throw Error("ORIGINAL_PARTICIPANT_BRANCH_REQUIRED");
      const event = signed({ ...previous, eventId: randomUUID(), kind: "OPT_OUT" as const, statement: "Withdrawn. Do not contact me again.",
        observedAt: new Date().toISOString(), terms: null, nextStep: null }, people.get(original.config.personId)!);
      original.events.push(event); process.send!({ id: message.id, event });
    } else throw Error("ORIGINAL_ADMINISTRATOR_COMMAND_UNSUPPORTED");
  } catch (error) { process.send!({ id: message.id, failure: (error as Error).message }); }
});
const stop = () => { for (const socket of sockets) socket.destroy(); http.closeAllConnections(); smtp.close(); http.close(); process.exit(0); };
process.once("SIGTERM", stop); process.once("SIGINT", stop); process.once("disconnect", stop);
