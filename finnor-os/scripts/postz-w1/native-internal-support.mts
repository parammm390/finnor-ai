/** Disposable observers only. Selection, claims, grants and execution stay with
 * the original owners. Install the observer catalogue before fitting/compiling
 * any subject so that its fixed schema is part of every actual schema cut. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { receiveWork } from "@finnor/db";
import { PRODUCTION_JOB_CONTRACTS } from "../../packages/db/compute-contract";

export const INTERNAL_OPTIONS = {
  schema: "finnor.economic-orchestration-options.v1",
  purposeRef: "W1-original-native-internal-owner-journeys",
  populationRef: "W1-original-source-acceptance-and-existing-shared-grant",
  domainRef: "P1_LIABILITY_ARITHMETIC", responseRef: null, observationSplit: "TRAIN",
} as const;
export async function submitInternalSearch(http: any, f: any, programId = f.p.programId) {
  const response = await http.call("economic-orchestration-submit", {
    ...f.search, schema: "finnor.economic-orchestration-request.v1", programId,
    idempotencyKey: randomUUID(), orchestration: INTERNAL_OPTIONS,
  });
  assert.equal(response.status, 202, JSON.stringify(response));
  return response.body.searchId as string;
}
export async function siblingInternalProgramme(http: any, f: any,
  limits?: { deadlineMs: number }, operations?: unknown[]) {
  const instruction = f.request.instruction + (operations?.length ?
    " Additionally propose one model of the explicitly recorded arithmetic; no effect is authorized." : "");
  const work = await receiveWork({ tenantId: f.f.tenant, userId: f.f.principal,
    instruction, channel: "console", idempotencyKey: randomUUID() });
  const request = { ...f.request, instruction, workId: work.workId, workInputId: work.workInputId,
    idempotencyKey: randomUUID(), limits: { ...f.request.limits, ...limits },
    ...(operations ? { operations } : {}) };
  const response = await http.call("program-submit", request);
  assert.equal(response.status, 202, JSON.stringify(response));
  return { work, request, program: response.body };
}
export async function registerInternalHandlers(queue: any, sourceOnly = false) {
  queue.register("run_harness_program_v1",
    (await import("../../packages/private-equity/src/program-synthesis/worker")).runHarnessProgramJob,
    PRODUCTION_JOB_CONTRACTS.run_harness_program_v1);
  queue.register("run_evidence_derivation_v1",
    (await import("../../packages/private-equity/src/evidence-execution/worker")).runEvidenceDerivationJob,
    PRODUCTION_JOB_CONTRACTS.run_evidence_derivation_v1);
  if (!sourceOnly) queue.register("run_compute_search_unit_v1",
    (await import("../../packages/private-equity/src/compute-search/worker")).runComputeSearchUnitJob,
    PRODUCTION_JOB_CONTRACTS.run_compute_search_unit_v1);
}
/** Attempt every owned cleanup in dependency order, retaining a failed cleanup
 * as a failed journey rather than returning a previously constructed PASS. */
export async function closeInternalResources(report: any, closers: Array<() => unknown>) {
  const errors: string[] = [];
  for (const close of closers) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.resolve().then(close), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("W1_INTERNAL_OWNED_CLOSER_BOUND")), 60000);
      })]);
    } catch (error) { errors.push(String(error)); }
    finally { if (timer) clearTimeout(timer); }
  }
  report.cleanup = { status: errors.length ? "FAIL" : "PASS_OWNED_RESOURCES_CLOSED", errors };
  if (errors.length) {
    report.status = "FAIL";
    throw new AggregateError(errors, "W1_INTERNAL_OWNED_CLEANUP_FAILED");
  }
}
export async function waitInternalBackoff(e: any, queue: any, expires: number) {
  const next = (await e.admin.query(`SELECT extract(epoch FROM(min(run_at)-clock_timestamp()))*1000 wait_ms
    FROM finnor_os.jobs WHERE status='queued' AND type=ANY($1::text[])`, [queue.registeredTypes()])).rows[0];
  assert(next.wait_ms !== null, "Original owner must retain a scheduled continuation");
  const delay = Math.max(2050, Math.ceil(Number(next.wait_ms)));
  assert(Date.now() + delay < expires, "Original queued continuation exceeds the finite observer bound");
  await new Promise<void>(resolve => setTimeout(resolve, delay));
}
export async function stageInternalSources(e: any, queue: any, searchIds: string[], expires = Date.now() + 120000) {
  for (let decision = 0; decision < 128; decision++) {
    assert(Date.now() < expires, "Original finite source-stage observation bound");
    const rows = (await e.admin.query("SELECT id,status,context FROM finnor_os.p2_requests WHERE id=ANY($1::uuid[])", [searchIds])).rows;
    if (rows.length === searchIds.length && rows.every((row: any) => row.context)) return rows;
    assert(rows.every((row: any) => !["FAILED", "INVALIDATED", "CANCELLED"].includes(row.status)),
      "A failed original source stage is not a prepared native subject");
    if (!await queue.tick()) await waitInternalBackoff(e, queue, expires);
  }
  throw Error("W1_INTERNAL_ORIGINAL_SOURCE_DECISION_BOUND");
}
export async function internalOwnerCut(e: any, tenant: string) {
  const tables = ["works", "work_inputs", "p1_requests", "p1_episodes", "p1_events",
    "p2_requests", "p2_units", "p2_attempts", "p2_events", "p2_grant_usage",
    "s5_reservations", "jobs", "job_delivery_attempts", "w1_capsules", "w1_invalidations",
    "w1_response_states", "w1_continuation_states", "w1_development_checks"];
  const cut: Record<string, any> = {
    observedAt: (await e.admin.query("SELECT clock_timestamp()::text at")).rows[0].at,
  };
  // Keep exact PostgreSQL timestamp text in JSON, not JS Date millisecond cuts.
  for (const table of tables) cut[table] = (await e.admin.query(
    "SELECT to_jsonb(r) body FROM finnor_os." + table +
    " r WHERE tenant_id=$1 ORDER BY to_jsonb(r)::text", [tenant])).rows.map((row: any) => row.body);
  cut.leases = (await e.admin.query(`SELECT to_jsonb(r) body FROM finnor_os.compute_resource_leases r
    WHERE tenant_key=$1 ORDER BY acquired_at,id`, [tenant])).rows.map((row: any) => row.body);
  cut.physicalPolicies = (await e.admin.query(`SELECT to_jsonb(r) body FROM finnor_os.compute_resource_policies r
    WHERE resource_key='native:p2'`)).rows.map((row: any) => row.body);
  return cut;
}
export async function committedEventObserver(e: any) {
  const suffix = randomUUID().replaceAll("-", ""), table = "w1_fixture_observer_" + suffix;
  const fn = table + "_notify", trigger = table + "_trigger";
  const listener = new pg.Client({ connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 10000, query_timeout: 10000 });
  const dropCatalogue = async () => {
    const outcome: any = {};
    await closeInternalResources(outcome, [
      () => e.admin.query(`DROP TRIGGER IF EXISTS ${trigger} ON finnor_os.p2_events`),
      () => e.admin.query(`DROP FUNCTION IF EXISTS finnor_os.${fn}()`),
      () => e.admin.query(`DROP TABLE IF EXISTS finnor_os.${table}`),
    ]);
  };
  try {
    await e.admin.query(`CREATE TABLE finnor_os.${table}(
    channel text PRIMARY KEY,tenant_id uuid NOT NULL,search_id uuid NOT NULL,event_kind text NOT NULL,
    boundary text,unit_kind text,active boolean NOT NULL DEFAULT true)`);
  await e.admin.query(`CREATE FUNCTION finnor_os.${fn}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
    SET search_path=pg_catalog,finnor_os AS $observer$
    DECLARE target record;
    BEGIN
      FOR target IN SELECT * FROM finnor_os.${table} o WHERE o.active AND o.tenant_id=NEW.tenant_id
        AND o.search_id=NEW.search_id AND o.event_kind=NEW.kind
        AND (o.boundary IS NULL OR o.boundary=NEW.body->>'boundary')
        AND (o.unit_kind IS NULL OR EXISTS(SELECT 1 FROM finnor_os.p2_units u
          WHERE u.tenant_id=NEW.tenant_id AND u.search_id=NEW.search_id
            AND u.id::text=NEW.body->>'unitId' AND u.kind=o.unit_kind))
      LOOP
        UPDATE finnor_os.${table} SET active=false WHERE channel=target.channel;
        PERFORM pg_notify(target.channel,json_build_object('eventId',NEW.id,'searchId',NEW.search_id,
          'kind',NEW.kind,'boundary',NEW.body->>'boundary','unitId',NEW.body->>'unitId')::text);
      END LOOP;
      RETURN NEW;
    END $observer$`);
  await e.admin.query(`CREATE TRIGGER ${trigger} AFTER INSERT ON finnor_os.p2_events
    FOR EACH ROW EXECUTE FUNCTION finnor_os.${fn}()`);
    await listener.connect();
  } catch (error) {
    const cleanup: any = {};
    await closeInternalResources(cleanup, [() => listener.end(), dropCatalogue]);
    throw error;
  }
  const active = new Map<string, any>();
  listener.on("notification", notification => {
    const watch = active.get(notification.channel);
    if (!watch || watch.receipt || watch.closed) return;
    try {
      const event = JSON.parse(notification.payload ?? "{}");
      assert.equal(event.searchId, watch.searchId);
      // No arbitrary PID parameter: the original launcher attests this exact
      // child and its parent before the notification can signal it.
      assert.equal(watch.queue.pid, watch.queue.identity.pid);
      assert.equal(watch.queue.identity.parentPid, process.pid);
      process.kill(watch.queue.pid, "SIGSTOP");
      watch.stopped = true;
      watch.receipt = { event, pid: watch.queue.pid, parentPid: process.pid,
        pausedAt: new Date().toISOString(), originalClocksContinue: true };
      clearTimeout(watch.timer); watch.resolve(watch.receipt);
    } catch (error) {
      if (watch.stopped) {
        try { process.kill(watch.queue.pid, "SIGCONT"); }
        catch (resumeError) { error = new AggregateError([error, resumeError], "OWNED_OBSERVER_RESUME_FAILED"); }
        finally { watch.stopped = false; }
      }
      clearTimeout(watch.timer); watch.reject(error);
    }
  });
  return {
    catalogue: { table, fn, trigger, scope: "DISPOSABLE_COMMITTED_EVENT_OBSERVER_NO_OWNER_REPLACEMENT" },
    async arm(queue: any, criterion: { tenantId: string; searchId: string; kind: string; boundary?: string; unitKind?: string }) {
      const channel = "w1_pause_" + randomUUID().replaceAll("-", "");
      let resolve!: (v: any) => void, reject!: (e: unknown) => void;
      const paused = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
      // The rejection is still awaited by drive(); this avoids an unhandled
      // rejection while an earlier actual queue delivery is settling.
      void paused.catch(() => undefined);
      const watch: any = { ...criterion, queue, resolve, reject, receipt: null, closed: false,
        timer: setTimeout(() => reject(Error("W1_ACTUAL_COMMITTED_PAUSE_NOT_OBSERVED")), 120000) };
      active.set(channel, watch);
      let inFlight: Promise<unknown> | null = null;
      const handle = {
        async drive() {
          const expires = Date.now() + 120000;
          for (let decision = 0; decision < 128; decision++) {
            if (watch.receipt) return watch.receipt;
            assert(Date.now() < expires, "Finite original owner observation bound");
            const tick: Promise<unknown> = queue.tick();
            inFlight = tick;
            const result = await Promise.race([paused.then(receipt => ({ receipt })),
              tick.then(ran => ({ ran }))]);
            if ("receipt" in result) return result.receipt;
            inFlight = null;
            if (!result.ran) await waitInternalBackoff(e, queue, expires);
          }
          throw Error("W1_ACTUAL_PAUSE_ORIGINAL_DECISION_BOUND");
        },
        receipt: () => watch.receipt,
        async release() {
          if (watch.closed) return;
          watch.closed = true; clearTimeout(watch.timer);
          // Resume before any fallible/database cleanup. Never leave an owned
          // stopped child dependent on a successful observer-table UPDATE.
          let resumeFailure: unknown;
          if (watch.stopped) {
            try {
              process.kill(queue.pid, "SIGCONT");
              if (watch.receipt) watch.receipt.resumedAt = new Date().toISOString();
            } catch (error) { resumeFailure = error; }
            finally { watch.stopped = false; }
          } else reject(Error("W1_OWNED_OBSERVER_CLOSED_WITHOUT_PAUSE"));
          const cleanup: any = {};
          try {
            await closeInternalResources(cleanup, [
              () => { if (resumeFailure) throw resumeFailure; },
              () => e.admin.query(`UPDATE finnor_os.${table} SET active=false WHERE channel=$1`, [channel]),
              async () => {
                if (!inFlight) return;
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                  await Promise.race([inFlight, new Promise<never>((_, no) => {
                    timer = setTimeout(() => no(Error("W1_RESUMED_OWNED_TICK_SETTLEMENT_BOUND")), 30000);
                  })]);
                } catch (error) {
                  // No abandoned SQL/IPC promise: terminate only this attested
                  // child, await its exit and settle the original tick.
                  try { await queue.close(); } finally { await Promise.allSettled([inFlight]); }
                  throw error;
                } finally { if (timer) clearTimeout(timer); }
              },
              () => listener.query("UNLISTEN " + channel),
            ]);
          } finally { active.delete(channel); }
        },
      };
      watch.release = handle.release;
      try {
        await listener.query("LISTEN " + channel);
        await e.admin.query(`INSERT INTO finnor_os.${table}(channel,tenant_id,search_id,event_kind,boundary,unit_kind)
          VALUES($1,$2,$3,$4,$5,$6)`, [channel, criterion.tenantId, criterion.searchId, criterion.kind,
          criterion.boundary ?? null, criterion.unitKind ?? null]);
      } catch (error) { await handle.release(); throw error; }
      return handle;
    },
    async close() {
      const cleanup: any = {};
      await closeInternalResources(cleanup, [
        ...[...active.values()].map(watch => () => watch.release()),
        () => listener.end(), dropCatalogue,
      ]);
      assert.equal(active.size, 0, "Every armed owned pause must be released before observer close");
    },
  };
}
