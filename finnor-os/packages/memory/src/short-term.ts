// Short-term memory: principal-scoped Redis sessions, TTL 30 minutes (§10).

import { setTimeout } from "node:timers/promises";
import Redis from "ioredis";
import { z } from "zod";

const TTL_SECONDS = 30 * 60;
const MAX_SHORT_TERM_TURNS = 20;
const MAX_APPEND_ATTEMPTS = 64;
const ShortTermSchema = z.record(z.unknown());
const COMPARE_AND_SET = `
local current = redis.call('GET', KEYS[1])
if ARGV[1] == 'missing' then
  if current ~= false then return 0 end
elseif current ~= ARGV[2] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return 1
`;

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
    // Callers already treat short-term memory as best-effort and fall back to
    // durable memory. Consume connection errors here so ioredis does not emit an
    // unhandled-error warning for every serverless invocation during an outage.
    redis.on("error", () => undefined);
  }
  return redis;
}

function key(tenantId: string, employeeId: string, sessionId: string): string {
  return `stm:${tenantId}:${employeeId}:${sessionId}`;
}

export async function writeShortTerm(
  tenantId: string,
  employeeId: string,
  sessionId: string,
  data: Record<string, unknown>,
): Promise<void> {
  await getRedis().set(key(tenantId, employeeId, sessionId), JSON.stringify(data), "EX", TTL_SECONDS);
}

export async function readShortTerm(
  tenantId: string,
  employeeId: string,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const raw = await getRedis().get(key(tenantId, employeeId, sessionId));
  return raw === null ? null : ShortTermSchema.parse(JSON.parse(raw));
}

export async function appendShortTerm(
  tenantId: string,
  employeeId: string,
  sessionId: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const client = getRedis();
  const sessionKey = key(tenantId, employeeId, sessionId);
  const encodedEntry = JSON.stringify(entry);
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt += 1) {
    const raw = await client.get(sessionKey);
    const existing = raw === null ? {} : ShortTermSchema.parse(JSON.parse(raw));
    const turns = Array.isArray(existing.turns) ? existing.turns.slice() : [];
    if (JSON.stringify(turns.at(-1)) !== encodedEntry) turns.push(entry);
    const next = JSON.stringify({ ...existing, turns: turns.slice(-MAX_SHORT_TERM_TURNS) });
    // Compare raw bytes so JSON remains lossless in JavaScript. The Redis script
    // changes the value and TTL only if no other process has changed this cut.
    const written = await client.eval(COMPARE_AND_SET, 1, sessionKey,
      raw === null ? "missing" : "present", raw ?? "", next, TTL_SECONDS);
    if (written === 1) return;
    await setTimeout(Math.min(25, attempt + 1));
  }
  throw new Error("Short-term memory append contention exceeded its retry bound");
}

export async function closeShortTerm(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
