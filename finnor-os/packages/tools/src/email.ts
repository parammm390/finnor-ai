// Real email via Gmail SMTP (nodemailer) — a genuine delivery channel that needs no
// paid plan or card. Transport is injectable so tests never send real mail.

import nodemailer, { type Transporter } from "nodemailer";
import { IntegrationError } from "./errors";
import type { TenantCredentialContext } from "@finnor/security";

export type GmailCredentialContext = TenantCredentialContext<"gmail">;

// The explicit testing seam must survive a Next server bundle boundary: the
// fixture bootstrap and an API route can load separate copies of this module.
const transportKey = Symbol.for("finnor.tools.testing.emailTransport");
const gmailFetchKey = Symbol.for("finnor.tools.testing.gmailFetch");
const testInjections = globalThis as unknown as Record<symbol, unknown>;
function transportOverride(): Transporter | null { return (testInjections[transportKey] as Transporter | undefined) ?? null; }
function fetchOverride(): typeof fetch | null { return (testInjections[gmailFetchKey] as typeof fetch | undefined) ?? null; }

/** Tests inject a stub transport here; production uses the governed Gmail context. */
export function setEmailTransportForTesting(t: Transporter | null): void {
  if (t) testInjections[transportKey] = t;
  else delete testInjections[transportKey];
}

export function setGmailFetchForTesting(value: typeof fetch | null): void {
  if (value) testInjections[gmailFetchKey] = value;
  else delete testInjections[gmailFetchKey];
}

function getTransporter(context: GmailCredentialContext): Transporter {
  const override = transportOverride();
  if (override) return override;
  if (context.credentials.authMethod !== "app_password" || !context.credentials.appPassword) {
    throw new IntegrationError("email", "Gmail SMTP app-password credentials are unavailable", false);
  }
  return nodemailer.createTransport({ service: "gmail", auth: { user: context.credentials.user, pass: context.credentials.appPassword } });
}

function safeHeader(value: string): string {
  if (/\r|\n/.test(value)) throw new IntegrationError("email", "Email headers cannot contain line breaks", false);
  return value;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function sendGmailApi(opts: { to: string; subject: string; body: string }, context: GmailCredentialContext): Promise<{ messageId: string }> {
  const token = context.credentials.accessToken;
  if (!token) throw new IntegrationError("email", "Gmail OAuth access token is unavailable", false, "auth");
  const raw = [
    `From: ${safeHeader(context.credentials.user)}`,
    `To: ${safeHeader(opts.to)}`,
    `Subject: ${safeHeader(opts.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    opts.body,
  ].join("\r\n");
  const response = await (fetchOverride() ?? fetch)("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: base64Url(raw) }),
  });
  const payload = await response.json().catch(() => ({})) as { id?: unknown };
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new IntegrationError("email", `Gmail API send failed with status ${response.status}`, retryable, response.status === 401 || response.status === 403 ? "auth" : retryable ? "provider_down" : "terminal");
  }
  if (typeof payload.id !== "string" || !payload.id) throw new IntegrationError("email", "Gmail API returned no message id", true);
  return { messageId: payload.id };
}

export async function sendEmail(opts: {
  tenantId: string;
  to: string;
  subject: string;
  body: string;
}, context: GmailCredentialContext): Promise<{ messageId: string }> {
  if (context.tenantId !== opts.tenantId) throw new IntegrationError("email", "Gmail credential context tenant mismatch", false);
  if (!transportOverride() && context.credentials.authMethod === "oauth2") {
    try {
      return await sendGmailApi(opts, context);
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      throw new IntegrationError("email", `send failed: ${(err as Error).message}`, true);
    }
  }
  const transporter = getTransporter(context);
  try {
    const info = await transporter.sendMail({
      from: context.credentials.user,
      to: opts.to,
      subject: opts.subject,
      text: opts.body,
    });
    return { messageId: String(info.messageId ?? "sent") };
  } catch (err) {
    throw new IntegrationError("email", `send failed: ${(err as Error).message}`, true);
  }
}

/** Verify SMTP credentials without sending anything. */
export async function verifyEmailTransport(context: GmailCredentialContext): Promise<boolean> {
  try {
    if (!transportOverride() && context.credentials.authMethod === "oauth2") {
      if (!context.credentials.accessToken) return false;
      const response = await (fetchOverride() ?? fetch)("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { authorization: `Bearer ${context.credentials.accessToken}` },
      });
      return response.ok;
    }
    await getTransporter(context).verify();
    return true;
  } catch {
    return false;
  }
}
