// Staging-only current PE intake, durable readback, reads and exact reviewed effects.
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const contract = JSON.parse(open('../../infra/deployment/production.contract.json'));
const base = (__ENV.BASE_URL || '').replace(/\/$/, '');
const tenant = __ENV.TENANT_ID;
const deal = __ENV.K6_FIXTURE_DEAL_ID;
const workstream = __ENV.K6_FIXTURE_WORKSTREAM_ID;
const runId = __ENV.K6_RUN_ID;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const positiveInt = (value, fallback, max) => {
  const number = Number(value === undefined ? fallback : value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new Error('Load must be a bounded positive integer');
  return number;
};
const intakeRate = positiveInt(__ENV.INBOX_RATE, 5, 50);
const readVus = positiveInt(__ENV.READ_VUS, 20, 200);
const approvalRate = positiveInt(__ENV.APPROVAL_RATE, 5, 120);
const duration = __ENV.LOAD_DURATION || '60s';
if (!/^(?:[1-9]|[1-9][0-9]|[1-5][0-9]{2}|600)s$/.test(duration)) throw new Error('LOAD_DURATION must be 1s–600s');
const ackDuration = new Trend('intake_ack_duration', true);
const readDuration = new Trend('read_model_duration', true);
const approvals = new Counter('reviewed_approvals');
const readbacks = new Counter('durable_work_readbacks');
const submitted = new Counter('submitted_work');

export const options = {
  maxRedirects: 0,
  scenarios: {
    intake: { executor: 'constant-arrival-rate', rate: intakeRate, timeUnit: '1s', duration, preAllocatedVUs: Math.max(2, intakeRate), maxVUs: intakeRate * 3, exec: 'intake' },
    reads: { executor: 'constant-vus', vus: readVus, duration, exec: 'readModel' },
    approvals: { executor: 'constant-arrival-rate', rate: approvalRate, timeUnit: '1m', duration, preAllocatedVUs: 2, maxVUs: 10, exec: 'approveOwnedFinding' },
  },
  thresholds: {
    checks: ['rate==1'], http_req_failed: ['rate==0'], dropped_iterations: ['count==0'],
    intake_ack_duration: ['p(95)<500'], read_model_duration: ['p(95)<800'],
    submitted_work: ['count>0'], durable_work_readbacks: ['count>0'], reviewed_approvals: ['count>0'],
  },
};

function params(name) {
  return { headers: { authorization: `Bearer ${__ENV.AUTH_BEARER_TOKEN}`, 'content-type': 'application/json', ...(__ENV.VERCEL_BYPASS_SECRET ? { 'x-vercel-protection-bypass': __ENV.VERCEL_BYPASS_SECRET } : {}) }, tags: { name }, timeout: '30s', redirects: 0 };
}
function body(response, label) {
  if (!check(response, { [`${label}: HTTP 200`]: row => row.status === 200 })) fail(label + ' failed');
  try { return response.json(); } catch { fail(label + ' returned invalid JSON'); }
}
function context() {
  return { version: 1, capturedAt: new Date().toISOString(), source: 'console', focusedEntity: { entityType: 'pe_deal', entityId: deal },
    selectedEntities: [], excludedEntities: [], surface: { id: 'deals', route: '/centropy' }, filters: [] };
}
export function setup() {
  const loopback = __ENV.K6_DISPOSABLE_LOOPBACK === '1' && __ENV.NODE_ENV === 'test' && /^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]+$/.test(base);
  if (!(loopback || /^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(base))) throw new Error('A staging HTTPS origin or explicit disposable loopback is required');
  if ([contract.topology.api.productionUrl, contract.topology.frontend.productionUrl].some(origin => origin.replace(/\/$/, '') === base)) throw new Error('Canonical production targets are forbidden');
  if (![tenant, deal, workstream].every(value => uuid.test(value || '')) || !__ENV.AUTH_BEARER_TOKEN || !/^[a-zA-Z0-9_-]{8,100}$/.test(runId || '')) throw new Error('Tenant, disposable PE Deal/Workstream, token and unique run ID are required');
  const release = body(http.get(base + '/api/release', params('release')), 'release');
  if (release.environment !== 'staging' && !(loopback && ['test', 'development'].includes(release.environment))) throw new Error('Target does not identify itself as staging');
  const identity = body(http.get(base + '/api/me', params('identity')), 'identity');
  if (identity.tenantId !== tenant || !uuid.test(identity.employeeId || '') || identity.role !== 'owner') throw new Error('Authenticated identity must be the configured disposable tenant owner');
  const roots = body(http.post(base + '/api/company-brain/roots', JSON.stringify({ query: deal, limit: 1 }), params('fixture-root')), 'fixture root');
  if (!Array.isArray(roots.results) || !roots.results.some(row => Array.isArray(row.rootRefs) && row.rootRefs.some(root => root.entityType === 'pe_deal' && root.entityId === deal))) throw new Error('Configured synthetic Deal is not visible to the caller');
  return { employeeId: identity.employeeId, environment: release.environment };
}
function readWork(id) {
  const aggregate = body(http.get(`${base}/api/works/${id}`, params('work-readback')), 'durable Work readback').work;
  if (!check(aggregate, { 'Work identity and tenant match': row => row && row.work && row.work.id === id && row.work.tenantId === tenant })) fail('Durable Work identity mismatch');
  readbacks.add(1);
  return aggregate;
}
function submit(instruction) {
  const idempotencyKey = `${runId}:${__VU}:${__ITER}`;
  const response = http.post(base + '/api/actions', JSON.stringify({ instruction, channel: 'console', sessionId: runId, idempotencyKey, reviewBeforeExecution: true, activeContext: context() }), params('intake'));
  ackDuration.add(response.timings.duration);
  const accepted = body(response, 'intake');
  if (!check(accepted, { 'intake records a Work ID': row => row && uuid.test(row.workId || '') })) fail('Intake did not identify durable Work');
  submitted.add(1);
  return accepted;
}
export function intake() {
  const accepted = submit(`Show the current deal execution graph for Deal ${deal}. FINNOR_K6_READ ${runId}`);
  readWork(accepted.workId);
}
export function readModel() {
  const response = http.get(base + '/api/read-models/attention?limit=20', params('attention'));
  readDuration.add(response.timings.duration);
  const result = body(response, 'attention');
  if (!check(result, { 'attention returns an items array': row => Array.isArray(row.data && row.data.items) })) fail('Attention contract mismatch');
  sleep(0.1);
}
export function approveOwnedFinding(data) {
  const accepted = submit(`Record a low severity, non-material synthetic test finding in Deal ${deal}, Workstream ${workstream}, owned by employee ${data.employeeId}. Statement: FINNOR_K6_APPROVAL ${runId} ${__VU}:${__ITER}. This is disposable load-test evidence. Prepare it for review before execution.`);
  const prepared = accepted.prepared;
  if (!check(prepared, { 'exactly one synthetic finding prepared': rows => Array.isArray(rows) && rows.length === 1 && rows[0].actionType === 'record_finding' && ['pending', 'needs_human_review'].includes(rows[0].status) && uuid.test(rows[0].actionId) && /^[a-f0-9]{64}$/i.test(rows[0].semanticHash || '') })) fail('No exact owned finding to approve');
  const action = prepared[0], aggregate = readWork(accepted.workId);
  if (!check(aggregate, { 'reviewed effect belongs to this Work': row => Array.isArray(row.actions) && row.actions.some(candidate => candidate.id === action.actionId && candidate.workId === accepted.workId) && Array.isArray(row.businessEffects) && row.businessEffects.some(effect => effect.domainActionId === action.actionId && effect.semanticHash === action.semanticHash) })) fail('Prepared effect did not match canonical readback');
  const result = body(http.post(`${base}/api/actions/${action.actionId}/confirm`, JSON.stringify({ expectedEffectHash: action.semanticHash, typedConfirmation: true, note: `Disposable load fixture ${runId}` }), params('confirm-owned')), 'reviewed approval');
  if (!check(result, { 'approval reports success': row => row.result && row.result.status === 'success' })) fail('Approval was not successful');
  const updated = readWork(accepted.workId);
  if (!check(updated, { 'canonical action records approval': row => row.actions.some(candidate => candidate.id === action.actionId && ['approved', 'executing', 'completed'].includes(candidate.status)) })) fail('Approval absent from canonical state');
  approvals.add(1);
}
export function handleSummary(data) {
  const thresholdPass = Object.values(data.metrics).every(metric => Object.values(metric.thresholds || {}).every(threshold => threshold.ok))
    && ['submitted_work', 'durable_work_readbacks', 'reviewed_approvals'].every(name => data.metrics[name] && data.metrics[name].values.count > 0);
  const inputs = { base, tenantId: tenant, dealId: deal, workstreamId: workstream, runId, intakeRate, readVus, approvalRate, duration };
  const proof = { schema: 'finnor.staging-load-probe.v1', generatedAt: new Date().toISOString(), status: thresholdPass ? 'PASS' : 'FAIL', inputs, metrics: data.metrics,
    steps: ['Require staging release identity and configured caller tenant', 'Verify synthetic PE Deal visibility', 'Submit reviewed Work and read it canonically', 'Query attention', 'Create only a run-owned synthetic finding, bind reviewed effect, approve and reread'],
    qualification: 'HTTP load and finite Work/approval readback. No zero-loss claim outside observed IDs, no independent economic or provider outcome claim.',
    rerun: 'Use the same script and recorded rates/duration with freshly provisioned disposable PE fixtures and a new K6_RUN_ID. Supply tokens only through the environment.' };
  return { [__ENV.K6_EVIDENCE_FILE || 'k6-load-evidence.json']: JSON.stringify(proof, null, 2) };
}
