import {env as runtimeEnvironment} from 'node:process';
import { SecretsManagerClient, CreateSecretCommand, GetSecretValueCommand, PutSecretValueCommand } from "@aws-sdk/client-secrets-manager";

type Provider = "env" | "aws-secrets-manager";
let initialization: Promise<void> | null = null;
let loadedAt = 0;
type SecretReferenceReader = (secretId: string, version?: string) => Promise<Record<string, string>>;
let secretReferenceReaderOverride: SecretReferenceReader | null = null;

function provider(): Provider {
  return process.env.SECRETS_PROVIDER === "aws-secrets-manager" ? "aws-secrets-manager" : "env";
}

function mappings(): Record<string, string> {
  const raw = process.env.FINNOR_SECRET_IDS ?? "{}";
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("must be an object");
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch (error) {
    throw new Error(`FINNOR_SECRET_IDS is invalid JSON: ${(error as Error).message}`);
  }
}

function isRetryableAwsError(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? "";
  // Access/not-found problems never resolve on retry — fail fast instead of burning
  // 3 attempts (~1.75s of backoff) on a guaranteed-to-fail call, same reasoning as
  // packages/tools/src/wrap.ts's IntegrationError.retryable distinction.
  return !/AccessDenied|ResourceNotFoundException|InvalidRequestException|DecryptionFailure/.test(name);
}

function versionSelector(version?: string): { VersionId?: string; VersionStage?: string } {
  if (!version) return {};
  if (version.startsWith("id:")) return { VersionId: version.slice(3) };
  return { VersionStage: version.startsWith("stage:") ? version.slice(6) : version };
}

async function readAwsSecretOnce(client: SecretsManagerClient, secretId: string, version?: string): Promise<Record<string, string>> {
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId, ...versionSelector(version) }));
  const raw = response.SecretString ?? (response.SecretBinary ? Buffer.from(response.SecretBinary as Uint8Array).toString("utf8") : "");
  if (!raw) throw new Error(`Secret ${secretId} had no value`);
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && !Array.isArray(value) && typeof value === "object") {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
  } catch {
    // Single-value secrets are supported below.
  }
  return { value: raw };
}

/** 3 attempts, exponential backoff + jitter — same shape as packages/tools/src/wrap.ts's
 *  wrappedCall, so this codebase has exactly one retry convention, not two. */
async function readAwsSecret(client: SecretsManagerClient, secretId: string, version?: string): Promise<Record<string, string>> {
  const attempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await readAwsSecretOnce(client, secretId, version);
    } catch (err) {
      lastErr = err;
      if (!isRetryableAwsError(err) || attempt === attempts) break;
      const jitter = Math.random() * 100;
      await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1) + jitter));
    }
  }
  throw lastErr;
}

/** Read one opaque AWS secret reference without mutating process.env. Tenant-scoped
 * credential resolution uses this path; ensureSecretsLoaded remains the explicit
 * legacy/system bootstrap for process-wide infrastructure secrets. */
export async function readAwsSecretReference(secretId: string, version?: string): Promise<Record<string, string>> {
  if (secretReferenceReaderOverride) return secretReferenceReaderOverride(secretId, version);
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? process.env.AWS_BEDROCK_REGION ?? "us-east-1" });
  return readAwsSecret(client, secretId, version);
}

export function setAwsSecretReaderForTesting(reader: SecretReferenceReader | null): void {
  secretReferenceReaderOverride = reader;
}

type SecretWriter = (secretId: string, value: Record<string, string>) => Promise<string>;
let secretWriterOverride: SecretWriter | null = null;

/** Create or rotate one tenant-scoped JSON secret and return an immutable VersionId.
 * Secret values never enter logs or Postgres. AccessDenied and malformed requests
 * fail closed; only ResourceNotFound selects the create path. */
export async function writeAwsSecretReference(secretId: string, value: Record<string, string>): Promise<string> {
  if (!secretId.trim() || Object.keys(value).length === 0 || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error("A non-empty managed-secret reference and string bundle are required");
  }
  if (secretWriterOverride) return secretWriterOverride(secretId, value);
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? process.env.AWS_BEDROCK_REGION ?? "us-east-1" });
  const SecretString = JSON.stringify(value);
  try {
    const response = await client.send(new PutSecretValueCommand({ SecretId: secretId, SecretString }));
    if (!response.VersionId) throw new Error("Secrets Manager did not return a version id");
    return response.VersionId;
  } catch (error) {
    if ((error as { name?: string }).name !== "ResourceNotFoundException") throw error;
    const response = await client.send(new CreateSecretCommand({ Name: secretId, SecretString }));
    if (!response.VersionId) throw new Error("Secrets Manager did not return a version id");
    return response.VersionId;
  }
}

export function setAwsSecretWriterForTesting(writer: SecretWriter | null): void {
  secretWriterOverride = writer;
}

/** Loads managed secrets into process memory only; never logs a secret value. */
export async function ensureSecretsLoaded(): Promise<void> {
  const refreshMs = Number(process.env.SECRET_REFRESH_MS ?? 300_000);
  if (initialization && Date.now() - loadedAt < refreshMs) return initialization;
  // Stamped BEFORE the fetch starts, not after it completes — a concurrent caller
  // arriving while this fetch is still in flight must see a "fresh enough" loadedAt
  // and join this SAME in-flight promise, rather than reading the still-zero/stale
  // loadedAt from a prior attempt and kicking off a second, redundant fetch.
  loadedAt = Date.now();
  initialization = (async () => {
    // A5.T3: dev-header auth is test/local-only. Treat *any* configured value as a
    // production configuration error rather than relying on a future parser to
    // interpret "0" or another non-empty value safely. API routes and the worker both
    // call this at their entry boundary, so neither can start under this posture.
    if (runtimeEnvironment.NODE_ENV === "production" && Object.hasOwn(process.env, "AUTH_DEV_BYPASS")) {
      console.error("[security] production refused: AUTH_DEV_BYPASS must be unset");
      throw new Error("Production refuses to boot while AUTH_DEV_BYPASS is configured");
    }
    if (provider() === "env") {
      if (runtimeEnvironment.NODE_ENV === "production" && process.env.ALLOW_PLAINTEXT_ENV_SECRETS !== "1") {
        // The only env-provider production path is a deliberate, noisy emergency
        // override. Normal production boot must prove its managed provider instead.
        console.error("[security] production refused: SECRETS_PROVIDER=aws-secrets-manager is required (set ALLOW_PLAINTEXT_ENV_SECRETS=1 only for an emergency override)");
        throw new Error("Production requires SECRETS_PROVIDER=aws-secrets-manager; ALLOW_PLAINTEXT_ENV_SECRETS=1 is the loud emergency override");
      }
      return;
    }
    const map = mappings();
    if (Object.keys(map).length === 0) throw new Error("SECRETS_PROVIDER=aws-secrets-manager requires FINNOR_SECRET_IDS");
    const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? process.env.AWS_BEDROCK_REGION ?? "us-east-1" });
    for (const [envName, secretId] of Object.entries(map)) {
      const secret = await readAwsSecret(client, secretId);
      const value = secret[envName] ?? secret.value;
      if (!value) throw new Error(`Managed secret ${secretId} did not contain ${envName}`);
      process.env[envName] = value;
    }
  })();
  try {
    await initialization;
  } catch (error) {
    initialization = null;
    loadedAt = 0; // failed load was never "fresh" — the next call must retry, not skip
    throw error;
  }
}

export function secretProviderStatus(): { provider: Provider; loaded: boolean; loadedAt: string | null } {
  return { provider: provider(), loaded: loadedAt > 0, loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null };
}
