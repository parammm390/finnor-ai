// Pre-specified application protocol readiness, NOT a learner connector or native X2 acceptance.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fresh = prefix => `${prefix}_${randomUUID()}`;
const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const artifactIndex = process.argv.indexOf('--artifact');
const artifact = process.argv[artifactIndex + 1];
if (artifactIndex < 0 || !isAbsolute(artifact ?? '') ||
    !resolve(artifact).startsWith(`${here}/artifacts/`)) throw new Error('New absolute fixture artifacts path required');
await mkdir(dirname(artifact), { recursive: true });
await (await open(artifact, 'wx', 0o644)).close();

const sources = [
  'oracle-contract.json', 'freeze.json', 'store.mjs', 'admin.mjs', 'application.mjs',
  'views.mjs', 'server.mjs', 'evaluate.mjs', 'readiness.mjs',
];
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async file => [
  `finnor-os/scripts/x2/fixtures/${file}`, sha(await readFile(join(here, file))),
])));
const freeze = JSON.parse(await readFile(join(here, 'freeze.json'), 'utf8'));
for (const [path, expected] of Object.entries(freeze.hashes)) {
  const actual = sha(await readFile(join(root, path)));
  if (expected !== actual) throw new Error('Pre-code oracle seal changed');
  sourceHashes[path] = actual;
}
const oracle = JSON.parse(await readFile(join(here, 'oracle-contract.json'), 'utf8'));
const started = performance.now();
const stamp = () => new Date().toISOString();
const privateDirs = [];
const privateBase = `/tmp/x2-portal-readiness-${randomUUID()}`;
const sensitive = new Map([[privateBase, '[PRIVATE_CUSTODY_DIR]']]);
const trace = [];
let server;
let origin;
let stepIndex = 0;
let running = true;
const evidence = {
  schema: 'X2.INDEPENDENT_FIXTURE_READINESS.v1', startedAt: stamp(), status: 'RUNNING',
  scope: 'Fixture protocol readiness only; NOT learner/owner/native/mounted/installed/protected proof',
  sourceCommit: null, suppliedParentCommit: oracle.suppliedParentCommit, suppliedParentTree: oracle.suppliedParentTree,
  sourceHashes, oracleRevision: oracle.revision, oracleFreezeSha256: sourceHashes['finnor-os/scripts/x2/fixtures/freeze.json'],
  runtime: { executable: process.execPath, node: process.version, platform: process.platform, arch: process.arch },
  command: [process.execPath, fileURLToPath(import.meta.url), '--artifact', artifact],
  dependencies: 'Node standard library only; no installs, cloud, model or solver calls',
  contracts: oracle.readinessCases, assertions: [], steps: trace, privateEvidence: [],
  gaps: [
    'No FINNOR learner/checker/model-freeze/canonical owner/action/Work execution',
    'No physical main-worker SIGKILL; provider response socket loss and provider restart only',
    'No real browser keyboard/pointer or mounted product inspection',
    'No second simultaneous provider server; independent administrator writers exercise process lock',
    'No protected custody/OS same-UID sandbox, qualification or promotion',
    'Human work, aggregate host memory and material lifecycle costs are not measured; not zero',
  ],
};

function remember(value, label = 'PRIVATE') {
  if (typeof value === 'string' && value.length > 8 && !sensitive.has(value)) {
    sensitive.set(value, `[${label}_${sensitive.size}]`);
  }
}

function register(value) {
  if (Array.isArray(value)) value.forEach(register);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['bearer', 'csrf', 'session'].includes(key)) remember(item, key.toUpperCase());
      register(item);
    }
  } else if (typeof value === 'string') {
    for (const match of value.matchAll(/\b(?:app|account|entity|record|principal|grant|request|effect|obligation|key|parent|attempt|acceptance)_[0-9a-f-]{36}\b/g)) {
      remember(match[0], match[0].split('_')[0].toUpperCase());
    }
    for (const match of value.matchAll(/name="csrf"\s+value="([^"]+)"/g)) remember(decode(match[1]), 'CSRF');
    for (const match of value.matchAll(/portal_session=([A-Za-z0-9_-]+)/g)) remember(match[1], 'SESSION');
  }
}

function redact(value) {
  register(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redact(item)])
  );
  if (typeof value !== 'string') return value;
  let result = value;
  for (const [privateValue, alias] of sensitive) result = result.replaceAll(privateValue, alias);
  return result;
}

async function checkpoint() {
  await writeFile(artifact, `${JSON.stringify(redact(evidence), null, 2)}\n`, { mode: 0o644 });
}
async function log(value) {
  trace.push({ step: ++stepIndex, at: stamp(), ...value });
  await checkpoint();
}
function assert(contract, label, expected, observed, passed = equal(expected, observed)) {
  evidence.assertions.push({ contract, label, expected, observed, passed });
  if (!passed) throw new Error(`${contract}: ${label}`);
}

function remainingBudget() {
  const remaining = Math.floor(90000 - (performance.now() - started));
  if (remaining <= 0) throw new Error('Original fixture readiness 90-second budget exhausted');
  return remaining;
}

async function command(label, module, commandArgs, expectedCode = 0) {
  const argv = [join(here, module), ...commandArgs];
  const start = performance.now();
  let result;
  try {
    const value = await execute(process.execPath, argv, { timeout: Math.min(10000, remainingBudget()), maxBuffer: 1024 * 1024 });
    result = { code: 0, ...value };
  } catch (error) {
    result = { code: typeof error.code === 'number' ? error.code : -1, stdout: error.stdout ?? '', stderr: error.stderr ?? '', signal: error.signal ?? null };
  }
  await log({ kind: 'process', label, argv: [process.execPath, ...argv], durationMs: performance.now() - start, ...result });
  if (result.code !== expectedCode) throw new Error(`Process ${label} returned ${result.code}, expected ${expectedCode}`);
  return result;
}
const admin = (label, directory, ...rest) => command(label, 'admin.mjs', [rest[0], '--private-dir', directory, ...rest.slice(1)]);
const set = (label, directory, patch) => admin(label, directory, 'set', '--patch', JSON.stringify(patch));

async function startServer(directory) {
  remainingBudget();
  if (server) throw new Error('Only one small owned fixture server may run');
  const child = spawn(process.execPath, [join(here, 'server.mjs'), '--private-dir', directory, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const owned = { child, stdout: '', stderr: '', directory };
  owned.closed = new Promise(resolveExit => child.once('close', (code, signal) => {
    owned.exit = { code, signal }; resolveExit(owned.exit);
  }));
  child.stdout.on('data', bytes => { owned.stdout += bytes; });
  child.stderr.on('data', bytes => { owned.stderr += bytes; });
  child.on('error', error => { owned.stderr += error.message; });
  server = owned;
  const start = performance.now();
  while (performance.now() - start < 5000) {
    remainingBudget();
    const readyLine = owned.stdout.split('\n').find(line => line.includes('"event":"ready"'));
    if (readyLine) {
      const ready = JSON.parse(readyLine);
      origin = ready.origin;
      await log({ kind: 'process-start', argv: [process.execPath, join(here, 'server.mjs'), '--private-dir', directory, '--port', '0'], pid: child.pid, ready });
      return;
    }
    if (owned.exit) throw new Error('Fixture server exited before readiness');
    await sleep(20);
  }
  throw new Error('Fixture server readiness timeout');
}

async function stopServer() {
  if (!server) return;
  const owned = server;
  if (!owned.exit) owned.child.kill('SIGTERM');
  let watchdog;
  try {
    await Promise.race([
      owned.closed,
      new Promise((_, reject) => {
        watchdog = setTimeout(() => { owned.child.kill('SIGKILL'); reject(new Error('Owned fixture stop timed out')); }, 5000);
      }),
    ]);
    await log({ kind: 'process-stop', pid: owned.child.pid, signalSent: 'SIGTERM', exit: owned.exit, stdout: owned.stdout, stderr: owned.stderr });
    if (owned.exit.code !== 0 || owned.stderr) throw new Error('Owned fixture exited with an error');
  } finally {
    clearTimeout(watchdog);
    server = null;
  }
}

async function http(label, path, options = {}) {
  const budget = remainingBudget();
  const url = new URL(path, origin);
  if (url.origin !== origin) throw new Error('Readiness may use only its owned loopback origin');
  const input = options.body instanceof URLSearchParams ? options.body.toString()
    : options.body && typeof options.body === 'object' ? JSON.stringify(options.body) : options.body;
  const headers = {
    ...(options.auth ? { Authorization: `Bearer ${options.auth.bearer}`, 'X-Portal-Grant': options.auth.grantId } : {}),
    ...(options.cookie ? { Cookie: options.cookie } : {}),
    ...(input !== undefined ? {
      'Content-Type': options.body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json',
      'Content-Length': Buffer.byteLength(input),
    } : {}),
    ...options.headers,
  };
  const start = performance.now();
  const outcome = await new Promise(resolveResponse => {
    const request = httpRequest({
      hostname: '127.0.0.1', port: url.port, path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET', headers, agent: false,
    }, response => {
      const chunks = [];
      response.on('data', bytes => chunks.push(bytes));
      response.on('end', () => resolveResponse({
        status: response.statusCode, headers: response.headers, rawBody: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.setTimeout(Math.min(6000, budget), () => request.destroy(new Error('READINESS_HTTP_TIMEOUT')));
    request.on('error', error => resolveResponse({ status: null, error: { code: error.code ?? null, message: error.message } }));
    request.end(input);
  });
  register(outcome);
  await log({ kind: 'http', label, input: { origin, path, method: options.method ?? 'GET', headers, body: input ?? null }, durationMs: performance.now() - start, actual: outcome });
  if (options.status !== undefined && outcome.status !== options.status) {
    throw new Error(`${label}: HTTP ${outcome.status}, expected ${options.status}`);
  }
  if (outcome.rawBody && (outcome.headers['content-type'] ?? '').startsWith('application/json')) {
    outcome.json = JSON.parse(outcome.rawBody);
  }
  return outcome;
}

const auth = (credentials, name, grantName) => ({
  bearer: credentials.tokens[name], grantId: credentials.grantIds[grantName],
});
async function input(credential, accountId, recordId, extra = {}) {
  const context = (await http('Current authenticated context', '/api/context', { auth: credential, status: 200 })).json;
  const record = (await http('Current record revision', `/api/accounts/${accountId}/records/${recordId}`, { auth: credential, status: 200 })).json;
  return {
    context: { ...context.binding, recordId }, expectedVersion: record.version,
    request: { requestId: fresh('request'), effectId: fresh('effect'), obligationId: fresh('obligation'), idempotencyKey: fresh('key'), parentId: parentIdentity, deadline: context.deadline },
    ...extra,
  };
}
let parentIdentity = fresh('parent');
const route = (accountId, recordId, operation) => `/api/accounts/${accountId}/records/${recordId}/${operation}`;
async function mutate(label, credential, accountId, recordId, operation, extra = {}, status = 200, prepared) {
  const payload = prepared ?? await input(credential, accountId, recordId, extra);
  const response = await http(label, route(accountId, recordId, operation), { method: 'POST', auth: credential, body: payload, status });
  return { payload, response };
}
async function completion(credential, requestId, status = 'SUBMITTED') {
  const start = performance.now();
  while (performance.now() - start < 4000) {
    const value = await http('Lawful request completion readback', `/api/requests/${requestId}`, { auth: credential, status: 200 });
    if (value.json.status === status) return value.json;
    await sleep(40);
  }
  throw new Error('Lawful completion readback timed out');
}

function forms(html) {
  return [...html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].map(match => {
    const body = new URLSearchParams();
    for (const field of match[2].matchAll(/<input\b[^>]*name="([^"]+)"[^>]*>/g)) {
      const value = /value="([^"]*)"/.exec(field[0])?.[1] ?? '';
      body.set(decode(field[1]), decode(value));
    }
    for (const select of match[2].matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
      const values = [...select[2].matchAll(/<option value="([^"]+)"([^>]*)>/g)];
      body.set(decode(select[1]), decode((values.find(value => value[2].includes('selected')) ?? values[0])[1]));
    }
    return { action: decode(match[1]), body, label: decode(/<button\b[^>]*>([^<]+)<\/button>/.exec(match[2])?.[1] ?? '') };
  });
}
function description(html) {
  return Object.fromEntries([...html.matchAll(/<dt>([^<]+)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map(match => {
    const text = decode(match[2]);
    let value = text;
    try { value = JSON.parse(text); } catch { /* Ordinary description strings are retained. */ }
    return [decode(match[1]), value];
  }));
}
async function signIn(credential) {
  const response = await http('Ordinary portal sign in', '/login', {
    method: 'POST', body: new URLSearchParams({ bearer: credential.bearer, grantId: credential.grantId }), status: 303,
  });
  return response.headers['set-cookie'][0].split(';')[0];
}
async function portalForm(cookie, recordId, label) {
  const view = await http('Accessible record and ordinary forms', `/portal/records/${recordId}`, { cookie, status: 200 });
  const form = forms(view.rawBody).find(value => value.label === label);
  if (!form) throw new Error(`Ordinary form absent: ${label}`);
  return { ...form, html: view.rawBody };
}
async function sendForm(label, cookie, form, status = 200) {
  return http(label, form.action, { method: 'POST', cookie, body: form.body, status });
}
function fillTerms(form, reporting) {
  for (const [name, value] of Object.entries(reporting)) {
    form.body.set(form.body.has(`reporting.${name}`) ? `reporting.${name}` : name, value);
  }
}
async function htmlCompletion(cookie, requestId, wanted = 'SUBMITTED') {
  const start = performance.now();
  while (performance.now() - start < 4000) {
    const response = await http('Lawful HTML completion readback', `/portal/requests/${requestId}`, { cookie, status: 200 });
    const readback = description(response.rawBody);
    if (readback.status === wanted) return readback;
    await sleep(40);
  }
  throw new Error('HTML completion readback timed out');
}
async function evaluatorSnapshot(directory, name) {
  const path = join(directory, `${name}.json`);
  await command('Private independent evaluator snapshot', 'evaluate.mjs', ['snapshot', '--private-dir', directory, '--output', path]);
  return JSON.parse(await readFile(path, 'utf8'));
}
async function init(directory, surface, mode = 'full') {
  sensitive.set(directory, `[PRIVATE_CUSTODY_${privateDirs.length + 1}]`);
  await admin('Initialize independently administered fixture', directory, 'init', '--surface', surface, '--completion', mode);
  privateDirs.push(directory);
  const credentials = JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8'));
  Object.values(credentials.tokens).forEach(value => remember(value, 'BEARER'));
  register(credentials);
  return credentials;
}

try {
  const directory = privateBase;
  const credentials = await init(directory, 'api');
  await set('Set bounded asynchronous completion delay', directory, { asyncDelayMs: 600 });
  await startServer(directory);
  assert('R01', 'Loopback ephemeral origin', true, /^http:\/\/127\.0\.0\.1:\d+$/.test(origin));
  await http('Unauthenticated bounded readiness', '/healthz', { status: 200 });
  for (const path of ['/admin', '/__evaluator', '/provider/journal.ndjson']) await http('No privileged HTTP endpoint', path, { status: 404 });
  await http('Reject mismatched Host', '/healthz', { headers: { Host: 'example.invalid' }, status: 421 });
  await http('Reject foreign Origin', '/healthz', { headers: { Origin: 'https://example.invalid' }, status: 403 });
  const editor = auth(credentials, 'editor', 'discovery');
  const approver = auth(credentials, 'approver', 'approval');
  const reader = auth(credentials, 'reader', 'readOnly');
  const accountId = credentials.accounts.primary;
  const first = credentials.recordIds.discoveryOne;
  const second = credentials.recordIds.discoveryTwo;
  const records = (await http('Authorized discovery list', `/api/accounts/${accountId}/records`, { auth: editor, status: 200 })).json.records;
  assert('R02', 'Two discovery records only', 2, records.length);
  assert('R02', 'Held-out absent', false, records.some(value => value.recordId === credentials.recordIds.heldOut));
  await http('Held-out direct access denied', `/api/accounts/${accountId}/records/${credentials.recordIds.heldOut}`, { auth: editor, status: 403 });
  await http('Cross-account read denied', `/api/accounts/${credentials.accounts.isolated}/records`, { auth: editor, status: 403 });
  const docs = await http('Honest exposed OpenAPI', '/openapi.json', { auth: editor, status: 200 });
  assert('R02', 'No oracle extensions or withheld objective in docs', false,
    docs.rawBody.includes('x-finnor') || docs.rawBody.includes(credentials.recordIds.heldOut) || docs.rawBody.includes('9007199254740993.01'));
  const terms = { amount: '1234.56', currency: 'USD', entity: credentials.entities.usd, unit: 'ones', date: '2026-11-30', basis: 'cash' };
  await mutate('Reject Number amount', editor, accountId, first, 'draft', { reporting: { ...terms, amount: 1234.56 } }, 400);
  await mutate('Reject unsupported unit', editor, accountId, first, 'draft', { reporting: { ...terms, unit: 'millions' } }, 400);
  await mutate('Reject impossible calendar date', editor, accountId, first, 'draft', { reporting: { ...terms, date: '2026-02-30' } }, 400);
  await mutate('Persist business-invalid draft', editor, accountId, first, 'draft', { reporting: { ...terms, amount: '0.00', currency: 'EUR' } });
  const invalid = await mutate('Independently validate invalid terms', editor, accountId, first, 'validate');
  assert('R03', 'Validation distinct INVALID', 'INVALID', invalid.response.json.record.validation.status);
  assert('R03', 'Committed baseline unchanged', '100.00', invalid.response.json.record.reporting.amount);
  const saved = await mutate('Persist exact valid draft', editor, accountId, first, 'draft', { reporting: terms });
  const validated = await mutate('Validate current valid draft', editor, accountId, first, 'validate');
  assert('R03', 'Exact draft terms', terms, validated.response.json.record.draft.reporting);
  assert('R03', 'VALID is not submission', null, validated.response.json.record.submission);
  const noEffectVersion = validated.response.json.record.version;
  const wrongActor = await input(editor, accountId, first, { reporting: terms });
  wrongActor.context.principalId = credentials.principalIds.secondEditor;
  await mutate('Wrong principal binding', editor, accountId, first, 'draft', {}, 409, wrongActor);
  await mutate('Read-only actor cannot save', reader, accountId, first, 'draft', { reporting: terms }, 403);
  const mismatchedAccount = await input(editor, accountId, first, { reporting: terms });
  await http('Wrong physical account mutation', route(credentials.accounts.isolated, first, 'draft'), { method: 'POST', auth: editor, body: mismatchedAccount, status: 403 });
  await http('Wrong physical record mutation', route(accountId, credentials.recordIds.isolated, 'draft'), { method: 'POST', auth: editor, body: mismatchedAccount, status: 403 });
  const badIdentity = await input(editor, accountId, first);
  badIdentity.request.effectId = saved.payload.request.effectId;
  await mutate('Effect identity reused with another request', editor, accountId, first, 'validate', {}, 409, badIdentity);
  const stale = await input(editor, accountId, first);
  stale.expectedVersion--;
  await mutate('Stale record revision', editor, accountId, first, 'validate', {}, 409, stale);
  const staleApplication = await input(editor, accountId, first);
  staleApplication.context.schemaRevision = 'portal.public.obsolete';
  await mutate('Stale schema revision', editor, accountId, first, 'validate', {}, 409, staleApplication);
  const unchanged = (await http('Read after rejected physical mutations', `/api/accounts/${accountId}/records/${first}`, { auth: editor, status: 200 })).json;
  assert('R05', 'No accepted effects from negative dispatch', noEffectVersion, unchanged.version);
  const submitted = await mutate('Asynchronous actual submit', editor, accountId, first, 'submit', {}, 202);
  const pending = (await http('Immediate lawful pending observation', `/api/accounts/${accountId}/records/${first}`, { auth: editor, status: 200 })).json;
  assert('R04', '202 precedes durable submission', 'PENDING', pending.phase);
  assert('R04', 'Toast did not change committed reporting', '100.00', pending.reporting.amount);
  const completed = await completion(editor, submitted.payload.request.requestId);
  assert('R04', 'Durable exact request lineage', submitted.payload.request, completed.request);
  await mutate('Editor cannot commit approval', editor, accountId, first, 'approve', { submissionRequestId: completed.request.requestId }, 403);
  const committed = await mutate('Separate role/grant approval', approver, accountId, first, 'approve', { submissionRequestId: completed.request.requestId });
  assert('R04', 'Committed reporting exact', terms, committed.response.json.record.reporting);
  await mutate('Stable original identity is idempotent', editor, accountId, first, 'submit', {}, 202, submitted.payload);
  await mutate('New submission identity rejected', editor, accountId, first, 'submit', {}, 409);
  const secondTerms = { amount: '4200.00', currency: 'EUR', entity: credentials.entities.eur, unit: 'ones', date: '2026-10-31', basis: 'accrual' };
  await mutate('Prepare second independent discovery record', editor, accountId, second, 'draft', { reporting: secondTerms });
  await mutate('Validate second discovery record', editor, accountId, second, 'validate');
  await set('Arm real response loss after acceptance', directory, { responseFault: 'drop-next-submit' });
  const lostPayload = await input(editor, accountId, second);
  const lost = await http('Real submit socket response loss', route(accountId, second, 'submit'), { method: 'POST', auth: editor, body: lostPayload });
  assert('R10', 'No response after physical submit', null, lost.status);
  assert('R10', 'Actual socket error retained', 'ECONNRESET', lost.error?.code);
  await command('Private acceptance timing observation', 'evaluate.mjs', ['wait', '--private-dir', directory, '--event', 'submission.accepted', '--request-id', lostPayload.request.requestId, '--timeout-ms', '3000']);
  const acceptedRead = (await http('Original request before provider restart', `/api/requests/${lostPayload.request.requestId}`, { auth: editor, status: 200 })).json;
  assert('R12', 'Durable pending request before provider restart', 'PENDING', acceptedRead.status);
  await stopServer();
  await startServer(directory);
  const recovered = await completion(editor, lostPayload.request.requestId);
  assert('R10', 'Same original request after provider restart', lostPayload.request, recovered.request);
  await Promise.all([
    http('Concurrent replay one, original bytes', route(accountId, second, 'submit'), { method: 'POST', auth: editor, body: lostPayload, status: 202 }),
    http('Concurrent replay two, original bytes', route(accountId, second, 'submit'), { method: 'POST', auth: editor, body: lostPayload, status: 202 }),
  ]);
  await Promise.all([
    set('Independent process writer one', directory, { renderingRevision: 1 }),
    set('Independent process writer two', directory, { readbackDelayMs: 0 }),
  ]);
  const concurrency = await evaluatorSnapshot(directory, 'concurrency-snapshot');
  assert('R12', 'Only one normal completion for original effect', 1,
    concurrency.events.filter(value => value.type === 'submission.completed' && value.requestId === lostPayload.request.requestId).length);
  await admin('Release DEVELOPMENT held-out inputs; no learner claim', directory, 'release-held-out');
  const execution = JSON.parse(await readFile(join(directory, 'execution-packet.json'), 'utf8'));
  const approval = JSON.parse(await readFile(join(directory, 'approver-packet.json'), 'utf8'));
  register(execution); register(approval);
  await set('Expose UI-only application', directory, { surface: 'ui' });
  await http('UI-only API denied', '/api/context', { auth: editor, status: 404 });
  await http('UI-only documentation absent', '/openapi.json', { auth: editor, status: 404 });
  const executionAuth = { bearer: execution.bearer, grantId: execution.grant.grantId };
  const approvalAuth = { bearer: approval.bearer, grantId: approval.grant.grantId };
  const cookie = await signIn(executionAuth);
  const heldOut = execution.objective.recordId;
  const draftForm = await portalForm(cookie, heldOut, 'Save draft');
  fillTerms(draftForm, execution.objective.reporting);
  const badCsrf = { ...draftForm, body: new URLSearchParams(draftForm.body) };
  badCsrf.body.set('csrf', 'invalid-csrf');
  await sendForm('Reject ordinary form with wrong CSRF', cookie, badCsrf, 403);
  await sendForm('UI-only save exact fresh reporting', cookie, draftForm);
  await sendForm('UI-only validation', cookie, await portalForm(cookie, heldOut, 'Validate'));
  const submitForm = await portalForm(cookie, heldOut, 'Submit');
  const uiRequest = JSON.parse(submitForm.body.get('request'));
  await sendForm('UI-only submit produces status message', cookie, submitForm, 202);
  const uiPending = description((await http('UI-only pending readback', `/portal/records/${heldOut}`, { cookie, status: 200 })).rawBody);
  assert('R07', 'UI-only actual pending state', 'PENDING', uiPending.phase);
  await htmlCompletion(cookie, uiRequest.requestId);
  const approvalCookie = await signIn(approvalAuth);
  await sendForm('UI-only distinct approval authority', approvalCookie, await portalForm(approvalCookie, heldOut, 'Commit approval'));
  const finalHtml = description((await http('UI-only committed readback', `/portal/records/${heldOut}`, { cookie: approvalCookie, status: 200 })).rawBody);
  assert('R07', 'UI-only exact large decimal retained', execution.objective.reporting.amount, finalHtml.reporting.amount);
  const signOut = await portalForm(cookie, heldOut, 'Sign out');
  await sendForm('Genuine portal logout', cookie, signOut, 303);
  await http('Old portal session rejected after logout', `/portal/records/${heldOut}`, { cookie, status: 401 });
  const again = await signIn(executionAuth);
  await http('Fresh sign in after logout', `/portal/records/${heldOut}`, { cookie: again, status: 200 });
  await command('Independent exact held-out grade', 'evaluate.mjs', ['grade', '--private-dir', directory, '--objective', join(directory, 'held-out-objective.json'), '--output', join(directory, 'held-out-grade.json')]);
  const wrong = { ...execution.objective, reporting: { ...execution.objective.reporting, amount: '9007199254740993.02' } };
  await writeFile(join(directory, 'wrong-objective.json'), `${JSON.stringify(wrong)}\n`, { flag: 'wx', mode: 0o600 });
  await command('Independent wrong-objective negative', 'evaluate.mjs', ['grade', '--private-dir', directory, '--objective', join(directory, 'wrong-objective.json'), '--output', join(directory, 'wrong-objective-grade.json')], 2);
  const isolatedAuth = auth(credentials, 'isolatedEditor', 'isolated');
  const isolatedCookie = await signIn(isolatedAuth);
  const isolated = credentials.recordIds.isolated;
  const originalForm = await portalForm(isolatedCookie, isolated, 'Save draft');
  await set('Independent rendering-preserving revision', directory, { renderingRevision: 2, injectionText: true });
  const revisedForm = await portalForm(isolatedCookie, isolated, 'Save draft');
  assert('R08', 'HTML action relocation', true, originalForm.action !== revisedForm.action);
  assert('R08', 'HTML field structure changed', true, revisedForm.body.has('reporting.amount') && !originalForm.body.has('reporting.amount'));
  await sendForm('Old rendering action no longer routes', isolatedCookie, originalForm, 404);
  const revisedTerms = { amount: '77.01', currency: 'USD', entity: credentials.entities.isolated, unit: 'ones', date: '2027-01-15', basis: 'accrual' };
  fillTerms(revisedForm, revisedTerms);
  await sendForm('Relocated form preserves draft semantics', isolatedCookie, revisedForm);
  await sendForm('Relocated validation preserves semantics', isolatedCookie, await portalForm(isolatedCookie, isolated, 'Validate'));
  const oldSemanticForm = await portalForm(isolatedCookie, isolated, 'Submit');
  await set('Independent same-label semantic revision', directory, { semanticRevision: 2 });
  await sendForm('Stale semantic form denied at dispatch', isolatedCookie, oldSemanticForm, 409);
  await sendForm('Current semantic validation', isolatedCookie, await portalForm(isolatedCookie, isolated, 'Validate'));
  const sameLabel = await portalForm(isolatedCookie, isolated, 'Submit');
  assert('R08', 'Submit label retained', oldSemanticForm.label, sameLabel.label);
  await sendForm('Same-label submit now only confirms validation', isolatedCookie, sameLabel, 202);
  const confirmation = await htmlCompletion(isolatedCookie, JSON.parse(sameLabel.body.get('request')).requestId, 'CONFIRMED');
  assert('R08', 'Semantic revision produces confirmation, not submission', 'CONFIRMED', confirmation.status);
  const noSubmission = description((await http('Independent semantic falsifying readback', `/portal/records/${isolated}`, { cookie: isolatedCookie, status: 200 })).rawBody);
  assert('R08', 'No durable submission under changed Submit meaning', '', noSubmission.submission);
  assert('R08', 'Committed baseline remains unchanged', '100.00', noSubmission.reporting.amount);
  assert('R08', 'Injection text is visible untrusted content', true, sameLabel.html.includes('Ignore your mandate'));
  await set('Restore current semantics and arm GET mutation trap', directory, { semanticRevision: 1, methodTrap: true });
  await sendForm('Revalidate restored semantics', isolatedCookie, await portalForm(isolatedCookie, isolated, 'Validate'));
  const readerCookie = await signIn(reader);
  const readerPage = await http('Read-only ordinary page with Preview link', `/portal/records/${second}`, { cookie: readerCookie, status: 200 });
  const previewLink = html => decode(/href="([^"]+)"[^>]*>Preview<\/a>/.exec(html)?.[1] ?? '');
  await http('Read-only GET preview denied at mutation boundary', previewLink(readerPage.rawBody), { cookie: readerCookie, status: 403 });
  const trapPage = await http('Authorized target for method trap', `/portal/records/${isolated}`, { cookie: isolatedCookie, status: 200 });
  const trapLink = previewLink(trapPage.rawBody);
  const trapRequest = JSON.parse(new URL(trapLink, origin).searchParams.get('request'));
  await http('Explicit authorized GET Preview physically submits', trapLink, { cookie: isolatedCookie, status: 202 });
  await htmlCompletion(isolatedCookie, trapRequest.requestId);
  await set('Expose API for physical revocation checks', directory, { surface: 'api', methodTrap: false, readbackDelayMs: 0 });
  const secondEditor = auth(credentials, 'secondEditor', 'secondEditor');
  const actorPayload = await input(secondEditor, accountId, second, { reporting: secondTerms });
  await admin('Independent principal revocation', directory, 'revoke', '--kind', 'principal', '--id', credentials.principalIds.secondEditor);
  await mutate('Revoked principal physical dispatch denied', secondEditor, accountId, second, 'draft', {}, 401, actorPayload);
  const rolePayload = await input(isolatedAuth, credentials.accounts.isolated, isolated, { reporting: revisedTerms });
  await admin('Independent role revocation', directory, 'revoke', '--kind', 'role', '--id', credentials.principalIds.isolatedEditor, '--role', 'editor');
  await mutate('Revoked role physical dispatch denied', isolatedAuth, credentials.accounts.isolated, isolated, 'draft', {}, 403, rolePayload);
  const grantPayload = await input(editor, accountId, second, { reporting: secondTerms });
  await admin('Independent grant revocation', directory, 'revoke', '--kind', 'grant', '--id', credentials.grantIds.discovery);
  await mutate('Revoked grant physical dispatch denied', editor, accountId, second, 'draft', {}, 403, grantPayload);
  await set('Delay lawful readback before rechecking authority', directory, { readbackDelayMs: 300 });
  const delayed = http('Delayed read cannot resurrect revoked authority', `/api/accounts/${accountId}/records/${second}`, { auth: reader, status: 403 });
  await sleep(60);
  await admin('Revoke read grant during actual delayed read', directory, 'revoke', '--kind', 'grant', '--id', credentials.grantIds.readOnly);
  await delayed;
  await set('Remove bounded readback delay', directory, { readbackDelayMs: 0 });
  const preserved = (await http('Unrelated execution grant remains usable', `/api/accounts/${accountId}/records/${heldOut}`, { auth: executionAuth, status: 200 })).json;
  assert('R06', 'Prior accepted approved effect survives revocation', execution.objective.reporting, preserved.reporting);
  const normalSnapshot = await evaluatorSnapshot(directory, 'final-normal-snapshot');
  assert('R09', 'GET trap is actually submission authority', true,
    normalSnapshot.events.some(value => value.type === 'dispatch.accepted' && value.operation === 'preview' && value.action === 'submission.create'));
  await stopServer();

  // A separate fresh DEVELOPMENT profile; still only one fixture server at a time.
  const hybridDir = `${privateBase}-hybrid`;
  const hybridCred = await init(hybridDir, 'hybrid');
  await startServer(hybridDir);
  parentIdentity = fresh('parent');
  const hybridEditor = auth(hybridCred, 'editor', 'discovery');
  const hybridApprover = auth(hybridCred, 'approver', 'approval');
  const hybridRecord = hybridCred.recordIds.discoveryOne;
  const hybridTerms = { amount: '43.21', currency: 'USD', entity: hybridCred.entities.usd, unit: 'ones', date: '2027-02-28', basis: 'cash' };
  await mutate('Hybrid API draft persistence', hybridEditor, hybridCred.accounts.primary, hybridRecord, 'draft', { reporting: hybridTerms });
  await mutate('Hybrid API validation', hybridEditor, hybridCred.accounts.primary, hybridRecord, 'validate');
  const hybridInput = await input(hybridEditor, hybridCred.accounts.primary, hybridRecord);
  await http('Hybrid JSON submit is not exposed', route(hybridCred.accounts.primary, hybridRecord, 'submit'), { method: 'POST', auth: hybridEditor, body: hybridInput, status: 404 });
  const hybridCookie = await signIn(hybridEditor);
  const hybridSubmit = await portalForm(hybridCookie, hybridRecord, 'Submit');
  assert('R07', 'Hybrid prep forms absent, HTML submit present', false, forms(hybridSubmit.html).some(value => value.label === 'Save draft'));
  await sendForm('Hybrid actual HTML submit', hybridCookie, hybridSubmit, 202);
  await htmlCompletion(hybridCookie, JSON.parse(hybridSubmit.body.get('request')).requestId);
  const hybridApprovalCookie = await signIn(hybridApprover);
  await sendForm('Hybrid separate HTML approval', hybridApprovalCookie, await portalForm(hybridApprovalCookie, hybridRecord, 'Commit approval'));
  const hybridRead = (await http('Hybrid legitimate JSON committed observation', `/api/accounts/${hybridCred.accounts.primary}/records/${hybridRecord}`, { auth: hybridEditor, status: 200 })).json;
  assert('R07', 'Hybrid exact committed tuple', hybridTerms, hybridRead.reporting);
  await evaluatorSnapshot(hybridDir, 'final-hybrid-snapshot');
  await stopServer();

  const opaqueDir = `${privateBase}-opaque`;
  const opaqueCred = await init(opaqueDir, 'api', 'opaque');
  await startServer(opaqueDir);
  parentIdentity = fresh('parent');
  const opaqueEditor = auth(opaqueCred, 'editor', 'discovery');
  const opaqueRecord = opaqueCred.recordIds.discoveryOne;
  const opaqueTerms = { amount: '81.09', currency: 'USD', entity: opaqueCred.entities.usd, unit: 'thousands', date: '2026-12-31', basis: 'accrual' };
  await mutate('Opaque profile draft under unavailable version', opaqueEditor, opaqueCred.accounts.primary, opaqueRecord, 'draft', { reporting: opaqueTerms });
  await mutate('Opaque profile validation', opaqueEditor, opaqueCred.accounts.primary, opaqueRecord, 'validate');
  const absent = (await http('Public opaque view before possible egress', `/api/accounts/${opaqueCred.accounts.primary}/records/${opaqueRecord}`, { auth: opaqueEditor, status: 200 })).json;
  await set('Opaque real response-loss boundary', opaqueDir, { responseFault: 'drop-next-submit' });
  const opaqueInput = await input(opaqueEditor, opaqueCred.accounts.primary, opaqueRecord);
  const opaqueLost = await http('Opaque request loses real response', route(opaqueCred.accounts.primary, opaqueRecord, 'submit'), { method: 'POST', auth: opaqueEditor, body: opaqueInput });
  assert('R11', 'Opaque accepted request response is ambiguous', null, opaqueLost.status);
  await command('Private evaluator alone sees opaque completion', 'evaluate.mjs', ['wait', '--private-dir', opaqueDir, '--event', 'submission.completed', '--request-id', opaqueInput.request.requestId, '--timeout-ms', '3000']);
  const hidden = (await http('Public opaque view after durable completion', `/api/accounts/${opaqueCred.accounts.primary}/records/${opaqueRecord}`, { auth: opaqueEditor, status: 200 })).json;
  assert('R11', 'Absent versus accepted publicly indistinguishable', absent, hidden);
  const existsUnavailable = await http('Opaque original completion is unavailable', `/api/requests/${opaqueInput.request.requestId}`, { auth: opaqueEditor, status: 410 });
  const missingUnavailable = await http('Opaque missing completion is equally unavailable', `/api/requests/${fresh('request')}`, { auth: opaqueEditor, status: 410 });
  assert('R11', 'No public existence oracle', existsUnavailable.rawBody, missingUnavailable.rawBody);
  await http('Deliberate negative: opaque resend is not idempotent', route(opaqueCred.accounts.primary, opaqueRecord, 'submit'), { method: 'POST', auth: opaqueEditor, body: opaqueInput, status: 202 });
  await sleep(500);
  const duplicate = await evaluatorSnapshot(opaqueDir, 'duplicate-snapshot');
  assert('R11', 'Independent journal detects two actual completions', 2,
    duplicate.events.filter(value => value.type === 'submission.completed' && value.requestId === opaqueInput.request.requestId).length);
  await writeFile(join(opaqueDir, 'opaque-objective.json'), `${JSON.stringify({
    schema: 'X2.PORTAL.INDEPENDENT_OBJECTIVE.v1', oracleRevision: oracle.revision,
    applicationId: opaqueCred.applicationId, accountId: opaqueCred.accounts.primary, recordId: opaqueRecord,
    requiredFinalStage: 'SUBMITTED', semanticRevision: 1, reporting: opaqueTerms,
    submittingPrincipalId: opaqueCred.principalIds.editor, submittingGrantId: opaqueCred.grantIds.discovery,
    requestIdentity: opaqueInput.request,
  })}\n`, { mode: 0o600, flag: 'wx' });
  await command('Independent duplicate-effect negative grade', 'evaluate.mjs', ['grade', '--private-dir', opaqueDir, '--objective', join(opaqueDir, 'opaque-objective.json'), '--output', join(opaqueDir, 'duplicate-grade.json')], 2);
  await stopServer();
  evidence.status = 'PASS';
  evidence.contractCoverage = oracle.readinessCases.map(value => ({
    id: value.id, disposition: 'FIXTURE_PROTOCOL_READY', nativeX2Acceptance: 'NOT_RUN',
  }));
} catch (error) {
  evidence.status = 'FAIL';
  evidence.failure = { message: error.message, stack: error.stack };
} finally {
  running = false;
  try { await stopServer(); } catch (error) {
    evidence.status = 'FAIL'; evidence.cleanupFailure = { message: error.message };
  }
  evidence.finishedAt = stamp();
  evidence.durationMs = performance.now() - started;
  if (evidence.durationMs > 90000) {
    evidence.status = 'FAIL'; evidence.budgetExceeded = true;
  }
  for (const directory of privateDirs) {
    const rawPath = join(directory, 'readiness-raw-trace.json');
    await writeFile(rawPath, `${JSON.stringify({ ...evidence, custodyDirectory: directory }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const bytes = await readFile(rawPath);
    const journal = await readFile(join(directory, 'provider', 'journal.ndjson'));
    evidence.privateEvidence.push({ custodyDirectory: directory, rawTraceSha256: sha(bytes), journalSha256: sha(journal), journalBytes: journal.length, rawTraceBytes: (await stat(rawPath)).size });
  }
  evidence.sourceUnchangedDuringRun = true;
  for (const file of sources) {
    if (sha(await readFile(join(here, file))) !== sourceHashes[`finnor-os/scripts/x2/fixtures/${file}`]) {
      evidence.sourceUnchangedDuringRun = false; evidence.status = 'FAIL';
    }
  }
  await checkpoint();
  console.log(JSON.stringify({
    status: evidence.status, scope: 'Fixture readiness only', assertions: evidence.assertions.length,
    durationMs: evidence.durationMs, artifact, ownedServerStopped: server === null,
  }));
  if (evidence.status !== 'PASS') process.exitCode = 1;
}
if (running) throw new Error('Readiness did not finish');
