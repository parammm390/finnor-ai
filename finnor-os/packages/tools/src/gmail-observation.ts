import { createHash } from "node:crypto";
import type { BusinessEffectSet, CanonicalSourceRecord, SourceSyncCursor, SourceSyncPage } from "@finnor/shared-types";
import type { SourceAdapter, SourceAdapterContext } from "./source-adapters";
import { IntegrationError } from "./errors";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const messageText = (value: string) => value.replaceAll("\r\n", "\n").replace(/\n$/, "");
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A readback target is bound to the immutable approved content and recipient,
 * never to a provider's success flag. Sent-mail evidence does not prove delivery. */
export function sentMessageObservationTarget(output: Record<string, unknown>, effect: BusinessEffectSet) {
  const values = effect.delta.values;
  if (effect.operation.name !== "send_message" || values.channel !== "email" || typeof output.messageId !== "string" || !output.messageId || typeof values.subject !== "string" || typeof values.body !== "string") return null;
  const recipient = object(values.recipient);
  const address = effect.before.find((snapshot) => snapshot.target.kind === "party" && snapshot.target.type === recipient.partyType && snapshot.target.id === recipient.partyId)?.values.businessEmail;
  if (typeof address !== "string" || !address) return null;
  return { objectType: "sent_message", externalId: output.messageId, expected: { sent: true, recipientHash: digest(address.trim().toLowerCase()), subjectHash: digest(values.subject), bodyHash: digest(messageText(values.body)) } };
}

export function sentMessageRecord(context: SourceAdapterContext, externalId: string, observed: { sent: boolean; to: string; subject: string; body: string; observedAt: string; messageId: string }): CanonicalSourceRecord {
  return { tenantId: context.tenantId, integrationId: context.integrationId, provider: "gmail", sourceScope: "sent_message_readback", externalObjectType: "sent_message", externalId, canonicalEntity: "communication_delivery", observedAt: observed.observedAt,
    data: { sent: observed.sent, recipientHash: digest(observed.to.trim().toLowerCase()), subjectHash: digest(observed.subject), bodyHash: digest(messageText(observed.body)), providerMessageId: observed.messageId, observationMeaning: "Sent message observed; recipient delivery is not established" }, ownership: { default: "external", direction: "inbound" } };
}

function headerText(value: string): string {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset: string, mode: string, encoded: string) => {
    const bytes = mode.toLowerCase() === "b" ? Buffer.from(encoded, "base64") : Buffer.from(encoded.replaceAll("_", " ").replace(/=([0-9a-f]{2})/gi, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1");
    try { return new TextDecoder(charset, { fatal: true }).decode(bytes); } catch { throw new IntegrationError("gmail", "Sent message header encoding cannot be verified", false, "validation"); }
  });
}

/** Bounded exact Gmail readback. This is a transport observation, with no domain
 * import, mailbox discovery, background sync, or recipient-delivery assertion. */
export class GmailSentMessageAdapter implements SourceAdapter {
  readonly provider = "gmail";
  readonly scopes = ["sent_message_readback"];
  observationTarget = sentMessageObservationTarget;
  isTerminalObservation(record: CanonicalSourceRecord): boolean { return record.data.sent === true; }
  async readPage(_scope: string, _cursor: SourceSyncCursor, _context: SourceAdapterContext): Promise<SourceSyncPage> { throw new IntegrationError("gmail", "Only exact sent-message readback is supported", false, "config"); }
  async readObject(objectType: string, externalId: string, context: SourceAdapterContext): Promise<CanonicalSourceRecord | null> {
    if (objectType !== "sent_message" || context.credentialContext.tenantId !== context.tenantId || context.credentialContext.provider !== "gmail") throw new IntegrationError("gmail", "Sent-message readback scope mismatch", false, "auth");
    const credentials = context.credentialContext.credentials as { authMethod?: string; accessToken?: string };
    if (credentials.authMethod !== "oauth2" || !credentials.accessToken) throw new IntegrationError("gmail", "Gmail OAuth read permission is required to verify sent mail", false, "auth");
    const read = async (path: string): Promise<Record<string, unknown> | null> => {
      const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${credentials.accessToken}` }, signal: AbortSignal.timeout(15_000), redirect: "error" });
      if (response.status === 404) return null;
      if (!response.ok) throw new IntegrationError("gmail", `Sent-message readback returned ${response.status}`, response.status === 429 || response.status >= 500, response.status === 401 || response.status === 403 ? "auth" : "provider_down");
      const bytes = await response.text();
      if (bytes.length > 300_000) throw new IntegrationError("gmail", "Sent-message readback exceeds its bound", false, "validation");
      return object(JSON.parse(bytes));
    };
    let id = externalId;
    if (externalId.startsWith("<") && externalId.endsWith(">")) {
      const listed = await read(`messages?maxResults=2&q=${encodeURIComponent(`in:sent rfc822msgid:${externalId.slice(1, -1)}`)}`);
      const matches = Array.isArray(listed?.messages) ? listed.messages : [];
      if (!matches.length) return null;
      if (matches.length !== 1 || typeof object(matches[0]).id !== "string") throw new IntegrationError("gmail", "Message-ID readback is ambiguous", false, "validation");
      id = String(object(matches[0]).id);
    }
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new IntegrationError("gmail", "Invalid provider message reference", false, "validation");
    const message = await read(`messages/${encodeURIComponent(id)}?format=full`);
    if (!message) return null;
    if (message.id !== id) throw new IntegrationError("gmail", "Provider message identity mismatch", false, "validation");
    const payload = object(message.payload), headers = Array.isArray(payload.headers) ? payload.headers.map(object) : [];
    const header = (name: string) => { const matches = headers.filter((row) => String(row.name).toLowerCase() === name); const value = matches[0]?.value; if (matches.length !== 1 || typeof value !== "string") throw new IntegrationError("gmail", `Sent message has no unambiguous ${name} header`, false, "validation"); return headerText(value); };
    const toHeader = header("to");
    // The active single-party action authorizes one recipient. Additional To,
    // Cc, or Bcc recipients cannot pass the same verification contract.
    if (headers.some((row) => ["cc", "bcc"].includes(String(row.name).toLowerCase()) && String(row.value ?? "").trim())) throw new IntegrationError("gmail", "Sent message has additional recipients", false, "validation");
    const address = /^[^<>]*<([^<>]+)>$/.exec(toHeader)?.[1] ?? toHeader;
    if (!/^[^\s,;<>]+@[^\s,;<>]+$/.test(address)) throw new IntegrationError("gmail", "Sent message recipient is not singular", false, "validation");
    let visited = 0;
    const textParts = (part: Record<string, unknown>, depth = 0): string[] => {
      if (++visited > 64 || depth > 8) throw new IntegrationError("gmail", "Sent-message MIME structure exceeds its bound", false, "validation");
      if (part.mimeType === "text/plain") { const body = object(part.body); if (typeof body.data !== "string") throw new IntegrationError("gmail", "Sent-message text is unavailable", false, "validation"); return [Buffer.from(body.data, "base64url").toString("utf8")]; }
      return Array.isArray(part.parts) ? part.parts.flatMap((child) => textParts(object(child), depth + 1)) : [];
    };
    const parts = textParts(payload);
    const body = parts[0];
    if (parts.length !== 1 || body === undefined || body.length > 100_002) throw new IntegrationError("gmail", "Sent-message text is not unambiguous", false, "validation");
    return sentMessageRecord(context, externalId, { sent: Array.isArray(message.labelIds) && message.labelIds.includes("SENT"), to: address, subject: header("subject"), body, observedAt: new Date().toISOString(), messageId: id });
  }
}
