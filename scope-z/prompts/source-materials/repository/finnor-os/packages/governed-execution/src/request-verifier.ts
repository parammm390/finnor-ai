/** Mechanical verifier only: no compilation, business choice, credentials or dispatch. */
import { createHash, verify } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, LedgerFault } from './protocol.js';

type RecordValue = Record<string, any>;
interface VerificationContext {
  owner: { tenantId: string; principalId: string; rightsRefs: string[] };
  domain: string; methodAdmissionPublicKey: string | undefined;
  verifierSourceDigests: Array<{ path: string; sha256: string }>;
}
const fail = (status: number, code: string): never => { throw new LedgerFault(status, code); };
const object = (v: unknown): RecordValue => v && typeof v === 'object' && !Array.isArray(v) ? v : fail(400, 'EXPECTED_IR_OBJECT');
const keys = (v: RecordValue, expected: string[]) => {
  if (Object.keys(v).length !== expected.length || expected.some(key => !Object.hasOwn(v, key))) fail(400, 'REQUEST_IR_FIELD_SET_MISMATCH');
};
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const list = (v: unknown): any[] => Array.isArray(v) && v.length >= 1 && v.length <= 64 ? v : fail(400, 'REQUEST_IR_MEMBER_BOUND');
function reference(v: unknown, owner: string, version: string, prefix: string, preimage: unknown) {
  const ref = object(v); keys(ref, ['owner', 'id', 'version', 'contentDigest']);
  if (ref.owner !== owner || ref.version !== version || ref.contentDigest !== hash(preimage) || ref.id !== prefix + ref.contentDigest) fail(409, 'REQUEST_REFERENCE_PREIMAGE_MISMATCH');
  return ref;
}
function sourceIdentity(v: unknown) {
  // The protected v3 release pins the broker and fixed-route IO in addition to
  // the v2 ledger/verifier/native lock substrate. Exact equality is still checked.
  if (!Array.isArray(v) || v.length < 1 || v.length > 16) return fail(400, 'SOURCE_SET_BOUND');
  return v.map(raw => { const item = object(raw); keys(item, ['path', 'sha256']); if (typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) fail(400, 'SOURCE_IDENTITY_INVALID'); return { path: resolve(item.path), sha256: item.sha256 }; }).sort((a,b) => a.path.localeCompare(b.path));
}

export async function verifyGovernedRequest(input: unknown, acceptedObligation: unknown, context: VerificationContext) {
  const request = object(input); keys(request, ['ref', 'ir', 'admissions']);
  if (Buffer.byteLength(canonical(request)) > 2 * 1024 * 1024) fail(413, 'REQUEST_IR_BYTE_BOUND');
  const ir = object(request.ir), obligation = object(acceptedObligation);
  reference(request.ref, 'S6', 's6-conditional-json-v1', 'request-ir:', ir);
  keys(ir, ['schema','tenantId','principalId','episodeId','obligationRef','effectRef','mandateRef','rightsRef','policyRef','decisionRef','allocationRef','reservationRef','consumptionRef','interventionRef','intervention','preconditions','deadline','resourceEnvelope','compiler','members']);
  if (ir.schema !== 'finnor.s6.request-ir.v1' || obligation.schema !== 'finnor.durable-obligation.v1' || obligation.executionAuthorityGranted !== false || obligation.protectedReceipt !== null || obligation.status !== 'PREPARED_UNADMITTED') fail(400, 'UNSUPPORTED_OBLIGATION_OR_IR');
  const { ref: obligationRef, ...origin } = obligation;
  reference(obligationRef, 'S6', 's6-obligation-v1', 'durable-obligation:', origin);
  if (ir.tenantId !== context.owner.tenantId || ir.principalId !== context.owner.principalId || !context.owner.rightsRefs.includes(ir.rightsRef)) fail(403, 'REQUEST_OWNER_OR_RIGHTS_MISMATCH');
  if (!same(ir.obligationRef, obligationRef)) fail(409, 'OBLIGATION_REFERENCE_MISMATCH');
  for (const key of ['tenantId','principalId','episodeId','effectRef','mandateRef','rightsRef','policyRef','decisionRef','allocationRef','reservationRef','consumptionRef','interventionRef','intervention','preconditions','deadline','resourceEnvelope']) {
    if (!same(ir[key], obligation[key])) fail(409, 'AUTHORIZED_OBLIGATION_SUBSTITUTION');
  }
  if (!Number.isFinite(Date.parse(ir.deadline.authorityExpiresAt)) || Date.parse(ir.deadline.authorityExpiresAt) <= Date.now()) fail(409, 'OBLIGATION_AUTHORITY_EXPIRED');
  const compiler = object(ir.compiler); keys(compiler, ['version','sourceDigests']);
  if (compiler.version !== 's6-conditional-json-v1') fail(400, 'COMPILER_VERSION_UNADMITTED');
  const compilerSources = sourceIdentity(compiler.sourceDigests);
  const compilerPath = fileURLToPath(new URL('../../orchestration/src/request-compiler.ts', import.meta.url));
  if (compilerSources.length !== 1 || compilerSources[0]!.path !== compilerPath) fail(409, 'COMPILER_SOURCE_SET_UNADMITTED');
  const fd = await open(compilerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat(); if (!stat.isFile() || stat.size > 1024 * 1024) fail(503, 'COMPILER_SOURCE_UNAVAILABLE');
    if (createHash('sha256').update(await fd.readFile()).digest('hex') !== compilerSources[0]!.sha256) fail(409, 'COMPILER_SOURCE_CHANGED');
  } finally { await fd.close(); }
  const admissionRoot = context.methodAdmissionPublicKey ?? fail(403, 'INDEPENDENT_METHOD_ROOT_UNAVAILABLE');
  const admissions = list(request.admissions), members = list(ir.members), channels = list(obligation.intervention.channels);
  if (members.length !== channels.length) fail(409, 'PARTIAL_OR_DUPLICATE_OBLIGATION_MEMBERS');
  const admissionIds = new Set<string>();
  for (const raw of admissions) {
    const admission = object(raw); keys(admission, ['ref','body','signature']);
    const body = object(admission.body);
    reference(admission.ref, 'S8', 'json-field-replace-v1', 'method:', body);
    if (admissionIds.has(admission.ref.id)) fail(400, 'DUPLICATE_METHOD_ADMISSION'); admissionIds.add(admission.ref.id);
    if (typeof admission.signature !== 'string' || admission.signature.length > 256 || !verify(null, Buffer.from(canonical(body)), admissionRoot, Buffer.from(admission.signature, 'base64'))) fail(403, 'INDEPENDENT_METHOD_SIGNATURE_INVALID');
    keys(body, ['schema','domain','tenantId','principalId','rightsRef','obligationRef','effectRef','compiler','verifierSourceDigests','validAfter','validUntil','semantic','request','qualification']);
    if (body.schema !== 'finnor.s8.method-admission.v1' || body.domain !== context.domain || body.tenantId !== ir.tenantId || body.principalId !== ir.principalId || body.rightsRef !== ir.rightsRef || !same(body.obligationRef, obligationRef) || !same(body.effectRef, ir.effectRef)) fail(403, 'METHOD_ADMISSION_SCOPE_MISMATCH');
    const after = Date.parse(body.validAfter), until = Date.parse(body.validUntil);
    if (!Number.isFinite(after) || !Number.isFinite(until) || after > Date.now() || until <= Date.now() || until <= after) fail(403, 'METHOD_ADMISSION_EXPIRED_OR_NOT_YET_VALID');
    if (!same(body.compiler, compiler) || !same(sourceIdentity(body.verifierSourceDigests), sourceIdentity(context.verifierSourceDigests))) fail(409, 'METHOD_ADMISSION_SOURCE_VERSION_MISMATCH');
  }
  const used = new Set<string>(), seen = new Set<string>(), physical = new Set<string>();
  for (const raw of members) {
    const member = object(raw); keys(member, ['memberId','methodRef','semantic','request']);
    const semantic = object(member.semantic), concrete = object(member.request);
    const channel = channels.find(channel => channel.exposureId === semantic.exposureId);
    if (!channel || seen.has(semantic.exposureId) || channel.doses.length !== 1 || channel.permittedRefinements.length !== 0) fail(409, 'PARTIAL_OR_DUPLICATE_OBLIGATION_MEMBERS');
    seen.add(semantic.exposureId);
    if (member.memberId !== `request-member:${hash([obligationRef,channel.exposureId])}` || !same(semantic, { exposureId:channel.exposureId,target:channel.target,operation:channel.operation,unit:channel.unit,dose:channel.doses[0],intendedExposure:channel.intendedExposure,permittedRefinements:[] })) fail(409, 'AUTHORIZED_CHANNEL_SUBSTITUTION');
    const admission = admissions.find(admission => same(admission.ref, member.methodRef));
    if (!admission) fail(403, 'EXACT_METHOD_ADMISSION_MISSING'); used.add(admission.ref.id);
    const binding = object(admission.body.request), meaning = object(admission.body.semantic);
    keys(binding, ['kind','providerOrigin','applicationAccountId','recordKey','field','expectedVersion']);
    keys(meaning, ['exposureId','target','operation','unit','intendedExposure','permittedRefinements','doseRange']);
    const { doseRange, ...mapping } = meaning, { dose, ...authorizedMapping } = semantic;
    if (!same(mapping, authorizedMapping) || !Array.isArray(doseRange) || doseRange.length !== 2 || doseRange.some(value => typeof value !== 'number' || !Number.isFinite(value)) || doseRange[0] > dose || doseRange[1] < dose) fail(409, 'METHOD_SEMANTIC_MAPPING_UNADMITTED');
    if (typeof binding.providerOrigin !== 'string' || typeof binding.applicationAccountId !== 'string' || typeof binding.recordKey !== 'string' || typeof binding.field !== 'string' || typeof binding.expectedVersion !== 'string') fail(400, 'METHOD_REQUEST_CONTRACT_INVALID');
    let url: URL; try { url = new URL(binding.providerOrigin); } catch { return fail(400, 'METHOD_ORIGIN_INVALID'); }
    if (url.protocol !== 'https:' || url.origin !== binding.providerOrigin || url.username || url.password || !/^[0-9a-f-]{36}$/i.test(binding.applicationAccountId) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(binding.field) || ['constructor','prototype','__proto__'].includes(binding.field) || binding.recordKey.length < 1 || binding.recordKey.length > 1024 || binding.expectedVersion.length < 1 || binding.expectedVersion.length > 512 || /[\u0000-\u001f\u007f]/.test(binding.recordKey + binding.expectedVersion)) fail(400, 'METHOD_REQUEST_CONTRACT_INVALID');
    if (binding.kind !== 'CONDITIONAL_JSON_FIELDS_REPLACE' || !same(concrete, { kind:binding.kind,providerOrigin:binding.providerOrigin,applicationAccountId:binding.applicationAccountId,recordKey:binding.recordKey,expectedVersion:binding.expectedVersion,changes:{[binding.field]:dose} })) fail(409, 'CONCRETE_REQUEST_SUBSTITUTION');
    const physicalKey = canonical([binding.providerOrigin,binding.applicationAccountId,binding.recordKey,binding.field]);
    if (physical.has(physicalKey)) fail(409, 'OVERLAPPING_PHYSICAL_MEMBERS'); physical.add(physicalKey);
  }
  if (used.size !== admissions.length) fail(400, 'UNBOUND_METHOD_ADMISSION');
  return { requestRef: request.ref, obligationRef, effectRef: ir.effectRef, methodRefs: admissions.map(admission => admission.ref), validUntil: new Date(Math.min(Date.parse(ir.deadline.authorityExpiresAt), ...admissions.map(admission => Date.parse(admission.body.validUntil)))).toISOString() };
}
