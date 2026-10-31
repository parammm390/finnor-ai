import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = path.resolve(process.env.FINNOR_W2_DOMAIN_EVIDENCE_ROOT ??
  path.join(repo, 'scope-postz/w2-accountable-workforce/domain/evidence'));
const runStartedAt = new Date().toISOString();
const runStarted = performance.now();
const cpuStarted = process.cpuUsage();
const at = '2026-10-25T10:00:00.000Z';
const end = '2026-10-25T11:00:00.000Z';
const later = '2026-10-26T10:00:00.000Z';
const ref = (id: string) => ({ owner: 'SYNTHETIC_NATIVE_OBSERVATION', id, version: '1', contentDigest: `fixture-${id}` });
const ceiling = { capabilities: ['analyse'], dataScopes: ['public'], purposes: ['trial'], effects: [], validFrom: at, validUntil: later, allowSubdelegation: true };
const envelope = (amount: string, resourceId = 'human-time', unit = 'seconds') => ({
  resourceId, unit, kind: 'OCCUPANCY' as const, horizon: { startAt: at, periodMs: 3600000, periods: 1 },
  quantities: [amount, '0'], minimumQuantities: ['0', '0'],
});
const terms = { revision: 1, deliverable: 'original comparison', compensation: { value: '0', unit: 'USD' }, subdelegation: true, expiresAt: later };
const actor = (id: string, kind: 'INTERNAL_HUMAN' | 'MODEL_AGENT' = 'MODEL_AGENT') => ({
  id, tenantId: 'tenant', identityRef: ref(`identity-${id}`), kind, status: 'CURRENT' as const,
  capabilities: [{ skill: 'compare', scope: 'public', evidenceRef: ref(`skill-${id}`), validUntil: later, certainty: 'OBSERVED' as const }],
  availability: { kind: 'OBSERVED' as const, ref: ref(`schedule-${id}`), validUntil: later,
    slots: [{ startAt: at, endAt: end, capacity: '4', committed: '0' }], maxConcurrent: 4,
    humanLimits: kind === 'INTERNAL_HUMAN' ? { kind: 'OBSERVED' as const, maxEffortSeconds: '3600', alreadyCommittedSeconds: '0', fatigue: 'WITHIN_LIMIT' as const, ref: ref(`human-${id}`) } : { kind: 'NOT_HUMAN' as const } },
});
const task = (id: string, parentTaskId: string | null = null) => ({
  id, parentTaskId, dependsOn: [], returnTo: [], delegatorActorId: 'requester', criterionId: 'criterion',
  requiredCapabilities: [{ skill: 'compare', scope: 'public' }], allowedActorKinds: ['MODEL_AGENT', 'INTERNAL_HUMAN'],
  assignmentMode: 'INTERNAL_AUTHORIZED' as const, ceiling, terms, dueAt: end,
  slot: { startAt: at, endAt: end }, effortSeconds: '60', demand: [envelope('1')],
  context: { dataScopes: ['public'], purposes: ['trial'], includesCredentials: false as const },
  effectId: null,
});
const fixture = () => ({
  schema: 'finnor.workforce-compiler-input.v1' as const, programId: 'programme', tenantId: 'tenant', principalId: 'principal',
  now: at, snapshotRef: ref('snapshot'), sourceClass: 'SYNTHETIC' as const,
  historyAnchor: { revision: 0, commandsDigest: createHash('sha256').update('[]').digest('hex') },
  outcome: { ref: ref('outcome'), workId: 'work', rootId: 'root', requesterActorId: 'requester', deadline: end,
    criteria: [{ id: 'criterion', ref: ref('original-criterion'), checkerActorId: 'checker', evidenceCustodianActorId: 'custodian' }],
    tasks: [task('t1')], ceiling, resourceLimits: [envelope('512')] },
  actors: [actor('requester', 'INTERNAL_HUMAN'), actor('worker'), actor('checker'), actor('custodian')],
  grants: ['requester', 'worker', 'checker', 'custodian'].map(actorId => ({ ref: ref(`grant-${actorId}`), actorId, tenantId: 'tenant', ceiling, revoked: false })),
  funding: [], dispositions: [], deliveries: [], verifications: [], effects: [], reconciliations: [], obligations: [],
  termChanges: [], commandAuthorities: [],
});

type Raw = ReturnType<typeof fixture>;
const clone = <T,>(x: T): T => structuredClone(x);
const cases: Array<{ id: string; expected: unknown; actual: unknown; ok: boolean; boundary: string; input: unknown }> = [];
function record(id: string, expected: unknown, actual: unknown, boundary: string, input: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  cases.push({ id, expected, actual, ok, boundary, input: structuredClone(input) });
}

await mkdir(evidence, { recursive: true });
process.on('uncaughtException', async error => {
  const failure = { status: 'RUNTIME_FAILURE', sourceClass: 'SYNTHETIC', error: String(error), stack: error.stack,
    reachedCases: cases.map(({ input: _input, ...c }) => c), rerun: 'cd finnor-os && node_modules/.bin/tsx scripts/postz-w2/run-domain-e2e.mts' };
  try { await writeFile(path.join(evidence, `runtime-failure-${Date.now()}.json`), JSON.stringify(failure, null, 2)); }
  catch (writeError) { console.error(String(writeError)); }
  console.error(error); process.exitCode = 1;
});
process.on('unhandledRejection', error => { throw error; });
let domain: typeof import('../../packages/workforce/src/execution-program/index.js');
try {
  domain = await import('../../packages/workforce/src/execution-program/index.js');
} catch (error) {
  const failure = { status: 'ORIGINAL_FAILURE', sourceClass: 'SYNTHETIC', boundary: 'MODULE_LOAD', expected: 'implemented domain',
    actual: String(error), input: fixture(), rerun: 'cd finnor-os && node_modules/.bin/tsx scripts/postz-w2/run-domain-e2e.mts' };
  await writeFile(path.join(evidence, `original-failure-${Date.now()}.json`), JSON.stringify(failure, null, 2));
  console.error(JSON.stringify(failure)); process.exit(1);
}
const compile = (raw: unknown) => domain.compileWorkforceExecutionProgram(domain.parseWorkforceCompilerInput(raw));
const shortCalendar = fixture(); shortCalendar.outcome.resourceLimits[0]!.quantities = ['512'];
record('native-last-index-short-vector-rejected', false, domain.workforceCompilerInputSchema.safeParse(shortCalendar).success, 'SCHEMA', shortCalendar);
const noAnchor = clone(fixture()) as Record<string, unknown>; delete noAnchor.historyAnchor;
record('native-history-anchor-required', false, domain.workforceCompilerInputSchema.safeParse(noAnchor).success, 'SCHEMA', noAnchor);
const base = fixture();
const positive = compile(base);
record('useful-original-assignment', ['COMPLETE', 1, 't1'], [positive.status, positive.program?.assignments.length, positive.program?.assignments[0]?.taskId], 'COMPILER', base);
if (!positive.program) throw Error('Positive fixture did not produce a programme');
const program = positive.program;
const originalAssignment = program.assignments[0];
if (!originalAssignment) throw Error('Positive fixture has no assignment');
record('whole-program-positive', true, domain.checkWorkforceExecutionProgram(program, domain.parseWorkforceCompilerInput(base)).valid, 'GRAPH', base);
const relabeledPopulation = clone(program); relabeledPopulation.sourceClass = 'NATIVE_RECORDS';
record('synthetic-program-cannot-be-relabeled-native', true, domain.checkWorkforceExecutionProgram(relabeledPopulation, domain.parseWorkforceCompilerInput(base)).issues.some(i => i.code === 'SOURCE_CLASS_MISMATCH'),
  'GRAPH', { program: relabeledPopulation, current: base });

const mutation = (id: string, change: (x: Raw) => void, expectedCode: string) => {
  const raw = fixture(); change(raw);
  const current = domain.parseWorkforceCompilerInput(raw);
  const check = domain.checkWorkforceExecutionProgram(program, current);
  record(id, true, check.issues.some(x => x.code === expectedCode), check.issues.find(x => x.code === expectedCode)?.boundary ?? 'TARGET_NOT_REACHED', raw);
};
mutation('cross-tenant-identity', x => { for (const a of x.actors) if (a.id === originalAssignment.actorId) a.tenantId = 'foreign'; }, 'ACTOR_IDENTITY');
mutation('capability-expired', x => { for (const a of x.actors) if (a.id === originalAssignment.actorId) a.capabilities[0]!.validUntil = '2026-10-24T00:00:00.000Z'; }, 'CAPABILITY_EVIDENCE');
mutation('capability-scope-mismatch', x => { for (const a of x.actors) if (a.id === originalAssignment.actorId) a.capabilities[0]!.scope = 'private'; }, 'CAPABILITY_EVIDENCE');
mutation('revoked-grant', x => { for (const g of x.grants) if (g.actorId === originalAssignment.actorId) g.revoked = true; }, 'CURRENT_GRANT');
mutation('competing-work', x => { for (const a of x.actors) if (a.id === originalAssignment.actorId) a.availability.slots[0]!.committed = '4'; }, 'CAPACITY');
mutation('resource-near-boundary', x => { x.outcome.resourceLimits[0]!.quantities = ['999999999999999999/1000000000000000000', '0']; }, 'RESOURCE_LIMIT');
const finalPeriod = fixture();
finalPeriod.outcome.tasks[0]!.demand[0]!.quantities = ['0', '1'];
finalPeriod.outcome.resourceLimits[0]!.quantities = ['0', '1'];
const lastIndexProgram = compile(finalPeriod).program!;
record('native-final-period-is-funded', true, domain.checkWorkforceExecutionProgram(lastIndexProgram, domain.parseWorkforceCompilerInput(finalPeriod)).valid, 'ACCOUNTING', finalPeriod);
finalPeriod.outcome.resourceLimits[0]!.quantities = ['0', '999999999999999999/1000000000000000000'];
record('native-final-period-excess-is-not-dropped', true, domain.checkWorkforceExecutionProgram(lastIndexProgram, domain.parseWorkforceCompilerInput(finalPeriod)).issues.some(i => i.code === 'RESOURCE_LIMIT'), 'ACCOUNTING', finalPeriod);

const damaged = clone(program);
damaged.assignments.push({ ...clone(originalAssignment), id: 'duplicate-live-assignment' });
const duplicate = domain.checkWorkforceExecutionProgram(damaged, domain.parseWorkforceCompilerInput(base));
record('duplicate-live-leaf', true, duplicate.issues.some(x => x.code === 'DUPLICATE_LIVE_TASK'), 'GRAPH', damaged);

for (const delegatorKind of ['INTERNAL_HUMAN', 'MODEL_AGENT'] as const) {
  for (const recipientKind of ['INTERNAL_HUMAN', 'MODEL_AGENT'] as const) {
    const raw = fixture(); raw.actors = [actor('requester', delegatorKind), actor('worker', recipientKind), actor('checker'), actor('custodian')];
    raw.outcome.tasks[0]!.allowedActorKinds = [recipientKind];
    const result = compile(raw);
    record(`pairing-${delegatorKind}-${recipientKind}`, ['COMPLETE', recipientKind], [result.status,
      raw.actors.find(a => a.id === result.program?.assignments[0]?.actorId)?.kind], 'COMPILER', raw);
  }
}

const max = fixture();
max.actors = Array.from({ length: 128 }, (_, i) => actor(i === 0 ? 'requester' : i === 1 ? 'checker' : i === 2 ? 'custodian' : `actor-${i}`));
for (const a of max.actors) { a.availability.maxConcurrent = 512; a.availability.slots[0]!.capacity = '512'; }
max.grants = max.actors.map(a => ({ ref: ref(`grant-${a.id}`), actorId: a.id, tenantId: 'tenant', ceiling, revoked: false }));
max.outcome.tasks = Array.from({ length: 512 }, (_, i) => task(`t${i}`, i > 0 && i < 8 ? `t${i - 1}` : null));
for (let i = 0; i < 7; i++) max.outcome.tasks[i]!.demand = [envelope(String(8 - i))];
max.outcome.resourceLimits = [envelope('520')];
const bounded = compile(max);
record('full-profile-no-truncation', ['COMPLETE', 512, 128, 8], [bounded.status, bounded.program?.assignments.length, bounded.metrics.actorsConsidered, bounded.metrics.maximumDepth], 'COMPILER', max);
const tooMany = clone(max); tooMany.actors.push(actor('actor-over'));
record('129-actors-explicit-limit', 'LIMIT_EXCEEDED', compile(tooMany).status, 'PROFILE', tooMany);
const tooDeep = clone(max); tooDeep.outcome.tasks[8]!.parentTaskId = 't7';
record('depth9-explicit-limit', 'LIMIT_EXCEEDED', compile(tooDeep).status, 'PROFILE', tooDeep);
const tooLive = clone(max); tooLive.outcome.tasks.push(task('task-over'));
record('513-assignments-explicit-limit', 'LIMIT_EXCEEDED', compile(tooLive).status, 'PROFILE', tooLive);

const noMatch = fixture(); noMatch.outcome.tasks[0]!.requiredCapabilities = [{ skill: 'licensed-surgery', scope: 'public' }];
record('unsupported-qualification-honest-gap', ['PARTIAL', 1], [compile(noMatch).status, compile(noMatch).gaps.length], 'SUITABILITY', noMatch);

const current = domain.parseWorkforceCompilerInput(base);
let live = clone(program);
const assignment = live.assignments[0]!;
current.funding.push({ ref: ref('s5-reservation'), assignmentId: assignment.id, rootId: 'root', parentReservationId: null,
  envelope: [envelope('1')], directReserved: [envelope('1')], spent: [], unresolved: [], status: 'HELD' });
const command = (action: Record<string, unknown>, actorId = assignment.delegatorActorId) => {
  const cmd = domain.parseAuthenticatedWorkforceCommand({ id: `command-${live.revision}-${action.kind}`, expectedRevision: live.revision,
    actorId, assignmentId: assignment.id, at, action, authorityRef: ref(`authority-${live.revision}-${action.kind}`) });
  current.commandAuthorities.push({ ref: cmd.authorityRef, commandId: cmd.id, actorId, assignmentId: assignment.id,
    commandDigest: domain.workforceDigest(cmd), actions: [cmd.action.kind], validFrom: at, validUntil: later });
  return cmd;
};
const offer = command({ kind: 'OFFER', offerRef: ref('offer') });
let applied = domain.applyWorkforceCommand(live, offer, current);
record('offer-not-acceptance', ['APPLIED', 'OFFERED'], [applied.status, applied.program.assignments[0]?.state.kind], 'LIFECYCLE', offer);
live = applied.program;
const acceptRef = ref('internal-assignment-disposition');
current.dispositions.push({ ref: acceptRef, assignmentId: assignment.id, actorId: assignment.actorId, mode: 'INTERNAL_AUTHORIZED',
  source: 'NATIVE_INSTITUTIONAL_ASSIGNMENT', decision: 'ACCEPT', termsDigest: assignment.termsDigest,
  termsRevision: assignment.terms.revision, at, revokedAt: null });
const accept = command({ kind: 'ACCEPT', dispositionRef: acceptRef }, assignment.actorId);
applied = domain.applyWorkforceCommand(live, accept, current);
record('internal-actual-assignment', ['APPLIED', 'ACCEPTED'], [applied.status, applied.program.assignments[0]?.state.kind], 'ACCEPTANCE', accept);
live = applied.program;
record('acceptance-not-performance', false, domain.checkWorkforceUse(live, assignment.id, current).allowed, 'USE', live);
const start = command({ kind: 'START', observationRef: ref('arrival') }, assignment.actorId);
applied = domain.applyWorkforceCommand(live, start, current); live = applied.program;
record('current-accepted-use', true, domain.checkWorkforceUse(live, assignment.id, current).allowed, 'USE', start);
record('duplicate-command-idempotent', 'IDEMPOTENT', domain.applyWorkforceCommand(live, start, current).status, 'LIFECYCLE', start);
const relabeledReplay = clone(live); relabeledReplay.sourceClass = 'NATIVE_RECORDS';
const populationReplay = domain.applyWorkforceCommand(relabeledReplay, start, current);
record('idempotent-replay-cannot-upgrade-evidence-population', ['REJECTED', true], [populationReplay.status,
  populationReplay.issues.some(i => i.code === 'SOURCE_CLASS_MISMATCH')], 'LIFECYCLE', { program: relabeledReplay, current });
const deliveryRef = ref('delivery');
current.deliveries.push({ ref: deliveryRef, assignmentId: assignment.id, actorId: assignment.actorId, termsDigest: assignment.termsDigest,
  evidenceRefs: [ref('independent-evidence')], custodianActorId: 'custodian', at });
const deliver = command({ kind: 'DELIVER', deliveryRef }, assignment.actorId);
applied = domain.applyWorkforceCommand(live, deliver, current); live = applied.program;
record('delivery-not-verification', 'DELIVERED', live.assignments[0]?.state.kind, 'LIFECYCLE', deliver);
const verificationRef = ref('verification');
current.verifications.push({ ref: verificationRef, assignmentId: assignment.id, deliveryRef, criterionRef: ref('original-criterion'),
  checkerActorId: 'checker', custodianActorId: 'custodian', evidenceRefs: [ref('independent-evidence')], result: 'SATISFIED', at });
const verify = command({ kind: 'VERIFY', verificationRef }, 'checker');
applied = domain.applyWorkforceCommand(live, verify, current); live = applied.program;
record('independent-original-verification', ['APPLIED', 'VERIFIED'], [applied.status, live.assignments[0]?.state.kind], 'LIFECYCLE', verify);
const close = command({ kind: 'CLOSE', observationRef: ref('closure') });
const closeMissingLabor = domain.applyWorkforceCommand(live, close, current);
record('accepted-human-missing-labor-release-blocks-close', ['REJECTED', true], [closeMissingLabor.status,
  closeMissingLabor.issues.some(i => i.code === 'LABOR_RELEASE_UNKNOWN')], 'ACCOUNTING', { program: live, current });
current.obligations.push({ ref: ref('explicit-synthetic-labor-release'), assignmentId: assignment.id, rootId: assignment.rootId,
  kind: 'ACCEPTED_LABOR', status: 'RELEASED', at });
for (const variant of ['wrong-root', 'before-acceptance', 'future'] as const) {
  const invalidRelease = clone(current);
  if (variant === 'wrong-root') invalidRelease.obligations[0]!.rootId = 'foreign-root';
  else invalidRelease.obligations[0]!.at = variant === 'future' ? later : '2026-10-24T10:00:00.000Z';
  const rejectedRelease = domain.applyWorkforceCommand(live, close, invalidRelease);
  record(`labor-release-${variant}-is-unknown`, ['REJECTED', true], [rejectedRelease.status,
    rejectedRelease.issues.some(i => i.code === 'LABOR_RELEASE_UNKNOWN')], 'ACCOUNTING', { program: live, current: invalidRelease });
}
applied = domain.applyWorkforceCommand(live, close, current); live = applied.program;
record('independent-completion-closes', ['APPLIED', 'CLOSED'], [applied.status, live.assignments[0]?.state.kind], 'LIFECYCLE', close);
const missingIdentityRelease = clone(current);
missingIdentityRelease.actors = missingIdentityRelease.actors.filter(a => a.id !== assignment.actorId);
missingIdentityRelease.obligations = [];
record('missing-historical-actor-cannot-turn-labor-into-zero', true, domain.checkWorkforceExecutionProgram(live, missingIdentityRelease).issues.some(i => i.code === 'LABOR_RELEASE_UNKNOWN'), 'ACCOUNTING', { program: live, current: missingIdentityRelease });
const dishonest = clone(current); dishonest.verifications[0]!.checkerActorId = assignment.actorId;
record('self-verification-rejected', true, domain.checkWorkforceExecutionProgram(live, dishonest).issues.some(x => x.code === 'VERIFICATION_CUSTODY'), 'ACCEPTANCE', dishonest);
const anchored = clone(current);
anchored.historyAnchor = { revision: live.revision, commandsDigest: domain.workforceDigest(live.history) };
record('native-history-anchor-helper-exact', anchored.historyAnchor, domain.workforceHistoryAnchor(live.history), 'LIFECYCLE', live.history);
record('native-committed-history-cannot-be-recompiled-as-genesis', ['INVALID_INPUT', null],
  [domain.compileWorkforceExecutionProgram(anchored).status, domain.compileWorkforceExecutionProgram(anchored).program], 'LIFECYCLE', anchored);
record('native-committed-history-prefix-positive', true, domain.checkWorkforceExecutionProgram(live, anchored).valid, 'LIFECYCLE', { program: live, current: anchored });
record('native-history-omission-rejected', true, domain.checkWorkforceExecutionProgram(program, anchored).issues.some(i => i.code === 'HISTORY_ANCHOR_MISMATCH'), 'LIFECYCLE', { program, current: anchored });
const alteredPrefix = clone(live); alteredPrefix.history[0]!.id = 'altered-committed-offer';
record('native-history-altered-prefix-rejected', true, domain.checkWorkforceExecutionProgram(alteredPrefix, anchored).issues.some(i => i.code === 'HISTORY_ANCHOR_MISMATCH'), 'LIFECYCLE', { program: alteredPrefix, current: anchored });
record('native-anchor-checked-before-idempotent-replay', ['REJECTED', true], [
  domain.applyWorkforceCommand(alteredPrefix, start, anchored).status,
  domain.applyWorkforceCommand(alteredPrefix, start, anchored).issues.some(i => i.code === 'HISTORY_ANCHOR_MISMATCH')], 'LIFECYCLE', { program: alteredPrefix, current: anchored });
const anchoredPrefix = clone(current); anchoredPrefix.historyAnchor = { revision: 1, commandsDigest: domain.workforceDigest(live.history.slice(0, 1)) };
record('native-authenticated-tail-after-anchor-positive', true, domain.checkWorkforceExecutionProgram(live, anchoredPrefix).valid, 'LIFECYCLE', { program: live, current: anchoredPrefix });

type Input = import('../../packages/workforce/src/execution-program/index.js').WorkforceCompilerInput;
type Program = import('../../packages/workforce/src/execution-program/index.js').WorkforceExecutionProgram;
type Action = import('../../packages/workforce/src/execution-program/index.js').AuthenticatedWorkforceCommand['action'];
const owned = (): Input => domain.parseWorkforceCompilerInput(fixture());
const factor = (value: string) => ({ kind: 'EVIDENCED' as const, value, evidenceRef: ref(`measurement-${value}`), admission: 'ADMITTED' as const });
const matching = owned();
matching.matchingObservations = ['requester', 'worker'].map(actorId => ({ ref: ref(`matching-${actorId}`), taskId: 't1', actorId, validUntil: later,
  cost: { ...factor(actorId === 'worker' ? '999999999999999999/1000000000000000000' : '1'), unit: 'USD' },
  latencySeconds: factor(actorId === 'worker' ? '100' : '1'),
  verificationEffortSeconds: { ...factor(actorId === 'worker' ? '1' : '100'), checkerActorId: 'checker', criterionRef: ref('original-criterion') } }));
record('matching-exact-cost-before-latency-no-rounded-tie', 'worker', domain.compileWorkforceExecutionProgram(matching).program?.assignments[0]?.actorId, 'COMPILER', matching);
const burden = clone(matching);
for (const o of burden.matchingObservations!) { o.cost = { ...factor('1'), unit: 'USD' }; o.latencySeconds = factor('1'); }
record('matching-independent-verification-burden', 'worker', domain.compileWorkforceExecutionProgram(burden).program?.assignments[0]?.actorId, 'COMPILER', burden);
const latency = clone(burden);
for (const o of latency.matchingObservations!) {
  o.latencySeconds = factor(o.actorId === 'worker' ? '999999999999999999/1000000000000000000' : '1');
  o.verificationEffortSeconds = { ...factor('1'), checkerActorId: 'checker', criterionRef: ref('original-criterion') };
}
record('matching-exact-actor-specific-latency', 'worker', domain.compileWorkforceExecutionProgram(latency).program?.assignments[0]?.actorId, 'COMPILER', latency);
const unadmitted = clone(burden);
for (const o of unadmitted.matchingObservations!) {
  if (o.cost.kind === 'EVIDENCED') o.cost.admission = 'UNADMITTED';
  o.latencySeconds = { kind: 'UNKNOWN', reason: 'Not measured' };
  o.verificationEffortSeconds = { kind: 'UNKNOWN', reason: 'Not independently measured' };
}
const unadmittedResult = domain.compileWorkforceExecutionProgram(unadmitted);
record('matching-unadmitted-unknown-not-zero', ['requester', []], [unadmittedResult.program?.assignments[0]?.actorId,
  unadmittedResult.metrics.matchingDecisions[0]?.factorsUsed], 'COMPILER', unadmitted);
const partialFactors = clone(unadmitted);
partialFactors.matchingObservations![0]!.cost = { ...factor('100'), unit: 'USD' };
partialFactors.matchingObservations![1]!.cost = { kind: 'UNKNOWN', reason: 'No worker cost evidence' };
record('matching-one-unknown-cost-never-becomes-free-worker', 'requester', domain.compileWorkforceExecutionProgram(partialFactors).program?.assignments[0]?.actorId, 'COMPILER', partialFactors);
const staleFactors = clone(burden);
staleFactors.matchingObservations![1]!.validUntil = '2026-10-24T10:00:00.000Z';
record('matching-stale-evidence-is-unknown', 'requester', domain.compileWorkforceExecutionProgram(staleFactors).program?.assignments[0]?.actorId, 'COMPILER', staleFactors);
const incompatibleUnits = clone(burden);
if (incompatibleUnits.matchingObservations![0]!.cost.kind === 'EVIDENCED') incompatibleUnits.matchingObservations![0]!.cost.unit = 'hours';
const unitResult = domain.compileWorkforceExecutionProgram(incompatibleUnits);
record('matching-distinct-cost-units-never-added-or-converted', ['worker', false], [unitResult.program?.assignments[0]?.actorId,
  unitResult.metrics.matchingDecisions[0]?.factorsUsed.includes('COST')], 'COMPILER', incompatibleUnits);
const selfBurden = clone(burden);
for (const o of selfBurden.matchingObservations!) if (o.verificationEffortSeconds.kind === 'EVIDENCED') o.verificationEffortSeconds.checkerActorId = o.actorId;
record('matching-producer-self-verification-factor-is-unknown', 'requester', domain.compileWorkforceExecutionProgram(selfBurden).program?.assignments[0]?.actorId, 'COMPILER', selfBurden);
function session(input: Input) {
  const compiled = domain.compileWorkforceExecutionProgram(input);
  if (!compiled.program || compiled.status !== 'COMPLETE') throw Error(`Invalid session fixture ${JSON.stringify(compiled.gaps)}`);
  let p = compiled.program;
  for (const a of p.assignments) {
    const t = input.outcome.tasks.find(t => t.id === a.taskId)!;
    input.funding.push({ ref: ref(`funding-${a.id}`), assignmentId: a.id, rootId: a.rootId,
      parentReservationId: a.parentAssignmentId === null ? null : `funding-${a.parentAssignmentId}`,
      envelope: clone(t.demand), directReserved: p.assignments.some(child => child.parentAssignmentId === a.id) ? [] : clone(t.demand),
      spent: [], unresolved: [], status: 'HELD' });
  }
  function step(action: Action, assignmentId = p.assignments[0]!.id, by?: string) {
    const a = p.assignments.find(a => a.id === assignmentId)!;
    const c = domain.parseAuthenticatedWorkforceCommand({ id: `${p.id}-command-${p.revision}-${action.kind}`,
      expectedRevision: p.revision, actorId: by ?? a.delegatorActorId, assignmentId, at: input.now, action,
      authorityRef: ref(`${p.id}-authority-${p.revision}-${action.kind}`) });
    input.commandAuthorities.push({ ref: c.authorityRef, commandId: c.id, actorId: c.actorId, assignmentId, commandDigest: domain.workforceDigest(c),
      actions: [action.kind], validFrom: at, validUntil: later });
    const result = domain.applyWorkforceCommand(p, c, input);
    if (result.status === 'APPLIED') { p = result.program; input.historyAnchor = domain.workforceHistoryAnchor(p.history); }
    return result;
  }
  function acceptTask(assignmentId = p.assignments[0]!.id) {
    const a = p.assignments.find(a => a.id === assignmentId)!;
    const t = input.outcome.tasks.find(t => t.id === a.taskId)!;
    const offered = step({ kind: 'OFFER', offerRef: ref(`offer-${a.id}-${a.terms.revision}`) }, a.id);
    const dispositionRef = ref(`accept-${a.id}-${a.terms.revision}`);
    input.dispositions.push({ ref: dispositionRef, assignmentId: a.id, actorId: a.actorId, mode: t.assignmentMode,
      source: t.assignmentMode === 'EXTERNAL_VOLUNTARY' ? 'NATIVE_RECIPIENT_DISPOSITION' : 'NATIVE_INSTITUTIONAL_ASSIGNMENT',
      decision: 'ACCEPT', termsDigest: a.termsDigest, termsRevision: a.terms.revision, at: input.now, revokedAt: null });
    const accepted = step({ kind: 'ACCEPT', dispositionRef }, a.id, a.actorId);
    return { offered, accepted, dispositionRef };
  }
  return { input, get program() { return p; }, step, acceptTask };
}

const voluntary = owned();
voluntary.outcome.tasks[0]!.assignmentMode = 'EXTERNAL_VOLUNTARY';
voluntary.outcome.tasks[0]!.allowedActorKinds = ['EXTERNAL_PROFESSIONAL'];
const externalActor = voluntary.actors.find(a => a.id === 'worker')!;
externalActor.kind = 'EXTERNAL_PROFESSIONAL';
if (externalActor.availability.kind === 'OBSERVED') externalActor.availability.humanLimits = {
  kind: 'OBSERVED', maxEffortSeconds: '3600', alreadyCommittedSeconds: '0', fatigue: 'WITHIN_LIMIT', ref: ref('external-human-limits') };
const ext = session(voluntary);
const extA = ext.program.assignments[0]!;
ext.step({ kind: 'OFFER', offerRef: ref('external-offer') });
const extRef = ref('external-disposition');
ext.input.dispositions.push({ ref: extRef, assignmentId: extA.id, actorId: extA.actorId, mode: 'EXTERNAL_VOLUNTARY',
  source: 'NATIVE_INSTITUTIONAL_ASSIGNMENT', decision: 'ACCEPT', termsDigest: extA.termsDigest, termsRevision: 1, at, revokedAt: null });
const falseConsent = ext.step({ kind: 'ACCEPT', dispositionRef: extRef }, extA.id, extA.actorId);
record('external-institutional-order-is-not-consent', ['REJECTED', true], [falseConsent.status, falseConsent.issues.some(i => i.code === 'ACCEPTANCE_BINDING')], 'ACCEPTANCE', { program: ext.program, current: ext.input });
ext.input.dispositions[0]!.source = 'NATIVE_RECIPIENT_DISPOSITION';
const realConsent = ext.step({ kind: 'ACCEPT', dispositionRef: extRef }, extA.id, extA.actorId);
record('external-actual-synthetic-recipient-disposition', ['APPLIED', 'ACCEPTED'], [realConsent.status, ext.program.assignments[0]?.state.kind], 'ACCEPTANCE', { program: ext.program, current: ext.input });
const noShow = ext.step({ kind: 'BLOCK', observationRef: ref('no-show'), reason: 'Accepted provider did not arrive' });
record('human-no-show-retains-acceptance-not-delivery', ['APPLIED', 'BLOCKED', 1, 0], [noShow.status, ext.program.assignments[0]?.state.kind,
  ext.program.history.filter(c => c.action.kind === 'ACCEPT').length, ext.input.deliveries.length], 'LIFECYCLE', { program: ext.program, current: ext.input });
ext.input.funding[0]!.status = 'RELEASED'; ext.input.funding[0]!.directReserved = [];
const externalNoRelease = ext.step({ kind: 'REASSIGN', replacementActorId: extA.actorId, replacementAssignmentId: 'external-replacement', reconciliationRef: null });
record('accepted-external-professional-missing-labor-release', ['REJECTED', true], [externalNoRelease.status,
  externalNoRelease.issues.some(i => i.code === 'LABOR_RELEASE_UNKNOWN')], 'LIFECYCLE', { program: ext.program, current: ext.input });

const changed = session(owned()); changed.acceptTask();
changed.input.termChanges.push({ ref: ref('terms2'), taskId: 't1', terms: { ...terms, revision: 2, compensation: { value: '1/3', unit: 'USD' } } });
const revised = changed.step({ kind: 'REVISE_TERMS', termChangeRef: ref('terms2') });
record('changed-terms-invalidates-current-acceptance', ['APPLIED', 'PROPOSED', 1], [revised.status, changed.program.assignments[0]?.state.kind,
  changed.program.history.filter(c => c.action.kind === 'ACCEPT').length], 'ACCEPTANCE', { program: changed.program, current: changed.input });
changed.step({ kind: 'OFFER', offerRef: ref('offer2') });
const oldConsent = changed.step({ kind: 'ACCEPT', dispositionRef: changed.input.dispositions[0]!.ref },
  changed.program.assignments[0]!.id, changed.program.assignments[0]!.actorId);
record('old-consent-cannot-accept-changed-terms', ['REJECTED', true], [oldConsent.status, oldConsent.issues.some(i => i.code === 'ACCEPTANCE_BINDING')], 'ACCEPTANCE', { program: changed.program, current: changed.input });
changed.step({ kind: 'CANCEL', observationRef: ref('changed-cancel') });
changed.step({ kind: 'CONFIRM_CANCEL', observationRef: ref('changed-cancel-residual') });
const changedNoRelease = changed.step({ kind: 'CLOSE', observationRef: ref('changed-close') });
record('terms-revision-never-erases-prior-accepted-labor', ['REJECTED', true], [changedNoRelease.status,
  changedNoRelease.issues.some(i => i.code === 'LABOR_RELEASE_UNKNOWN')], 'ACCOUNTING', { program: changed.program, current: changed.input });

const providerInput = owned();
providerInput.outcome.tasks[0]!.assignmentMode = 'EXTERNAL_VOLUNTARY';
providerInput.outcome.tasks[0]!.allowedActorKinds = ['PROVIDER'];
const providerActor = providerInput.actors.find(a => a.id === 'worker')!;
providerActor.kind = 'PROVIDER';
if (providerActor.availability.kind === 'OBSERVED') providerActor.availability.humanLimits = {
  kind: 'OBSERVED', maxEffortSeconds: '3600', alreadyCommittedSeconds: '0',
  fatigue: 'WITHIN_LIMIT', ref: ref('provider-human-agreement') };
const providerProgramme = domain.compileWorkforceExecutionProgram(providerInput).program!;
record('provider-with-observed-human-agreement-remains-useful', ['worker', true], [
  providerProgramme.assignments[0]?.actorId,
  domain.checkWorkforceExecutionProgram(providerProgramme, providerInput).valid], 'SUITABILITY', providerInput);
for (const variant of ['not-human', 'unknown', 'fatigue', 'effort'] as const) {
  const invalid = clone(providerInput), actor = invalid.actors.find(a => a.id === 'worker')!;
  if (actor.availability.kind !== 'OBSERVED') throw Error('PROVIDER_OBSERVED_AVAILABILITY_REQUIRED');
  actor.availability.humanLimits = variant === 'not-human' ? { kind: 'NOT_HUMAN' } :
    variant === 'unknown' ? { kind: 'UNKNOWN', reason: 'No current observed provider agreement' } :
      { kind: 'OBSERVED', maxEffortSeconds: variant === 'effort' ? '59' : '3600', alreadyCommittedSeconds: '0',
        fatigue: variant === 'fatigue' ? 'EXCEEDED' : 'WITHIN_LIMIT', ref: ref('provider-' + variant) };
  const compiled = domain.compileWorkforceExecutionProgram(invalid);
  record('provider-human-limits-' + variant + '-compiler', ['PARTIAL', 0],
    [compiled.status, compiled.program?.assignments.length ?? 0], 'COMPILER', invalid);
  const checked = domain.checkWorkforceExecutionProgram(providerProgramme, invalid);
  record('provider-human-limits-' + variant + '-independent-checker', true,
    checked.issues.some(issue => issue.code === 'HUMAN_CAPACITY'), 'SUITABILITY',
    { program: providerProgramme, current: invalid });
}
const provider = session(providerInput); provider.acceptTask();
provider.step({ kind: 'CANCEL', observationRef: ref('provider-cancel') });
provider.step({ kind: 'CONFIRM_CANCEL', observationRef: ref('provider-residual') });
const providerClose = provider.step({ kind: 'CLOSE', observationRef: ref('provider-close') });
record('accepted-provider-missing-labor-release-blocks-close', ['REJECTED', true], [providerClose.status,
  providerClose.issues.some(i => i.code === 'LABOR_RELEASE_UNKNOWN')], 'ACCOUNTING', { program: provider.program, current: provider.input });

const ambiguousInput = owned(); ambiguousInput.outcome.tasks[0]!.effectId = 'original-order';
const ambiguous = session(ambiguousInput); ambiguous.acceptTask();
const ambA = ambiguous.program.assignments[0]!;
ambiguous.input.effects.push({ ref: ref('original-s6'), assignmentId: ambA.id, rootId: ambA.rootId,
  effectId: 'original-order', status: 'NOT_DISPATCHED', reconciliationRef: null, at });
ambiguous.step({ kind: 'START', observationRef: ref('started') }, ambA.id, ambA.actorId);
ambiguous.input.effects[0]!.status = 'MAY_HAVE_LEFT';
const unknownEffect = ambiguous.step({ kind: 'MARK_UNKNOWN_EFFECT', effectRef: ref('original-s6') });
record('possible-egress-is-sticky', ['APPLIED', 'UNKNOWN_EFFECT', false], [unknownEffect.status, ambiguous.program.assignments[0]?.state.kind,
  domain.checkWorkforceUse(ambiguous.program, ambA.id, ambiguous.input).allowed], 'USE', { program: ambiguous.program, current: ambiguous.input });
ambiguous.input.obligations.push({ ref: ref('compensation'), assignmentId: ambA.id, rootId: ambA.rootId, kind: 'COMPENSATION', status: 'OPEN', at });
ambiguous.step({ kind: 'CANCEL', observationRef: ref('cancel-request') });
const cancelled = ambiguous.step({ kind: 'CONFIRM_CANCEL', observationRef: ref('cancel-observed') });
record('partial-cancel-retains-residual-and-compensation', ['APPLIED', 'CANCELLED_WITH_RESIDUAL_EXPOSURE', 'OPEN'], [cancelled.status,
  ambiguous.program.assignments[0]?.state.kind, ambiguous.input.obligations[0]?.status], 'LIFECYCLE', { program: ambiguous.program, current: ambiguous.input });
const replaceUnsafe = ambiguous.step({ kind: 'REASSIGN', replacementActorId: 'worker', replacementAssignmentId: 'replacement', reconciliationRef: null });
record('replacement-cannot-clear-old-effects-or-labor', ['REJECTED', true], [replaceUnsafe.status,
  replaceUnsafe.issues.some(i => ['REPLACEMENT_RESIDUAL', 'REPLACEMENT_RECONCILIATION'].includes(i.code))], 'LIFECYCLE', { program: ambiguous.program, current: ambiguous.input });
ambiguous.input.reconciliations.push({ ref: ref('s6-reconciled'), effectId: 'original-order', rootId: ambA.rootId, authority: 'S6', status: 'CONFIRMED_NOT_LEFT', at });
ambiguous.input.obligations[0]!.status = 'SETTLED';
ambiguous.input.funding[0]!.status = 'RELEASED'; ambiguous.input.funding[0]!.directReserved = [];
const reconciled = ambiguous.step({ kind: 'RECONCILE', reconciliationRef: ref('s6-reconciled') });
const replacementMissingLabor = ambiguous.step({ kind: 'REASSIGN', replacementActorId: 'worker', replacementAssignmentId: 'replacement', reconciliationRef: ref('s6-reconciled') });
record('accepted-human-missing-labor-release-blocks-replacement', ['REJECTED', true], [replacementMissingLabor.status,
  replacementMissingLabor.issues.some(i => i.code === 'LABOR_RELEASE_UNKNOWN')], 'LIFECYCLE', { program: ambiguous.program, current: ambiguous.input });
ambiguous.input.obligations.push({ ref: ref('explicit-synthetic-replacement-labor-release'), assignmentId: ambA.id, rootId: ambA.rootId,
  kind: 'ACCEPTED_LABOR', status: 'SETTLED', at });
const replaced = ambiguous.step({ kind: 'REASSIGN', replacementActorId: 'worker', replacementAssignmentId: 'replacement', reconciliationRef: ref('s6-reconciled') });
record('authoritative-reconciliation-allows-rooted-replacement', ['APPLIED', 'APPLIED', 2, 'root', end], [reconciled.status, replaced.status,
  ambiguous.program.assignments.length, ambiguous.program.assignments[1]?.rootId, ambiguous.program.assignments[1]?.originalDeadline],
  'LIFECYCLE', { program: ambiguous.program, current: ambiguous.input });

const paidInput = owned(); paidInput.outcome.tasks[0]!.terms.compensation.value = '1/3';
const paid = session(paidInput); paid.acceptTask();
const paidA = paid.program.assignments[0]!;
paid.step({ kind: 'BLOCK', observationRef: ref('paid-block'), reason: 'Requires replacement' });
paid.input.funding[0]!.status = 'RELEASED'; paid.input.funding[0]!.directReserved = [];
paid.input.obligations.push({ ref: ref('paid-labor-release'), assignmentId: paidA.id, rootId: paidA.rootId, kind: 'ACCEPTED_LABOR', status: 'RELEASED', at });
const paidNoComp = paid.step({ kind: 'REASSIGN', replacementActorId: 'worker', replacementAssignmentId: 'paid-replacement', reconciliationRef: null });
record('positive-compensation-missing-settlement-is-unknown', ['REJECTED', true], [paidNoComp.status,
  paidNoComp.issues.some(i => i.code === 'COMPENSATION_RELEASE_UNKNOWN')], 'LIFECYCLE', { program: paid.program, current: paid.input });
for (const variant of ['wrong-root', 'before-acceptance', 'future'] as const) {
  const obligation: Input['obligations'][number] = { ref: ref(`invalid-comp-${variant}`), assignmentId: paidA.id, rootId: paidA.rootId,
    kind: 'COMPENSATION', status: 'SETTLED', at };
  if (variant === 'wrong-root') obligation.rootId = 'foreign-root';
  else obligation.at = variant === 'future' ? later : '2026-10-24T10:00:00.000Z';
  paid.input.obligations.push(obligation);
  const invalidComp = paid.step({ kind: 'REASSIGN', replacementActorId: 'worker', replacementAssignmentId: 'paid-replacement', reconciliationRef: null });
  record(`compensation-release-${variant}-is-unknown`, ['REJECTED', true], [invalidComp.status,
    invalidComp.issues.some(i => i.code === 'COMPENSATION_RELEASE_UNKNOWN')], 'LIFECYCLE', { program: paid.program, current: paid.input });
  paid.input.obligations.pop();
}
paid.input.obligations.push({ ref: ref('paid-compensation-settled'), assignmentId: paidA.id, rootId: paidA.rootId, kind: 'COMPENSATION', status: 'SETTLED', at });
const paidReleased = paid.step({ kind: 'REASSIGN', replacementActorId: 'worker', replacementAssignmentId: 'paid-replacement', reconciliationRef: null });
record('explicit-synthetic-labor-and-compensation-settlement', 'APPLIED', paidReleased.status, 'LIFECYCLE', { program: paid.program, current: paid.input });
const unpaidModelInput = owned(); unpaidModelInput.outcome.tasks[0]!.allowedActorKinds = ['MODEL_AGENT'];
const unpaidModel = session(unpaidModelInput); unpaidModel.acceptTask();
unpaidModel.step({ kind: 'CANCEL', observationRef: ref('unpaid-model-cancel') });
unpaidModel.step({ kind: 'CONFIRM_CANCEL', observationRef: ref('unpaid-model-cancelled') });
record('model-without-compensation-does-not-invent-human-labor', 'APPLIED', unpaidModel.step({ kind: 'CLOSE', observationRef: ref('unpaid-model-close') }).status,
  'LIFECYCLE', { program: unpaidModel.program, current: unpaidModel.input });

const reciprocalInput = owned();
reciprocalInput.outcome.tasks.push({ ...clone(reciprocalInput.outcome.tasks[0]!), id: 't2', parentTaskId: 't1', returnTo: ['t1'] });
reciprocalInput.outcome.tasks[0]!.returnTo = ['t2'];
reciprocalInput.outcome.tasks[0]!.demand = [envelope('2')];
const reciprocal = session(reciprocalInput);
record('reciprocal-requests-not-budget-cycles', true, domain.checkWorkforceExecutionProgram(reciprocal.program, reciprocal.input).valid, 'GRAPH', { program: reciprocal.program, current: reciprocal.input });
reciprocal.input.funding[0]!.directReserved = [envelope('1')];
reciprocal.input.funding[0]!.spent = [envelope('1/2')];
reciprocal.input.funding[0]!.unresolved = [envelope('1/2')];
record('parent-direct-spent-and-exposure-are-not-hidden', true,
  domain.checkWorkforceExecutionProgram(reciprocal.program, reciprocal.input).issues.some(i => i.code === 'RESOURCE_LIMIT'), 'ACCOUNTING', { program: reciprocal.program, current: reciprocal.input });

const families: Array<{ name: string; code: string; change: (p: Program, x: Input, n: number) => void }> = [
  { name: 'actual-identity', code: 'ACTOR_IDENTITY', change: (p, x, n) => { x.actors.find(a => a.id === p.assignments[0]!.actorId)!.tenantId = `foreign-${n}`; } },
  { name: 'evidence-scope', code: 'CAPABILITY_EVIDENCE', change: (p, x, n) => { x.actors.find(a => a.id === p.assignments[0]!.actorId)!.capabilities[0]!.scope = `private-${n}`; } },
  { name: 'observed-capacity', code: 'CAPACITY', change: (p, x, n) => { const a = x.actors.find(a => a.id === p.assignments[0]!.actorId)!; if (a.availability.kind === 'OBSERVED') a.availability.slots[0]!.committed = String(4 + n); } },
  { name: 'minimum-disclosure', code: 'DISCLOSURE_CEILING', change: (_p, x, n) => { x.outcome.tasks[0]!.context.dataScopes = [`private-${n}`]; } },
  { name: 'current-grant', code: 'CURRENT_GRANT', change: (p, x) => { x.grants.find(g => g.actorId === p.assignments[0]!.actorId)!.revoked = true; } },
  { name: 'exact-frontier', code: 'RESOURCE_LIMIT', change: (_p, x, n) => { x.outcome.resourceLimits[0]!.quantities = [`0.99999999999999999${n}`, '0']; } },
  { name: 'task-ancestry', code: 'TASK_ANCESTRY_CYCLE_OR_DANGLING', change: (_p, x) => { x.outcome.tasks[0]!.parentTaskId = 't1'; } },
  { name: 'deadline-coupling', code: 'DEADLINE_ANCESTRY', change: (_p, x, n) => { x.outcome.tasks[0]!.dueAt = `2026-10-26T1${n}:00:00.000Z`; } },
  { name: 'duplicate-funding', code: 'DUPLICATE_RESERVATION', change: (p, x, n) => { const f: Input['funding'][number] = { ref: ref(`reservation-${n}`), assignmentId: p.assignments[0]!.id,
    rootId: 'root', parentReservationId: null, envelope: [envelope('1')], directReserved: [envelope('1')], spent: [], unresolved: [], status: 'HELD' }; x.funding.push(f, clone(f)); } },
  { name: 'budget-ancestry', code: 'BUDGET_ANCESTRY_CYCLE', change: (p, x, n) => { x.funding.push({ ref: ref(`cycle-${n}`), assignmentId: p.assignments[0]!.id, rootId: 'root',
    parentReservationId: `cycle-${n}`, envelope: [envelope('1')], directReserved: [], spent: [], unresolved: [], status: 'HELD' }); } },
  { name: 'original-root', code: 'ORIGINAL_ROOT', change: (p, _x, n) => { p.assignments[0]!.rootId = `new-root-${n}`; } },
  { name: 'duplicate-live-leaves', code: 'DUPLICATE_LIVE_TASK', change: (p, _x, n) => { p.assignments.push({ ...clone(p.assignments[0]!), id: `duplicate-${n}` }); } },
  { name: 'false-acceptance', code: 'ACCEPTANCE_REQUIRED', change: (p, _x, n) => { p.assignments[0]!.state = { kind: 'ACCEPTED', ref: ref(`self-made-${n}`) }; } },
  { name: 'unknown-rights', code: 'CURRENT_GRANT', change: (p, x, n) => { p.assignments[0]!.ceiling.capabilities.push(`ungranted-${n}`); x.grants = x.grants.filter(g => g.actorId !== p.assignments[0]!.actorId); } },
  { name: 'uncertain-competence', code: 'CAPABILITY_EVIDENCE', change: (p, x) => { x.actors.find(a => a.id === p.assignments[0]!.actorId)!.capabilities[0]!.certainty = 'UNKNOWN'; } },
  { name: 'human-physical-limits', code: 'HUMAN_CAPACITY', change: (p, x, n) => { const a = x.actors.find(a => a.id === p.assignments[0]!.actorId)!; if (a.availability.kind === 'OBSERVED')
    a.availability.humanLimits = { kind: 'OBSERVED', maxEffortSeconds: String(n + 1), alreadyCommittedSeconds: '0', fatigue: 'EXCEEDED', ref: ref(`fatigue-${n}`) }; } },
];
for (const family of families) for (let n = 0; n < 8; n++) {
  const x = owned(); x.programId = `family-${family.name}-${n}`;
  const candidate = domain.compileWorkforceExecutionProgram(x).program!;
  family.change(candidate, x, n);
  const parsed = domain.parseWorkforceCompilerInput(x);
  const checked = domain.checkWorkforceExecutionProgram(domain.parseWorkforceExecutionProgram(candidate), parsed);
  const reached = checked.issues.find(i => i.code === family.code);
  record(`${family.name}-${n}`, true, Boolean(reached), reached?.boundary ?? 'TARGET_NOT_REACHED', { program: candidate, current: parsed });
}

const fabricatedParent = clone(reciprocal.program);
fabricatedParent.assignments[0]!.state = { kind: 'CLOSED', ref: ref('false-closure') };
record('closure-reconstructs-open-descendants', true, domain.checkWorkforceExecutionProgram(fabricatedParent, reciprocal.input).issues.some(i => i.code === 'OPEN_DESCENDANT'), 'GRAPH', { program: fabricatedParent, current: reciprocal.input });
const currentness = session(owned()); currentness.acceptTask();
const curA = currentness.program.assignments[0]!;
currentness.step({ kind: 'START', observationRef: ref('active') }, curA.id, curA.actorId);
currentness.input.grants.find(g => g.actorId === curA.actorId)!.revoked = true;
record('acceptance-to-use-revocation-race', false, domain.checkWorkforceUse(currentness.program, curA.id, currentness.input).allowed, 'USE', { program: currentness.program, current: currentness.input });
const revoked = currentness.step({ kind: 'REVOKE', observationRef: ref('revocation'), reason: 'Current native authority revoked' });
record('revocation-fences-without-erasing-accepted-history', ['APPLIED', 'BLOCKED', 1], [revoked.status, currentness.program.assignments[0]?.state.kind,
  currentness.program.history.filter(c => c.action.kind === 'ACCEPT').length], 'LIFECYCLE', { program: currentness.program, current: currentness.input });

const refusal = session(owned()); const refusalA = refusal.program.assignments[0]!;
refusal.step({ kind: 'OFFER', offerRef: ref('declinable-offer') });
refusal.input.dispositions.push({ ref: ref('actual-decline'), assignmentId: refusalA.id, actorId: refusalA.actorId, mode: 'INTERNAL_AUTHORIZED',
  source: 'NATIVE_INSTITUTIONAL_ASSIGNMENT', decision: 'DECLINE', termsDigest: refusalA.termsDigest, termsRevision: 1, at, revokedAt: null });
const declined = refusal.step({ kind: 'DECLINE', dispositionRef: ref('actual-decline') }, refusalA.id, refusalA.actorId);
record('actual-decline-retains-root', ['APPLIED', 'DECLINED', 'root'], [declined.status, refusal.program.assignments[0]?.state.kind,
  refusal.program.assignments[0]?.rootId], 'LIFECYCLE', { program: refusal.program, current: refusal.input });
const expiryInput = owned(); expiryInput.outcome.tasks[0]!.terms.expiresAt = at;
const expiry = session(expiryInput); expiry.step({ kind: 'OFFER', offerRef: ref('expiring-offer') });
expiry.input.now = '2026-10-25T10:00:01.000Z';
const expired = expiry.step({ kind: 'EXPIRE', observationRef: ref('elapsed-offer') });
record('silence-expires-without-acceptance', ['APPLIED', 'EXPIRED', 0], [expired.status, expiry.program.assignments[0]?.state.kind,
  expiry.program.history.filter(c => c.action.kind === 'ACCEPT').length], 'LIFECYCLE', { program: expiry.program, current: expiry.input });
const dispute = session(owned()); dispute.acceptTask();
const disputeA = dispute.program.assignments[0]!;
dispute.step({ kind: 'START', observationRef: ref('disputed-start') }, disputeA.id, disputeA.actorId);
const disputed = dispute.step({ kind: 'DISPUTE', observationRef: ref('actual-dispute'), reason: 'Original acceptance criterion remains unsatisfied' });
const disputedClose = dispute.step({ kind: 'CLOSE', observationRef: ref('premature-closure') });
record('dispute-is-not-verified-completion', ['APPLIED', 'DISPUTED', 'REJECTED'], [disputed.status, dispute.program.assignments[0]?.state.kind, disputedClose.status],
  'LIFECYCLE', { program: dispute.program, current: dispute.input });
const splitInput = owned();
splitInput.outcome.tasks[0]!.allowedActorKinds = ['INTERNAL_HUMAN'];
splitInput.outcome.tasks.push({ ...clone(splitInput.outcome.tasks[0]!), id: 't2', allowedActorKinds: ['MODEL_AGENT'] });
const split = session(splitInput);
for (const a of [...split.program.assignments]) {
  split.acceptTask(a.id); split.step({ kind: 'START', observationRef: ref(`start-${a.id}`) }, a.id, a.actorId);
}
split.input.grants.find(g => g.actorId === 'worker')!.revoked = true;
record('smallest-closure-preserves-unrelated-lawful-work', [true, false],
  ['t1', 't2'].map(id => domain.checkWorkforceUse(split.program, split.program.assignments.find(a => a.taskId === id)!.id, split.input).allowed),
  'USE', { program: split.program, current: split.input });
const unknownAvailability = owned();
unknownAvailability.actors.find(a => a.id === originalAssignment.actorId)!.availability = { kind: 'UNKNOWN', reason: 'No current agreement or schedule' };
record('unknown-availability-is-not-zero-burden', true, domain.checkWorkforceExecutionProgram(program, unknownAvailability).issues.some(i => i.code === 'CAPACITY'),
  'SUITABILITY', { program, current: unknownAvailability });
const forged = clone(start); forged.id = 'forged-command'; forged.expectedRevision = 0;
record('forged-authenticated-command-is-rejected', ['REJECTED', true], [domain.applyWorkforceCommand(program, forged, domain.parseWorkforceCompilerInput(base)).status,
  domain.applyWorkforceCommand(program, forged, domain.parseWorkforceCompilerInput(base)).issues.some(i => i.code === 'COMMAND_AUTHORITY')],
  'LIFECYCLE', forged);
const otherPrincipal = clone(current); otherPrincipal.principalId = 'different-principal';
record('replay-under-changed-principal-is-rejected', ['REJECTED', true], [domain.applyWorkforceCommand(live, start, otherPrincipal).status,
  domain.applyWorkforceCommand(live, start, otherPrincipal).issues.some(i => i.code === 'PROGRAM_IDENTITY')], 'LIFECYCLE', otherPrincipal);

const sourcePaths = ['packages/workforce/src/execution-program/index.ts', 'packages/workforce/src/execution-program/schema.ts',
  'packages/workforce/src/execution-program/compiler.ts', 'packages/workforce/src/execution-program/checker.ts',
  'packages/workforce/src/execution-program/lifecycle.ts', 'packages/workforce/src/execution-program/exact.ts', 'scripts/postz-w2/run-domain-e2e.mts'];
const sources = await Promise.all(sourcePaths.map(async p => ({ path: p, sha256: createHash('sha256').update(await readFile(path.join(repo, 'finnor-os', p))).digest('hex') })));
const inputsByDigest: Record<string, unknown> = {};
const compactCases = cases.map(({ input, ...c }) => {
  const inputDigest = domain.workforceDigest(input); inputsByDigest[inputDigest] ??= input; return { ...c, inputDigest };
});
const failures = cases.filter(x => !x.ok);
const result = { status: failures.length ? 'FAIL' : 'PASS', sourceClass: 'SYNTHETIC', claim: 'PURE_DOMAIN_DEVELOPMENT_ONLY',
  limits: { actors: 128, liveAssignments: 512, depth: 8, externalCalls: 0, timeoutSeconds: 120 }, sources,
  runtime: { node: process.version, platform: process.platform, architecture: process.arch, llmCalls: 0 },
  usage: { startedAt: runStartedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - runStarted,
    cpu: process.cpuUsage(cpuStarted), rssBytesAtObservation: process.memoryUsage().rss,
    scope: 'ONE_PROCESS_INCLUSIVE_NOT_ISOLATED_PEAK', money: 'UNKNOWN', performanceComparisonClaimed: false },
  steps: ['Parse separately resolved original observations', 'Compile useful assignments', 'Check full graph', 'Authenticate exact synthetic dispositions',
    'Apply ordered lifecycle commands', 'Re-resolve current observations', 'Exercise adverse graph boundaries', 'Retain exact expected and actual observations'],
  families: families.map(f => ({ name: f.name, cases: 8, code: f.code, qualification: 'PUBLIC_SYNTHETIC_DEVELOPMENT_NOT_PROTECTED' })),
  cases: compactCases, inputsByDigest, failures: failures.map(x => x.id), originalFailuresRetained: true,
  rerun: 'cd finnor-os && node_modules/.bin/tsx scripts/postz-w2/run-domain-e2e.mts' };
const artifact = path.join(evidence, `domain-run-${Date.now()}.json`);
await writeFile(artifact, JSON.stringify(result));
console.log(JSON.stringify({ status: result.status, cases: cases.length, failures: result.failures, artifact }));
process.exitCode = failures.length ? 1 : 0;
