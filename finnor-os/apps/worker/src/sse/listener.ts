// B1.T1/T2 — the one dedicated, non-pooled LISTEN connection every 'jarvis_events'
// consumer in this process (the SSE gateway, the CQRS projector) shares. LISTEN/NOTIFY
// only ever reaches the specific backend connection that issued LISTEN — a pooled
// connection (transaction-mode PgBouncer/Supavisor, or even this app's own small
// session pool) can't be used for this at all, since the connection handing back the
// notification isn't guaranteed to be the one still held open by the caller (§10 risk
// note). POSTGRES_URL_NON_POOLING is preferred for exactly this reason — same env var
// convention packages/db/index.ts's getPool() already reads, just prioritized in the
// opposite order since this path specifically needs the direct connection, not
// whichever URL happens to be pooled.

import pg from "pg";
import { pgConnectionConfig } from "@finnor/db";
import { getLogger } from "@finnor/tools";
import type { CentropyEvent } from "@finnor/shared-types";

export type { CentropyEvent };

type Listener = (event: CentropyEvent) => void;

const CHANNEL = "jarvis_events";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

let client: pg.Client | null = null;
let stopped = false;
let reconnectAttempt = 0;
const subscribers = new Set<Listener>();

function listenUrl(): string {
  const url = process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL (or POSTGRES_URL_NON_POOLING) is not set — required for jarvis_events LISTEN");
  return url;
}

function handleNotification(msg: pg.Notification): void {
  if (msg.channel !== CHANNEL || !msg.payload) return;
  let event: CentropyEvent;
  try {
    event = JSON.parse(msg.payload) as CentropyEvent;
  } catch {
    getLogger().warn({ payload: msg.payload }, "[sse] malformed jarvis_events payload, dropped");
    return;
  }
  for (const sub of subscribers) sub(event);
}

async function connect(): Promise<void> {
  if (stopped) return;
  const c = new pg.Client(pgConnectionConfig(listenUrl()));
  client = c;
  c.on("notification", handleNotification);
  // A dedicated LISTEN connection dying is a background event with no other listener —
  // node-postgres's own guidance (packages/db/index.ts's pool 'error' handler has the
  // identical reasoning): let it recycle via reconnect, never crash the process.
  c.on("error", (err) => {
    getLogger().error({ err: err.message }, "[sse] jarvis_events LISTEN connection error, reconnecting");
    scheduleReconnect();
  });
  c.on("end", () => {
    if (!stopped) {
      getLogger().warn("[sse] jarvis_events LISTEN connection closed, reconnecting");
      scheduleReconnect();
    }
  });
  await c.connect();
  await c.query(`LISTEN ${CHANNEL}`);
  reconnectAttempt = 0;
  getLogger().info("[sse] listening on jarvis_events");
}

function scheduleReconnect(): void {
  if (stopped) return;
  const client_ = client;
  client = null;
  client_?.removeAllListeners();
  client_?.end().catch(() => undefined);
  reconnectAttempt += 1;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1));
  setTimeout(() => {
    connect().catch((err) => {
      getLogger().error({ err: err instanceof Error ? err.message : String(err) }, "[sse] jarvis_events reconnect failed");
      scheduleReconnect();
    });
  }, delay);
}

/** Call once at process startup. Idempotent — a second call is a no-op while already
 *  connected/connecting. */
export async function startCentropyEventListener(): Promise<void> {
  stopped = false;
  if (client) return;
  await connect();
}

export async function stopCentropyEventListener(): Promise<void> {
  stopped = true;
  const c = client;
  client = null;
  c?.removeAllListeners();
  await c?.end().catch(() => undefined);
}

/** Subscribe to every jarvis_events notification this process receives, regardless of
 *  tenant — callers (the SSE gateway, the projector) filter for what they care about.
 *  Returns an unsubscribe function. */
export function onCentropyEvent(listener: Listener): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}
