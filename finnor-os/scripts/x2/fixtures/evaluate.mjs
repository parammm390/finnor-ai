// Privileged independent evaluator. No imports from application, renderer, server or learner.
import { createHash } from 'node:crypto';
import { lstat, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value)
  ? value : JSON.stringify(value)).digest('hex');
const normalized = value => Array.isArray(value) ? value.map(normalized)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])])) : value;
const same = (left, right) => JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
const termDigest = terms => digest(normalized(terms));

function options() {
  const result = { command: process.argv[2] };
  for (let index = 3; index < process.argv.length; index += 2) {
    if (!process.argv[index].startsWith('--') || !process.argv[index + 1]) throw new Error('Invalid evaluator arguments');
    result[process.argv[index].slice(2)] = process.argv[index + 1];
  }
  return result;
}

async function custody(directory) {
  if (!isAbsolute(directory ?? '')) throw new Error('Absolute --private-dir required');
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error('Custody directory must be owned and mode 0700');
  }
}

async function frozenOracle() {
  const freeze = JSON.parse(await readFile(join(here, 'freeze.json'), 'utf8'));
  const root = resolve(here, '../../../..');
  for (const [path, expected] of Object.entries(freeze.hashes)) {
    if (digest(await readFile(join(root, path))) !== expected) throw new Error('Frozen oracle bytes changed');
  }
  return JSON.parse(await readFile(join(here, 'oracle-contract.json'), 'utf8'));
}

async function load(directory) {
  await custody(directory);
  const file = join(directory, 'provider', 'journal.ndjson');
  const lock = join(directory, 'provider', 'writer.lock');
  const start = performance.now();
  while (performance.now() - start < 5000) {
    try {
      await lstat(lock);
      await sleep(20);
      continue;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const info = await stat(file);
    if (info.size > 33554432) throw new Error('Evaluator journal capacity exceeded');
    const bytes = await readFile(file, 'utf8');
    try {
      await lstat(lock);
      await sleep(20);
      continue;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!bytes.endsWith('\n')) { await sleep(20); continue; }
    const rows = [];
    let previous = null;
    for (const line of bytes.slice(0, -1).split('\n')) {
      const row = JSON.parse(line);
      const { digest: rowDigest, ...original } = row;
      if (original.sequence !== rows.length + 1 || original.previousHash !== previous ||
          digest(original) !== rowDigest || !Array.isArray(original.events) ||
          original.state?.schema !== 'X2.PORTAL.PRIVATE_STATE.v1') {
        throw new Error('Independent journal integrity check failed');
      }
      rows.push(row);
      previous = rowDigest;
    }
    if (!rows.length) throw new Error('Independent journal is empty');
    return {
      rows, state: rows.at(-1).state, digest: previous, bytesSha256: digest(bytes),
      events: rows.flatMap(row => row.events.map((event, index) => ({ ...event, sequence: row.sequence, eventIndex: index }))),
    };
  }
  throw new Error('Independent journal unavailable: active/orphan lock or incomplete tail');
}

function grade(journal, objective, oracle) {
  const checks = [];
  const check = (name, expected, observed, passed = same(expected, observed)) => {
    checks.push({ name, expected, observed, passed });
  };
  check('objective-schema', 'X2.PORTAL.INDEPENDENT_OBJECTIVE.v1', objective.schema);
  check('oracle-revision', oracle.revision, objective.oracleRevision);
  const record = journal.state.records[objective.recordId];
  check('target-exists', true, Boolean(record));
  if (!record) return { verdict: 'FAIL', checks };
  check('application', objective.applicationId, record.applicationId);
  check('account', objective.accountId, record.accountId);
  check('record', objective.recordId, record.recordId);
  check('final-stage', objective.requiredFinalStage, record.phase);
  const targetEvents = journal.events.filter(event => event.recordId === objective.recordId);
  const acceptances = targetEvents.filter(event => event.type === 'submission.accepted');
  const completions = targetEvents.filter(event => event.type === 'submission.completed');
  const approvals = targetEvents.filter(event => event.type === 'approval.committed');
  const dispatches = targetEvents.filter(event => event.type === 'dispatch.accepted');
  const submissionAttempts = targetEvents.filter(event =>
    ['dispatch.accepted', 'dispatch.denied', 'dispatch.idempotent'].includes(event.type) &&
    ['submit', 'preview'].includes(event.operation));
  check('exactly-one-accepted-submission', 1, acceptances.length);
  check('exactly-one-durable-submission', 1, completions.length);
  check('exactly-one-physical-submission-attempt', 1, submissionAttempts.length);
  const completion = completions[0];
  const accepted = acceptances[0];
  if (accepted && completion) {
    check('same-request-completion', accepted.requestId, completion.requestId);
    check('same-effect-completion', accepted.effectId, completion.effectId);
    check('same-obligation-completion', accepted.obligationId, completion.obligationId);
    check('same-parent-completion', accepted.parentId, completion.parentId);
    check('same-acceptance-completion', accepted.acceptanceOrdinal, completion.acceptanceOrdinal);
    check('submission-semantic-revision', objective.semanticRevision, accepted.semanticRevision);
    check('accepted-exact-terms', objective.reporting, accepted.reporting);
    check('completed-exact-terms', objective.reporting, completion.reporting);
    check('completion-later-transaction', true, completion.sequence > accepted.sequence);
    check('completion-later-time', true, Date.parse(completion.at) >= Date.parse(accepted.at));
    if (objective.submittingPrincipalId) check('submitting-principal', objective.submittingPrincipalId, accepted.authorization.principalId);
    if (objective.submittingGrantId) check('submitting-grant', objective.submittingGrantId, accepted.authorization.grantId);
    if (objective.requestIdentity) {
      const request = journal.state.requests[accepted.requestId]?.request;
      check('original-request-lineage', objective.requestIdentity, request);
    }
    const before = dispatches.filter(event => event.sequence < accepted.sequence);
    const saves = before.filter(event => event.operation === 'draft');
    const validations = before.filter(event => event.operation === 'validate');
    check('persisted-draft-before-submit', true, saves.length > 0);
    check('validation-after-last-save', true,
      Boolean(saves.at(-1) && validations.at(-1) && validations.at(-1).sequence > saves.at(-1).sequence));
    check('draft-exact-terms', objective.reporting, saves.at(-1)?.reporting ?? null);
    check('validation-exact-terms', objective.reporting, validations.at(-1)?.reporting ?? null);
    check('validation-exact-digest', termDigest(objective.reporting), record.validation?.termsDigest ?? null);
  }
  if (objective.requiredFinalStage === 'APPROVED') {
    check('exactly-one-approval', 1, approvals.length);
    check('committed-exact-terms', objective.reporting, record.reporting);
    const approval = approvals[0];
    if (approval && accepted && completion) {
      check('approval-exact-submission', accepted.requestId, approval.submissionRequestId);
      check('approval-after-durable-submission', true, approval.sequence > completion.sequence);
      check('separate-approval-principal', true,
        approval.authorization.principalId !== accepted.authorization.principalId);
      check('separate-approval-grant', true,
        approval.authorization.grantId !== accepted.authorization.grantId);
      check('approved-exact-terms', objective.reporting, approval.reporting);
      if (objective.approvingPrincipalId) check('approving-principal', objective.approvingPrincipalId, approval.authorization.principalId);
      if (objective.approvingGrantId) check('approving-grant', objective.approvingGrantId, approval.authorization.grantId);
    }
  }
  for (const [index, event] of dispatches.entries()) {
    const auth = event.authorization;
    const role = event.operation === 'approve' ? 'approver' : 'editor';
    check(`dispatch-${index}-authority`, true,
      Boolean(auth?.principalActive && auth.grantActive && auth.roles.includes(role) &&
        auth.actions.includes(event.action) && auth.recordIds.includes(objective.recordId) &&
        auth.applicationId === objective.applicationId && auth.accountId === objective.accountId &&
        auth.principalId === event.context.principalId && auth.grantId === event.context.grantId &&
        auth.grantRevision === event.context.grantRevision &&
        auth.authorityRevision === event.context.authorityRevision &&
        Date.parse(event.at) < Date.parse(auth.expiresAt) &&
        Date.parse(event.request.deadline) <= Date.parse(auth.expiresAt) &&
        Date.parse(event.at) < Date.parse(event.request.deadline)));
    check(`dispatch-${index}-version-advance`, event.beforeVersion + 1, event.afterVersion);
  }
  return {
    schema: 'X2.PORTAL.INDEPENDENT_GRADE.v1', oracleRevision: oracle.revision,
    verdict: checks.every(value => value.passed) ? 'PASS' : 'FAIL', checks,
    journalDigest: journal.digest, journalBytesSha256: journal.bytesSha256,
    sourceCommit: null, scope: 'Independent DEVELOPMENT application outcome only',
    gaps: ['No native action/Work/S5/S6/model admission verdict', 'No same-UID OS sandbox or protected evaluation custody'],
  };
}

async function output(directory, path, value) {
  if (!isAbsolute(path ?? '') || !resolve(path).startsWith(`${resolve(directory)}/`)) {
    throw new Error('Evaluator output must stay inside custody directory');
  }
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

async function main() {
  const opts = options();
  const directory = opts['private-dir'];
  const oracle = await frozenOracle();
  if (opts.command === 'wait') {
    const timeout = Number(opts['timeout-ms'] ?? 3000);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000 ||
        !['submission.accepted', 'submission.completed', 'approval.committed'].includes(opts.event)) {
      throw new Error('Unsupported evaluator wait domain');
    }
    const start = performance.now();
    while (performance.now() - start < timeout) {
      const journal = await load(directory);
      const event = journal.events.find(value =>
        value.type === opts.event && (!opts['request-id'] || value.requestId === opts['request-id']));
      if (event) {
        console.log(JSON.stringify({ observed: true, event: opts.event, sequence: event.sequence, at: event.at }));
        return;
      }
      await sleep(20);
    }
    console.log(JSON.stringify({ observed: false, event: opts.event, reason: 'TIMEOUT' }));
    process.exitCode = 1;
    return;
  }
  const journal = await load(directory);
  if (opts.command === 'snapshot') {
    await output(directory, opts.output, journal);
    console.log(JSON.stringify({ written: true, sequence: journal.rows.length, journalDigest: journal.digest }));
  } else if (opts.command === 'grade') {
    if (!isAbsolute(opts.objective ?? '') || !resolve(opts.objective).startsWith(`${resolve(directory)}/`)) {
      throw new Error('Objective must come from the private administrator');
    }
    const objective = JSON.parse(await readFile(opts.objective, 'utf8'));
    const result = grade(journal, objective, oracle);
    await output(directory, opts.output, { input: objective, ...result });
    console.log(JSON.stringify({ verdict: result.verdict, failedChecks: result.checks.filter(value => !value.passed).length, journalDigest: journal.digest }));
    if (result.verdict !== 'PASS') process.exitCode = 2;
  } else throw new Error('Evaluator commands: wait, snapshot, grade');
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
});
