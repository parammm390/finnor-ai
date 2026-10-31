/** Independent finite original-input oracle. No producer, model, lowering,
 * checker or product observer is imported. All reads use the real scoped
 * read-only native observer; supplied expected rows never drive computation. */
import { createHash } from "node:crypto";

const ensure = (value, code) => { if (!value) throw Error(code); };
const bytesDigest = value => createHash("sha256").update(value).digest("hex");
function originalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(originalJson).join(",") + "]";
  return "{" + Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ":" + originalJson(item)).join(",") + "}";
}
export const originalDigest = value => bytesDigest(originalJson(value));
const text = value => typeof value === "string" && value.trim().length > 0;
const iso = value => value instanceof Date || typeof value === "string"
  ? Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null : null;
const exactInstant = value => typeof value === "string" && iso(value) === value;
const same = (a, b) => a !== undefined && b !== undefined && originalDigest(a) === originalDigest(b);
const completion = Object.freeze({
  open_workstream: ["pe_workstream", "x1:pe-workstream-created:v1", "x1:pe-workstream-creation-observer:v1"],
  create_deal_request: ["pe_request", "x1:pe-request-created:v1", "x1:pe-request-creation-observer:v1"],
  record_finding: ["pe_finding", "x1:pe-finding-created:v1", "x1:pe-finding-creation-observer:v1"],
});
const pinFields = ["schema", "compilerRequestId", "programId", "sourceGrantId", "sourceId", "sourceRevision",
  "rawSourceSha256", "mandateSha256", "canonicalSha256", "nativeLinksSha256", "ruleId", "recordId", "subjectRef"];
export const originalOracleContract = Object.freeze({
  schema: "finnor.project-z.z0.independent-original-owner-oracle.v1",
  inputSchema: "finnor.project-z.z0.original-owner-inputs.v1",
  inputs: pinFields, sourceProtocol: "json_records", acquisition: "core_export",
  recordValues: "FLAT_EXPLICIT_STRING_BOOLEAN_NULL_NO_NUMERIC_OR_NESTED_INFERENCE",
  operations: Object.keys(completion), candidateImports: false, expectedRowsAreInputs: false,
  database: "EXISTING_RESTRICTED_READONLY_OBSERVER_ONLY", qualification: "NOT_NATIVE_PROOF_WITHOUT_EXECUTION",
});

export function originalOwnerPins(owner) {
  const pins = owner?.originalInputs;
  ensure(pins && typeof pins === "object" && !Array.isArray(pins)
    && same(Object.keys(pins).sort(), [...pinFields].sort())
    && pins.schema === originalOracleContract.inputSchema
    && pinFields.every(key => text(pins[key]) && pins[key].length <= 1024)
    && ["rawSourceSha256", "mandateSha256", "canonicalSha256", "nativeLinksSha256"]
      .every(key => /^[a-f0-9]{64}$/.test(pins[key])), "Z0_PRECOMMITTED_ORIGINAL_OWNER_INPUT_PINS_REQUIRED");
  ensure(/^pe_deal:[a-f0-9-]{36}@v[1-9]\d*$/.test(pins.subjectRef), "Z0_ORIGINAL_NATIVE_DEAL_SUBJECT_REQUIRED");
  return pins;
}

/** Read the original flat JSON grammar directly. Reject duplicate/aliased keys,
 * nested/numeric meaning and trailing input instead of inheriting inference
 * or last-key-wins behavior from the producer's decoder. */
function records(bytes) {
  ensure(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 2 * 1024 ** 2,
    "Z0_ORIGINAL_ORACLE_BYTE_BOUND");
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let at = 0;
  const space = () => { while (/[ \t\r\n]/.test(raw[at] ?? "") && at < raw.length) at++; };
  const take = character => { space(); ensure(raw[at++] === character, "Z0_ORIGINAL_ORACLE_JSON_GRAMMAR"); };
  const string = () => {
    space();
    const found = /"(?:\\.|[^"\\])*"/y; found.lastIndex = at;
    const match = found.exec(raw); ensure(match, "Z0_ORIGINAL_ORACLE_JSON_STRING_REQUIRED");
    at = found.lastIndex;
    const value = JSON.parse(match[0]);
    ensure(typeof value === "string" && value.length <= 32768, "Z0_ORIGINAL_ORACLE_TEXT_BOUND");
    return value;
  };
  const rows = []; take("["); space();
  while (raw[at] !== "]") {
    ensure(rows.length < 1024, "Z0_ORIGINAL_ORACLE_RECORD_BOUND");
    const row = Object.create(null), keys = new Set(); take("{"); space();
    while (raw[at] !== "}") {
      const key = string(), normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
      ensure(normalized && !keys.has(normalized) && keys.size < 128
        && !["__proto__", "prototype", "constructor"].includes(key), "Z0_ORIGINAL_ORACLE_FIELD_AMBIGUITY");
      keys.add(normalized); take(":"); space();
      if (raw[at] === '"') row[key] = string();
      else {
        const literal = /^(true|false|null)(?=[ \t\r\n]*[,}])/.exec(raw.slice(at));
        ensure(literal, "Z0_ORIGINAL_ORACLE_SCALAR_MEANING_UNSUPPORTED");
        row[key] = JSON.parse(literal[1]); at += literal[1].length;
      }
      space(); if (raw[at] === "}") break;
      take(","); space(); ensure(raw[at] !== "}", "Z0_ORIGINAL_ORACLE_JSON_GRAMMAR");
    }
    take("}"); ensure(text(row.id), "Z0_ORIGINAL_ORACLE_EXPLICIT_RECORD_ID_REQUIRED");
    ensure(!rows.some(prior => prior.id === row.id), "Z0_ORIGINAL_ORACLE_DUPLICATE_RECORD");
    rows.push(row); space(); if (raw[at] === "]") break;
    take(","); space(); ensure(raw[at] !== "]", "Z0_ORIGINAL_ORACLE_JSON_GRAMMAR");
  }
  take("]"); space(); ensure(at === raw.length && rows.length > 0, "Z0_ORIGINAL_ORACLE_JSON_GRAMMAR");
  return rows;
}

function derive({ pins, actor, workId, workInputId, original, mandate, grant, coreBytes, deal, workstreams, parties }) {
  ensure(original?.tenantId === actor.tenantId && original.principalId === actor.principalId
    && original.workId === workId && original.institutionId === mandate.institutionId
    && same(original.mandate, mandate) && originalDigest(mandate) === pins.mandateSha256
    && originalDigest(original.canonical) === pins.canonicalSha256, "Z0_ORIGINAL_STANDING_INPUT_PREIMAGE_CHANGED");
  const source = original.sources?.find(row => row.id === pins.sourceId && row.grantId === pins.sourceGrantId);
  ensure(source && grant?.id === pins.sourceGrantId && grant.source_id === pins.sourceId
    && grant.revision === pins.sourceRevision && source.revision === grant.revision
    && source.coreDocumentId === grant.document_id && source.coreVersionId === grant.document_version_id
    && source.sourceClass === grant.source_class && source.protocol === grant.protocol
    && grant.institution_id === original.institutionId && grant.acquisition_kind === "core_export"
    && grant.protocol === "json_records" && !source.ownerCoverageGap
    && original.current?.sourceDigests?.[pins.sourceId] === pins.rawSourceSha256
    && source.originalSha256 === pins.rawSourceSha256 && grant.original_sha256 === pins.rawSourceSha256
    && grant.document_sha256 === pins.rawSourceSha256 && grant.content_sha256 === pins.rawSourceSha256
    && grant.core_revision === pins.sourceRevision
    && grant.storage_backend === "postgres" && Buffer.isBuffer(coreBytes)
    && coreBytes.length === Number(grant.physical_size) && coreBytes.length === Number(grant.size_bytes)
    && coreBytes.length === Number(grant.content_size)
    && bytesDigest(coreBytes) === pins.rawSourceSha256, "Z0_REAL_IMMUTABLE_CORE_ORIGINAL_REQUIRED");
  ensure(Array.isArray(mandate.rules) && mandate.rules.length > 0 && mandate.rules.length <= 128
    && new Set(mandate.rules.map(rule => rule.id)).size === mandate.rules.length, "Z0_ORIGINAL_STANDING_RULE_POPULATION_REQUIRED");
  const rule = mandate.rules.find(row => row.id === pins.ruleId), rows = records(coreBytes);
  const record = rows.find(row => row.id === pins.recordId);
  ensure(rule && record, "Z0_ORIGINAL_RULE_AND_TRIGGER_REQUIRED");
  const raw = Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null)
    .map(([key, value]) => [key.replace(/[^a-z0-9]/gi, "").toLowerCase(), String(value)]));
  const nativeTrigger = grant.source_class === "work_tracking" && record.kind === undefined
    && /^\s*evidence[\s_-]+request[\s_-]+needed\s*[.!]?\s*$/i.test(raw.activity ?? raw.subject ?? "");
  const triggerKind = nativeTrigger ? "evidence_request_needed" : record.triggerKind;
  const occurredAt = nativeTrigger ? raw.createdat ?? raw.occurredat : record.occurredAt;
  const availableAt = nativeTrigger ? raw.availableat : record.availableAt;
  const registration = record.registrationId ?? raw.registrationid ?? raw.dealnumber ?? raw.opportunitynumber;
  ensure((record.kind === "trigger" || nativeTrigger) && text(registration)
    && triggerKind === rule.triggerKind && exactInstant(occurredAt) && exactInstant(availableAt)
    && exactInstant(original.knowledgeCut) && occurredAt <= availableAt && availableAt <= original.knowledgeCut
    && exactInstant(rule.deadlineAt), "Z0_ORIGINAL_TRIGGER_CHRONOLOGY_OR_MEANING_UNSUPPORTED");
  const allowedRuleFields = ["id", "triggerKind", "operation", "principalId", "deadlineAt", "materiality",
    "postconditionRef", "observerRef", "operationInputs", "actionPayload", "expectedEntityId", "postconditionDigest"];
  const contract = completion[rule.operation];
  ensure(contract && Object.keys(rule).every(key => allowedRuleFields.includes(key))
    && rule.postconditionRef === contract[1] && rule.observerRef === contract[2] && text(rule.principalId),
  "Z0_ORIGINAL_RULE_COMPLETION_MEANING_UNSUPPORTED");
  const dealId = pins.subjectRef.split(":")[1].split("@")[0];
  ensure(deal?.id === dealId && deal.tenant_id === actor.tenantId && deal.external_id === registration
    && pins.subjectRef === `pe_deal:${deal.id}@v${deal.version}` && deal.archived_at === null && deal.status === "active"
    && original.canonical?.entities?.some(row => row.ref === pins.subjectRef && row.registrationId === registration
      && row.institutionId === original.institutionId && (!row.sourceId || row.sourceId === pins.sourceId))
    && originalDigest({ deal, workstreams, parties }) === pins.nativeLinksSha256,
  "Z0_INDEPENDENT_CANONICAL_ORIGINAL_LINKS_REQUIRED");
  const stableIdentity = "x1-obligation:" + originalDigest(["institution-obligation-identity-v1", actor.tenantId,
    original.institutionId, mandate.standingId ?? mandate.id, rule.id, pins.subjectRef.replace(/@v\d+$/, ""),
    pins.sourceId, pins.recordId, occurredAt]);
  const hash = bytesDigest(JSON.stringify(["x1-original-effect-v1", stableIdentity]));
  const entityId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const inputs = rule.operationInputs ?? {}, operation = rule.operation;
  const allowedInputs = operation === "open_workstream" ? ["workstreamKind", "workstreamName"]
    : operation === "create_deal_request" ? ["workstreamExternalId", "workstreamKind", "requestedFromExternalId",
      "requestText", "requiresAcceptedDeliverable"]
      : ["workstreamExternalId", "workstreamKind", "findingStatement", "findingSeverity", "requiredForWorkstreamCompletion"];
  ensure(inputs && typeof inputs === "object" && !Array.isArray(inputs)
    && Object.keys(inputs).every(key => allowedInputs.includes(key))
    && Object.values(inputs).every(value => typeof value === "string" || typeof value === "boolean"),
  "Z0_ORIGINAL_OPERATION_INPUT_MEANING_UNSUPPORTED");
  const value = key => inputs[key] ?? raw[key.toLowerCase()];
  const requiredText = key => { const found = value(key); ensure(text(found), "Z0_ORIGINAL_OPERATION_TEXT_REQUIRED"); return found.trim(); };
  const boolean = key => {
    const found = value(key);
    ensure(found === true || found === false || found === "true" || found === "false", "Z0_ORIGINAL_OPERATION_BOOLEAN_REQUIRED");
    return found === true || found === "true";
  };
  const owner = { partyType: "employee", partyId: rule.principalId };
  let payload;
  if (operation === "open_workstream") {
    const kind = requiredText("workstreamKind"), name = requiredText("workstreamName");
    ensure(["financial_diligence", "legal", "tax", "commercial", "technology", "financing",
      "insurance", "regulatory", "closing", "custom"].includes(kind), "Z0_ORIGINAL_WORKSTREAM_KIND_UNSUPPORTED");
    payload = { dealId, workstreamId: entityId, kind, name, owner };
  } else {
    const external = value("workstreamExternalId"), kind = value("workstreamKind");
    const matches = workstreams.filter(row => text(external) ? row.external_id === external.trim()
      : text(kind) && row.kind === kind.trim());
    ensure(matches.length === 1, "Z0_INDEPENDENT_EXACT_ACTIVE_WORKSTREAM_REQUIRED");
    const workstreamId = matches[0].id;
    if (operation === "create_deal_request") {
      const from = requiredText("requestedFromExternalId"), requestText = requiredText("requestText");
      const recipients = parties.filter(row => row.external_id === from);
      ensure(recipients.length === 1 && occurredAt <= rule.deadlineAt, "Z0_INDEPENDENT_EXACT_REQUEST_PARTY_OR_DEADLINE_REQUIRED");
      payload = { dealId, requestId: entityId, workstreamId, requestedFromDealPartyId: recipients[0].id,
        owner, requestText, requestedAt: occurredAt, dueAt: rule.deadlineAt,
        requiresAcceptedDeliverable: boolean("requiresAcceptedDeliverable") };
    } else {
      const statement = requiredText("findingStatement"), severity = requiredText("findingSeverity");
      ensure(["low", "medium", "high", "critical"].includes(severity)
        && ["immaterial", "non_material", "material", "critical"].includes(rule.materiality), "Z0_ORIGINAL_FINDING_MEANING_UNSUPPORTED");
      payload = { dealId, findingId: entityId, workstreamId, statement, severity, materiality: rule.materiality,
        owner, requiredForWorkstreamCompletion: boolean("requiredForWorkstreamCompletion") };
    }
  }
  const action = { responsibilityIdentity: stableIdentity, operation, payload, expectedEntityId: entityId,
    postconditionDigest: originalDigest({ operation, payload, expectedEntityId: entityId, deadlineAt: rule.deadlineAt,
      contractRef: contract[1], observerRef: contract[2] }) };
  ensure((!Object.hasOwn(rule, "actionPayload") || same(rule.actionPayload, payload))
    && (!Object.hasOwn(rule, "expectedEntityId") || rule.expectedEntityId === entityId)
    && (!Object.hasOwn(rule, "postconditionDigest") || rule.postconditionDigest === action.postconditionDigest),
  "Z0_ORIGINAL_EXPLICIT_MANDATE_INTENT_CONFLICT");
  const shared = { tenant_id: actor.tenantId, id: entityId, deal_id: dealId,
    owner_party_type: owner.partyType, owner_party_id: owner.partyId, archived_at: null };
  const fields = operation === "open_workstream" ? { ...shared, kind: payload.kind, name: payload.name,
    state: "not_started", completed_at: null, cancelled_at: null }
    : operation === "create_deal_request" ? { ...shared, workstream_id: payload.workstreamId,
      requested_from_deal_party_id: payload.requestedFromDealPartyId, request_text: payload.requestText,
      requested_at: iso(payload.requestedAt), due_at: iso(payload.dueAt),
      requires_accepted_deliverable: payload.requiresAcceptedDeliverable, state: "open",
      acknowledged_at: null, fulfilled_at: null, cancelled_at: null }
      : { ...shared, workstream_id: payload.workstreamId, related_request_id: null, related_deliverable_id: null,
        statement: payload.statement, severity: payload.severity, materiality: payload.materiality,
        required_for_workstream_completion: payload.requiredForWorkstreamCompletion, state: "open",
        disposition: null, resolved_at: null, accepted_at: null, superseded_at: null };
  return { operation, entityId, entityType: contract[0], stableIdentity, originalDeadlineAt: rule.deadlineAt,
    frozenPayload: payload, expectedFullRow: fields, action, actionSha256: originalDigest(action),
    postconditionRef: contract[1], observerRef: contract[2], programId: pins.programId,
    compilerRequestId: pins.compilerRequestId, workId, workInputId };
}

export async function readOriginalOwnerExpectation(db, actor, fixture, before) {
  const pins = originalOwnerPins(fixture.owner);
  const compiler = before.compiler.find(row => row.id === pins.compilerRequestId && row.program_id === pins.programId);
  const publication = compiler?.input_manifest?.publication;
  ensure(compiler && compiler.work_id === fixture.workId && compiler.work_input_id === fixture.workInputId
    && publication?.schema === "finnor.x1.compiler-publication-checkpoint.v1" && publication.requestId === compiler.id
    && publication.generation === compiler.generation, "Z0_REAL_ORIGINAL_COMPILER_PUBLICATION_REQUIRED");
  const original = publication.prepared?.result?.original, dealId = pins.subjectRef.split(":")[1].split("@")[0];
  ensure(original?.mandate?.id, "Z0_ORIGINAL_STANDING_INPUTS_NOT_RETAINED");
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.principal_id',$2,true),set_config('app.user_id',$2,true)",
      [actor.tenantId, actor.principalId]);
    const mandateRow = (await db.query(`SELECT id::text,standing_id::text,institution_id,revision,rules
      FROM finnor_os.x1_work_mandates WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND id=$4`,
    [actor.tenantId, actor.principalId, fixture.workId, original.mandate.id])).rows[0];
    ensure(mandateRow, "Z0_CANONICAL_ORIGINAL_MANDATE_NOT_DELIVERED");
    const mandate = { id: mandateRow.id, standingId: mandateRow.standing_id, revision: mandateRow.revision,
      tenantId: actor.tenantId, institutionId: mandateRow.institution_id, workId: fixture.workId, rules: mandateRow.rules };
    const grant = (await db.query(`SELECT g.id::text,g.source_id,g.source_class,g.protocol,g.revision,g.institution_id,
      g.acquisition_kind,g.document_id::text,g.document_version_id::text,g.original_sha256,
      v.byte_sha256 document_sha256,v.size_bytes,coalesce(v.provider_version_id,v.id::text) core_revision,
      c.sha256 content_sha256,c.size_bytes content_size,c.storage_backend,
      octet_length(c.bytes) physical_size,
      CASE WHEN octet_length(c.bytes) BETWEEN 1 AND 2097152 THEN c.bytes ELSE NULL END core_bytes
      FROM finnor_os.x1_source_grants g JOIN finnor_os.document_versions v
        ON v.tenant_id=g.tenant_id AND v.document_id=g.document_id AND v.id=g.document_version_id
      JOIN finnor_os.document_version_contents c ON c.tenant_id=v.tenant_id AND c.version_id=v.id
      WHERE g.tenant_id=$1 AND g.principal_id=$2 AND g.work_id=$3 AND g.id=$4`,
    [actor.tenantId, actor.principalId, fixture.workId, pins.sourceGrantId])).rows[0];
    const deal = (await db.query(`SELECT tenant_id::text,id::text,version,external_id,source_system,status,archived_at
      FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2 AND (source_system=$3 OR EXISTS
        (SELECT 1 FROM finnor_os.work_entity_links w WHERE w.tenant_id=pe_deals.tenant_id
          AND w.work_id=$4 AND w.entity_type='pe_deal' AND w.entity_id=pe_deals.id))`,
    [actor.tenantId, dealId, `x1:${mandate.institutionId}`, fixture.workId])).rows[0];
    const operation = mandate.rules.find(row => row.id === pins.ruleId)?.operation;
    const workstreams = operation !== "open_workstream" ? (await db.query(`SELECT id::text,external_id,kind,state,archived_at
      FROM finnor_os.pe_workstreams WHERE tenant_id=$1 AND deal_id=$2 AND archived_at IS NULL
        AND state NOT IN('complete','cancelled') ORDER BY id LIMIT 1025`, [actor.tenantId, dealId])).rows : [];
    const parties = operation === "create_deal_request" ? (await db.query(`SELECT id::text,external_id,state,removed_at
      FROM finnor_os.pe_deal_parties WHERE tenant_id=$1 AND deal_id=$2 AND state='active'
        AND removed_at IS NULL ORDER BY id LIMIT 1025`, [actor.tenantId, dealId])).rows : [];
    ensure(workstreams.length <= 1024 && parties.length <= 1024, "Z0_ORIGINAL_CANONICAL_LINK_POPULATION_BOUND");
    const expected = derive({ pins, actor, workId: fixture.workId, workInputId: fixture.workInputId,
      original, mandate, grant, coreBytes: grant?.core_bytes, deal, workstreams, parties });
    for (const key of ["operation", "entityId", "stableIdentity", "originalDeadlineAt", "frozenPayload", "expectedFullRow"]) {
      ensure(same(expected[key], fixture.owner[key]), "Z0_SUPPLIED_OWNER_ORACLE_DIFFERS_FROM_ORIGINAL_MEANING");
    }
    const programme = before.programs.find(row => row.id === expected.programId);
    const nodes = programme?.proposed?.nodes?.filter(node => node.stableIdentity === expected.stableIdentity);
    ensure(nodes?.length === 1 && same(nodes[0].action, expected.action) && nodes[0].operation === expected.operation
      && nodes[0].deadlineAt === expected.originalDeadlineAt && nodes[0].postconditionRef === expected.postconditionRef
      && nodes[0].observerRef === expected.observerRef, "Z0_FROZEN_P1_DIFFERS_FROM_INDEPENDENT_ORIGINAL_MEANING");
    await db.query("COMMIT");
    return { ...expected, inputWitness: { schema: originalOracleContract.schema, inputPinsSha256: originalDigest(pins),
      mandateSha256: pins.mandateSha256, originalCoreBytesSha256: pins.rawSourceSha256,
      canonicalOriginalSha256: pins.canonicalSha256, nativeLinksSha256: pins.nativeLinksSha256,
      expectedActionSha256: expected.actionSha256, expectedOwnerFieldsSha256: originalDigest(expected.expectedFullRow),
      originalBytes: grant.physical_size, computationUsesCandidate: false, expectedRowUsedForComputation: false } };
  } catch (error) { await db.query("ROLLBACK"); throw error; }
}

export function matchesOriginalOwnerArgument(expected, actual) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const { workId, grounding, ...business } = actual;
  if (workId === undefined && grounding === undefined) return same(actual, expected.frozenPayload);
  return workId === expected.workId && grounding && typeof grounding === "object" && !Array.isArray(grounding)
    && grounding.verticalKey === "private_equity" && grounding.work?.entityType === "work"
    && grounding.work.entityId === expected.workId && grounding.deal?.entityType === "pe_deal"
    && grounding.deal.entityId === expected.frozenPayload.dealId && same(business, expected.frozenPayload);
}

export function observeOriginalOwnerRow(expected, row, visibility, priorWitness) {
  if (!row || !visibility) return null;
  const fields = Object.fromEntries(Object.keys(expected.expectedFullRow).map(key => [key,
    ["requested_at", "due_at"].includes(key) ? iso(row[key]) : row[key]]));
  const createdAt = iso(row.created_at), observedAt = iso(visibility.observedAt), committedAt = iso(visibility.committedAt);
  const rowSha256 = originalDigest(row), deadline = Date.parse(expected.originalDeadlineAt);
  const timelyVisibility = observedAt !== null && (Date.parse(observedAt) <= deadline
    || committedAt !== null && Date.parse(committedAt) <= deadline);
  if (!same(fields, expected.expectedFullRow) || createdAt === null || Date.parse(createdAt) > deadline
    || !timelyVisibility && priorWitness?.rowSha256 !== rowSha256) return null;
  return timelyVisibility ? { rowSha256, ownerFieldsSha256: originalDigest(fields), createdAt, observedAt, committedAt,
    originalDeadlineAt: expected.originalDeadlineAt, basis: "TIMELY_ACTUAL_DB_READ_OR_COMMIT" } : priorWitness;
}
