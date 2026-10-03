import { z } from 'zod';
import type { BeliefClaim, BeliefView, ExperimentRef, InterventionAssumptionCategory, InterventionFeature, InterventionFitBundle,
  InterventionFitRequest, InterventionHistoryRow, InterventionIdentification, InterventionModel, InterventionResponseBundle,
  InterventionResponseQuery, InterventionSpecification, InterventionSpecificationRef, S3ExperienceEvent } from '@finnor/shared-types';
import { epistemicHash } from './source-precedence';
import { ExperimentRefSchema } from './experiments';
import { invokeInterventionBackend,type S3PreparedReferenceSink } from './intervention-backend';

export class InterventionContractError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'INVALID_MODEL' | 'PERMITTED_CONTEXT_UNAVAILABLE' | 'LIMIT_EXCEEDED' | 'UNSUPPORTED', message: string) { super(message); this.name = 'InterventionContractError'; }
}
const text = z.string().min(1).max(256), instant = z.string().datetime({ offset: true });
const finite = z.number().finite().min(-1e9).max(1e9);
const root = z.object({ entityType: text, entityId: z.string().uuid() }).strict();
const operation = z.enum(['PRICE_CHANGE', 'WORKING_CAPITAL', 'SUPPLIER_SWITCH', 'FINANCING_CHANGE', 'DISCLOSURE']);
const atom = z.union([z.object({ kind: z.literal('CONSTANT') }).strict(), z.object({ kind: z.enum(['STATE', 'EXPOSURE']), id: text, lag: z.number().int().min(0).max(3) }).strict()]);
const feature = z.union([atom, z.object({ kind: z.literal('PRODUCT'), left: atom, right: atom }).strict()]);
const categories = ['SEQUENTIAL_EXCHANGEABILITY', 'POSITIVITY', 'CONSISTENCY', 'MEASUREMENT', 'SELECTION', 'INTERFERENCE', 'STATIONARITY', 'FUNCTIONAL_FORM', 'ACTOR_INFORMATION'] as const;
const fitSchema = z.object({ schema: z.literal('finnor.s3.fit-request.v1'), modelKey: text, episodeId: text, roots: z.array(root).min(1).max(8),
  stateVariables: z.array(z.object({ id: text, root, seriesId: z.string().uuid(), unit: text, range: z.tuple([finite, finite]), role: z.enum(['ENTERPRISE_STATE', 'COUNTERPARTY']) }).strict()).min(1).max(8),
  exposures: z.array(z.object({ id: text, root, seriesId: z.string().uuid(), unit: text, operation,
    measurement: z.object({ status: z.enum(['MEASURED_ACTUAL', 'INTENDED', 'UNKNOWN']), methodRef: ExperimentRefSchema, qualification: z.literal('SUPPLIED_OWNER_MEASUREMENT_UNVERIFIED') }).strict() }).strict()).min(1).max(4),
  time: z.object({ startAt: instant, endAt: instant, periodMs: z.number().int().min(1).max(31536000000), trainingThrough: instant }).strict(),
  validity: z.object({ validUntil: instant, maxBeliefAgeMs: z.number().int().positive().max(31536000000), regimes: z.array(text).min(1).max(32), contexts: z.array(text).min(1).max(32), maximumHorizon: z.number().int().min(1).max(24) }).strict(),
  measurementPolicy: z.object({ selection: z.enum(['COMPLETE_RECORDED_GRID_ASSUMED', 'UNKNOWN']), missingness: z.enum(['NONE', 'INFORMATIVE', 'UNKNOWN']), instrumentError: z.enum(['ASSUMED_NEGLIGIBLE', 'UNKNOWN']) }).strict(),
  mechanisms: z.array(z.object({ id: text, meaning: text, origin: z.literal('SUPPLIED_HYPOTHESIS'), assumptions: z.array(z.object({ id: text, category: z.enum(categories), status: z.enum(['DECLARED', 'UNKNOWN', 'CONTRADICTED']), meaning: text, evidenceRefs: z.array(ExperimentRefSchema).max(32) }).strict()).max(32),
    equations: z.array(z.object({ variableId: text, features: z.array(feature).min(1).max(24) }).strict()).min(1).max(8),
    counterparties: z.array(z.object({ variableId: text, actorRef: ExperimentRefSchema, objectives: z.array(text).min(1).max(16), informationExposureIds: z.array(text).max(4), constraints: z.array(text).min(1).max(16), responseAssumption: z.enum(['LEARNED_LAGGED_RESPONSE', 'UNKNOWN']) }).strict()).max(8) }).strict()).min(1).max(4),
  numerical: z.object({ bootstrapDraws: z.number().int().min(64).max(256), blockLength: z.number().int().min(2).max(16), seed: z.number().int().min(0).max(4294967295) }).strict(),
}).strict();
const specSchema = z.object({ schema: z.literal('finnor.intervention-specification.v1'), vocabularyVersion: z.literal('s3-intervention-v1'), targets: z.array(root).min(1).max(8), context: text,
  timing: z.object({ startAt: instant, periodMs: z.number().int().positive(), durationMs: z.number().int().positive() }).strict(),
  channels: z.array(z.object({ exposureId: text, operation, unit: text, target: root, doses: z.array(finite).min(1).max(24), intendedExposure: z.literal('REGISTERED_DOSE'), permittedRefinements: z.array(z.never()).max(0) }).strict()).min(1).max(4),
}).strict();
const querySchema = z.object({ schema: z.literal('finnor.s3.response-query.v1'), id: text, episodeId: text, kind: z.enum(['POPULATION_INTERVENTION', 'OBSERVATIONAL_FORECAST', 'UNIT_COUNTERFACTUAL']), targets: z.array(root).min(1).max(8), context: text, regime: text,
  horizon: z.number().int().min(1).max(24), intervention: specSchema, comparator: specSchema, simulations: z.number().int().min(256).max(4096), seed: z.number().int().min(0).max(4294967295) }).strict();
export const INTERVENTION_ADMISSION = Object.freeze({ status: 'BLOCKED_EXTERNAL' as const, methodAdmitted: false as const, receipt: null, appendAuthorityGranted: false as const, executionAuthorityGranted: false as const });
const key = (r: { entityType: string; entityId: string }) => `${r.entityType}:${r.entityId}`;
const unique = (values: string[], reason: string) => { if (new Set(values).size !== values.length) throw new InterventionContractError('INVALID_REQUEST', reason); };
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const atoms = (f: InterventionFeature) => f.kind === 'PRODUCT' ? [f.left, f.right] : [f];
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; }
export function parseInterventionFitRequest(value: unknown): InterventionFitRequest {
  const result = fitSchema.safeParse(value); if (!result.success) throw new InterventionContractError('INVALID_REQUEST', 'Unsupported S3 fitting contract');
  const request = result.data as InterventionFitRequest;
  unique(request.roots.map(key), 'Duplicate root'); unique([...request.stateVariables, ...request.exposures].map(v => v.id), 'Duplicate variable/channel');
  unique([...request.stateVariables, ...request.exposures].map(v => v.seriesId), 'One measured series cannot acquire multiple state/exposure meanings'); unique(request.mechanisms.map(m => m.id), 'Duplicate mechanism');
  if ([...request.stateVariables, ...request.exposures].some(v => !request.roots.some(r => key(r) === key(v.root)))) throw new InterventionContractError('INVALID_REQUEST', 'Variable target is outside registered roots');
  if (request.stateVariables.some(v => v.range[1] <= v.range[0])) throw new InterventionContractError('INVALID_REQUEST', 'Outcome range must be nondegenerate');
  const periods = (Date.parse(request.time.endAt)-Date.parse(request.time.startAt))/request.time.periodMs;
  const training = (Date.parse(request.time.trainingThrough)-Date.parse(request.time.startAt))/request.time.periodMs;
  if (!Number.isInteger(periods) || !Number.isInteger(training) || periods > 512 || training < 64 || periods-training < 20)
    throw new InterventionContractError('UNSUPPORTED', 'Complete aligned history requires 64 training and 20 holdout periods, at most 512 periods');
  for (const m of request.mechanisms) {
    unique(m.assumptions.map(a => a.id), 'Duplicate assumption'); unique(m.assumptions.map(a => a.category), 'Contradictory duplicate assumption categories');
    if (!sameSet(m.equations.map(e => e.variableId), request.stateVariables.map(v => v.id))) throw new InterventionContractError('INVALID_REQUEST', 'Each mechanism must fit every joint state exactly once');
    for (const e of m.equations) {
      unique(e.features.map(epistemicHash), 'Duplicate feature');
      if (e.features.filter(f => f.kind === 'CONSTANT').length !== 1) throw new InterventionContractError('INVALID_REQUEST', 'Each equation requires one explicit intercept');
      for (const f of e.features) for (const a of atoms(f)) if (a.kind !== 'CONSTANT') {
        const variables = a.kind === 'STATE' ? request.stateVariables : request.exposures;
        if (!variables.some(v => v.id === a.id) || (a.kind === 'STATE' && a.lag === 0)) throw new InterventionContractError('UNSUPPORTED', 'Unknown variable or contemporaneous/post-treatment state adjustment');
      }
    }
    unique(m.counterparties.map(a => a.variableId), 'Duplicate actor response');
    for (const actor of m.counterparties) if (!request.stateVariables.some(v => v.id === actor.variableId && v.role === 'COUNTERPARTY') || actor.informationExposureIds.some(id => !request.exposures.some(v => v.id === id)))
      throw new InterventionContractError('INVALID_REQUEST', 'Actor identity/information must reference registered measured variables');
  }
  return freeze(structuredClone(request));
}
export function parseInterventionQuery(value: unknown): InterventionResponseQuery {
  const result = querySchema.safeParse(value); if (!result.success) throw new InterventionContractError('INVALID_REQUEST', 'Unsupported S3 response contract');
  return freeze(structuredClone(result.data as InterventionResponseQuery));
}
export function interventionSpecificationRef(value: InterventionSpecification): InterventionSpecificationRef {
  const parsed = specSchema.safeParse(value); if (!parsed.success) throw new InterventionContractError('INVALID_REQUEST', 'Unsupported intervention meaning');
  const digest = epistemicHash(parsed.data);
  return { owner: 'S3', id: `intervention:${digest}`, version: 's3-intervention-v1', contentDigest: digest };
}
export function prepareS3ExperienceEvent(input: Omit<S3ExperienceEvent, 'eventId'>): S3ExperienceEvent {
  return freeze({ ...structuredClone(input), eventId: `s3-event:${epistemicHash(input)}` });
}
export function assertInterventionModel(value: unknown): asserts value is InterventionModel {
  if (!value || typeof value !== 'object') throw new InterventionContractError('INVALID_MODEL', 'S3 artifact unavailable');
  const model = value as InterventionModel;
  const { ref, ...body } = model;
  if (model.schema !== 'finnor.intervention-model.v1' || model.version !== 's3-temporal-linear-v1' || !ref || ref.owner !== 'S3' || ref.version !== model.version
    || ref.contentDigest !== epistemicHash(body) || ref.id !== `intervention-model:${ref.contentDigest}` || !sameSet(Object.keys(model.admission), Object.keys(INTERVENTION_ADMISSION))
    || epistemicHash(model.admission) !== epistemicHash(INTERVENTION_ADMISSION)) throw new InterventionContractError('INVALID_MODEL', 'S3 artifact commitment or admission is invalid');
  parseInterventionFitRequest(model.request);
}
function experience(model: Pick<InterventionModel, 'tenantId' | 'principalId' | 'knowledgeAt' | 'beliefBindings' | 'request'>, type: S3ExperienceEvent['type'], revisionRef: string, detail: Record<string, unknown>, modelComputeRef: string | null = null, parents: string[] = []): S3ExperienceEvent {
  return prepareS3ExperienceEvent({ schema: 'finnor.s3.experience.v1', episodeId: model.request.episodeId, semanticOwner: 'S3', type,
    tenantId: model.tenantId, principalId: model.principalId, rightsRefs: model.beliefBindings.map(v => v.rightsRef), preparedParentRefs: parents, causalParents: [],
    revisionRef, contentDigest: epistemicHash(detail), validAt: model.request.time.endAt, knowledgeAt: model.knowledgeAt,
    dependencyRefs: model.beliefBindings.map(v => v.dependencyDigest), freshnessRefs: model.beliefBindings.map(v => v.dependencyDigest), uncertainty: 'ASSUMPTION_CONDITIONAL_UNADMITTED_H1', horizon: 'H1',
    // Model/BeliefView references commit the full observation lineage. Avoid
    // duplicating that entire history in every hypothesis/query/cost event.
    provenanceRefs: model.beliefBindings.flatMap(v => v.selectedSeriesRefs), modelComputeRef, detail });
}
function history(request: InterventionFitRequest, views: BeliefView[]): { rows: InterventionHistoryRow[]; bindings: InterventionModel['beliefBindings'] } {
  const count = (Date.parse(request.time.endAt)-Date.parse(request.time.startAt))/request.time.periodMs;
  const rows: InterventionHistoryRow[] = Array.from({ length: count }, (_, period) => ({ period, startAt: new Date(Date.parse(request.time.startAt)+period*request.time.periodMs).toISOString(), endAt: new Date(Date.parse(request.time.startAt)+(period+1)*request.time.periodMs).toISOString(), states: {}, exposures: {}, measurementRefs: [] }));
  const bindings: InterventionModel['beliefBindings'] = [];
  for (const r of request.roots) {
    const view = views.find(v => key(v.root) === key(r)); if (!view) throw new InterventionContractError('PERMITTED_CONTEXT_UNAVAILABLE', 'Permitted S3 context is unavailable');
    if (view.coverage.canonicalStatus !== 'COMPLETE' || view.coverage.truncated) throw new InterventionContractError('UNSUPPORTED', 'Canonical S1 coverage is incomplete');
    const binding = { viewRef: view.id, contentDigest: view.contentDigest, dependencyDigest: view.dependencyDigest, pin: view.pin, rightsRef: view.rights.ref, coverage: view.coverage, selectedSeriesRefs: [] as BeliefClaim['ownerRef'][], selectedObservationRefs: [] as BeliefClaim['ownerRef'][] };
    for (const variable of [...request.stateVariables, ...request.exposures].filter(v => key(v.root) === key(r))) {
      const series = view.claims.find(c => c.ownerRef.entityType === 'pe_metric_series' && c.ownerRef.id === variable.seriesId);
      if (!series || series.value.unit !== variable.unit || series.value.subjectId !== r.entityId || series.value.subjectType !== r.entityType) throw new InterventionContractError('UNSUPPORTED', 'Canonical measured series owner, target or units mismatch');
      binding.selectedSeriesRefs.push(series.ownerRef);
      const selected = view.claims.filter(c => c.kind === 'OBSERVED_RECORD' && c.ownerRef.entityType === 'pe_metric_observation' && c.value.metricSeriesId === variable.seriesId
        && Date.parse(String(c.value.periodStart)) >= Date.parse(request.time.startAt) && Date.parse(String(c.value.periodStart)) < Date.parse(request.time.endAt));
      if (selected.length !== count) throw new InterventionContractError('UNSUPPORTED', 'Missing, duplicated or censored measured history; complete-case fitting is not qualified');
      const seen = new Set<number>();
      for (const claim of selected) {
        const i = (Date.parse(String(claim.value.periodStart))-Date.parse(request.time.startAt))/request.time.periodMs;
        const number = Number(claim.value.valueNumeric);
        if (!Number.isInteger(i) || !rows[i] || seen.has(i) || Date.parse(String(claim.value.periodEnd)) !== Date.parse(rows[i]!.endAt)
          || claim.value.valueType !== 'number' || claim.value.valueNumeric === null || !Number.isFinite(number) || Math.abs(number) > 1e9
          || Date.parse(claim.knowledgeAt) > Date.parse(view.knowledgeAt) || claim.uncertainty.reasons.includes('PROVENANCE_DEPENDENCY_UNAVAILABLE'))
          throw new InterventionContractError('UNSUPPORTED', 'Measured history timing/value/provenance or identity is unresolved');
        seen.add(i); const row = rows[i]!;
        (request.stateVariables.some(v => v.id === variable.id) ? row.states : row.exposures)[variable.id] = number;
        row.measurementRefs.push(claim.ownerRef); binding.selectedObservationRefs.push(claim.ownerRef);
      }
    }
    const selectedIds = new Set([...binding.selectedSeriesRefs, ...binding.selectedObservationRefs].map(r => r.revisionId));
    if (view.contradictions.some(c => c.claimRefs.some(id => selectedIds.has(id)))) throw new InterventionContractError('UNSUPPORTED', 'Selected measured history has unresolved conflicting evidence');
    bindings.push(binding);
  }
  return { rows, bindings };
}
export async function fitInterventionModel(input: { request: unknown; beliefViews: BeliefView[]; now?: string;preparedReferenceSink?:S3PreparedReferenceSink }): Promise<InterventionFitBundle> {
  const request = parseInterventionFitRequest(input.request), now = input.now ?? new Date().toISOString();
  const first = input.beliefViews[0]; if (!first || input.beliefViews.some(v => v.tenantId !== first.tenantId || v.principalId !== first.principalId)) throw new InterventionContractError('PERMITTED_CONTEXT_UNAVAILABLE', 'Permitted S3 context unavailable');
  const shell = { tenantId: first.tenantId, principalId: first.principalId, knowledgeAt: now, request, beliefBindings: input.beliefViews.map(v => ({ viewRef: v.id, contentDigest: v.contentDigest, dependencyDigest: v.dependencyDigest, pin: v.pin, rightsRef: v.rights.ref, coverage: v.coverage, selectedSeriesRefs: [], selectedObservationRefs: [] })) as InterventionModel['beliefBindings'] };
  const reject = (reason: string): InterventionFitBundle => freeze({ schema: 'finnor.s3.fit-bundle.v1', status: 'REJECTED', model: null, reasons: [reason], compute: null, experience: [experience(shell, 'REJECTION', `fit-request:${epistemicHash(request)}`, { reason })], admission: INTERVENTION_ADMISSION });
  if (request.exposures.some(e => e.measurement.status !== 'MEASURED_ACTUAL') || request.measurementPolicy.missingness !== 'NONE' || request.measurementPolicy.selection !== 'COMPLETE_RECORDED_GRID_ASSUMED' || request.measurementPolicy.instrumentError !== 'ASSUMED_NEGLIGIBLE') return reject('ACTUAL_EXPOSURE_SELECTION_OR_MEASUREMENT_UNQUALIFIED');
  if (Date.parse(request.validity.validUntil) <= Date.parse(now) || Date.parse(request.time.endAt) > Date.parse(now)
    || input.beliefViews.some(v => Date.parse(v.knowledgeAt) > Date.parse(now) || Date.parse(now)-Date.parse(v.knowledgeAt) > request.validity.maxBeliefAgeMs)) return reject('HISTORY_KNOWLEDGE_OR_VALIDITY_CUT_INVALID');
  let data: ReturnType<typeof history>; try { data = history(request, input.beliefViews); } catch (e) { if (e instanceof InterventionContractError && e.code === 'UNSUPPORTED') return reject(e.message); throw e; }
  shell.beliefBindings = data.bindings;
  const trainingPeriods = (Date.parse(request.time.trainingThrough)-Date.parse(request.time.startAt))/request.time.periodMs;
  const parameterCount = request.mechanisms.reduce((n, m) => n+m.equations.reduce((k, e) => k+e.features.length, 0), 0);
  const projectedBytes = parameterCount*request.numerical.bootstrapDraws*32
    + (trainingPeriods-3)*request.stateVariables.length*request.mechanisms.length*32
    + 2*Buffer.byteLength(JSON.stringify({ request, rows: data.rows, bindings: data.bindings })) + 256*1024;
  if (projectedBytes > 8*1024*1024) return reject('PROJECTED_MODEL_AND_BACKEND_INPUT_EXCEED_REGISTERED_8_MIB_BUDGET');
  const invoked = await invokeInterventionBackend({ operation: 'fit', request, rows: data.rows, trainingPeriods }, { tenantId: first.tenantId, principalId: first.principalId, rightsRefs: data.bindings.map(b => b.rightsRef), seed: request.numerical.seed,preparedReferenceSink:input.preparedReferenceSink });
  const events = request.mechanisms.map(m => experience(shell, 'HYPOTHESIS', `mechanism:${epistemicHash(m)}`, { mechanism: m, truthEstablished: false }));
  events.push(experience(shell, 'COMPUTE', invoked.compute.id, { compute: invoked.compute }, invoked.compute.id));
  if (invoked.reason || !invoked.result?.fits?.length || invoked.result.fits.some((f: any) => f.status !== 'FITTED')) {
    const reason = invoked.reason ?? 'INCOMPLETE_FIT_NUMERICAL_FAILURE'; events.push(experience(shell, 'REJECTION', invoked.compute.inputRef, { reason, partialFits: invoked.result?.fits ?? null }, invoked.compute.id));
    return freeze({ schema: 'finnor.s3.fit-bundle.v1', status: 'FAILED', model: null, reasons: [reason], compute: invoked.compute, experience: events, admission: INTERVENTION_ADMISSION });
  }
  const body: Omit<InterventionModel, 'ref'> = { schema: 'finnor.intervention-model.v1', semanticOwner: 'S3', version: 's3-temporal-linear-v1', ...shell,
    history: { periods: data.rows.length, trainingPeriods, holdoutPeriods: data.rows.length-trainingPeriods, inputDigest: epistemicHash(data.rows), rows: data.rows, measurementQualification: 'OWNER_MEASUREMENTS_UNVERIFIED', causalExposureVerification: 'UNKNOWN', omittedRows: 0 },
    fits: invoked.result.fits, compute: invoked.compute, uncertainty: { parameter: 'SYNCHRONIZED_MOVING_BLOCK_BOOTSTRAP_APPROXIMATE', stochastic: 'JOINT_RESIDUAL_BLOCKS', mechanism: 'UNWEIGHTED_COMPETING_HYPOTHESES', measurement: 'ASSUMPTION_CONDITIONAL', identification: 'QUERY_SPECIFIC', transport: 'NO_AUTOMATIC_TRANSFER', numerical: 'FLOAT64_MONTE_CARLO_NOT_EXACT' }, admission: INTERVENTION_ADMISSION };
  const digest = epistemicHash(body), model: InterventionModel = freeze({ ...body, ref: { owner: 'S3', id: `intervention-model:${digest}`, version: body.version, contentDigest: digest } });
  events.push(experience(model, 'FIT', model.ref.id, { modelRef: model.ref, inputDigest: model.history.inputDigest, warmupPeriods: 3, omittedRows: 0, fittingCut: request.time.trainingThrough, methodAdmitted: false }, invoked.compute.id, events.map(e => e.eventId)));
  for (const f of model.fits) events.push(experience(model, 'REFUTATION', model.ref.id, { mechanismId: f.mechanismId, refutations: f.refutations, passingProvesIdentification: false }, invoked.compute.id));
  return freeze({ schema: 'finnor.s3.fit-bundle.v1', status: 'FITTED', model, reasons: [], compute: invoked.compute, experience: events, admission: INTERVENTION_ADMISSION });
}
export function assessInterventionIdentification(model: InterventionModel): InterventionIdentification {
  const mechanismAssessments: InterventionIdentification['mechanismAssessments'] = model.request.mechanisms.map(m => {
    const reasons: string[] = [];
    for (const category of categories) if (m.assumptions.find(a => a.category === category)?.status !== 'DECLARED') reasons.push(`${category}_UNKNOWN_OR_CONTRADICTED`);
    for (const variable of model.request.stateVariables.filter(v => v.role === 'COUNTERPARTY')) {
      const actor = m.counterparties.find(a => a.variableId === variable.id);
      if (!actor || actor.responseAssumption !== 'LEARNED_LAGGED_RESPONSE') reasons.push('COUNTERPARTY_RESPONSE_UNKNOWN');
      const exposed = m.equations.find(e => e.variableId === variable.id)!.features.flatMap(atoms).filter(a => a.kind === 'EXPOSURE').map(a => (a as { id: string }).id);
      if (actor && exposed.some(id => !actor.informationExposureIds.includes(id))) reasons.push('ACTOR_INFORMATION_ASSUMPTION_CONTRADICTS_FEATURES');
    }
    if (model.fits.find(f => f.mechanismId === m.id)?.refutations.some(r => r.status !== 'NOT_FALSIFIED')) reasons.push('MECHANISM_FALSIFIED_OR_DIAGNOSTIC_UNAVAILABLE');
    return { mechanismId: m.id, status: reasons.length ? 'UNRESOLVED' as const : 'CONDITIONALLY_IDENTIFIED' as const, assumptionRefs: m.assumptions.map(a => a.id), reasons };
  });
  return { status: mechanismAssessments.every(m => m.status === 'CONDITIONALLY_IDENTIFIED') ? 'CONDITIONALLY_IDENTIFIED' : 'UNRESOLVED', estimand: 'POPULATION_INTERVENTIONAL_STATE_CONTRAST',
    reasons: mechanismAssessments.flatMap(m => m.reasons.map(r => `${m.mechanismId}:${r}`)), method: 'SEQUENTIAL_G_FORMULA_UNDER_DECLARED_ASSUMPTIONS', graphTruthEstablished: false, fieldIdentified: false, mechanismAssessments };
}
export function interventionInquiryNeeds(model: InterventionModel): string[] {
  const assessed = assessInterventionIdentification(model);
  return [...assessed.reasons, 'DISTINGUISH_COMPETING_MECHANISMS_WITH_INDEPENDENT_MEASUREMENTS', 'QUALIFY_ACTUAL_EXPOSURE_AND_INSTRUMENT_ERROR', 'PROSPECTIVE_COMPANY_TIME_REGIME_RESPONSE_CALIBRATION', 'S2_FINITE_IID_LAWS_REQUIRE_SEPARATE_INDEPENDENT_INSTRUMENT_ASSUMPTIONS'];
}
export function interventionModelEvent(model: InterventionModel, type: S3ExperienceEvent['type'], detail: Record<string, unknown>, parents: string[] = []): S3ExperienceEvent {
  return experience({ ...model, knowledgeAt: new Date().toISOString() }, type, model.ref.id, detail, null, parents);
}
export async function queryInterventionModel(model: InterventionModel, value: unknown,options:{preparedReferenceSink?:S3PreparedReferenceSink}={}): Promise<InterventionResponseBundle> {
  assertInterventionModel(model); const query = parseInterventionQuery(value);
  const assessed = assessInterventionIdentification(model), reasons: string[] = [];
  if (query.kind !== 'POPULATION_INTERVENTION') reasons.push(query.kind === 'UNIT_COUNTERFACTUAL' ? 'UNIT_SPECIFIC_COUNTERFACTUAL_NOT_IDENTIFIED' : 'OBSERVED_POLICY_LAW_NOT_FITTED_NO_OBSERVATIONAL_FORECAST');
  if (!sameSet(query.targets.map(key), model.request.roots.map(key))) reasons.push('COMPANY_POPULATION_TRANSPORT_UNQUALIFIED');
  if (!model.request.validity.regimes.includes(query.regime) || !model.request.validity.contexts.includes(query.context)) reasons.push('REGIME_OR_CONTEXT_TRANSPORT_UNQUALIFIED');
  if (query.horizon > model.request.validity.maximumHorizon) reasons.push('HORIZON_EXCEEDS_QUALIFIED_DOMAIN');
  for (const specification of [query.intervention, query.comparator]) {
    if (!sameSet(specification.targets.map(key), query.targets.map(key)) || specification.context !== query.context
      || specification.timing.periodMs !== model.request.time.periodMs || specification.timing.durationMs !== query.horizon*model.request.time.periodMs
      || Date.parse(specification.timing.startAt) !== Date.parse(model.request.time.endAt)) throw new InterventionContractError('INVALID_REQUEST', 'Intervention target/context/time/duration differs from the initial-history semantics');
    unique(specification.channels.map(c => c.exposureId), 'Duplicate intervention channel');
    if (!sameSet(specification.channels.map(c => c.exposureId), model.request.exposures.map(e => e.id))) throw new InterventionContractError('INVALID_REQUEST', 'Joint schedule must bind every measured exposure/disclosure channel');
    for (const channel of specification.channels) {
      const exposure = model.request.exposures.find(e => e.id === channel.exposureId)!;
      if (channel.unit !== exposure.unit || channel.operation !== exposure.operation || key(channel.target) !== key(exposure.root) || channel.doses.length !== query.horizon)
        throw new InterventionContractError('INVALID_REQUEST', 'Intervention operation, dose units, target or duration differs from the registered measurement meaning');
    }
  }
  if (reasons.length) { assessed.status = 'UNRESOLVED'; assessed.reasons.push(...reasons); }
  const interventionRef = interventionSpecificationRef(query.intervention), comparatorRef = interventionSpecificationRef(query.comparator);
  let responses: InterventionResponseBundle['responses'] = [], compute: InterventionResponseBundle['compute'] = null;
  if (!reasons.length) {
    const invoked = await invokeInterventionBackend({ operation: 'simulate', model, query, unresolvedMechanisms: assessed.mechanismAssessments.filter(m => m.status === 'UNRESOLVED').map(m => m.mechanismId) },
      { tenantId: model.tenantId, principalId: model.principalId, rightsRefs: model.beliefBindings.map(b => b.rightsRef), seed: query.seed,preparedReferenceSink:options.preparedReferenceSink });
    compute = invoked.compute;
    if (invoked.reason || !invoked.result?.responses?.length) { assessed.status = 'UNRESOLVED'; assessed.reasons.push(invoked.reason ?? 'NUMERICAL_RESPONSE_UNAVAILABLE'); }
    else {
      responses = invoked.result.responses;
      if (responses.some(r => r.periods.some(p => p.unsupportedFraction > 0))) {
        if (assessed.status === 'CONDITIONALLY_IDENTIFIED') assessed.status = 'BOUNDED';
        assessed.reasons.push('UNSUPPORTED_TRAJECTORY_MASS_RETAINED_WITH_DECLARED_RANGE_APPROXIMATE_BOUNDS');
      }
    }
  }
  const queryRef = `response-query:${epistemicHash(query)}`;
  // Separate invocations have distinct cost/provenance records even when the
  // numeric seed/output is identical. Never collide their immutable artifacts.
  const outputDigest = epistemicHash({ modelRef: model.ref, queryRef, identification: assessed, responses, compute });
  const ref: ExperimentRef = { owner: 'S3', id: `intervention-response:${outputDigest}`, version: model.version, contentDigest: outputDigest };
  const events = [interventionModelEvent(model, 'IDENTIFICATION', { queryRef, queryEpisodeId: query.episodeId, identification: assessed }), interventionModelEvent(model, 'SIMULATION', { queryRef, queryEpisodeId: query.episodeId, responseRef: ref, interventionRef, comparatorRef, status: assessed.status, reasons: assessed.reasons }, [])];
  if (compute) events.push(interventionModelEvent(model, 'COMPUTE', { compute }));
  return freeze({ schema: 'finnor.s3.response-bundle.v1', ref, modelRef: model.ref, queryRef, query, identification: assessed, responses, compute,
    lineage: { modelRef: model.ref, interventionRef, comparatorRef, policyRef: null, allocationRef: null, authorityRef: null, effectRef: null, actualExposureRef: null, outcomeEstimandRef: null, attributionGranted: false, stages: responses.length ? ['MODELED', 'SIMULATED'] : ['MODELED'] },
    handoffs: { S2: { inquiryNeeds: interventionInquiryNeeds(model), iidLikelihoodGranted: false }, S4: { responseRef: ref.id, executionAuthorityGranted: false }, S5: { jointResponseRef: ref.id, reservationGranted: false }, S7: { evidenceRef: ref.id, creditGranted: false }, S8: { methodAdmission: 'BLOCKED_EXTERNAL' } },
    experience: events, admission: INTERVENTION_ADMISSION, limitations: ['Assumptions and measured exposure reliability are declared, not established by fit', 'No automatic company/regime/dose transport', 'Parameter bootstrap and Monte Carlo bounds are approximations with no finite-sample coverage certificate', 'Intervals are population distributions; paired shocks do not identify individual counterfactuals', 'Support mass bounds are simulation-relative and conditional on supplied finite ranges', 'Three initial periods are declared history warmup, not omitted outcomes', 'Prepared history and local files have no protected ExperienceLedger receipt', 'No field calibration, method admission, execution or realized economic credit'] });
}
