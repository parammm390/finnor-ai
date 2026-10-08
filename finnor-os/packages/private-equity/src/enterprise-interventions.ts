import { constants } from 'node:fs';
import { mkdir, open, link, unlink, lstat,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { BeliefView,ExperimentRef, InterventionFitBundle, InterventionModel, InterventionResponseBundle, S3ExperienceEvent } from '@finnor/shared-types';
import { assertInterventionModel, epistemicHash, ExperimentRefSchema, fitInterventionModel, interventionInquiryNeeds, interventionModelEvent,
  InterventionContractError, parseExperimentDesignRequest, parseInterventionFitRequest, queryInterventionModel } from '@finnor/epistemic-runtime';
import { interventionBackendCurrent } from '../../epistemic-runtime/src/intervention-backend';
import { loadEnterpriseBeliefView, validateBeliefViewPin } from './enterprise-beliefs';
import { designEnterpriseExperiments } from './enterprise-experiments';
import { PeDomainError, type PeMutationContext, type PeWorldRootRef } from './types';
import {enqueueNativeReferences,enqueueNativePreparedEvents,enqueueNativeS3Model,nativeReference,nativeOwnerTransportConfigured} from './native-experience-transport';

const actor = (ctx: PeMutationContext) => ctx.auth.employeeId ?? ctx.auth.userId;
const unavailable = () => new PeDomainError('PE_ENTITY_NOT_FOUND', 'Permitted S3 context is unavailable');
function storeRoot(): string {
  if (!process.env.FINNOR_S3_MODEL_STORE) throw new InterventionContractError('UNSUPPORTED', 'S3 private artifact store is not configured');
  return resolve(process.env.FINNOR_S3_MODEL_STORE);
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path), uid = process.getuid?.();
  if (info.isSymbolicLink() || !info.isDirectory() || uid === undefined || info.uid !== uid || (info.mode & 0o077) !== 0)
    throw new InterventionContractError('UNSUPPORTED', 'S3 artifact store ownership or private directory permissions are unavailable');
}
async function checkedStore(ctx: PeMutationContext): Promise<void> {
  // Validate both identities before deriving any filesystem mutation path.
  const principalDirectory = directory(ctx);
  const root = storeRoot(); await privateDirectory(root);
  await privateDirectory(join(root, ctx.auth.tenantId)); await privateDirectory(principalDirectory);
}
function directory(ctx: PeMutationContext): string {
  if (![ctx.auth.tenantId, actor(ctx)].every(id => /^[a-f0-9-]{36}$/i.test(id))) throw unavailable();
  return join(storeRoot(), ctx.auth.tenantId, actor(ctx));
}
/** Ordinary immutable producer artifacts, outside Ring-0. Files retain H1
 * proposals/rejections across process restart; no protected ledger is invented. */
async function immutableFile(ctx: PeMutationContext, category: string, digest: string, value: unknown): Promise<void> {
  await checkedStore(ctx);
  const dir = join(directory(ctx), category); await privateDirectory(dir);
  const body = JSON.stringify(value), target = join(dir, `${digest}.json`), temporary = join(dir, `.${randomUUID()}.tmp`);
  if (Buffer.byteLength(body) > 8*1024*1024) throw new InterventionContractError('LIMIT_EXCEEDED', 'S3 artifact exceeds 8 MiB');
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
  try { await link(temporary, target); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const prior = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if ((await prior.stat()).size > 8*1024*1024 || await prior.readFile('utf8') !== body) throw new InterventionContractError('INVALID_MODEL', 'Conflicting immutable S3 artifact'); }
    finally { await prior.close(); }
  } finally { await unlink(temporary).catch(() => undefined); }
}
async function saveEvents(ctx: PeMutationContext, events: readonly S3ExperienceEvent[]): Promise<void> {
  for (const event of events) await immutableFile(ctx, 'prepared-experience', event.eventId.replace('s3-event:', ''), event);
  await enqueueNativeReferences(ctx,events.flatMap(event=>{const compute=event.detail.compute as any;return compute?.id?[nativeReference('S3',compute.id,compute,'model-compute-v1')]:[]}),events.flatMap(e=>e.rightsRefs));
  await enqueueNativePreparedEvents(ctx,'S3',events);
}
/** Recover only immutable records bound to this already-authorized model cut. */
async function recoverModelExperience(ctx:PeMutationContext,model:InterventionModel){
 if(!await nativeOwnerTransportConfigured(ctx,'S3'))return;await enqueueNativeS3Model(ctx,model);
 const allowed=new Set([model.ref.id,model.compute.id,`fit-request:${epistemicHash(model.request)}`,...model.request.mechanisms.map(m=>`mechanism:${epistemicHash(m)}`)]),events:S3ExperienceEvent[]=[];
 const dir=join(directory(ctx),'prepared-experience');let names:string[];try{names=await readdir(dir);}catch(e:any){if(e.code==='ENOENT')return;throw e;}
 if(names.length>256)throw new InterventionContractError('LIMIT_EXCEEDED','S3 prepared history requires bounded operator pagination');
 for(const name of names.sort()){if(!/^[a-f0-9]{64}\.json$/.test(name))throw unavailable();const fd=await open(join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const st=await fd.stat();if(!st.isFile()||st.size>8*1024*1024)throw unavailable();const event=JSON.parse(await fd.readFile('utf8'));if(event.eventId!==`s3-event:${name.slice(0,-5)}`)throw unavailable();if(event.tenantId===ctx.auth.tenantId&&event.principalId===actor(ctx)&&event.episodeId===model.request.episodeId&&allowed.has(event.revisionRef))events.push(event);}finally{await fd.close();}
 }
 await enqueueNativePreparedEvents(ctx,'S3',events);
}
async function readModel(ctx: PeMutationContext, value: unknown): Promise<InterventionModel> {
  const parsed = ExperimentRefSchema.safeParse(value);
  if (!parsed.success || parsed.data.owner !== 'S3' || parsed.data.version !== 's3-temporal-linear-v1' || parsed.data.id !== `intervention-model:${parsed.data.contentDigest}`) throw unavailable();
  try {
    await checkedStore(ctx);
    await privateDirectory(join(directory(ctx), 'models'));
    const file = await open(join(directory(ctx), 'models', `${parsed.data.contentDigest}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
    let model: InterventionModel;
    try { if ((await file.stat()).size > 8*1024*1024) throw unavailable(); const data: unknown = JSON.parse(await file.readFile('utf8')); assertInterventionModel(data); model = data; }
    finally { await file.close(); }
    if (model.tenantId !== ctx.auth.tenantId || model.principalId !== actor(ctx) || epistemicHash(model.ref) !== epistemicHash(parsed.data)) throw unavailable();
    return model;
  } catch { throw unavailable(); }
}
async function current(ctx: PeMutationContext, model: InterventionModel): Promise<string | null> {
  const now = Date.now();
  if (Date.parse(model.request.validity.validUntil) <= now || model.beliefBindings.some(b => now-Date.parse(b.pin.knowledgeAt) > model.request.validity.maxBeliefAgeMs)) return 'MODEL_EXPIRED_OR_BELIEF_STALE';
  if (!await interventionBackendCurrent(model.compute.backend.sourceDigests)) return 'LOADED_METHOD_OR_BACKEND_SOURCE_CHANGED';
  for (const b of model.beliefBindings) if ((await validateBeliefViewPin(ctx, b.pin)).status !== 'CURRENT') return 'S1_SOURCE_RIGHTS_COVERAGE_OR_INTERPRETATION_INVALIDATED';
  return null;
}
async function readableHistory(ctx: PeMutationContext, model: InterventionModel): Promise<void> {
  // Revisions can be invalid while an earlier proposal is still legitimately
  // readable for a correction. Current source rights are always checked anew.
  for (const root of model.request.roots) await loadEnterpriseBeliefView(ctx, { root: root as PeWorldRootRef });
  await recoverModelExperience(ctx,model);
}
/** Minimal S3-owned reference resolver for S4. Callers never submit model tensors. */
export async function resolveEnterpriseInterventionModelForControl(ctx: PeMutationContext, value: unknown): Promise<InterventionModel> {
  const model = await readModel(ctx, value); await readableHistory(ctx, model);
  if (await current(ctx, model)) throw unavailable();
  await recoverModelExperience(ctx,model);
  return model;
}
/** Historical variable metadata is readable for an S2 observation/revision.
 * It is not a current dynamics resolver and cannot authorize a policy choice. */
export async function readEnterpriseInterventionMetadataForObservation(ctx: PeMutationContext, value: unknown): Promise<InterventionModel> {
  const model = await readModel(ctx, value); await readableHistory(ctx, model);await recoverModelExperience(ctx,model); return model;
}
export async function fitEnterpriseInterventionModel(ctx: PeMutationContext, value: unknown, priorRef?: unknown): Promise<InterventionFitBundle> {
  await checkedStore(ctx);
  const request = parseInterventionFitRequest(value);
  const prior = priorRef ? await readModel(ctx, priorRef) : null;
  if (prior) await readableHistory(ctx, prior);
  const views:BeliefView[] = [];
  for (const root of request.roots) views.push(await loadEnterpriseBeliefView(ctx, { root: root as PeWorldRootRef }));
  await enqueueNativeReferences(ctx,[nativeReference('S3',`fit-request:${epistemicHash(request)}`,request,'s3-fit-request-v1'),...request.mechanisms.map(m=>nativeReference('S3',`mechanism:${epistemicHash(m)}`,m,'s3-mechanism-v1'))],views.map(v=>v.rights.ref));
  const bundle = await fitInterventionModel({ request, beliefViews: views,preparedReferenceSink:async({schema,...reference})=>{await enqueueNativeReferences(ctx,[{...reference,owner:'S3'}],views.map(v=>v.rights.ref));} });
  for (const view of views) if ((await validateBeliefViewPin(ctx, view.pin)).status !== 'CURRENT') throw unavailable();
  if (!bundle.model) { await saveEvents(ctx, bundle.experience); return bundle; }
  const events = [...bundle.experience];
  if (prior) events.push(interventionModelEvent(bundle.model, 'MODEL_REVISION', { priorModelRef: prior.ref, modelRef: bundle.model.ref,
    parameterUpdateOnlyWithinProposedMethod: true, methodAdmission: 'BLOCKED_EXTERNAL', sourceInputChanged: prior.history.inputDigest !== bundle.model.history.inputDigest }, []));
  await immutableFile(ctx, 'models', bundle.model.ref.contentDigest, bundle.model);
  await enqueueNativeS3Model(ctx,bundle.model);
  await saveEvents(ctx, events);
  // No partial numerical artifact is published on failure. A source can change
  // after storage; current-use rechecks keep the stored historical proposal.
  if (await current(ctx, bundle.model)) throw unavailable();
  return { ...bundle, experience: events };
}
export async function validateEnterpriseInterventionModel(ctx: PeMutationContext, value: unknown): Promise<{
  status: 'CURRENT' | 'INVALIDATED'; reason: string; executionAuthorityGranted: false; checkedScope: 'S1_AND_LOCAL_ARTIFACT_NOT_SCIENTIFIC_ADMISSION'; modelRef: ExperimentRef;
}> {
  const model = await readModel(ctx, value); await readableHistory(ctx, model);
  await recoverModelExperience(ctx,model);
  const reason = await current(ctx, model);
  if (reason) await saveEvents(ctx, [interventionModelEvent(model, 'VALIDITY_CHANGE', { reason, checkedScope: 'S1_AND_LOCAL_ARTIFACT_NOT_SCIENTIFIC_ADMISSION' })]);
  return { status: reason ? 'INVALIDATED' : 'CURRENT', reason: reason ?? 'CURRENT_SOURCE_AND_LOCAL_ARTIFACT_ONLY_NOT_CAUSAL_METHOD_OR_EXECUTION_ADMISSION', executionAuthorityGranted: false, checkedScope: 'S1_AND_LOCAL_ARTIFACT_NOT_SCIENTIFIC_ADMISSION', modelRef: model.ref };
}
export async function queryEnterpriseInterventionModel(ctx: PeMutationContext, input: { modelRef: unknown; query: unknown }): Promise<InterventionResponseBundle> {
  const model = await readModel(ctx, input.modelRef);
  if (await current(ctx, model)) throw unavailable();
  await recoverModelExperience(ctx,model);
  const response = await queryInterventionModel(model, input.query,{preparedReferenceSink:async({schema,...reference})=>{await enqueueNativeReferences(ctx,[{...reference,owner:'S3'}],model.beliefBindings.map(b=>b.rightsRef));}});
  if (await current(ctx, model)) throw unavailable();
  await enqueueNativeReferences(ctx,[nativeReference('S3',response.queryRef,response.query,'s3-response-query-v1'),{...response.ref,content:{modelRef:response.modelRef,queryRef:response.queryRef,identification:response.identification,responses:response.responses,compute:response.compute}},...(response.compute?[nativeReference('S3',response.compute.id,response.compute,'model-compute-v1')]:[]),{...response.lineage.interventionRef,content:response.query.intervention},{...response.lineage.comparatorRef,content:response.query.comparator}],model.beliefBindings.map(b=>b.rightsRef));
  await saveEvents(ctx, response.experience);
  await immutableFile(ctx, 'responses', response.ref.contentDigest, response);
  return response;
}
export async function projectEnterpriseInterventionExperiment(ctx: PeMutationContext, modelRef: unknown): Promise<{
  schema: 'finnor.s3.experiment-projection.v1'; status: 'UNSUPPORTED'; modelRef: ExperimentRef;
  hypotheses: Array<{ ref: ExperimentRef; meaning: string; prior: null }>; inquiryNeeds: string[];
  reason: string; likelihood: { status: 'UNKNOWN'; reasons: string[] }; executionAuthorityGranted: false;
}> {
  const model = await readModel(ctx, modelRef); if (await current(ctx, model)) throw unavailable();
  await readableHistory(ctx,model);await recoverModelExperience(ctx,model);
  await enqueueNativeReferences(ctx,model.request.mechanisms.map(mechanism=>nativeReference('S3',`mechanism:${epistemicHash({modelRef:model.ref,mechanism})}`,{modelRef:model.ref,mechanism},model.version)),model.beliefBindings.map(b=>b.rightsRef));
  return { schema: 'finnor.s3.experiment-projection.v1', status: 'UNSUPPORTED', modelRef: model.ref,
    hypotheses: model.request.mechanisms.map(m => { const digest = epistemicHash({ modelRef: model.ref, mechanism: m }); return { ref: { owner: 'S3', id: `mechanism:${digest}`, version: model.version, contentDigest: digest }, meaning: m.meaning, prior: null }; }),
    inquiryNeeds: interventionInquiryNeeds(model), reason: 'TEMPORAL_JOINT_PARAMETER_UNCERTAINTY_AND_ADAPTIVE_RESPONSE_DO_NOT_ESTABLISH_S2_FIXED_CONDITIONAL_IID_INSTRUMENT_LAWS',
    likelihood: { status: 'UNKNOWN', reasons: ['Independent instrument, assignment/dependence/selection/error law and calibrated priors required; no invented IID projection'] }, executionAuthorityGranted: false };
}
/** Safe actual S2 integration when a caller independently supplies a finite IID
 * measurement instrument. S3 hypotheses are bound; S2 retains all qualifications.
 * Neither the supplied instrument law nor its priors are certified by S3 fit. */
export async function designEnterpriseInterventionExperiment(ctx: PeMutationContext, input: { modelRef: unknown; root: PeWorldRootRef; request: unknown }): Promise<{
  s3Binding: { modelRef: ExperimentRef; qualification: 'INDEPENDENT_SUPPLIED_IID_INSTRUMENT_LAWS_NOT_TEMPORAL_MODEL'; methodAdmitted: false };
  bundle: Awaited<ReturnType<typeof designEnterpriseExperiments>>;
}> {
  const projection = await projectEnterpriseInterventionExperiment(ctx, input.modelRef);
  const sourceModel = await readModel(ctx, input.modelRef);
  if (!sourceModel.request.roots.some(r => r.entityType === input.root.entityType && r.entityId === input.root.entityId))
    throw new InterventionContractError('INVALID_REQUEST', 'S2 inquiry root is outside the S3 model population');
  const request = parseExperimentDesignRequest(input.request);
  if (request.hypotheses.some(h => !projection.hypotheses.some(p => epistemicHash(p.ref) === epistemicHash(h.ref))))
    throw new InterventionContractError('INVALID_REQUEST', 'S2 inquiry hypothesis is not bound to the current S3 competing mechanisms');
  const bundle = await designEnterpriseExperiments(ctx, { root: input.root, request });
  const model = await readModel(ctx, input.modelRef); if (await current(ctx, model)) throw unavailable();
  return { s3Binding: { modelRef: model.ref, qualification: 'INDEPENDENT_SUPPLIED_IID_INSTRUMENT_LAWS_NOT_TEMPORAL_MODEL', methodAdmitted: false }, bundle };
}
export async function recordEnterpriseInterventionAssessment(ctx: PeMutationContext, input: { modelRef: unknown; type: 'CORRECTION' | 'HUMAN_OVERRIDE'; reason: string; evidenceRefs: ExperimentRef[] }): Promise<{ event: S3ExperienceEvent; receipt: null; appendAuthorityGranted: false }> {
  const model = await readModel(ctx, input.modelRef); await readableHistory(ctx, model);
  await recoverModelExperience(ctx,model);
  const event = interventionModelEvent(model, input.type, { reason: input.reason, evidenceRefs: input.evidenceRefs,
    suppliedAuthenticatedAssertionNotScientificTruth: true, changesModelOrIdentification: false, protectedHumanOverrideAuthority: 'UNVERIFIED' });
  await saveEvents(ctx, [event]); return { event, receipt: null, appendAuthorityGranted: false };
}
