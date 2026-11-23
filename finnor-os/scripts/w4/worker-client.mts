import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import type { WorkerObservation } from "./worker.mjs";

export function createNativeWorkerClient(input: {
  workspace: string; databaseUrl: string; checkBound(): void; recoverWorkflowSteps?: boolean;
}) {
  let processHandle: ChildProcess | undefined;
  let closed: Promise<boolean> | undefined;
  let ready = false, running = false, log = "";

  const start = () => {
    const child = spawn(process.execPath, ["--max-old-space-size=1536", "--import=tsx", "scripts/w4/worker.mts",
      ...(input.recoverWorkflowSteps ? ["--recover-workflow-steps"] : [])], {
      cwd: input.workspace, env: { ...process.env, DATABASE_URL: input.databaseUrl },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const capture = (bytes: Buffer) => {
      log += bytes.toString();
      if (log.length > 4 * 1024 * 1024) child.kill("SIGKILL");
    };
    child.stdout!.on("data", capture);
    child.stderr!.on("data", capture);
    child.on("error", error => capture(Buffer.from(error.message)));
    closed = new Promise<boolean>(resolve => child.once("close", (code, signal) => resolve(code === 0 && signal === null)));
    return child;
  };

  return {
    async tick(maximum: number, signal?: AbortSignal) {
      input.checkBound(); signal?.throwIfAborted();
      assert(Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 16, "W4_WORKER_TICK_BOUND");
      assert(!running, "W4_ONE_ACTUAL_WORKER_BATCH_AT_A_TIME");
      log = "";
      const child = processHandle ??= start();
      assert(child.pid && child.connected && child.exitCode === null && child.signalCode === null, "W4_OWNED_WORKER_NOT_RUNNING");
      running = true;
      try {
        const observations = await new Promise<WorkerObservation[]>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            child.off("message", message); child.off("error", fail); child.off("exit", exit);
            signal?.removeEventListener("abort", abort);
          };
          const fail = (error: unknown) => { cleanup(); reject(error); };
          const exit = () => fail(Error("W4_OWNED_WORKER_EXITED"));
          const abort = () => { child.kill("SIGKILL"); fail(signal?.reason ?? Error("W4_WORKER_ABORTED")); };
          const send = () => child.send(maximum, error => { if (error) fail(error); });
          const message = (result: unknown) => {
            if (!ready && result === "ready") { ready = true; send(); }
            else if (ready && Array.isArray(result)) { cleanup(); resolve(result); }
            else fail(Error("W4_INVALID_WORKER_REPLY"));
          };
          const timer = setTimeout(() => { child.kill("SIGKILL"); fail(Error("W4_WORKER_TIME_BOUND")); }, 60_000);
          child.on("message", message); child.once("error", fail); child.once("exit", exit);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          else if (ready) send();
        });
        signal?.throwIfAborted();
        assert(observations.length >= 1 && observations.length <= maximum, "W4_ACTUAL_WORKER_OBSERVATIONS_REQUIRED");
        for (const [ordinal, observed] of observations.entries()) {
          assert.equal(observed.schema, "finnor.w4.worker-observation.v1");
          assert.equal(observed.pid, child.pid);
          assert.equal(observed.role.current_user, "finnor_worker");
          assert.equal(observed.role.rolsuper, false); assert.equal(observed.role.rolbypassrls, false);
          assert.equal(observed.registration, "ACTUAL_PRODUCTION_CREATE_WORKER");
          assert.equal(observed.tick, ordinal); assert.equal(typeof observed.worked, "boolean");
        }
        return { pid: child.pid, observations, ticks: observations.length, log };
      } finally { running = false; }
    },
    async close(): Promise<boolean> {
      const child = processHandle;
      if (!child || !closed) return true;
      if (child.exitCode !== null || child.signalCode !== null) return closed;
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try {
        if (child.connected) child.send("stop", error => { if (error) child.kill("SIGKILL"); });
        return await closed;
      } finally { clearTimeout(timer); }
    },
    lastLog: () => log,
  };
}
