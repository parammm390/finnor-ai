import { createHash, createHmac, createVerify, timingSafeEqual } from "node:crypto";
import { adminDb, webhookReceipts } from "@finnor/db";
import { logWithTrace } from "@finnor/tools";
import { verifyTimestampedHmacSignature } from "./verify-hmac-signature";

type Verify = (req: Request, rawBody: string, json: unknown) => boolean;

function constantTime(value: string, expected: string): boolean {
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function eventId(json: unknown, hash: string): string {
  const root = object(json);
  const data = object(root.data);
  const message = object(root.message);
  const call = object(message.call);
  for (const candidate of [
    root.webhookId,
    root.eventId,
    root.id,
    data.envelopeId,
    message.id,
    call.id,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 500);
  }
  return `body:${hash}`;
}

export function allowUnsignedOnlyInDevelopment(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function verifySharedSecret(req: Request, header: string, secret?: string): boolean {
  if (!secret) return allowUnsignedOnlyInDevelopment();
  return constantTime(req.headers.get(header) ?? "", secret);
}

export function verifyGhlSignature(req: Request, rawBody: string): boolean {
  const publicKey = process.env.GHL_WEBHOOK_PUBLIC_KEY;
  if (!publicKey) return allowUnsignedOnlyInDevelopment();
  const signature = req.headers.get("x-wh-signature");
  if (!signature) return false;
  try {
    return createVerify("RSA-SHA256").update(rawBody).verify(publicKey, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export function verifyDocusignSignature(req: Request, rawBody: string): boolean {
  const secret = process.env.DOCUSIGN_CONNECT_SECRET ?? process.env.RETIRED_WATER_WEBHOOK_SECRET;
  if (!secret) return allowUnsignedOnlyInDevelopment();
  const actual = Buffer.from(req.headers.get("x-docusign-signature-1") ?? "", "base64");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyPaymentSignature(req: Request, rawBody: string): boolean {
  if (req.headers.has("stripe-signature")) {
    return verifyTimestampedHmacSignature(req, {
      header: "stripe-signature",
      secret: process.env.STRIPE_WEBHOOK_SECRET ?? process.env.RETIRED_WATER_WEBHOOK_SECRET,
      rawBody,
      allowUnsetSecret: allowUnsignedOnlyInDevelopment(),
    });
  }
  return verifyTimestampedHmacSignature(req, {
    header: "x-payment-signature",
    secret: process.env.PAYMENT_EMULATOR_WEBHOOK_SECRET ?? process.env.RETIRED_WATER_WEBHOOK_SECRET,
    rawBody,
    allowUnsetSecret: allowUnsignedOnlyInDevelopment(),
  });
}

/**
 * Authenticate, receipt and quarantine a historical Water delivery. No tenant is
 * resolved and no domain row/job/event is created, so a replay can never resurrect
 * the retired vertical.
 */
export async function quarantineRetiredWaterWebhook(
  req: Request,
  provider: string,
  verify: Verify,
): Promise<Response> {
  const rawBody = await req.text();
  let json: unknown = null;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Malformed webhook" }, { status: 400 });
  }
  if (!verify(req, rawBody, json)) {
    logWithTrace({ route: `webhooks/${provider}` }).warn(
      { event: "webhook_signature_rejected", provider },
      "rejected retired Water webhook: bad signature",
    );
    return Response.json({ error: "Bad signature" }, { status: 401 });
  }
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  const id = eventId(json, payloadHash);
  const inserted = await adminDb().insert(webhookReceipts).values({
    provider: `retired_water:${provider}`,
    eventId: id,
    payloadHash,
  }).onConflictDoNothing({
    target: [webhookReceipts.provider, webhookReceipts.eventId],
  }).returning({ eventId: webhookReceipts.eventId });
  return Response.json({
    received: true,
    quarantined: true,
    duplicate: inserted.length === 0,
    vertical: "water",
    status: "retired",
  }, { status: 410 });
}
