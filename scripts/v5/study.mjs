#!/usr/bin/env node
/**
 * Finite V5 study runner. It neither recruits people nor issues admission.
 * External evaluator/firm signatures are verified against separately supplied
 * trusted custody. Development keys can never qualify protected results.
 */
import { createHash, createPublicKey, verify } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { resolve, isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"

const HELP = `V5 matched study and activation contracts (no external actions)
  node scripts/v5/study.mjs validate --registration <absolute.json>
  node scripts/v5/study.mjs assign --registration <absolute.json> --out <absolute.json>
  node scripts/v5/study.mjs score --registration <absolute.json> --observations <absolute.json> --trust <absolute.json> --out <absolute.json>
  node scripts/v5/study.mjs activation --profile <absolute.json> --trust <absolute.json>

Inputs must be actual externally bound records. Templates/unbound profiles fail.
Output files are new only. Raw participant evidence and secrets stay in custody.
Scoring computes team-block simultaneous lower bounds; no qualifying gain is
guaranteed. A passing study is not S8 admission, live activation or economics.
`
const ALPHA = 0.05
const METHOD = "TEAM_PAIRED_EMPIRICAL_BERNSTEIN_BONFERRONI.v1"
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const hash = value => createHash("sha256").update(canonical(value)).digest("hex")
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
}
function bounded(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) fail("INVALID_NUMBER", `${name} is outside its registered finite range`)
  return value
}
function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /^(TBD|TODO|PLACEHOLDER|UNBOUND)$/i.test(value.trim())) fail("UNBOUND_PROFILE", `${name} must bind an actual value`)
  return value
}
function digest(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail("INVALID_DIGEST", `${name} requires a SHA-256 digest`)
  return value
}
function array(value, name, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100000) fail("UNBOUND_PROFILE", `${name} needs ${minimum} or more bounded entries`)
  return value
}
function instant(value, name) {
  requiredText(value, name)
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail("INVALID_TIME", `${name} must be an explicit UTC instant`)
  return Date.parse(value)
}
function unique(rows, key, name) {
  const values = rows.map(row => requiredText(row[key], `${name}.${key}`))
  if (new Set(values).size !== values.length) fail("DUPLICATE_IDENTITY", `${name} includes duplicate ${key}`)
}
function validateEndpoint(endpoint, name, direction) {
  if (!endpoint || endpoint.direction !== direction) fail("ENDPOINT_MISMATCH", `${name} direction must be ${direction}`)
  requiredText(endpoint.unit, `${name}.unit`)
  const lower = bounded(endpoint.pairedDifferenceLowerBound, `${name}.lower`, { min: -1e12, max: 1e12 })
  const upper = bounded(endpoint.pairedDifferenceUpperBound, `${name}.upper`, { min: -1e12, max: 1e12 })
  if (upper <= lower) fail("INVALID_BOUND", `${name} must preregister a nonzero supported difference range`)
  bounded(endpoint.materialMargin, `${name}.materialMargin`, { min: Number.MIN_VALUE, max: upper })
  requiredText(endpoint.meaningfulMarginBasisRef, `${name}.meaningfulMarginBasisRef`)
}

export function validateRegistration(registration) {
  if (registration?.schemaRevision !== "v5-matched-study.v1") fail("UNSUPPORTED_SCHEMA", "Expected v5-matched-study.v1")
  if (!["DEVELOPMENT_DIAGNOSTIC", "PROTECTED_EXPERIENCED_TEAM"].includes(registration.environment)) fail("UNSUPPORTED_ENVIRONMENT", "Register diagnostic or protected experienced-team environment explicitly")
  requiredText(registration.registrationId, "registrationId")
  instant(registration.registeredAt, "registeredAt")
  const start = instant(registration.windowStart, "windowStart")
  const end = instant(registration.windowEnd, "windowEnd")
  if (Date.parse(registration.registeredAt) >= start || end <= start) fail("POST_OUTCOME_REGISTRATION", "Registration must precede a fixed nonempty observation window")
  if (registration.stoppingRule !== "FIXED_REGISTERED_WINDOW_NO_OUTCOME_PEEK") fail("INVALID_STOPPING_RULE", "Outcome-driven stopping is unsupported")
  if (registration.method !== METHOD || registration.familyAlpha !== ALPHA || registration.familySize !== 2) fail("UNSUPPORTED_INFERENCE", `Only ${METHOD}, family alpha .05 and exactly two endpoints are supported`)
  if (registration.assignmentUnit !== "EXPERIENCED_TEAM_BLOCK" || registration.missingTreatment !== "ASSIGNMENT_LEVEL_NO_GAIN_COMPLETE_CASE_SENSITIVITY") fail("UNSUPPORTED_ASSIGNMENT", "Team-block assignment and registered missing treatment are required")
  requiredText(registration.distributionAndIndependenceBasisRef, "distributionAndIndependenceBasisRef")
  requiredText(registration.powerAnalysisRef, "powerAnalysisRef")
  requiredText(registration.oracleSpecificationRef, "oracleSpecificationRef")
  digest(registration.assignmentSeed, "assignmentSeed")
  digest(registration.B_liveDigest, "B_liveDigest")
  digest(registration.B_RDigest, "B_RDigest")
  digest(registration.historicalXDefinitionDigest, "historicalXDefinitionDigest")
  const teams = array(registration.teams, "teams", registration.environment === "PROTECTED_EXPERIENCED_TEAM" ? 20 : 2)
  const tasks = array(registration.tasks, "tasks", registration.environment === "PROTECTED_EXPERIENCED_TEAM" ? 100 : 2)
  unique(teams, "teamId", "teams")
  unique(tasks, "taskId", "tasks")
  const teamIds = new Set(teams.map(team => team.teamId))
  for (const team of teams) {
    requiredText(team.experienceEvidenceRef, "team.experienceEvidenceRef")
    requiredText(team.consentRef, "team.consentRef")
  }
  for (const task of tasks) {
    if (!teamIds.has(task.teamId)) fail("UNKNOWN_TEAM", "Every task must bind an assigned team")
    digest(task.decisionSpecificationDigest, "task.decisionSpecificationDigest")
    requiredText(task.independenceAndNonduplicationRef, "task.independenceAndNonduplicationRef")
    bounded(task.concurrentParticipants, "task.concurrentParticipants", { min: 2, max: 10, integer: true })
    for (const field of ["modelDigest", "dataDigest", "grantDigest", "toolsDigest", "adapterDigest", "checkerDigest", "permissionsDigest"]) digest(task[field], `task.${field}`)
    if (task.arms?.length !== 2 || !task.arms.includes("EQUIPPED_CURRENT") || !task.arms.includes("V5")) fail("UNEQUIPPED_COMPARATOR", "Both equipped current and V5 arms must use the same task owner contracts")
    bounded(task.totalCostLimit, "task.totalCostLimit", { min: Number.MIN_VALUE })
    bounded(task.totalParticipantSecondsLimit, "task.totalParticipantSecondsLimit", { min: Number.MIN_VALUE })
    bounded(task.aggregatePeakMemoryBytesLimit, "task.aggregatePeakMemoryBytesLimit", { min: Number.MIN_VALUE })
    bounded(task.wallSecondsLimit, "task.wallSecondsLimit", { min: Number.MIN_VALUE })
  }
  if (teams.some(team => !tasks.some(task => task.teamId === team.teamId))) fail("EMPTY_TEAM", "Every assigned team needs actual matched task instances")
  validateEndpoint(registration.endpoints?.throughput, "throughput", "HIGHER")
  validateEndpoint(registration.endpoints?.burdenReduction, "burdenReduction", "HIGHER")
  for (const floor of ["correctness", "regret", "calibration", "hardConstraints", "authorityTenantAuditFalseState"]) requiredText(registration.floorContracts?.[floor], `floorContracts.${floor}`)
  requiredText(registration.accountingContractRef, "accountingContractRef")
  return { digest: hash(registration), environment: registration.environment, teams: teams.length, tasks: tasks.length }
}

export function assign(registration) {
  const registered = validateRegistration(registration)
  const pairs = registration.tasks.map(task => {
    // A frozen hash assignment counterbalances within each actual team block.
    const teamTasks = registration.tasks.filter(item => item.teamId === task.teamId)
      .sort((a, b) => hash([registration.assignmentSeed, a.taskId]).localeCompare(hash([registration.assignmentSeed, b.taskId])))
    const index = teamTasks.findIndex(item => item.taskId === task.taskId)
    const initial = parseInt(hash([registration.assignmentSeed, task.teamId]).slice(0, 2), 16) % 2
    return { teamId: task.teamId, taskId: task.taskId, order: (index + initial) % 2 === 0 ? ["EQUIPPED_CURRENT", "V5"] : ["V5", "EQUIPPED_CURRENT"], decisionSpecificationDigest: task.decisionSpecificationDigest }
  })
  return { schemaRevision: "v5-team-assignment.v1", registrationDigest: registered.digest, pairs, qualification: "ASSIGNMENT_NOT_OBSERVATION_OR_ADMISSION" }
}

function verifySigned(envelope, trust, requiredPurpose, environment) {
  if (!envelope?.payload) fail("MISSING_INDEPENDENT_EVIDENCE", `${requiredPurpose} requires an external signed payload`)
  const key = array(trust?.issuers, "trusted issuers").find(item => item.issuerId === envelope.issuerId && item.purposes?.includes(requiredPurpose))
  if (!key) fail("UNTRUSTED_ISSUER", `Issuer is not independently trusted for ${requiredPurpose}`)
  requiredText(key.custodyRef, "issuer.custodyRef")
  if (environment === "PROTECTED_EXPERIENCED_TEAM" && key.environment !== "PROTECTED_INDEPENDENT") fail("DEVELOPMENT_NOT_PROTECTED", "A development issuer cannot qualify protected evidence")
  const publicKey = createPublicKey(key.publicKeyPem)
  const fingerprint = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex")
  if (fingerprint !== key.keyFingerprint) fail("TRUST_KEY_MISMATCH", "Trusted issuer fingerprint does not match its pinned key")
  const bytes = Buffer.from(canonical(envelope.payload))
  if (!verify(null, bytes, publicKey, Buffer.from(requiredText(envelope.signature, "signature"), "base64"))) fail("INVALID_SIGNATURE", "Independent evidence signature is invalid")
  return envelope.payload
}

// Maurer-Pontil finite-range empirical Bernstein bound, Bonferroni family.
// The registered inference basis must support independent bounded team blocks.
export function lowerBound(values, endpoint, familySize = 2) {
  if (values.length < 2) fail("INSUFFICIENT_BLOCKS", "At least two independently assigned team blocks are required")
  const range = endpoint.pairedDifferenceUpperBound - endpoint.pairedDifferenceLowerBound
  for (const value of values) if (!Number.isFinite(value) || value < endpoint.pairedDifferenceLowerBound || value > endpoint.pairedDifferenceUpperBound) fail("OUT_OF_REGISTERED_DOMAIN", "Observed team difference exceeds preregistered finite bounds")
  const n = values.length
  const mean = values.reduce((sum, value) => sum + value, 0) / n
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
  const log = Math.log(2 * familySize / ALPHA)
  const radius = Math.sqrt(2 * variance * log / n) + 7 * range * log / (3 * (n - 1))
  return { n, mean, sampleVariance: variance, lower: Math.max(endpoint.pairedDifferenceLowerBound, mean - radius), upper: Math.min(endpoint.pairedDifferenceUpperBound, mean + radius), radius, method: METHOD, familyAlpha: ALPHA, familySize }
}

export function score(registration, signedObservations, trust) {
  const registered = validateRegistration(registration)
  const custody = verifySigned(signedObservations, trust, "V5_TEAM_OBSERVATIONS", registration.environment)
  if (custody.registrationDigest !== registered.digest) fail("REGISTRATION_MISMATCH", "Observations bind another registration")
  if (instant(custody.completedAt, "completedAt") < Date.parse(registration.windowEnd)) fail("EARLY_STOP", "Fixed registered horizon has not completed")
  const observed = array(custody.observations, "observations")
  const assignment = assign(registration)
  const cells = new Map()
  const allMeters = ["models", "native", "data", "integration", "checking", "storage", "idleCapacity", "professional", "human", "orchestration", "failedCancelled", "maintenance"]
  const start = Date.parse(registration.windowStart), end = Date.parse(registration.windowEnd)
  for (const row of observed) {
    const task = registration.tasks.find(item => item.taskId === row.taskId && item.teamId === row.teamId)
    if (!task || !task.arms.includes(row.arm)) fail("UNASSIGNED_OBSERVATION", "Observation is not an assigned matched arm")
    const cellKey = `${row.taskId}:${row.arm}`
    if (cells.has(cellKey)) fail("DUPLICATE_OBSERVATION", "Every assigned task/arm has one canonical observation")
    const assigned = assignment.pairs.find(item => item.taskId === row.taskId)
    if (row.orderIndex !== assigned.order.indexOf(row.arm)) fail("ASSIGNMENT_ORDER_CHANGED", "Observed arm order differs from the frozen counterbalance")
    if (row.decisionSpecificationDigest !== task.decisionSpecificationDigest) fail("ORACLE_CHANGED", "Decision specification changed between assignment and acceptance")
    for (const field of ["modelDigest", "dataDigest", "grantDigest", "toolsDigest", "adapterDigest", "checkerDigest", "permissionsDigest"]) if (row[field] !== task[field]) fail("UNMATCHED_ARM", `${field} differs from the matched task`)
    const began = instant(row.startedAt, "startedAt"), completed = instant(row.completedAt, "row.completedAt")
    if (began < start || completed > end || completed < began) fail("OUTSIDE_HORIZON", "Observation falls outside the fixed observation window")
    const participants = array(row.participants, "participants", 2)
    unique(participants, "participantId", "participants")
    if (participants.length > 10 || participants.length !== task.concurrentParticipants) fail("PARTICIPANT_PROFILE_CHANGED", "Actual participant count differs from the registered 2-10 profile")
    const hours = participants.reduce((sum, participant) => {
      if (!["HUMAN", "AGENT"].includes(participant.kind)) fail("UNRESOLVED_ACTOR", "Each actual participant must retain its human/agent identity")
      requiredText(participant.identityEvidenceRef, "participant.identityEvidenceRef")
      requiredText(participant.authorityRef, "participant.authorityRef")
      const active = bounded(participant.activeSeconds, "participant.activeSeconds")
      const setup = bounded(participant.trainingSetupSeconds, "participant.trainingSetupSeconds")
      const corrections = bounded(participant.correctionHandoffSeconds, "participant.correctionHandoffSeconds")
      return sum + (active + setup + corrections) / 3600
    }, 0)
    if (!(hours > 0)) fail("MISSING_LABOR_DENOMINATOR", "All actual participant work and setup/corrections must be accounted")
    const costs = row.accounting
    for (const meter of allMeters) {
      if (costs?.[meter]?.coverage !== "COMPLETE") fail("METER_GAP", `${meter} accounting coverage is incomplete`)
      bounded(costs[meter].totalCost, `${meter}.totalCost`)
      requiredText(costs[meter].sourceRef, `${meter}.sourceRef`)
    }
    const totalCost = allMeters.reduce((sum, meter) => sum + costs[meter].totalCost, 0)
    const memory = bounded(row.aggregatePeakMemoryBytes, "aggregatePeakMemoryBytes")
    if (hours * 3600 > task.totalParticipantSecondsLimit || totalCost > task.totalCostLimit || memory > task.aggregatePeakMemoryBytesLimit || (completed - began) / 1000 > task.wallSecondsLimit) fail("RESOURCE_FLOOR_FAILED", "An actual observation exceeded its original matched aggregate resource envelope")
    const burden = bounded(row.interactionBurdenSeconds, "interactionBurdenSeconds")
    const decisions = Array.isArray(row.decisions) ? row.decisions : fail("MISSING_DECISION_RECORD", "Original independently accepted/rejected business decisions are required")
    unique(decisions, "decisionId", "decisions")
    for (const decision of decisions) {
      requiredText(decision.canonicalBusinessUnitRef, "decision.canonicalBusinessUnitRef")
      requiredText(decision.independentAcceptanceRef, "decision.independentAcceptanceRef")
      if (!["ACCEPTED", "REJECTED", "UNRESOLVED", "CORRECT_STOP"].includes(decision.status)) fail("INVALID_DECISION_STATUS", "Decision needs an explicit independent disposition")
    }
    const accepted = decisions.filter(decision => decision.status === "ACCEPTED")
    if (new Set(accepted.map(decision => decision.canonicalBusinessUnitRef)).size !== accepted.length) fail("DUPLICATE_BUSINESS_CREDIT", "Splitting one business decision cannot multiply throughput")
    for (const floor of Object.keys(registration.floorContracts)) {
      if (row.floors?.[floor]?.status !== "PASS" || row.floors[floor].contractRef !== registration.floorContracts[floor]) fail("INHERITED_FLOOR_FAILED", `${floor} did not pass the frozen independent contract`)
      requiredText(row.floors[floor].independentCheckRef, `${floor}.independentCheckRef`)
    }
    if (row.authorityViolations !== 0 || row.tenantViolations !== 0 || row.falseStateViolations !== 0) fail("ZERO_VIOLATION_FLOOR_FAILED", "An authority/tenant/false-state violation defeats the study")
    cells.set(cellKey, { row, hours, totalCost, burden, accepted })
  }
  const teamRows = registration.teams.map(team => {
    const totals = { EQUIPPED_CURRENT: { hours: 0, decisions: new Set(), burden: 0, totalCost: 0 }, V5: { hours: 0, decisions: new Set(), burden: 0, totalCost: 0 } }
    let missing = 0
    for (const task of registration.tasks.filter(item => item.teamId === team.teamId)) {
      const pair = task.arms.map(arm => cells.get(`${task.taskId}:${arm}`))
      // Missing assignments stay in the denominator; missing pairs receive no
      // gain. The complete-case sensitivity remains separate and cannot admit.
      if (pair.some(cell => !cell)) { missing++; continue }
      for (const arm of task.arms) {
        const cell = cells.get(`${task.taskId}:${arm}`), total = totals[arm]
        total.hours += cell.hours; total.burden += cell.burden; total.totalCost += cell.totalCost
        for (const decision of cell.accepted) {
          const identity = decision.canonicalBusinessUnitRef
          if (total.decisions.has(identity)) fail("DUPLICATE_TEAM_CREDIT", "Repeated business decisions across tasks cannot be credited twice")
          total.decisions.add(identity)
        }
      }
    }
    const conventional = totals.EQUIPPED_CURRENT, candidate = totals.V5
    const throughput = missing ? 0 : candidate.decisions.size / candidate.hours - conventional.decisions.size / conventional.hours
    const burdenReduction = missing ? 0 : conventional.burden / conventional.hours - candidate.burden / candidate.hours
    if (!Number.isFinite(throughput) || !Number.isFinite(burdenReduction)) fail("EMPTY_MATCHED_TEAM", "A team lacks a complete matched work denominator")
    return { teamIdHash: hash(team.teamId), throughput, burdenReduction, missingPairs: missing, currentHours: conventional.hours, v5Hours: candidate.hours, currentDecisions: conventional.decisions.size, v5Decisions: candidate.decisions.size, currentCost: conventional.totalCost, v5Cost: candidate.totalCost }
  })
  const throughput = lowerBound(teamRows.map(team => team.throughput), registration.endpoints.throughput)
  const burdenReduction = lowerBound(teamRows.map(team => team.burdenReduction), registration.endpoints.burdenReduction)
  const missingPairs = teamRows.reduce((sum, team) => sum + team.missingPairs, 0)
  const gain = throughput.lower > registration.endpoints.throughput.materialMargin
    && burdenReduction.lower > registration.endpoints.burdenReduction.materialMargin && missingPairs === 0
  return { schemaRevision: "v5-study-result.v1", registrationDigest: registered.digest, observationDigest: hash(custody), environment: registration.environment, disposition: gain ? "REGISTERED_STUDY_PREDICATE_MET" : "NO_QUALIFYING_GAIN", throughput, burdenReduction, teams: teamRows, missingPairs, protectedEvidence: registration.environment === "PROTECTED_EXPERIENCED_TEAM", S8Admission: "REQUIRED_EXTERNAL_NOT_ISSUED", liveActivation: false, economicQualification: false, inferenceLimit: "Conditional on the frozen independent bounded team-block inference basis; not a universal error or causal claim" }
}

export function validateActivation(signedProfile, trust) {
  const profile = verifySigned(signedProfile, trust, "V5_ACTIVITY_ACTIVATION", "PROTECTED_EXPERIENCED_TEAM")
  if (profile.schemaRevision !== "v5-activity-activation.v1") fail("UNSUPPORTED_SCHEMA", "Expected v5-activity-activation.v1")
  for (const field of ["profileId", "mandateRef", "termsRevision", "activityClass", "instrumentClass", "policyRevision", "S8AdmissionRef", "professionalDeterminationRef", "disclosureRulesRef", "contactSuppressionRef", "revocationRef", "S7AccountingRef", "independentObservationPredicateRef"]) requiredText(profile[field], field)
  for (const field of ["legalEntities", "jurisdictions", "authorizedActors", "externalInterfaces", "permittedChannels", "activityToActorMapping", "exactApprovalConditions"]) array(profile[field], field)
  for (const entity of profile.legalEntities) {
    requiredText(entity.canonicalEntityRef, "legalEntity.canonicalEntityRef")
    requiredText(entity.issuerEvidenceRef, "legalEntity.issuerEvidenceRef")
  }
  for (const actor of profile.authorizedActors) {
    requiredText(actor.principalRef, "actor.principalRef")
    requiredText(actor.authorityIssuerRef, "actor.authorityIssuerRef")
    requiredText(actor.presentGrantRef, "actor.presentGrantRef")
  }
  for (const iface of profile.externalInterfaces) {
    requiredText(iface.capabilityRef, "interface.capabilityRef")
    requiredText(iface.independentObservationRef, "interface.independentObservationRef")
    requiredText(iface.admissionRef, "interface.admissionRef")
  }
  for (const amount of ["computeLimit", "dataIntegrationLimit", "participantSecondsLimit", "capitalExposureLimit", "contactLimit"]) bounded(profile.resources?.[amount], `resources.${amount}`)
  bounded(profile.materialMargin, "materialMargin", { min: Number.MIN_VALUE })
  const effective = instant(profile.effectiveAt, "effectiveAt"), expiry = instant(profile.expiresAt, "expiresAt")
  if (expiry <= effective || Date.now() < effective || Date.now() >= expiry) fail("EXPIRED_AUTHORITY", "Activation authority is not currently effective")
  digest(profile.producerDigest, "producerDigest")
  digest(profile.dependencyLockDigest, "dependencyLockDigest")
  digest(profile.B_RDigest, "B_RDigest")
  return { status: "BOUND_EXTERNAL_PROFILE_VALIDATED_NOT_ACTIVATED", profileDigest: hash(profile), activityClass: profile.activityClass, activationPerformed: false }
}

async function load(path, name) {
  if (!path || !isAbsolute(path)) fail("ABSOLUTE_PATH_REQUIRED", `${name} requires an absolute custody path`)
  const bytes = await readFile(path)
  if (bytes.length > 32 * 1024 * 1024) fail("INPUT_LIMIT", "Custody file exceeds 32 MiB")
  return JSON.parse(bytes.toString("utf8"))
}
async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === "--help") { process.stdout.write(HELP); return }
  const flags = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || !args[i + 1] || flags[args[i]]) fail("INVALID_ARGUMENT", "Use named flags once with explicit absolute paths")
    flags[args[i]] = args[i + 1]
  }
  let result
  if (command === "activation") result = validateActivation(await load(flags["--profile"], "profile"), await load(flags["--trust"], "trust"))
  else {
    const registration = await load(flags["--registration"], "registration")
    if (command === "validate") result = validateRegistration(registration)
    else if (command === "assign") result = assign(registration)
    else if (command === "score") result = score(registration, await load(flags["--observations"], "observations"), await load(flags["--trust"], "trust"))
    else fail("UNSUPPORTED_COMMAND", "Use validate, assign, score or activation")
  }
  if (flags["--out"]) {
    if (!isAbsolute(flags["--out"])) fail("ABSOLUTE_PATH_REQUIRED", "Output requires an absolute new file")
    await writeFile(flags["--out"], JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    process.stdout.write(JSON.stringify({ status: "RECORDED", output: flags["--out"], resultDigest: hash(result), qualification: result.disposition ?? result.status ?? "REGISTRATION_ONLY" }) + "\n")
  } else process.stdout.write(JSON.stringify(result, null, 2) + "\n")
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ status: "REFUSED", code: error.code ?? "INPUT_OR_CUSTODY_FAILURE", message: error.message }) + "\n")
    process.exitCode = 1
  })
}
