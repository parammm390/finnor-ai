import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import {
  acquireComputeResourceLeases, releaseComputeResourceLeases, renewComputeResourceLeases,
  type ComputeResourceLease,
} from "@finnor/db";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { principal, tx } from "../evidence-execution/store";
import { R4_LIMITS } from "../../../shared-types/src/identification-plan";
import type { R4Profile, R4RunRow } from "./contracts";
import { hash, stable } from "./exact";
import { append, runRow, runtimeIdentity } from "./store";

const execute = promisify(execFile);
const supervisor = resolve(import.meta.dirname, "../../../epistemic-runtime/src/identification-plan/supervisor.py");

async function descendants(root: number) {
  const { stdout } = await execute("ps", ["-axo", "pid=,ppid=,rss="], { timeout: 1000, maxBuffer: 2 * 1024 * 1024 });
  const rows = stdout.trim().split("\n").map(s => s.trim().split(/\s+/).map(Number));
  const ids = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, parent] of rows) if (ids.has(parent!) && !ids.has(id!)) { ids.add(id!); changed = true; }
  }
  return { ids: [...ids], rss: rows.filter(([id]) => ids.has(id!)).reduce((n, r) => n + (r[2] ?? 0) * 1024, 0) };
}
async function update(ctx: PeMutationContext, run: R4RunRow, id: string, status: string, delta: any) {
  return tx(ctx, async c => {
    const row = (await c.query("SELECT body FROM finnor_os.r4_attempts WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR UPDATE",
      [ctx.auth.tenantId, principal(ctx), id])).rows[0];
    if (!row) throw Error("R4_DURABLE_NATIVE_ATTEMPT_MISSING");
    const body = { ...row.body, ...delta };
    await c.query("UPDATE finnor_os.r4_attempts SET status=$4,body=$5::jsonb,digest=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [ctx.auth.tenantId, principal(ctx), id, status, stable(body), hash(body)]);
    await append(ctx, run.id, "NATIVE_" + status, { attemptId: id, ...delta, costUSD: null }, c);
    return body;
  });
}

export async function nativeWork(ctx: PeMutationContext, p: R4Profile, run: R4RunRow,
  x: Readonly<JobExecutionContext>, kind: "PRODUCER" | "CHECKER", input: unknown) {
  let leases: ComputeResourceLease[] = [], child: ReturnType<typeof spawn> | null = null;
  let id: string | null = null;
  const original = await tx(ctx, async c => (await c.query(
    "SELECT deadline_at FROM finnor_os.r4_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
    [ctx.auth.tenantId, principal(ctx), run.episode_id])).rows[0], true);
  if (!original) throw Error("R4_ORIGINAL_EPISODE_REQUIRED");
  const originalDeadline = new Date(original.deadline_at).toISOString();
  const physicalDeadline = Math.min(Date.parse(originalDeadline), Date.now() + R4_LIMITS.nativeMs);
  if (physicalDeadline <= Date.now()) throw Error("R4_ORIGINAL_EPISODE_EXHAUSTED");
  const identity = await runtimeIdentity();
  try {
    leases = await acquireComputeResourceLeases({
      resourceKeys: ["native:r4", "native:r4-memory-1g"],
      requiredResourceKeys: ["native:r4", "native:r4-memory-1g"],
      tenantId: ctx.auth.tenantId, workloadClass: "INTERACTIVE", ownerId: `r4:${run.id}:${kind}:${x.deliveryAttemptId}`,
    });
    id = await tx(ctx, async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["s5-portfolio:" + ctx.auth.tenantId]);
      const locked = await runRow(ctx, run.id, c, true);
      if (locked.generation !== run.generation || locked.status !== "RUNNING" || locked.claim_token !== x.claimToken)
        throw Error("R4_NATIVE_RUN_FENCED");
      const job = (await c.query("SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 AND protocol_version=$5 FOR SHARE",
        [x.jobId, ctx.auth.tenantId, x.claimToken, x.claimFence, x.protocolVersion])).rows[0];
      if (!job) throw Error("R4_ACTUAL_QUEUE_CLAIM_REQUIRED");
      const s5 = p.ownerBinding.S5;
      const reservation = (await c.query("SELECT status,revocation_reason,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND allocation_digest=$2 FOR SHARE",
        [ctx.auth.tenantId, s5.allocationRef.contentDigest])).rows[0];
      if (!reservation || reservation.status === "RELEASED" || reservation.revocation_reason ||
          stable(reservation.envelopes.find((e: any) => e.resourceId === s5.resourceId)) !== stable(s5.envelope))
        throw Error("R4_S5_GRANT_REVOKED_OR_CHANGED");
      await c.query("INSERT INTO finnor_os.p2_grant_usage(tenant_id,principal_id,grant_digest,resource_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [ctx.auth.tenantId, principal(ctx), s5.allocationRef.contentDigest, s5.resourceId]);
      const debit = await c.query("UPDATE finnor_os.p2_grant_usage SET spent=spent+1 WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=$3 AND resource_id=$4 AND spent+1<=$5 RETURNING spent",
        [ctx.auth.tenantId, principal(ctx), s5.allocationRef.contentDigest, s5.resourceId, s5.capacity]);
      if (!debit.rowCount) throw Error("R4_ORIGINAL_S5_NATIVE_ENVELOPE_EXHAUSTED");
      const episode = await c.query("UPDATE finnor_os.r4_episodes SET native_used=native_used+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND native_used<max_native AND deadline_at>clock_timestamp() RETURNING id",
        [ctx.auth.tenantId, principal(ctx), run.episode_id]);
      if (!episode.rowCount) throw Error("R4_ORIGINAL_EPISODE_EXHAUSTED");
      const attemptId = randomUUID(), body = { kind, jobId: x.jobId, deliveryAttemptId: x.deliveryAttemptId,
        claimFence: x.claimFence, originalEpisode: run.episode_id, originalDeadline, physicalDeadline,
        inputDigest: hash(input), runtimeDigest: identity.digest, chargedNativeAttempts: 1,
        grantDigest: s5.allocationRef.contentDigest, leases, reservedAggregateBytes: 1024 ** 3, costUSD: null };
      await c.query("INSERT INTO finnor_os.r4_attempts(id,tenant_id,principal_id,run_id,delivery_id,claim_fence,kind,status,body,digest) VALUES($1,$2,$3,$4,$5,$6,$7,'INTENT',$8::jsonb,$9)",
        [attemptId, ctx.auth.tenantId, principal(ctx), run.id, x.deliveryAttemptId, x.claimFence, kind, stable(body), hash(body)]);
      await append(ctx, run.id, "NATIVE_ADMITTED", { attemptId, ...body }, c);
      return attemptId;
    });
    const began = performance.now();
    child = spawn(identity.python, ["-I", supervisor, kind.toLowerCase(), "--deadline", String(physicalDeadline)], {
      stdio: ["pipe", "pipe", "pipe"], detached: true,
      env: { PATH: process.env.PATH ?? "", NODE_ENV: process.env.NODE_ENV ?? "test", OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" },
    });
    child.on("error", () => undefined);
    if (!child.pid) throw Error("R4_NATIVE_PROCESS_START_FAILED");
    const pid = child.pid;
    let stdout = Buffer.alloc(0), stderr = "", peak = 0, totalProcessPeak = 0, monitors = 0;
    let stopped: string | null = null, monitoring: Promise<void> | null = null, killTimer: ReturnType<typeof setTimeout> | undefined;
    const terminate = (reason: string) => {
      if (stopped) return;
      stopped = reason;
      try { process.kill(-pid, "SIGTERM"); } catch { /* Already physically exited. */ }
      killTimer = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* Observed at close. */ } }, 500);
    };
    const finished = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((yes, no) => {
      child!.once("error", no);
      child!.once("close", (code, signal) => yes({ code, signal }));
    });
    await update(ctx, run, id, "SUBMITTED", { pid, acceptedAt: new Date().toISOString() });
    child.stdout!.on("data", (b: Buffer) => {
      if (stdout.length + b.length > R4_LIMITS.outputBytes + 1024 * 1024) return terminate("OUTPUT_BOUND_EXCEEDED");
      stdout = Buffer.concat([stdout, b]);
    });
    child.stderr!.on("data", (b: Buffer) => { if (stderr.length < 32768) stderr += b.toString(); });
    child.stdin!.on("error", () => terminate("NATIVE_INPUT_PIPE_FAILED"));
    child.stdin!.end(stable(input));
    const monitor = setInterval(() => {
      if (monitoring) return;
      monitoring = (async () => {
        monitors++;
        const state = await runRow(ctx, run.id);
        if (state.status !== "RUNNING" || state.generation !== run.generation) return terminate("CANCELLED_OR_INVALIDATED");
        if (Date.now() >= physicalDeadline) return terminate("ORIGINAL_NATIVE_DEADLINE_EXHAUSTED");
        if (!await renewComputeResourceLeases(leases)) return terminate("COMPUTE_LEASE_LOST");
        const usage = await descendants(pid);
        peak = Math.max(peak, usage.rss);
        totalProcessPeak = Math.max(totalProcessPeak, usage.rss + process.memoryUsage().rss);
        // The 512MiB limit is the scientific process-tree budget. The leased
        // 1GiB slot also reserves the worker's overhead, conservatively counted
        // again for every concurrent child rather than receiving a free pool.
        if (usage.rss > R4_LIMITS.memoryBytes || usage.rss + process.memoryUsage().rss > 1024 ** 3)
          terminate("AGGREGATE_RESERVED_NATIVE_MEMORY_EXCEEDED");
      })().catch(() => terminate("NATIVE_MONITOR_OR_CURRENTNESS_UNAVAILABLE")).finally(() => { monitoring = null; });
    }, 100);
    let ended;
    try { ended = await finished; }
    finally { clearInterval(monitor); if (monitoring) await monitoring; if (killTimer) clearTimeout(killTimer); }
    const parsed = !stopped && ended.code === 0 ? JSON.parse(stdout.toString()) : null;
    const receipt = { ...parsed?.receipt, pid: parsed?.receipt?.pid ?? pid, supervisorPid: pid,
      signal: ended.signal, exitCode: ended.code, terminationObserved: true,
      elapsedMs: performance.now() - began, peakRssBytes: Math.max(peak, parsed?.receipt?.peakRssBytes ?? 0),
      aggregateSampledPeakBytes: totalProcessPeak, monitorSamples: monitors, stdoutDigest: hash(stdout),
      stderrDigest: hash(stderr), termination: stopped ?? parsed?.receipt?.termination ?? "NATIVE_FAILED",
      costUSD: null, costQualification: "NATIVE_PHYSICAL_METERS_NO_DOLLAR_PRICEBOOK_OR_ALL_CONTAINER_BOUND" };
    const successful = parsed?.value && receipt.peakRssBytes <= R4_LIMITS.memoryBytes && receipt.termination === "RETURNED";
    await update(ctx, run, id, successful ? "COMPLETED" : "TERMINATED", receipt);
    if (!successful) throw Error("R4_" + receipt.termination);
    return { value: parsed.value, receipt, attemptId: id };
  } catch (error) {
    if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Close may have already reaped it. */ } }
    if (id) await update(ctx, run, id, "FAILED", { failure: "NATIVE_OR_OWNER_BOUNDARY_FAILED", costUSD: null }).catch(() => undefined);
    throw error;
  } finally {
    // A started child is not a released slot until its process close is observed.
    if (child?.pid && child.exitCode === null && child.signalCode === null)
      await new Promise<void>(yes => child!.once("close", () => yes()));
    await releaseComputeResourceLeases(leases, "r4-native-physically-finished");
  }
}
