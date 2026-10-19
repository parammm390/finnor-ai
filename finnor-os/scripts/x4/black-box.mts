/**
 * DEVELOPMENT replica, not protected evaluator custody.
 *
 * Only the trusted test administrator imports this file. Candidate runtime gets
 * `runtime` and `calibrations`, never this module, config, storage or inspector.
 * There are no product imports and no terminal model/admission/effect insertions.
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, mkdir, mkdtemp, open, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CalibrationDescriptor, ObservationPage, ObservationRecord, OperationEvent,
  OperationReadback, Role, Trial, TrialRecord,
} from "./provider-contract.mjs";

export type BehaviorMode = "snapshot-request" | "snapshot-start" | "page-truncate"
  | "role-filter" | "combined" | "affine" | "unrepresentable";
export type InstrumentFault = "none" | "duplicate" | "missing" | "wrong-unit" | "stale" | "truncated" | "wrong-event";
export type StartOptions = {
  mode?: BehaviorMode;
  role?: Role;
  instrumentFault?: InstrumentFault;
  responseLossOnce?: boolean;
  failOnce?: boolean;
  observationDelayMs?: number;
  actualExposureMismatch?: boolean;
  slotMs?: number;
  hardWallMs?: number;
};
export type RuntimeEndpoint = {
  baseUrl: string;
  token: string;
  instanceId: string;
  applicationVersion: string;
  role: Role;
};
type Control = CalibrationDescriptor & {
  displayedPageCount?: number;
  surfaceFault?: "duplicate" | "stale" | "repeated-cursor" | "skipped-cursor";
  delayMs?: number;
};
type CaseFile = {
  revision: number;
  applicationVersion: string;
  surfacePageSize: number;
  cases: Control[];
};
type Config = Required<StartOptions> & {
  port?: number;
  instanceId: string;
  applicationVersion: string;
  token: string;
  adminToken: string;
  storageDirectory: string;
};
type StoredOperation = {
  readback: OperationReadback;
  requested: Trial;
  bodyHash: string;
  liveRecords: TrialRecord[];
  requestSnapshot: TrialRecord[];
  startSnapshot: TrialRecord[];
  output: ObservationRecord[];
  readableAt: string | null;
};
type AdminEvent = {
  sequence: number;
  type: string;
  at: string;
  operationId?: string;
  bodyHash?: string;
};
export type AdminSnapshot = {
  inspection?: "LIVE_ADMIN_HTTP" | "DURABLE_FILES_AFTER_EXIT";
  instanceId: string;
  applicationVersion: string;
  role: Role;
  pid: number;
  storageDirectory: string;
  postCount: number;
  acceptedCount: number;
  observationRequests: number;
  journal: AdminEvent[];
  operations: (StoredOperation & { durableJournal: OperationEvent[] })[];
};
export type BlackBox = {
  /** These and ONLY these fields may be supplied to the candidate broker. */
  runtime: RuntimeEndpoint;
  /** Public, known calibration expectations, filtered to the bound role. */
  calibrations: CalibrationDescriptor[];
  /** Fresh public inputs, NOT answers. Analyst baseline makes three explanations fit. */
  ordinaryTrial: Trial;
  /** Administrator-only closure; its bearer is not a return property. */
  readAdminState(): Promise<AdminSnapshot>;
  /** Graceful task-owned child shutdown; private durable files are retained. */
  close(): Promise<void>;
};

const modulePath = fileURLToPath(import.meta.url);
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const casesPath = fileURLToPath(new URL("../../../scope-x4/acceptance/provider-cases.json", import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 64 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
const MAX_LOG = 64 * 1024;
const MAX_INTEGER = 9007199254740991n;
const now = () => new Date().toISOString();
const clone = <T,>(value: T): T => structuredClone(value);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function requireNode22(): void {
  if (Number(process.versions.node.split(".")[0]) !== 22) throw new Error("fixture-requires-node22");
}
async function loadCases(): Promise<CaseFile> {
  const value = JSON.parse(await readFile(casesPath, "utf8")) as CaseFile;
  assert.equal(value.revision, 1);
  assert.equal(value.surfacePageSize, 2);
  assert.equal(value.applicationVersion, "x4-fixture-v1");
  return value;
}
async function atomicJSON(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
async function appendDurable(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally { await handle.close(); }
}
function normalizedOptions(options: StartOptions): Required<StartOptions> {
  const config: Required<StartOptions> = {
    mode: options.mode ?? "snapshot-request",
    role: options.role ?? "analyst",
    instrumentFault: options.instrumentFault ?? "none",
    responseLossOnce: options.responseLossOnce ?? false,
    failOnce: options.failOnce ?? false,
    observationDelayMs: options.observationDelayMs ?? 0,
    actualExposureMismatch: options.actualExposureMismatch ?? false,
    slotMs: options.slotMs ?? 60,
    hardWallMs: options.hardWallMs ?? 30000,
  };
  assert(["snapshot-request", "snapshot-start", "page-truncate", "role-filter", "combined", "affine", "unrepresentable"].includes(config.mode));
  assert(["analyst", "auditor"].includes(config.role));
  assert(["none", "duplicate", "missing", "wrong-unit", "stale", "truncated", "wrong-event"].includes(config.instrumentFault));
  assert(Number.isInteger(config.slotMs) && config.slotMs >= 20 && config.slotMs <= 250);
  assert(Number.isInteger(config.hardWallMs) && config.hardWallMs >= 2000 && config.hardWallMs <= 30000);
  assert(Number.isInteger(config.observationDelayMs) && config.observationDelayMs >= 0 && config.observationDelayMs <= 5000);
  for (const key of ["responseLossOnce", "failOnce", "actualExposureMismatch"] as const) assert.equal(typeof config[key], "boolean");
  return config;
}
async function boundedJSON<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`fixture-inspection-http-${response.status}`);
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_RESPONSE) {
      await reader.cancel();
      throw new Error("fixture-inspection-output-bound");
    }
    chunks.push(next.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

/** Reserve the exact endpoint/identity before intake, then start the same fixed
 * provider only when experiments begin. No scientific response is synthesized
 * by the reservation. Both metadata and the 30s entire-child bound stay fixed. */
export async function prepareBlackBox(options: StartOptions = {}): Promise<BlackBox & {start():Promise<void>}> {
  requireNode22();
  const settings = normalizedOptions(options), cases = await loadCases();
  const reservation = createServer((_req, res) => res.destroy());
  await new Promise<void>((yes, no) => { reservation.once("error", no); reservation.listen(0, "127.0.0.1", yes); });
  const address = reservation.address(); assert(address && typeof address === "object");
  const pin = {port: address.port, token: randomBytes(32).toString("hex"), instanceId: randomUUID()};
  const runtime = Object.freeze({baseUrl:`http://127.0.0.1:${pin.port}`,token:pin.token,instanceId:pin.instanceId,applicationVersion:cases.applicationVersion,role:settings.role});
  let fixture:BlackBox|undefined, launching:Promise<void>|undefined, closed=false;
  const release = async () => { reservation.closeAllConnections(); if(reservation.listening)await new Promise<void>(yes=>reservation.close(()=>yes())); };
  return {
    runtime,
    get calibrations(){ assert(fixture,"fixture-not-started"); return fixture.calibrations; },
    get ordinaryTrial(){ assert(fixture,"fixture-not-started"); return fixture.ordinaryTrial; },
    start:()=>launching??=(async()=>{
      assert(!closed,"fixture-already-closed");await release();
      fixture=await startBlackBox(settings,pin);assert.deepEqual(fixture.runtime,runtime);
    })(),
    readAdminState:async()=>{assert(fixture,"fixture-not-started");return fixture.readAdminState();},
    close:async()=>{closed=true;await release();await launching?.catch(()=>undefined);await fixture?.close();},
  };
}
/** Starts this exact module in a Node 22 child over loopback; no shell or env secrets. */
export async function startBlackBox(options: StartOptions = {}, pin?:{port:number;token:string;instanceId:string}): Promise<BlackBox> {
  requireNode22();
  const settings = normalizedOptions(options);
  const cases = await loadCases();
  const storageDirectory = await mkdtemp(join(tmpdir(), "finnor-x4-provider-"));
  await chmod(storageDirectory, 0o700);
  const token = pin?.token ?? randomBytes(32).toString("hex");
  const adminToken = randomBytes(32).toString("hex");
  const instanceId = pin?.instanceId ?? randomUUID();
  const config: Config = {
    ...settings, token, adminToken, instanceId, storageDirectory,
    applicationVersion: cases.applicationVersion, ...(pin?{port:pin.port}:{}),
  };
  const launchedAt = Date.now();
  const child = fork(modulePath, ["--fixture-child"], {
    cwd: packageRoot,
    execPath: process.execPath,
    execArgv: ["--max-old-space-size=256", "--import=tsx"],
    // Do not inherit app/database/cloud secrets or NODE_OPTIONS into the replica.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: tmpdir(), LANG: "C.UTF-8" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
  });
  let logs = 0;
  let outputOverflow = false;
  const onOutput = (chunk: Buffer) => {
    logs += chunk.length;
    // Output is never forwarded: even a startup failure cannot print an IPC secret.
    if (logs > MAX_LOG) { outputOverflow = true; child.kill("SIGKILL"); }
  };
  child.stdout!.on("data", onOutput);
  child.stderr!.on("data", onOutput);
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolveExit => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  let closePromise: Promise<void> | undefined;
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  const close = (): Promise<void> => closePromise ??= (async () => {
    if (wallTimer) clearTimeout(wallTimer);
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ kind: "shutdown" }, () => {});
      else child.kill("SIGTERM");
      const escalation = setTimeout(() => child.kill("SIGKILL"), 3000);
      await exited;
      clearTimeout(escalation);
    }
    if (outputOverflow) throw new Error("fixture-child-log-bound");
  })();
  let port: number;
  try {
    port = await new Promise<number>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error("fixture-start-timeout")), 8000);
      const fail = () => { clearTimeout(timeout); rejectReady(new Error("fixture-start-failed")); };
      child.once("error", fail);
      child.once("exit", fail);
      child.on("message", message => {
        if (Buffer.byteLength(JSON.stringify(message)) > MAX_RESPONSE) return fail();
        const reply = message as { kind?: string; port?: number };
        if (reply.kind !== "ready" || !Number.isInteger(reply.port)) return;
        clearTimeout(timeout);
        child.off("error", fail);
        child.off("exit", fail);
        resolveReady(reply.port!);
      });
      child.send({ kind: "init", config }, error => { if (error) fail(); });
    });
  } catch (error) {
    await close();
    throw error;
  }
  // The entire child lifetime, not each HTTP request, has a finite wall bound.
  wallTimer = setTimeout(() => { child.kill("SIGKILL"); }, Math.max(1, settings.hardWallMs - (Date.now() - launchedAt)));
  const baseUrl = `http://127.0.0.1:${port}`;
  if(pin)assert.equal(port,pin.port);
  const inspectDurable = async ():Promise<AdminSnapshot> => {
    const instance=JSON.parse(await readFile(join(storageDirectory,"instance.json"),"utf8"));
    assert.equal(instance.instanceId,instanceId);assert.equal(instance.pid,child.pid);
    const journal=(await readFile(join(storageDirectory,"admin-journal.jsonl"),"utf8")).trim().split("\n").filter(Boolean).map(v=>JSON.parse(v) as AdminEvent);
    journal.forEach((v,i)=>assert.equal(v.sequence,i+1));
    const accepted=journal.filter(v=>v.type==="accepted"),operations:AdminSnapshot["operations"]=[];
    assert(accepted.length<=256);
    for(const event of accepted){
      assert(event.operationId&&UUID.test(event.operationId));
      const stored=JSON.parse(await readFile(join(storageDirectory,event.operationId+".json"),"utf8")) as StoredOperation;
      assert.equal(stored.readback.id,event.operationId);assert.equal(stored.bodyHash,event.bodyHash);assert.equal(stored.bodyHash,sha(canonical(stored.requested)));
      const durableJournal=(await readFile(join(storageDirectory,event.operationId+".events.jsonl"),"utf8")).trim().split("\n").filter(Boolean).map(v=>JSON.parse(v) as OperationEvent);
      assert.deepEqual(stored.readback.events,durableJournal);
      if(stored.readback.status==="COMPLETE"){
        const output=JSON.parse(await readFile(join(storageDirectory,event.operationId+".output.json"),"utf8"));assert.deepEqual(output.records,stored.output);assert.equal(output.completedAt,stored.readback.completedAt);
      }
      operations.push({...stored,durableJournal});
    }
    const result:AdminSnapshot={inspection:"DURABLE_FILES_AFTER_EXIT",instanceId,applicationVersion:cases.applicationVersion,role:settings.role,pid:instance.pid,storageDirectory,
      journal,operations,postCount:journal.filter(v=>v.type==="post-received").length,acceptedCount:accepted.length,
      observationRequests:journal.filter(v=>v.type==="control-read"||v.type==="observation-read").length};
    assert(Buffer.byteLength(JSON.stringify(result))<=MAX_RESPONSE);return result;
  };
  return {
    runtime: { baseUrl, token, instanceId, applicationVersion: cases.applicationVersion, role: settings.role },
    calibrations: cases.cases.filter(c => c.role === "any" || c.role === settings.role).map(c => ({
      id: c.id, role: c.role, semantics: c.semantics,
      expectedDisposition: c.expectedDisposition, expectedStatus: c.expectedStatus,
      expectedUnits: c.expectedUnits, expectedRecords: clone(c.expectedRecords),
      ...(c.expectedFault ? { expectedFault: c.expectedFault } : {}),
      ...(c.expectedTiming ? { expectedTiming: clone(c.expectedTiming) } : {}),
    })),
    ordinaryTrial: {
      id: randomUUID(), instanceId, applicationVersion: cases.applicationVersion, role: settings.role,
      controls: { updateTiming: 3, pageSize: 1 },
      records: [
        { id: randomUUID(), features: { updatedSlot: -1, position: 1, pageWindow: 1, roleVisible: 1 }, value: "5" },
        { id: randomUUID(), features: { updatedSlot: 3, position: 2, pageWindow: 1, roleVisible: settings.role === "auditor" ? 1 : 0 }, value: "9" },
        { id: randomUUID(), features: { updatedSlot: 3, position: 3, pageWindow: 1, roleVisible: settings.role === "auditor" ? 1 : 0 }, value: "13" },
      ],
    },
    readAdminState: async () => {
      try{return {...await boundedJSON<AdminSnapshot>(`${baseUrl}/admin/snapshot`, adminToken),inspection:"LIVE_ADMIN_HTTP"};}
      catch(error){if(child.exitCode===null&&child.signalCode===null)throw error;return inspectDurable();}
    },
    close,
  };
}

class Refusal extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function refuse(condition: unknown, status: number, code: string): asserts condition {
  if (!condition) throw new Refusal(status, code);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}
function validateTrial(value: unknown, config: Config): Trial {
  refuse(object(value) && exactKeys(value, ["id", "instanceId", "applicationVersion", "role", "controls", "records"]), 400, "invalid-trial-shape");
  refuse(typeof value.id === "string" && UUID.test(value.id), 400, "invalid-operation-id");
  refuse(value.instanceId === config.instanceId && value.applicationVersion === config.applicationVersion, 409, "instance-version-mismatch");
  refuse(value.role === config.role, 403, "role-mismatch");
  refuse(object(value.controls) && exactKeys(value.controls, ["updateTiming", "pageSize"]), 400, "invalid-controls");
  refuse([-1, 1, 3].includes(value.controls.updateTiming as number) && [1, 2, 4].includes(value.controls.pageSize as number), 400, "invalid-controls");
  refuse(Array.isArray(value.records) && value.records.length <= 16, 400, "record-bound");
  const ids = new Set<string>();
  const extraFeatures = new Set<string>();
  for (let i = 0; i < value.records.length; i++) {
    const row: unknown = value.records[i];
    refuse(object(row) && exactKeys(row, ["id", "features", "value"]), 400, "invalid-record-shape");
    refuse(typeof row.id === "string" && UUID.test(row.id) && !ids.has(row.id), 400, "record-identity");
    ids.add(row.id);
    refuse(typeof row.value === "string" && /^(0|-?[1-9][0-9]{0,15})$/.test(row.value), 400, "integer-string");
    refuse(BigInt(row.value) >= -MAX_INTEGER && BigInt(row.value) <= MAX_INTEGER, 400, "integer-range");
    refuse(object(row.features) && Object.keys(row.features).length <= 6, 400, "feature-bound");
    const f = row.features;
    for (const k of ["updatedSlot", "position", "pageWindow", "roleVisible"]) refuse(Object.hasOwn(f, k), 400, "required-feature");
    refuse(f.updatedSlot === -1 || f.updatedSlot === value.controls.updateTiming, 400, "inconsistent-update-slot");
    refuse(f.position === i + 1 && f.pageWindow === value.controls.pageSize, 400, "inconsistent-position-page");
    refuse(f.roleVisible === 0 || f.roleVisible === 1, 400, "invalid-role-visibility");
    refuse(config.role !== "auditor" || f.roleVisible === 1, 400, "auditor-visibility");
    for (const [key, n] of Object.entries(f)) {
      refuse(Number.isSafeInteger(n), 400, "integer-feature");
      if (["updatedSlot", "position", "pageWindow", "roleVisible"].includes(key)) continue;
      // Two optional declared features, each with seven admitted integer values.
      refuse(["cohort", "flag"].includes(key) && (n as number) >= -3 && (n as number) <= 3, 400, "undeclared-feature");
      extraFeatures.add(key);
    }
  }
  refuse(extraFeatures.size <= 2, 400, "feature-bound");
  return clone(value as unknown as Trial);
}
function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers.authorization;
  const expected = Buffer.from(`Bearer ${token}`);
  if (typeof supplied !== "string") return false;
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function bodyText(request: IncomingMessage): Promise<string> {
  refuse(/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? ""), 415, "json-required");
  const length = request.headers["content-length"];
  refuse(length === undefined || (/^[0-9]+$/.test(length) && Number(length) <= MAX_BODY), 413, "body-bound");
  request.setTimeout(3000, () => request.destroy());
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    refuse(bytes <= MAX_BODY, 413, "body-bound");
    chunks.push(data);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function send(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text) > MAX_RESPONSE) {
    response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"error":"output-bound"}');
    return;
  }
  response.writeHead(status, {
    "content-type": "application/json", "content-length": Buffer.byteLength(text),
    "cache-control": "no-store", "x-content-type-options": "nosniff",
  });
  response.end(text);
}

async function serve(config: Config): Promise<void> {
  requireNode22();
  const known = await loadCases();
  const operations = new Map<string, StoredOperation>();
  const controlFirstRead = new Map<string, number>();
  const jobs = new Set<Promise<void>>();
  const cursorSecret = randomBytes(32);
  const adminPath = join(config.storageDirectory, "admin-journal.jsonl");
  const statePath = (op: StoredOperation) => join(config.storageDirectory, `${op.readback.id}.json`);
  const journalPath = (op: StoredOperation) => join(config.storageDirectory, `${op.readback.id}.events.jsonl`);
  let adminSequence = 0;
  let observationRequests = 0;
  let postCount = 0;
  let lossUsed = false;
  let failUsed = false;
  let mismatchUsed = false;
  let stopping = false;
  let chain = Promise.resolve();
  const exclusive = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn);
    chain = next.then(() => {}, () => {});
    return next;
  };
  const audit = async (type: string, extras: Pick<AdminEvent, "operationId" | "bodyHash"> = {}) => {
    await appendDurable(adminPath, { sequence: ++adminSequence, type, at: now(), ...extras });
  };
  const persist = (op: StoredOperation) => atomicJSON(statePath(op), op);
  const addEvent = async (
    op: StoredOperation, type: OperationEvent["type"], recordIds: string[] = [], detail?: string,
  ) => {
    const event: OperationEvent = {
      sequence: op.readback.events.length + 1, id: randomUUID(), type, at: now(), recordIds,
      ...(detail ? { detail } : {}),
    };
    op.readback.events.push(event);
    await appendDurable(journalPath(op), event);
    await persist(op);
  };
  const update = async (op: StoredOperation, slot: 1 | 3) => {
    const rows = op.readback.delivered.records.filter(row => row.features.updatedSlot === slot);
    if (!rows.length) return;
    op.liveRecords.push(...clone(rows));
    op.liveRecords.sort((a, b) => a.features.position! - b.features.position!);
    await addEvent(op, "records-updated", rows.map(row => row.id), `slot:${slot}`);
  };
  const execute = async (op: StoredOperation, shouldFail: boolean) => {
    try {
      // These are physical time delays and actual dataset changes, not just labels.
      await delay(config.slotMs);
      await exclusive(() => update(op, 1));
      await delay(config.slotMs);
      await exclusive(async () => {
        op.readback.startedAt = now();
        op.startSnapshot = clone(op.liveRecords);
        await addEvent(op, "started");
      });
      await delay(config.slotMs);
      await exclusive(() => update(op, 3));
      await delay(config.slotMs);
      await exclusive(async () => {
        if (shouldFail) throw new Error("provider-failed-once");
        // One export pipeline, configured privately, rather than mechanism APIs.
        const snapshot = ["snapshot-request", "combined"].includes(config.mode) ? op.requestSnapshot
          : config.mode === "snapshot-start" ? op.startSnapshot : op.liveRecords;
        const pageLimited = config.mode === "page-truncate";
        const roleLimited = config.mode === "role-filter" || config.mode === "combined";
        op.output = snapshot.filter(row =>
          (!pageLimited || row.features.position! <= row.features.pageWindow!)
          && (!roleLimited || row.features.roleVisible === 1),
        ).map(row => {
          const x = BigInt(row.value);
          const value = config.mode === "affine" ? 2n * x + 1n
            : config.mode === "unrepresentable" ? x * x : x;
          if (value < -MAX_INTEGER || value > MAX_INTEGER) throw new Error("integer-range-exceeded");
          return { id: row.id, value: value.toString() };
        });
        op.readback.completedAt = now();
        await addEvent(op, "completed");
        // Completed export bytes are written durably before COMPLETE is observable.
        await atomicJSON(join(config.storageDirectory, `${op.readback.id}.output.json`), {
          completedAt: op.readback.completedAt, writtenAt: now(), records: op.output, units: "count",
        });
        op.readback.status = "COMPLETE";
        op.readableAt = new Date(Date.now() + config.observationDelayMs).toISOString();
        await addEvent(op, "output-written", op.output.map(row => row.id));
        await audit("completed", { operationId: op.readback.id });
      });
    } catch (error) {
      await exclusive(async () => {
        op.readback.status = "FAILED";
        op.readback.completedAt = now();
        op.readback.failure = error instanceof Error && ["provider-failed-once", "integer-range-exceeded"].includes(error.message)
          ? error.message : "provider-operation-failed";
        op.output = [];
        await addEvent(op, "failed", [], op.readback.failure);
        await audit("failed", { operationId: op.readback.id });
      });
    }
  };
  const cursor = (id: string, offset: number): string => {
    const value = `${offset}`;
    return `${value}.${createHmac("sha256", cursorSecret).update(`${config.instanceId}:${config.role}:${id}:${value}`).digest("base64url")}`;
  };
  const offsetFor = (id: string, supplied: string | null): number => {
    if (supplied === null) return 0;
    refuse(/^[0-9]{1,2}\.[A-Za-z0-9_-]{43}$/.test(supplied), 400, "invalid-cursor");
    const offset = Number(supplied.split(".")[0]);
    const expected = cursor(id, offset);
    refuse(offset > 0 && offset <= 32 && offset % 2 === 0
      && expected.length === supplied.length
      && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)), 400, "invalid-cursor");
    return offset;
  };
  const page = (
    id: string, inputRows: ObservationRecord[], available: boolean, completedAt: string | null,
    offset: number, control?: Control,
  ): ObservationPage => {
    let rows = clone(inputRows);
    const faults: string[] = [config.instrumentFault, control?.surfaceFault ?? "none"];
    if (faults.includes("missing")) rows = rows.slice(1);
    if (faults.includes("duplicate") && rows.length) rows.push(clone(rows[0]!));
    const stale = faults.includes("stale");
    let nextOffset = offset + known.surfacePageSize;
    if (faults.includes("skipped-cursor") && offset === 0) nextOffset = 4;
    if (faults.includes("repeated-cursor") && offset > 0) nextOffset = offset;
    const nextCursor = available && nextOffset < rows.length && !faults.includes("truncated")
      ? cursor(id, nextOffset) : null;
    const timing=control?.expectedTiming?clone(control.expectedTiming):undefined;
    if(timing&&faults.includes("wrong-event"))timing.events[0]!.type="unregistered-event";
    return {
      experimentId: id, instanceId: config.instanceId,
      applicationVersion: stale ? "x4-fixture-obsolete" : config.applicationVersion,
      role: config.role, units: faults.includes("wrong-unit") ? "bytes" : "count",
      available, records: available ? rows.slice(offset, offset + known.surfacePageSize) : [],
      nextCursor, observedAt: now(),
      completedAt: available ? (stale ? "2000-01-01T00:00:00.000Z" : completedAt) : null,
      ...(control?.displayedPageCount !== undefined ? { displayedPageCount: control.displayedPageCount } : {}),
      ...(timing ? { timing } : {}),
    };
  };
  const inspect = async (): Promise<AdminSnapshot> => {
    const journal = (await readFile(adminPath, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as AdminEvent);
    const snapshots: AdminSnapshot["operations"] = [];
    for (const op of operations.values()) {
      const stored = JSON.parse(await readFile(statePath(op), "utf8")) as StoredOperation;
      const durableJournal = (await readFile(journalPath(op), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as OperationEvent);
      assert.deepEqual(stored.readback.events, durableJournal);
      snapshots.push({ ...stored, durableJournal });
    }
    return {
      instanceId: config.instanceId, applicationVersion: config.applicationVersion, role: config.role,
      pid: process.pid, storageDirectory: config.storageDirectory,
      postCount: journal.filter(e => e.type === "post-received").length,
      acceptedCount: journal.filter(e => e.type === "accepted").length,
      observationRequests, journal, operations: snapshots,
    };
  };
  await atomicJSON(join(config.storageDirectory, "instance.json"), {
    instanceId: config.instanceId, applicationVersion: config.applicationVersion,
    role: config.role, pid: process.pid, createdAt: now(), custody: "development",
  });
  await audit("instance-started");

  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const route = async () => {
      refuse((request.url?.length ?? 0) <= 512, 414, "url-bound");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/admin/snapshot") {
        // The public credential must not even reveal an admin response schema.
        refuse(authorized(request, config.adminToken), 404, "not-found");
        refuse(request.method === "GET" && url.search === "", 405, "method-not-allowed");
        send(response, 200, await exclusive(inspect));
        return;
      }
      refuse(authorized(request, config.token), 401, "unauthorized");
      refuse(!stopping, 503, "provider-closing");
      if (request.method === "POST" && url.pathname === "/v1/experiments" && !url.search) {
        await exclusive(async () => {
          refuse(postCount < 256, 429, "post-bound");
          postCount++;
          await audit("post-received");
        });
        const raw = await bodyText(request);
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { throw new Refusal(400, "invalid-json"); }
        const trial = validateTrial(parsed, config);
        const bodyHash = sha(canonical(trial));
        const result = await exclusive(async () => {
          const existing = operations.get(trial.id);
          if (existing) {
            await addEvent(existing, "post-received", [], existing.bodyHash === bodyHash ? "same-body" : "conflicting-body");
            await audit("repeat-post", { operationId: trial.id, bodyHash });
            refuse(existing.bodyHash === bodyHash, 409, "operation-body-conflict");
            return { op: existing, lost: false, fresh: false };
          }
          refuse(operations.size < 64, 429, "experiment-bound");
          refuse(![...operations.values()].some(op => op.readback.status === "PENDING"), 409, "operation-busy");
          const delivered = clone(trial);
          if (config.actualExposureMismatch && !mismatchUsed) {
            mismatchUsed = true;
            delivered.controls.pageSize = trial.controls.pageSize === 4 ? 1 : 4;
            for (const row of delivered.records) row.features.pageWindow = delivered.controls.pageSize;
          }
          // Prepare the preexisting dataset before the export's request boundary.
          const prepared = clone(delivered.records.filter(row => row.features.updatedSlot === -1));
          const liveRecords = clone(prepared);
          const requestSnapshot = clone(liveRecords);
          const requestedAt = now();
          const op: StoredOperation = {
            readback: {
              id: trial.id, instanceId: config.instanceId, applicationVersion: config.applicationVersion,
              role: config.role, status: "PENDING", delivered, requestedAt, startedAt: null,
              completedAt: null, events: [], units: "count",
            },
            requested: trial, bodyHash, liveRecords,
            requestSnapshot, startSnapshot: [], output: [], readableAt: null,
          };
          operations.set(trial.id, op);
          await addEvent(op, "accepted");
          await addEvent(op, "post-received");
          await addEvent(op, "records-prepared", prepared.map(row => row.id), "slot:-1");
          // Acceptance state and exact input are fsynced before either ACK or socket loss.
          await audit("accepted", { operationId: trial.id, bodyHash });
          const shouldFail = config.failOnce && !failUsed;
          if (shouldFail) failUsed = true;
          const job = execute(op, shouldFail);
          jobs.add(job);
          void job.finally(() => jobs.delete(job)).catch(() => { void shutdown(); });
          const lost = config.responseLossOnce && !lossUsed;
          if (lost) lossUsed = true;
          return { op, lost, fresh: true };
        });
        if (result.lost) {
          request.socket.destroy();
          return;
        }
        send(response, result.fresh || result.op.readback.status === "PENDING" ? 202 : 200, clone(result.op.readback));
        return;
      }
      const controlMatch = /^\/v1\/controls\/([a-z][a-z-]{0,40})$/.exec(url.pathname);
      const observationMatch = /^\/v1\/experiments\/([0-9a-f-]{36})\/observations$/i.exec(url.pathname);
      if (request.method === "GET" && (controlMatch || observationMatch)) {
        refuse([...url.searchParams.keys()].every(key => key === "cursor")
          && url.searchParams.getAll("cursor").length <= 1, 400, "invalid-query");
        const id = (controlMatch ?? observationMatch)![1]!;
        const offset = offsetFor(id, url.searchParams.get("cursor"));
        const result = await exclusive(async () => {
          refuse(observationRequests < 256, 429, "observation-bound");
          observationRequests++;
          await audit(controlMatch ? "control-read" : "observation-read", observationMatch ? { operationId: id } : {});
          if (controlMatch) {
            const control = known.cases.find(c => c.id === id);
            refuse(control && control.expectedStatus !== 404, 404, "control-not-found");
            refuse(control.role === "any" || control.role === config.role, 403, "role-mismatch");
            const firstRead = controlFirstRead.get(id) ?? Date.now();
            controlFirstRead.set(id, firstRead);
            const available = Date.now() - firstRead >= (control.delayMs ?? 0);
            return page(id, control.expectedRecords, available, control.expectedTiming?.completedAt ?? new Date(firstRead).toISOString(), offset, control);
          }
          const op = operations.get(id);
          refuse(op, 404, "operation-not-found");
          const available = op.readback.status === "COMPLETE" && op.readableAt !== null && Date.now() >= Date.parse(op.readableAt);
          return page(id, op.output, available, op.readback.completedAt, offset);
        });
        send(response, 200, result);
        return;
      }
      const operationMatch = /^\/v1\/experiments\/([0-9a-f-]{36})$/i.exec(url.pathname);
      if (request.method === "GET" && operationMatch && !url.search) {
        const result = await exclusive(async () => {
          const op = operations.get(operationMatch[1]!);
          refuse(op, 404, "operation-not-found");
          await audit("operation-read", { operationId: op.readback.id });
          return clone(op.readback);
        });
        send(response, 200, result);
        return;
      }
      throw new Refusal(404, "not-found");
    };
    void route().catch(error => {
      if (response.destroyed || response.writableEnded) return;
      send(response, error instanceof Refusal ? error.status : 500, {
        error: error instanceof Refusal ? error.code : "provider-internal-failure",
      });
    });
  });
  server.maxHeadersCount = 32;
  server.maxConnections = 32;
  server.requestTimeout = 4000;
  server.headersTimeout = 3000;
  server.keepAliveTimeout = 1000;
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => shutdownPromise ??= (async () => {
    stopping = true;
    // Preserve already accepted effects: finish them instead of deleting their liability.
    await Promise.allSettled([...jobs]);
    await chain;
    await audit("instance-closed");
    await new Promise<void>(resolveClose => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    });
    if (process.connected) process.disconnect();
  })();
  process.on("message", message => {
    if ((message as { kind?: string }).kind === "shutdown") void shutdown();
  });
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("disconnect", () => { void shutdown(); });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    assert(config.port===undefined||Number.isInteger(config.port)&&config.port>0&&config.port<65536);
    server.listen(config.port??0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  assert(address && typeof address === "object");
  process.send?.({ kind: "ready", port: address.port });
}

// Strongest-boundary self-check: actual fork + HTTP + literal oracle; not product unit tests.
async function selfCheck(evidenceDirectory: string): Promise<void> {
  requireNode22();
  assert(isAbsolute(evidenceDirectory), "evidence directory must be absolute and fresh");
  await mkdir(evidenceDirectory, { mode: 0o700 });
  const receipt: Record<string, unknown> = {
    oracleRevision: 1, custody: "development-not-protected", startedAt: now(), status: "RUNNING",
    command: `${process.execPath} --import=tsx ${modulePath} --self-check ${evidenceDirectory}`,
    steps: [], artifacts: [],
  };
  receipt.sourceHashes = {
    blackBox: sha(await readFile(modulePath, "utf8")),
    providerContract: sha(await readFile(join(dirname(modulePath), "provider-contract.mts"), "utf8")),
    providerCases: sha(await readFile(casesPath, "utf8")),
  };
  const steps = receipt.steps as unknown[];
  const fixtures: BlackBox[] = [];
  const track = async (options: StartOptions) => {
    const fixture = await startBlackBox(options);
    fixtures.push(fixture);
    return fixture;
  };
  const request = async <T,>(fixture: BlackBox, path: string, trial?: Trial): Promise<{ status: number; body: T }> => {
    const at = now();
    try {
      const response = await fetch(`${fixture.runtime.baseUrl}${path}`, {
        method: trial ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${fixture.runtime.token}`,
          ...(trial ? { "content-type": "application/json" } : {}),
        },
        ...(trial ? { body: JSON.stringify(trial) } : {}),
        signal: AbortSignal.timeout(3000),
      });
      const raw = await response.text();
      assert(Buffer.byteLength(raw) <= MAX_RESPONSE);
      const result = { status: response.status, body: JSON.parse(raw) as T };
      await appendDurable(join(evidenceDirectory, "wire.jsonl"), {
        at, instanceId: fixture.runtime.instanceId, method: trial ? "POST" : "GET",
        path, ...(trial ? { trial } : {}), ...result,
      });
      return result;
    } catch (error) {
      await appendDurable(join(evidenceDirectory, "wire.jsonl"), {
        at, instanceId: fixture.runtime.instanceId, method: trial ? "POST" : "GET",
        path, ...(trial ? { trial } : {}), transport: "failed",
      });
      throw error;
    }
  };
  const walk = async (fixture: BlackBox, path: string): Promise<ObservationPage[]> => {
    const pages: ObservationPage[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let count = 0; count < 16; count++) {
      const result: { status: number; body: ObservationPage } = await request(fixture, `${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
      assert.equal(result.status, 200);
      pages.push(result.body);
      if (!result.body.nextCursor) return pages;
      assert(!seen.has(result.body.nextCursor), "repeated-cursor");
      seen.add(result.body.nextCursor);
      cursor = result.body.nextCursor;
    }
    throw new Error("page-bound");
  };
  const terminal = async (fixture: BlackBox, id: string): Promise<OperationReadback> => {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const result = await request<OperationReadback>(fixture, `/v1/experiments/${id}`);
      assert.equal(result.status, 200);
      if (result.body.status !== "PENDING") return result.body;
      await delay(25);
    }
    throw new Error("terminal-timeout");
  };
  const trialFor = (fixture: BlackBox, updateTiming: -1 | 1 | 3): Trial => ({
    id: randomUUID(), instanceId: fixture.runtime.instanceId,
    applicationVersion: fixture.runtime.applicationVersion, role: fixture.runtime.role,
    controls: { updateTiming, pageSize: 4 },
    records: [
      { id: "a0000000-0000-4000-8000-000000000001", features: { updatedSlot: -1, position: 1, pageWindow: 4, roleVisible: 1 }, value: "5" },
      { id: "a0000000-0000-4000-8000-000000000002", features: { updatedSlot: updateTiming, position: 2, pageWindow: 4, roleVisible: 1 }, value: "9" },
    ],
  });
  await atomicJSON(join(evidenceDirectory, "receipt.json"), receipt);
  try {
    const fixture = await track({ mode: "snapshot-start" });
    const trial = trialFor(fixture, 1);
    const ack = await request<OperationReadback>(fixture, "/v1/experiments", trial);
    assert.equal(ack.status, 202);
    assert.equal(ack.body.status, "PENDING");
    const accepted = await fixture.readAdminState();
    assert.equal(accepted.postCount, 1);
    assert.equal(accepted.acceptedCount, 1);
    assert.equal(accepted.operations[0]!.requested.id, trial.id);
    const done = await terminal(fixture, trial.id);
    assert.equal(done.status, "COMPLETE");
    assert.deepEqual(done.delivered, trial);
    const output = await walk(fixture, `/v1/experiments/${trial.id}/observations`);
    assert.deepEqual(output.flatMap(p => p.records), [
      { id: "a0000000-0000-4000-8000-000000000001", value: "5" },
      { id: "a0000000-0000-4000-8000-000000000002", value: "9" },
    ]);
    const updated = done.events.find(e => e.type === "records-updated")!;
    assert(updated);
    assert(Date.parse(updated.at) >= Date.parse(done.requestedAt) + 20);
    assert(Date.parse(updated.at) < Date.parse(done.startedAt!));
    assert(Date.parse(done.startedAt!) < Date.parse(done.completedAt!));
    assert.equal(done.events.at(-1)!.type, "output-written");
    const denied = await request<{ error: string }>(fixture, "/admin/snapshot");
    assert.equal(denied.status, 404);
    assert.deepEqual(denied.body, { error: "not-found" });
    const deniedRole = await request(fixture, "/v1/controls/role-auditor");
    assert.equal(deniedRole.status, 403);
    const admin = await fixture.readAdminState();
    assert.deepEqual(admin.operations[0]!.durableJournal, done.events);
    assert.equal(admin.pid === process.pid, false);
    await atomicJSON(join(evidenceDirectory, "positive.json"), { trial, ack, readback: done, pages: output, admin });
    steps.push({ name: "physical-positive", status: "PASS", artifact: "positive.json", childPid: admin.pid });

    const pagination = await walk(fixture, "/v1/controls/pagination");
    assert.equal(pagination.length, 3);
    assert.equal(pagination[0]!.displayedPageCount, 1);
    assert.deepEqual(pagination.flatMap(p => p.records), [
      { id: "10000000-0000-4000-8000-000000000001", value: "-4" },
      { id: "10000000-0000-4000-8000-000000000002", value: "0" },
      { id: "10000000-0000-4000-8000-000000000003", value: "7" },
      { id: "10000000-0000-4000-8000-000000000004", value: "23" },
      { id: "10000000-0000-4000-8000-000000000005", value: "101" },
    ]);
    await atomicJSON(join(evidenceDirectory, "pagination.json"), pagination);
    steps.push({ name: "literal-pagination-control", status: "PASS", artifact: "pagination.json" });

    const delayed = await request<ObservationPage>(fixture, "/v1/controls/delayed");
    assert.equal(delayed.body.available, false);
    assert.deepEqual(delayed.body.records, []);
    await delay(200);
    const delayedComplete = await request<ObservationPage>(fixture, "/v1/controls/delayed");
    assert.equal(delayedComplete.body.available, true);
    assert.deepEqual(delayedComplete.body.records, [{ id: "70000000-0000-4000-8000-000000000001", value: "31" }]);
    const missing = await request(fixture, "/v1/controls/missing");
    assert.equal(missing.status, 404);
    const empty = await request<ObservationPage>(fixture, "/v1/controls/empty");
    assert.equal(empty.body.available, true);
    assert.deepEqual(empty.body.records, []);
    await atomicJSON(join(evidenceDirectory, "availability.json"), { delayed, delayedComplete, missing, empty });
    steps.push({ name: "pending-missing-empty-distinct", status: "PASS", artifact: "availability.json" });

    const timing = await request<ObservationPage>(fixture, "/v1/controls/timing");
    assert.deepEqual(timing.body.timing, {
      requestedAt: "2026-01-01T00:00:00.000Z", startedAt: "2026-01-01T00:00:00.120Z",
      completedAt: "2026-01-01T00:00:00.240Z",
      events: [
        { id: "21000000-0000-4000-8000-000000000001", type: "accepted", at: "2026-01-01T00:00:00.000Z" },
        { id: "21000000-0000-4000-8000-000000000002", type: "started", at: "2026-01-01T00:00:00.120Z" },
        { id: "21000000-0000-4000-8000-000000000003", type: "completed", at: "2026-01-01T00:00:00.240Z" },
      ],
    });
    const integers = await walk(fixture, "/v1/controls/integer-units");
    assert.deepEqual(integers.flatMap(p => p.records).map(r => r.value), ["-9007199254740991", "0", "9007199254740991"]);
    assert(integers.every(p => p.units === "count"));
    const analyst = await request<ObservationPage>(fixture, "/v1/controls/role-analyst");
    assert.deepEqual(analyst.body.records, [{ id: "30000000-0000-4000-8000-000000000001", value: "13" }]);
    const duplicates = await walk(fixture, "/v1/controls/duplicates");
    assert.equal(duplicates.flatMap(p => p.records).length, 2);
    assert.equal(new Set(duplicates.flatMap(p => p.records).map(r => r.id)).size, 1);
    const stale = await request<ObservationPage>(fixture, "/v1/controls/stale");
    assert.notEqual(stale.body.applicationVersion, fixture.runtime.applicationVersion);
    await assert.rejects(walk(fixture, "/v1/controls/repeated-cursor"), /repeated-cursor/);
    const skipped = await walk(fixture, "/v1/controls/skipped-cursor");
    assert.deepEqual(skipped.flatMap(p => p.records).map(r => r.value), ["2", "3", "11"]);
    await atomicJSON(join(evidenceDirectory, "calibrations.json"), { timing, integers, analyst, duplicates, stale, skipped });
    steps.push({ name: "literal-timing-role-integer-and-negative-controls", status: "PASS", artifact: "calibrations.json" });

    // Count the forbidden retry without creating a second operation. Then conflict.
    const repeated = await request<OperationReadback>(fixture, "/v1/experiments", trial);
    assert.equal(repeated.status, 200);
    const conflict = clone(trial);
    conflict.records[0]!.value = "6";
    assert.equal((await request(fixture, "/v1/experiments", conflict)).status, 409);
    const afterRepeats = await fixture.readAdminState();
    assert.equal(afterRepeats.postCount, 3);
    assert.equal(afterRepeats.acceptedCount, 1);
    assert.equal(afterRepeats.operations.length, 1);
    assert.equal(afterRepeats.operations[0]!.readback.events.filter(e => e.type === "started").length, 1);
    await atomicJSON(join(evidenceDirectory, "idempotence.json"), { repeated, admin: afterRepeats });
    steps.push({ name: "same-body-only-idempotence-counts-every-post", status: "PASS", artifact: "idempotence.json" });
    await fixture.close();

    const lossy = await track({ mode: "snapshot-request", responseLossOnce: true });
    const lostTrial = trialFor(lossy, 3);
    // Independently fresh identities, rather than reusing positive-instance rows.
    lostTrial.records[0]!.id = "b0000000-0000-4000-8000-000000000001";
    lostTrial.records[1]!.id = "b0000000-0000-4000-8000-000000000002";
    let responseLost = false;
    try { await request(lossy, "/v1/experiments", lostTrial); } catch { responseLost = true; }
    assert(responseLost, "acceptance must close the response socket");
    const reconciled = await terminal(lossy, lostTrial.id); // GET only; never POST again.
    assert.equal(reconciled.status, "COMPLETE");
    const lossPages = await walk(lossy, `/v1/experiments/${lostTrial.id}/observations`);
    assert.deepEqual(lossPages.flatMap(p => p.records), [{ id: "b0000000-0000-4000-8000-000000000001", value: "5" }]);
    const lossAdmin = await lossy.readAdminState();
    assert.equal(lossAdmin.postCount, 1);
    assert.equal(lossAdmin.acceptedCount, 1);
    const afterStartUpdate = reconciled.events.find(e => e.type === "records-updated")!;
    assert(Date.parse(afterStartUpdate.at) > Date.parse(reconciled.startedAt!));
    assert(Date.parse(afterStartUpdate.at) < Date.parse(reconciled.completedAt!));
    await atomicJSON(join(evidenceDirectory, "response-loss.json"), {
      trial: lostTrial, responseLost, reconciled, pages: lossPages, admin: lossAdmin,
    });
    steps.push({ name: "response-loss-read-only-reconciliation", status: "PASS", artifact: "response-loss.json", actualPosts: 1 });
    await lossy.close();

    const negatives: unknown[] = [];
    for (const fault of ["duplicate", "missing", "wrong-unit", "stale", "truncated"] as const) {
      const bad = await track({ instrumentFault: fault, mode: "affine" });
      const pages = await walk(bad, "/v1/controls/pagination");
      const rows = pages.flatMap(p => p.records);
      // Independent, literal control defects: no fixture programme evaluates its own expected answer.
      if (fault === "duplicate") assert.equal(new Set(rows.map(r => r.id)).size < rows.length, true);
      if (fault === "missing") assert.equal(rows.some(r => r.id === "10000000-0000-4000-8000-000000000001"), false);
      if (fault === "wrong-unit") assert.equal(pages[0]!.units, "bytes");
      if (fault === "stale") assert.notEqual(pages[0]!.applicationVersion, "x4-fixture-v1");
      if (fault === "truncated") { assert.equal(rows.length, 2); assert.equal(pages[0]!.nextCursor, null); }
      assert.equal((await request(bad, "/v1/experiments", bad.ordinaryTrial)).status, 202);
      assert.equal((await terminal(bad, bad.ordinaryTrial.id)).status, "COMPLETE");
      const ordinaryPages = await walk(bad, `/v1/experiments/${bad.ordinaryTrial.id}/observations`);
      const ordinaryRows = ordinaryPages.flatMap(p => p.records);
      if (fault === "duplicate") assert.equal(new Set(ordinaryRows.map(r => r.id)).size, ordinaryRows.length - 1);
      if (fault === "missing") assert.deepEqual(ordinaryRows.map(r => r.value), ["19", "27"]);
      if (fault === "wrong-unit") assert.equal(ordinaryPages[0]!.units, "bytes");
      if (fault === "stale") assert.notEqual(ordinaryPages[0]!.applicationVersion, bad.runtime.applicationVersion);
      if (fault === "truncated") assert.deepEqual(ordinaryRows.map(r => r.value), ["11", "19"]);
      negatives.push({ fault, pages, ordinaryTrial: bad.ordinaryTrial, ordinaryPages });
      await bad.close();
    }
    await atomicJSON(join(evidenceDirectory, "instrument-faults.json"), negatives);
    steps.push({ name: "five-permitted-surface-instrument-defects", status: "PASS", artifact: "instrument-faults.json" });

    const baselineResults: unknown[] = [];
    const literalBaseline: Record<BehaviorMode, string[]> = {
      "snapshot-request": ["5"], "snapshot-start": ["5"], "page-truncate": ["5"],
      "role-filter": ["5"], combined: ["5"], affine: ["11", "19", "27"],
      unrepresentable: ["25", "81", "169"],
    };
    for (const mode of Object.keys(literalBaseline) as BehaviorMode[]) {
      const baseline = await track({ mode });
      const input = baseline.ordinaryTrial;
      assert.equal((await request(baseline, "/v1/experiments", input)).status, 202);
      const readback = await terminal(baseline, input.id);
      assert.equal(readback.status, "COMPLETE");
      const pages = await walk(baseline, `/v1/experiments/${input.id}/observations`);
      assert.deepEqual(pages.flatMap(p => p.records).map(r => r.value), literalBaseline[mode]);
      baselineResults.push({ mode, trial: input, pages, admin: await baseline.readAdminState() });
      await baseline.close();
    }
    await atomicJSON(join(evidenceDirectory, "ordinary-baselines.json"), baselineResults);
    steps.push({ name: "seven-private-modes-and-ambiguous-ordinary-input", status: "PASS", artifact: "ordinary-baselines.json" });

    const adverse = await track({ role: "auditor", mode: "affine", failOnce: true, actualExposureMismatch: true, observationDelayMs: 200 });
    const failedTrial = adverse.ordinaryTrial;
    assert.equal((await request(adverse, "/v1/experiments", failedTrial)).status, 202);
    const failed = await terminal(adverse, failedTrial.id);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.failure, "provider-failed-once");
    assert.notDeepEqual(failed.delivered, failedTrial);
    assert.equal((await request<ObservationPage>(adverse, `/v1/experiments/${failedTrial.id}/observations`)).body.available, false);
    const nextTrial = trialFor(adverse, -1);
    for (const row of nextTrial.records) row.id = randomUUID();
    assert.equal((await request(adverse, "/v1/experiments", nextTrial)).status, 202);
    const second = await terminal(adverse, nextTrial.id);
    assert.equal(second.status, "COMPLETE");
    assert.deepEqual(second.delivered, nextTrial);
    const pendingRead = await request<ObservationPage>(adverse, `/v1/experiments/${nextTrial.id}/observations`);
    assert.equal(pendingRead.body.available, false);
    await delay(220);
    const completeRead = await walk(adverse, `/v1/experiments/${nextTrial.id}/observations`);
    assert.deepEqual(completeRead.flatMap(p => p.records).map(r => r.value), ["11", "19"]);
    const auditor = await request<ObservationPage>(adverse, "/v1/controls/role-auditor");
    assert.deepEqual(auditor.body.records, [
      { id: "30000000-0000-4000-8000-000000000001", value: "13" },
      { id: "30000000-0000-4000-8000-000000000002", value: "17" },
    ]);
    await atomicJSON(join(evidenceDirectory, "adverse-operations.json"), {
      failedTrial, failed, nextTrial, second, pendingRead, completeRead, auditor, admin: await adverse.readAdminState(),
    });
    steps.push({ name: "retained-failure-exposure-mismatch-delayed-read-auditor", status: "PASS", artifact: "adverse-operations.json" });
    await adverse.close();
    receipt.status = "PASS";
  } catch (error) {
    receipt.status = "FAIL";
    // No raw HTTP headers, child output or arbitrary error object enters evidence.
    receipt.failure = error instanceof assert.AssertionError ? {
      kind: "AssertionError", message: error.message, actual: error.actual, expected: error.expected,
    } : { kind: "Error", message: error instanceof Error ? error.message : "unknown-failure" };
    throw error;
  } finally {
    const closed = await Promise.allSettled(fixtures.map(f => f.close()));
    receipt.closeFailures = closed.filter(r => r.status === "rejected").length;
    if (receipt.closeFailures !== 0) receipt.status = "FAIL";
    receipt.completedAt = now();
    receipt.artifacts = ["wire.jsonl", ...(steps as { artifact?: string }[]).map(step => step.artifact).filter(Boolean)];
    await atomicJSON(join(evidenceDirectory, "receipt.json"), receipt);
  }
  assert.equal(receipt.status, "PASS", "fixture-close-failed");
  process.stdout.write(`provider self-check PASS: ${evidenceDirectory}/receipt.json\n`);
}

const invokedDirectly = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly && process.argv[2] === "--fixture-child") {
  process.once("message", message => {
    const input = message as { kind?: string; config?: Config };
    if (input.kind !== "init" || !input.config || Buffer.byteLength(JSON.stringify(input)) > MAX_RESPONSE) {
      process.exitCode = 1;
      process.disconnect();
      return;
    }
    void serve(input.config).catch(() => {
      // Secrets or initialization stacks must never be emitted.
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
  });
} else if (invokedDirectly && process.argv[2] === "--self-check") {
  await selfCheck(process.argv[3] ?? "");
}
