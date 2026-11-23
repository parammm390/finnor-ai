import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { OriginalPortfolioStream, PORTFOLIO_STREAM } from "../../../packages/epistemic-runtime/src/project-z/z1-shared-work/portfolio-stream.ts";
import { boundedJSON } from "../../../packages/epistemic-runtime/src/project-z/z1-shared-work/contracts.ts";

const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, "../../../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value));

async function* mutatedFrames(settings, recipe) {
  let changed = false, firstOriginal = null, dropping = null, sequence = 0, index = -1, pages = [];
  const lines = createInterface({ input: createReadStream(settings.frames), crlfDelay: Infinity });
  for await (const line of lines) {
    index++;
    let frame = JSON.parse(line);
    if (recipe.kind === "missing-manifest" && frame.kind === "MANIFEST") continue;
    if (recipe.kind === "missing-seal" && frame.kind === "SEAL") continue;
    if (frame.kind === "MANIFEST" && ["tenant", "principal", "transaction", "rights"].includes(recipe.kind)) {
      const field = { tenant: "tenantId", principal: "principalId", transaction: "transactionId", rights: "rightsRevision" }[recipe.kind];
      frame.scope[field] = ["tenant", "principal"].includes(recipe.kind) ? "30000000-0000-4000-8000-000000000001" : "102";
    }
    if (frame.kind === "DATA") {
      const payload = JSON.parse(frame.payloadText);
      if (recipe.kind === "missing-page" && frame.sequence > 64 && frame.sequence <= 128) continue;
      if (["missing-original", "missing-other"].includes(recipe.kind)) {
        if (!dropping && payload.tag === "RESERVATION" &&
            payload.population === (recipe.kind === "missing-original" ? "ORIGINAL" : "OTHER"))
          dropping = payload.reservationRef.id;
        if (payload.tag === "RESERVATION" && payload.reservationRef.id === dropping ||
            payload.tag === "ENVELOPE" && payload.reservationId === dropping) continue;
      }
      if (!changed && recipe.kind === "resource-head" && payload.tag === "RESOURCE") {
        payload.reference.contentDigest = "0".repeat(64); changed = true;
      }
      if (!changed && recipe.kind === "original-label" && payload.tag === "RESERVATION" && payload.population === "ORIGINAL") {
        payload.population = "OTHER"; payload.originalKey = null; changed = true;
      }
      if (recipe.kind === "duplicate-original" && payload.tag === "RESERVATION" && payload.population === "ORIGINAL") {
        if (!firstOriginal) firstOriginal = payload.originalKey;
        else if (!changed) { payload.originalKey = firstOriginal; changed = true; }
      }
      if (!changed && payload.tag === "ENVELOPE" && !payload.opaque) {
        switch (recipe.kind) {
          case "horizon": payload.horizonDigest = "0".repeat(64); changed = true; break;
          case "unit": payload.unit = "different-unit"; changed = true; break;
          case "kind": payload.kind = payload.kind === "OCCUPANCY" ? "CUMULATIVE_EXPENDITURE" : "OCCUPANCY"; changed = true; break;
          case "quantity-count": payload.quantityCount--; changed = true; break;
          case "minimum": payload.minimumQuantities[0] = String(BigInt(payload.quantities[0]) + 1n); changed = true; break;
          case "negative": payload.quantities[0] = "-1"; changed = true; break;
          case "fractional": payload.quantities[0] = "1/2"; changed = true; break;
          case "opaque-selected": payload.opaque = true; payload.quantities = payload.minimumQuantities = null; changed = true; break;
          case "mixed-snapshot":
          case "forged-payload": payload.quantities[0] = String(BigInt(payload.quantities[0]) + 1n); changed = true; break;
        }
      }
      if (!changed && recipe.kind === "opaque-unselected" && payload.tag === "ENVELOPE" && payload.opaque) {
        payload.opaque = false; payload.quantities = payload.minimumQuantities = ["0", "0"]; changed = true;
      }
      if (changed) {
        frame.payloadText = JSON.stringify(payload);
        if (recipe.kind !== "forged-payload") frame.payloadDigest = sha(frame.payloadText);
      }
      if (!changed && recipe.kind === "oversize") {
        frame.payloadText += " ".repeat(PORTFOLIO_STREAM.frameBytes); changed = true;
      }
      if (!changed && recipe.kind === "malformed-json") {
        frame.payloadText = "{"; frame.payloadDigest = sha(frame.payloadText); changed = true;
      }
      if (!changed && recipe.kind === "mixed-transaction") { frame.fence = "0".repeat(64); changed = true; }
      if (["missing-page", "missing-original", "missing-other"].includes(recipe.kind)) frame.sequence = ++sequence;
      if (["duplicate-page", "reordered-pages"].includes(recipe.kind) && !changed) {
        pages.push(frame);
        const count = recipe.kind === "duplicate-page" ? 64 : 128;
        if (pages.length < count) continue;
        if (recipe.kind === "duplicate-page") {
          for (const item of pages) yield item;
          for (const item of pages) yield item;
        } else {
          for (const item of pages.slice(64)) yield item;
          for (const item of pages.slice(0, 64)) yield item;
        }
        changed = true; pages = []; continue;
      }
    }
    if (frame.kind === "SEAL" && ["missing-page", "missing-original", "missing-other"].includes(recipe.kind))
      frame.sequence = sequence + 1;
    yield frame;
    if (recipe.kind === "trailing-frame" && frame.kind === "SEAL") yield frame;
  }
  assert.equal(pages.length, 0, "NEGATIVE_PAGE_RECIPE_NOT_REACHED");
}

async function child(settingsPath, recipePath) {
  const settings = await json(settingsPath), recipe = recipePath ? await json(recipePath) : { kind: "positive" };
  let framesRead = 0, maxFrameBytes = 0, maxPageBytes = 0, opaqueWitnesses = 0;
  if (recipe.kind === "one-short") settings.requested[recipe.resourceId] = recipe.requested;
  try {
    const fold = new OriginalPortfolioStream(settings.scope, settings.resources, settings.requested);
    let page = [];
    for await (const frame of mutatedFrames(settings, recipe)) {
      framesRead++; maxFrameBytes = Math.max(maxFrameBytes, byteLength(frame));
      if (frame.kind === "DATA") {
        let preview;
        try { preview = JSON.parse(frame.payloadText); } catch { preview = null; }
        if (preview?.opaque) opaqueWitnesses++;
      }
      page.push({ frame });
      if (page.length === PORTFOLIO_STREAM.fetchFrames) {
        boundedJSON(page, PORTFOLIO_STREAM.pageBytes); maxPageBytes = Math.max(maxPageBytes, byteLength(page)); page = [];
      }
      fold.accept(frame);
    }
    boundedJSON(page, PORTFOLIO_STREAM.pageBytes); maxPageBytes = Math.max(maxPageBytes, byteLength(page));
    const receipt = fold.finish();
    process.stdout.write(JSON.stringify({ status: "PASSED", receipt, framesRead, opaqueWitnesses,
      maxFrameBytes, maxPageBytes, selfPeakRSSBytes: process.resourceUsage().maxRSS * 1024 }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: "REFUSED", reason: error.message, disposition: error.disposition ?? "INTERNAL_ERROR",
      capacityReturned: false, framesRead, maxFrameBytes, maxPageBytes,
      selfPeakRSSBytes: process.resourceUsage().maxRSS * 1024 }) + "\n");
    process.exitCode = 2;
  }
}

async function main(destination) {
  assert.ok(isAbsolute(destination), "ABSOLUTE_FRESH_REPLAY_DIRECTORY_REQUIRED");
  await mkdir(destination, { recursive: false, mode: 0o700 });
  const paths = [
    "finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work/portfolio-stream.ts",
    "finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work/contracts.ts",
    "finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work/engine.ts",
    "finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work/original_checker.py",
    "finnor-os/packages/private-equity/src/project-z/z1-shared-work/portfolio-store.ts",
    "finnor-os/packages/private-equity/src/project-z/z1-shared-work/resources.ts",
    "finnor-os/packages/private-equity/src/project-z/z1-shared-work/native-store.ts",
    "finnor-os/packages/private-equity/src/project-z/z1-shared-work/native.ts",
    "finnor-os/packages/private-equity/src/project-z/z1-shared-work/admission.ts",
    "finnor-os/packages/private-equity/src/project-z/z1-shared-work/processes.ts",
    "finnor-os/scripts/project-z/z1/portfolio-stream.sql",
    "finnor-os/scripts/project-z/z1/portfolio-stream-original.py",
    "finnor-os/scripts/project-z/z1/portfolio-stream-replay.mjs",
  ];
  const inventory = await Promise.all(paths.map(async (path) => ({ path, sha256: sha(await readFile(resolve(root, path))) })));
  await save(resolve(destination, "source-inventory.json"), inventory);
  const report = { scope: "BOUNDED_PUBLIC_DATA_PATH_PROCESS_NOT_NATIVE_SQL_AUTH_OWNER_OR_S8",
    status: "IN_PROGRESS", positives: [], refusals: [], inventory, node: process.version,
    databaseActions: 0, authUsersCreated: 0, nativeClaims: 0, nativeOwnerFlow: "NOT_RUN",
    sqlCursorExecution: "NOT_RUN", persistedDeliveryTransitions: "NOT_RUN", independentS8Admission: "NOT_RUN",
    installedOwnerFlow: "NOT_RUN", trueAggregatePeakRSS: "UNKNOWN", proofAdmissionRenewed: false };
  const env = { PATH: process.env.PATH, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1",
    TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "finnor-os/tsconfig.json") };
  const invoke = async (settings, recipe, name) => {
    const recipePath = resolve(destination, `${name}-recipe.json`);
    await save(recipePath, recipe);
    const argv = ["--max-old-space-size=512", "--import", resolve(root, "finnor-os/node_modules/tsx/dist/loader.mjs"),
      fileURLToPath(import.meta.url), "--read", settings, recipePath];
    const run = spawnSync(process.execPath, argv, { cwd: root, env, encoding: "utf8", timeout: 30000, maxBuffer: 1048576 });
    await save(resolve(destination, `${name}-process.json`), { executable: process.execPath, argv, exitCode: run.status,
      signal: run.signal, error: run.error?.message ?? null, stdout: run.stdout, stderr: run.stderr });
    assert.ok(!run.error && [0, 2].includes(run.status), `BOUNDED_READER_CHILD_FAILED:${name}`);
    const result = JSON.parse(run.stdout);
    await save(resolve(destination, `${name}-result.json`), result);
    return { name, exitCode: run.status, result };
  };
  try {
    const generated = spawnSync("python3", [resolve(here, "portfolio-stream-original.py"), resolve(destination, "inputs")],
      { cwd: root, env, encoding: "utf8", timeout: 240000, maxBuffer: 1048576 });
    await save(resolve(destination, "independent-generation-process.json"), { exitCode: generated.status,
      signal: generated.signal, stdout: generated.stdout, stderr: generated.stderr, error: generated.error?.message ?? null });
    assert.equal(generated.status, 0, "INDEPENDENT_ORIGINAL_INPUT_AND_EXPECTATION_PROCESS");
    const generation = await json(resolve(destination, "inputs/generation.json"));
    report.wireBound = await json(resolve(destination, "inputs/wire-bound.json"));
    assert.ok(report.wireBound.pageUpperUsingHardFrameLimitAnd256ProtocolBytesPerFrame < PORTFOLIO_STREAM.pageBytes);
    for (const row of generation.cases) {
      const settings = await json(row.settings), frozen = await json(settings.expected);
      assert.ok(row.maximumFrameBytes <= PORTFOLIO_STREAM.frameBytes);
      const legacy = await json(settings.legacySnapshot);
      assert.equal(byteLength(legacy), settings.legacyBytes);
      assert.throws(() => boundedJSON(legacy, 8388608), { message: "INPUT_BYTE_BOUND" });
      const actual = await invoke(row.settings, { kind: "positive" }, `${row.name}-positive`);
      assert.equal(actual.exitCode, 0); assert.deepEqual(actual.result.receipt.capacity, frozen);
      assert.deepEqual(actual.result.receipt.counts, settings.counts);
      assert.equal(actual.result.opaqueWitnesses, settings.expectedOpaqueEnvelopes);
      assert.equal(actual.result.receipt.settlement, "UNKNOWN_UNINSPECTED");
      assert.ok(actual.result.maxFrameBytes <= 65536 && actual.result.maxPageBytes <= 8388608);
      report.positives.push({ name: row.name, counts: settings.counts, legacyBytes: settings.legacyBytes,
        observedFrameBytes: actual.result.maxFrameBytes, observedPageBytes: actual.result.maxPageBytes,
        opaqueWitnesses: actual.result.opaqueWitnesses, selfPeakRSSBytes: actual.result.selfPeakRSSBytes });
    }
    const full = generation.cases.find(row => row.name === "p64-r16");
    const partial = generation.cases.find(row => row.name === "p64-r4");
    const kinds = ["missing-manifest", "missing-seal", "missing-page", "missing-original", "missing-other", "duplicate-page",
      "reordered-pages", "trailing-frame", "tenant", "principal", "transaction", "rights", "mixed-transaction",
      "resource-head", "original-label", "duplicate-original", "horizon", "unit", "kind", "quantity-count", "minimum",
      "negative", "fractional", "opaque-selected", "mixed-snapshot", "forged-payload", "oversize", "opaque-unselected", "malformed-json"];
    for (const kind of kinds) {
      const actual = await invoke(kind === "opaque-unselected" ? partial.settings : full.settings, { kind }, kind);
      assert.equal(actual.exitCode, 2, `MALFORMED_STREAM_ACCEPTED:${kind}`);
      assert.equal(actual.result.capacityReturned, false);
      assert.notEqual(actual.result.disposition, "INTERNAL_ERROR", `UNEXPECTED_INTERNAL_ERROR:${kind}`);
      report.refusals.push({ name: kind, reason: actual.result.reason, framesRead: actual.result.framesRead });
    }
    const fullSettings = await json(full.settings), expected = await json(fullSettings.expected);
    for (const resource of fullSettings.resources) {
      const values = expected[resource.resourceId].occupation.map(BigInt);
      const maximum = values.reduce((a, b) => a > b ? a : b), requested = 100000000n - 7n - maximum + 1n;
      const actual = await invoke(full.settings, { kind: "one-short", resourceId: resource.resourceId, requested: String(requested) },
        `one-short-${resource.resourceId}`);
      assert.equal(actual.exitCode, 2); assert.equal(actual.result.reason, "Z1_SHARED_S5_RESOURCE_EXHAUSTED");
      report.refusals.push({ name: actual.name, reason: actual.result.reason, requested: String(requested) });
    }
    report.byteCounterexamples = generation.byteCounterexamples;
    report.status = "PASSED";
  } catch (error) {
    report.status = "FAILED"; report.failure = { message: error.message, stack: error.stack };
    process.exitCode = 1;
  }
  await save(resolve(destination, "report.json"), report);
  process.stdout.write(JSON.stringify({ status: report.status, positives: report.positives.length, refusals: report.refusals.length,
    nativeOwnerFlow: report.nativeOwnerFlow, sqlCursorExecution: report.sqlCursorExecution }) + "\n");
}

if (process.argv[2] === "--read") await child(process.argv[3], process.argv[4]);
else await main(process.argv[2]);
