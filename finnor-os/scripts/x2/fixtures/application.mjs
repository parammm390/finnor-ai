import { randomBytes } from 'node:crypto';
import { hash, id, now, transaction } from './store.mjs';

export class ApplicationError extends Error {
  constructor(status, code, details = null) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const fail = (status, code, details) => { throw new ApplicationError(status, code, details); };
const actionFor = {
  draft: 'draft.write', validate: 'validation.run', submit: 'submission.create',
  approve: 'approval.commit', preview: 'submission.create',
};
const rolesFor = {
  'record.read': ['reader', 'editor', 'approver'], 'draft.write': ['editor'],
  'validation.run': ['editor'], 'submission.create': ['editor'], 'approval.commit': ['approver'],
};
const termKeys = ['amount', 'currency', 'entity', 'unit', 'date', 'basis'];
const requestKeys = ['requestId', 'effectId', 'obligationId', 'idempotencyKey', 'parentId', 'deadline'];
const contextKeys = [
  'applicationId', 'accountId', 'recordId', 'principalId', 'grantId', 'applicationVersion',
  'schemaRevision', 'semanticRevision', 'renderingRevision', 'authorityRevision', 'grantRevision',
];
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const termsDigest = terms => hash(canonical(terms));
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function exactKeys(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    fail(400, code);
  }
}

export function authenticate(state, identity, action = 'record.read', accountId, recordId) {
  let principal;
  let grantId = identity.grantId;
  let session;
  if (identity.bearer) {
    const digest = hash(identity.bearer);
    principal = Object.values(state.principals).find(value => value.tokenHash === digest);
  } else if (identity.session) {
    session = state.sessions[hash(identity.session)];
    if (session && Date.now() < Date.parse(session.expiresAt)) {
      principal = state.principals[session.principalId];
      grantId = session.grantId;
      if (principal?.credentialRevision !== session.credentialRevision) principal = null;
    }
  }
  if (!principal?.active) fail(401, 'AUTHENTICATION_REQUIRED');
  const grant = state.grants[grantId];
  if (!grant?.active || grant.principalId !== principal.principalId ||
      grant.applicationId !== state.applicationId || grant.accountId !== principal.accountId ||
      Date.now() >= Date.parse(grant.expiresAt)) fail(403, 'GRANT_DENIED');
  if (!grant.actions.includes(action) || !rolesFor[action]?.some(role => principal.roles.includes(role))) {
    fail(403, 'ROLE_OR_ACTION_DENIED');
  }
  if (accountId && (principal.accountId !== accountId || grant.accountId !== accountId)) {
    fail(403, 'ACCOUNT_DENIED');
  }
  const record = recordId ? state.records[recordId] : null;
  if (recordId && (!grant.recordIds.includes(recordId) || !record ||
      record.accountId !== grant.accountId || record.applicationId !== state.applicationId)) {
    fail(403, 'RECORD_DENIED');
  }
  return { principal, grant, record, session };
}

export function binding(state, auth, record = auth.record) {
  return {
    applicationId: state.applicationId, accountId: auth.grant.accountId,
    recordId: record?.recordId ?? null, principalId: auth.principal.principalId,
    grantId: auth.grant.grantId, applicationVersion: state.config.applicationVersion,
    schemaRevision: state.config.schemaRevision, semanticRevision: state.config.semanticRevision,
    renderingRevision: state.config.renderingRevision, authorityRevision: state.config.authorityRevision,
    grantRevision: auth.grant.revision,
  };
}

export function publicContext(state, auth) {
  return {
    binding: binding(state, auth), entities: state.accounts[auth.grant.accountId].entities,
    permissions: auth.grant.actions, recordIds: auth.grant.recordIds,
    deadline: auth.grant.expiresAt,
    completionReadback: state.config.completion === 'full' ? 'available' : 'unavailable',
  };
}

function publicSubmission(value) {
  if (!value) return null;
  const { authorization, acceptanceOrdinal, ...publicValue } = value;
  void authorization; void acceptanceOrdinal;
  return publicValue;
}

export function publicRecord(state, record) {
  const opaque = state.config.completion === 'opaque';
  return {
    applicationId: record.applicationId, accountId: record.accountId, recordId: record.recordId,
    version: opaque ? null : record.version,
    applicationVersion: state.config.applicationVersion, schemaRevision: state.config.schemaRevision,
    semanticRevision: state.config.semanticRevision, renderingRevision: state.config.renderingRevision,
    authorityRevision: state.config.authorityRevision, phase: opaque ? 'UNOBSERVABLE' : record.phase,
    reporting: opaque ? null : record.reporting, draft: record.draft, validation: record.validation,
    submission: opaque ? null : publicSubmission(record.submission),
    approval: opaque ? null : record.approval,
    observation: {
      available: opaque ? ['identities', 'applicationRevisions', 'draft', 'validation']
        : ['identities', 'applicationRevisions', 'version', 'phase', 'reporting', 'draft', 'validation', 'submission', 'approval'],
      unavailable: opaque ? ['version', 'phase', 'reporting', 'submission', 'approval'] : [],
    },
  };
}

export async function readApplication(directory, identity, accountId, recordId) {
  return transaction(directory, state => {
    const auth = authenticate(state, identity, 'record.read', accountId, recordId);
    return {
      context: publicContext(state, auth),
      records: recordId ? [publicRecord(state, auth.record)]
        : auth.grant.recordIds.map(value => publicRecord(state, state.records[value])),
      config: { ...state.config },
      csrf: auth.session?.csrf ?? null,
    };
  });
}

export async function requestReadback(directory, identity, requestId) {
  return transaction(directory, state => {
    const auth = authenticate(state, identity);
    if (state.config.completion === 'opaque') fail(410, 'COMPLETION_UNAVAILABLE');
    const request = state.requests[requestId];
    if (!request || !auth.grant.recordIds.includes(request.recordId) ||
        request.accountId !== auth.grant.accountId) fail(404, 'REQUEST_NOT_FOUND');
    return {
      applicationId: state.applicationId, accountId: request.accountId, recordId: request.recordId,
      principalId: request.context.principalId, operation: request.operation,
      request: request.request, status: request.status, reporting: request.reporting,
      applicationVersion: request.context.applicationVersion,
      schemaRevision: request.context.schemaRevision, semanticRevision: request.context.semanticRevision,
      acceptedAt: request.acceptedAt, completedAt: request.completedAt ?? null,
    };
  });
}

function checkTerms(state, accountId, terms) {
  exactKeys(terms, termKeys, 'REPORTING_FIELDS_REQUIRED');
  if (typeof terms.amount !== 'string' || !/^(0|[1-9][0-9]{0,17})\.[0-9]{2}$/.test(terms.amount)) {
    fail(400, 'EXACT_DECIMAL_STRING_REQUIRED');
  }
  if (!['USD', 'EUR'].includes(terms.currency)) fail(400, 'CURRENCY_UNSUPPORTED');
  if (!state.accounts[accountId].entities.some(value => value.entityId === terms.entity)) {
    fail(400, 'ENTITY_DENIED');
  }
  if (!['ones', 'thousands'].includes(terms.unit)) fail(400, 'UNIT_UNSUPPORTED');
  if (!['cash', 'accrual'].includes(terms.basis)) fail(400, 'BASIS_UNSUPPORTED');
  if (typeof terms.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(terms.date) ||
      terms.date < '2026-01-01' || terms.date > '2027-12-31') fail(400, 'DATE_UNSUPPORTED');
  const date = new Date(`${terms.date}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== terms.date) {
    fail(400, 'CALENDAR_DATE_REQUIRED');
  }
}

function validateTerms(state, accountId, terms) {
  const reasons = [];
  if (BigInt(terms.amount.replace('.', '')) === 0n) reasons.push('AMOUNT_MUST_BE_POSITIVE');
  if (state.accounts[accountId].entities.find(value => value.entityId === terms.entity)?.currency !== terms.currency) {
    reasons.push('ENTITY_CURRENCY_MISMATCH');
  }
  return reasons;
}

function checkEnvelope(state, auth, payload, operation, isUi) {
  const keys = ['context', 'request', 'expectedVersion'];
  if (operation === 'draft') keys.push('reporting');
  if (operation === 'approve') keys.push('submissionRequestId');
  exactKeys(payload, keys, 'REQUEST_FIELDS_REQUIRED');
  exactKeys(payload.context, contextKeys, 'CONTEXT_FIELDS_REQUIRED');
  exactKeys(payload.request, requestKeys, 'IDENTITY_FIELDS_REQUIRED');
  const current = binding(state, auth);
  for (const key of contextKeys) {
    if (key === 'renderingRevision' && !isUi) continue;
    if (payload.context[key] !== current[key]) fail(409, 'CONTEXT_MISMATCH', { field: key });
  }
  if (!Number.isInteger(payload.context.renderingRevision) ||
      ![1, 2].includes(payload.context.renderingRevision)) fail(400, 'RENDERING_REVISION_REQUIRED');
  for (const key of requestKeys.filter(value => value !== 'deadline')) {
    if (!identifier(payload.request[key])) fail(400, 'REQUEST_IDENTITY_INVALID', { field: key });
  }
  const deadline = payload.request.deadline;
  if (typeof deadline !== 'string' || !Number.isFinite(Date.parse(deadline)) ||
      new Date(deadline).toISOString() !== deadline) fail(400, 'DEADLINE_REQUIRED');
  if (Date.now() >= Date.parse(deadline) || Date.parse(deadline) > Date.parse(auth.grant.expiresAt)) {
    fail(403, 'DEADLINE_DENIED');
  }
  if (!(Number.isSafeInteger(payload.expectedVersion) && payload.expectedVersion >= 0) &&
      !(state.config.completion === 'opaque' && payload.expectedVersion === null && operation !== 'approve')) {
    fail(400, 'EXPECTED_VERSION_REQUIRED');
  }
  if (operation === 'draft') checkTerms(state, auth.grant.accountId, payload.reporting);
  if (operation === 'approve' && !identifier(payload.submissionRequestId)) fail(400, 'SUBMISSION_ID_REQUIRED');
}

function authSnapshot(state, auth) {
  return {
    applicationId: state.applicationId, accountId: auth.grant.accountId,
    principalId: auth.principal.principalId, roles: [...auth.principal.roles],
    principalActive: auth.principal.active, grantId: auth.grant.grantId,
    grantRevision: auth.grant.revision, grantActive: auth.grant.active,
    actions: [...auth.grant.actions], recordIds: [...auth.grant.recordIds],
    authorityRevision: state.config.authorityRevision, expiresAt: auth.grant.expiresAt,
  };
}

function submission(state, auth, payload, requestEntry, events) {
  const record = auth.record;
  if (!record.draft || record.validation?.status !== 'VALID' ||
      record.validation.draftRevision !== record.draft.revision ||
      record.validation.termsDigest !== termsDigest(record.draft.reporting) ||
      record.validation.semanticRevision !== state.config.semanticRevision) {
    fail(409, 'VALID_CURRENT_DRAFT_REQUIRED');
  }
  if (state.config.completion === 'full' && record.submissions.length) {
    fail(409, 'SUBMISSION_ALREADY_EXISTS');
  }
  requestEntry.reporting = structuredClone(record.draft.reporting);
  if (state.config.semanticRevision === 2) {
    requestEntry.status = 'CONFIRMED';
    record.validation.confirmation = {
      requestId: payload.request.requestId, confirmedAt: now(), reporting: requestEntry.reporting,
    };
    events.push({ type: 'validation.confirmed', requestId: payload.request.requestId, recordId: record.recordId, at: now() });
    return;
  }
  const acceptanceOrdinal = id('acceptance');
  const accepted = {
    ...payload.request, acceptanceOrdinal,
    principalId: auth.principal.principalId, grantId: auth.grant.grantId,
    authorization: authSnapshot(state, auth), applicationVersion: state.config.applicationVersion,
    schemaRevision: state.config.schemaRevision, semanticRevision: state.config.semanticRevision,
    draftRevision: record.draft.revision, status: 'PENDING',
    reporting: requestEntry.reporting, acceptedAt: requestEntry.acceptedAt, completedAt: null,
  };
  record.submission = accepted;
  record.submissions.push(accepted);
  record.phase = 'PENDING';
  requestEntry.status = 'PENDING';
  state.pending.push({
    recordId: record.recordId, requestId: payload.request.requestId, acceptanceOrdinal,
    dueAt: new Date(Date.now() + state.config.asyncDelayMs).toISOString(),
  });
  events.push({
    type: 'submission.accepted', requestId: payload.request.requestId,
    effectId: payload.request.effectId, obligationId: payload.request.obligationId,
    parentId: payload.request.parentId, recordId: record.recordId, acceptanceOrdinal,
    reporting: requestEntry.reporting, authorization: accepted.authorization,
    semanticRevision: state.config.semanticRevision, at: accepted.acceptedAt,
  });
}

export async function dispatch(directory, identity, accountId, recordId, operation, payload, isUi = false, csrf = null) {
  return transaction(directory, (state, events) => {
    if (state.attempts.length >= 4096) fail(503, 'REQUEST_CAPACITY_EXCEEDED');
    const attempt = {
      attemptId: id('attempt'), at: now(), operation, accountId, recordId,
      requestId: identifier(payload?.request?.requestId) ? payload.request.requestId : null,
      effectId: identifier(payload?.request?.effectId) ? payload.request.effectId : null,
      outcome: 'DENIED', error: null,
    };
    state.attempts.push(attempt);
    try {
      if (!actionFor[operation]) fail(404, 'OPERATION_NOT_FOUND');
      const auth = authenticate(state, identity, actionFor[operation], accountId, recordId);
      if (isUi && (!auth.session || csrf !== auth.session.csrf)) fail(403, 'CSRF_DENIED');
      checkEnvelope(state, auth, payload, operation, isUi);
      const fingerprint = hash(canonical({ operation, ...payload }));
      const prior = Object.values(state.requests).find(value =>
        value.request.requestId === payload.request.requestId ||
        value.request.idempotencyKey === payload.request.idempotencyKey ||
        value.request.effectId === payload.request.effectId ||
        value.request.obligationId === payload.request.obligationId
      );
      const nonIdempotent = state.config.completion === 'opaque' && ['submit', 'preview'].includes(operation);
      if (prior && (prior.fingerprint !== fingerprint || prior.request.requestId !== payload.request.requestId)) {
        fail(409, 'REQUEST_IDENTITY_CONFLICT');
      }
      if (prior && !nonIdempotent) {
        attempt.outcome = 'IDEMPOTENT';
        events.push({ type: 'dispatch.idempotent', ...attempt });
        return {
          status: ['submit', 'preview'].includes(operation) ? 202 : 200,
          data: { requestId: prior.request.requestId, status: 'ACCEPTED', message: 'Request accepted' },
          fault: 'none', ackDelayMs: 0,
        };
      }
      const record = auth.record;
      if (payload.expectedVersion !== null && payload.expectedVersion !== record.version) {
        fail(409, 'RECORD_VERSION_MISMATCH');
      }
      const beforeVersion = record.version;
      const requestEntry = prior ?? {
        request: structuredClone(payload.request), context: structuredClone(payload.context),
        operation, accountId, recordId, fingerprint, acceptedAt: now(), status: 'RECORDED',
        reporting: null, acceptedCount: 0, completionCount: 0,
      };
      if (operation === 'draft') {
        if (record.submissions.length) fail(409, 'DRAFT_LOCKED');
        record.draft = { revision: (record.draft?.revision ?? 0) + 1, reporting: structuredClone(payload.reporting), savedAt: now() };
        record.validation = null;
        record.phase = 'DRAFT';
        requestEntry.reporting = structuredClone(payload.reporting);
      } else if (operation === 'validate') {
        if (!record.draft || record.submissions.length) fail(409, 'EDITABLE_DRAFT_REQUIRED');
        const reasons = validateTerms(state, accountId, record.draft.reporting);
        record.validation = {
          status: reasons.length ? 'INVALID' : 'VALID', reasons,
          draftRevision: record.draft.revision, termsDigest: termsDigest(record.draft.reporting),
          semanticRevision: state.config.semanticRevision, validatedAt: now(),
        };
        record.phase = reasons.length ? 'DRAFT' : 'VALIDATED';
        requestEntry.reporting = structuredClone(record.draft.reporting);
      } else if (['submit', 'preview'].includes(operation)) {
        submission(state, auth, payload, requestEntry, events);
      } else if (operation === 'approve') {
        const submitted = record.submission;
        if (!submitted || submitted.status !== 'SUBMITTED' ||
            submitted.requestId !== payload.submissionRequestId || record.approval) {
          fail(409, 'EXACT_DURABLE_SUBMISSION_REQUIRED');
        }
        if (submitted.principalId === auth.principal.principalId) fail(403, 'SEPARATE_APPROVER_REQUIRED');
        if (submitted.semanticRevision !== state.config.semanticRevision) fail(409, 'SUBMISSION_REVISION_MISMATCH');
        record.reporting = structuredClone(submitted.reporting);
        record.approval = {
          ...payload.request, submissionRequestId: submitted.requestId,
          principalId: auth.principal.principalId, grantId: auth.grant.grantId, committedAt: now(),
        };
        record.phase = 'APPROVED';
        requestEntry.status = 'APPROVED';
        requestEntry.reporting = structuredClone(record.reporting);
        events.push({
          type: 'approval.committed', recordId, requestId: payload.request.requestId,
          submissionRequestId: submitted.requestId, reporting: record.reporting,
          authorization: authSnapshot(state, auth), at: now(),
        });
      }
      record.version++;
      requestEntry.acceptedCount++;
      state.requests[payload.request.requestId] = requestEntry;
      attempt.outcome = 'ACCEPTED';
      events.push({
        type: 'dispatch.accepted', ...attempt, action: actionFor[operation], fingerprint,
        context: structuredClone(payload.context), request: structuredClone(payload.request),
        reporting: requestEntry.reporting, beforeVersion, afterVersion: record.version,
        authorization: authSnapshot(state, auth),
      });
      let fault = 'none';
      if (['submit', 'preview'].includes(operation) && requestEntry.status === 'PENDING') {
        fault = state.config.responseFault;
        if (fault !== 'none') {
          state.config.responseFault = 'none';
          events.push({ type: 'fault.response-boundary', requestId: payload.request.requestId, fault, at: now() });
        }
      }
      const asynchronous = ['submit', 'preview'].includes(operation);
      return {
        status: asynchronous ? 202 : 200, fault,
        ackDelayMs: fault === 'hold-next-submit' ? state.config.ackDelayMs : 0,
        data: asynchronous
          ? { requestId: payload.request.requestId, status: 'ACCEPTED', message: 'Submission accepted' }
          : { requestId: payload.request.requestId, record: publicRecord(state, record) },
      };
    } catch (error) {
      if (!(error instanceof ApplicationError)) throw error;
      attempt.error = error.code;
      events.push({ type: 'dispatch.denied', ...attempt });
      return { status: error.status, data: { error: error.code, details: error.details }, fault: 'none', ackDelayMs: 0 };
    }
  });
}

export async function completeDue(directory) {
  return transaction(directory, (state, events) => {
    const remaining = [];
    for (const pending of state.pending) {
      if (Date.parse(pending.dueAt) > Date.now()) { remaining.push(pending); continue; }
      const record = state.records[pending.recordId];
      const accepted = record.submissions.find(value => value.acceptanceOrdinal === pending.acceptanceOrdinal);
      if (!accepted || accepted.status !== 'PENDING') throw new Error('PRIVATE_PENDING_INVARIANT_FAILED');
      accepted.status = 'SUBMITTED';
      accepted.completedAt = now();
      if (record.submission.acceptanceOrdinal === accepted.acceptanceOrdinal) {
        record.submission = accepted;
        record.phase = 'SUBMITTED';
      }
      record.version++;
      const request = state.requests[pending.requestId];
      request.status = 'SUBMITTED';
      request.completedAt = accepted.completedAt;
      request.completionCount++;
      events.push({
        type: 'submission.completed', requestId: accepted.requestId, effectId: accepted.effectId,
        obligationId: accepted.obligationId, parentId: accepted.parentId,
        recordId: record.recordId, acceptanceOrdinal: accepted.acceptanceOrdinal,
        reporting: accepted.reporting, semanticRevision: accepted.semanticRevision,
        version: record.version, at: accepted.completedAt,
      });
    }
    state.pending = remaining;
    return events.length;
  });
}

export async function login(directory, bearer, grantId) {
  return transaction(directory, (state, events) => {
    const auth = authenticate(state, { bearer, grantId });
    const handle = randomBytes(32).toString('base64url');
    state.sessions[hash(handle)] = {
      principalId: auth.principal.principalId, grantId,
      credentialRevision: auth.principal.credentialRevision,
      csrf: randomBytes(24).toString('base64url'), expiresAt: auth.grant.expiresAt,
    };
    events.push({ type: 'session.created', principalId: auth.principal.principalId, at: now() });
    return handle;
  });
}

export async function logout(directory, identity) {
  return transaction(directory, (state, events) => {
    if (identity.session && state.sessions[hash(identity.session)]) {
      const session = state.sessions[hash(identity.session)];
      delete state.sessions[hash(identity.session)];
      events.push({ type: 'session.closed', principalId: session.principalId, at: now() });
    }
  });
}
