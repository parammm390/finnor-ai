import { z } from "zod";
import type { CoalitionProblem } from "../../../shared-types/src/coalition-programme";
import { R5_PROFILE, R5_VERSION } from "../../../shared-types/src/coalition-programme";
import { R2RequestSchema } from "../../../shared-types/src/robust-programme-search";
import { r2Quantity as q } from "../r2-rational";
import { requireCoalition } from "./guards";
import {AllocationResourceInputSchema} from "../allocation-contracts";
import {parseEconomicMandate} from "../control-contracts";
export { requireCoalition } from "./guards";

const id = z.string().min(1).max(256);
const quantity = z.string().max(1025).regex(/^-?(?:0|[1-9]\d*)(?:\/[1-9]\d*|\.\d+)?$/)
  .superRefine((value, context) => {
    try { q(value); } catch { context.addIssue({ code: "custom", message: "Original rational precision exceeded" }); }
  });
const ref = z.object({ owner: id, id: z.string().min(1).max(512), version: id,
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const series = z.array(quantity).min(1).max(24);
const atom = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CONSTANT") }).strict(),
  z.object({ kind: z.literal("TERM"), id }).strict(),
  z.object({ kind: z.literal("GRANT"), resourceId: id, date: z.number().int().min(0).max(23) }).strict(),
  z.object({ kind: z.literal("MEMBER"), partyId: id }).strict(),
  z.object({ kind: z.literal("MEMBER_PAIR"), parties: z.tuple([id, id]) }).strict(),
]);
const feature = z.union([atom, z.object({ kind: z.literal("PRODUCT"), left: atom, right: atom }).strict()]);
const equation = z.object({
  itemId: id, ownerPartyId: id, kind: z.enum(["CASH", "RESIDUAL_ASSET", "LIABILITY"]),
  unit: id, currency: z.string().regex(/^[A-Z]{3}$/), date: z.number().int().min(0).max(23),
  terms: z.array(z.object({ coefficientId: id, feature }).strict()).min(1).max(64),
}).strict();
const operator = z.object({
  id, operationRef: ref, modelRef: ref, kind: z.enum(["INTERVENE", "WAIT", "STOP"]),
  eligibleParties: z.array(id).min(1).max(8), requiredParties: z.array(id).max(8),
  minMembers: z.number().int().min(1).max(8), maxMembers: z.number().int().min(1).max(8),
  termChoices: z.array(z.record(quantity)).min(1).max(64),
  grantChoices: z.array(z.record(series)).min(1).max(64),
  equations: z.array(equation).max(256), costs: z.array(equation).max(256),
  requiresAfter: z.array(id).max(8), exclusiveItems: z.array(id).max(256),
  consentRequired: z.array(id).max(8),
}).strict();

const canonicalBasis=z.object({
  schema:z.literal("finnor.r5.canonical-allocation-basis.v1"),
  mandate:z.unknown().transform((value,context)=>{
    try{return parseEconomicMandate(value);}
    catch{context.addIssue({code:"custom",message:"Original canonical S4 mandate is invalid"});return z.NEVER;}
  }),
  resources:z.array(AllocationResourceInputSchema.extend({ref,revision:z.number().int().positive(),priorRef:ref.nullable()}).strict()).min(1).max(32),
  outstanding:z.array(z.object({
    reservationRef:ref,certificateRef:ref,policyRefs:z.array(ref).max(32),effectRefs:z.array(ref).max(32),
    status:z.enum(["RESERVED","CONSUMPTION_PENDING","UNKNOWN_OUTCOME","PARTIALLY_RECONCILED","SETTLED_RETAINED"]),
    envelopes:z.array(z.object({resourceId:id,unit:id,kind:AllocationResourceInputSchema.shape.kind,
      horizon:AllocationResourceInputSchema.shape.horizon,quantities:series,minimumQuantities:series}).strict()).min(1).max(32),
  }).strict()).max(256),
  snapshotDigest:z.string().regex(/^[0-9a-f]{64}$/),knowledgeAt:z.string().datetime(),
}).strict();

export const CoalitionProblemSchema: z.ZodType<CoalitionProblem,z.ZodTypeDef,unknown> = z.object({
  schema: z.literal("finnor.r5.original.v1"), version: z.literal(R5_VERSION), profile: z.literal(R5_PROFILE),
  parties: z.array(z.object({
    id, partyRef: ref, rightsRef: ref, outsideOptionRef: ref, fundingRef: ref, requiredConsentRef: ref,
    outsideOptions: z.record(quantity), settledCash: z.record(series), ownerObjectiveWeight: quantity,
  }).strict()).min(1).max(8),
  worlds: z.array(z.object({ id, coefficients: z.record(quantity), eventTokens: z.record(id) }).strict()).min(1).max(32),
  dates: z.array(z.string().datetime()).min(1).max(24),
  unit: id, currency: z.string().regex(/^[A-Z]{3}$/), valuationDate: z.string().datetime(),
  discountFactors: series,
  events: z.array(z.object({ id, eventRef: ref, availableDate: z.number().int().min(0).max(23),
    tokens: z.array(id).min(1).max(32) }).strict()).min(1).max(32),
  transfers: z.array(z.object({
    eventId: id, token: id, date: z.number().int().min(0).max(23), operationRef: ref,
    bounds: z.record(z.tuple([quantity, quantity])),
  }).strict()).min(1).max(768),
  grammar: z.object({ ref, operators: z.array(operator).min(1).max(8),
    maxSteps: z.number().int().min(1).max(8), admittedCoalitions: z.literal("ALL_ELIGIBLE_NONEMPTY_SUBSETS") }).strict(),
  model: z.object({ ref, qualification: z.literal("SUPPLIED_FINITE_MODEL_UNADMITTED"),
    noStrategicSpillover: z.literal("SUPPLIED_NO_CROSS_COALITION_SPILLOVER"),
    omittedMechanisms: z.array(id).max(128) }).strict(),
  objective: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ROBUST"), mandateRef: ref }).strict(),
    z.object({ kind: z.literal("EXPECTED"), mandateRef: ref, qualifiedLawRef: ref, probabilities: z.record(quantity) }).strict(),
  ]),
  resources: z.array(z.object({ id, sourceRef: ref, unit: id, available: z.record(series),
    kind: z.enum(["CUMULATIVE_EXPENDITURE", "OCCUPANCY", "FLOW"]) }).strict()).min(1).max(32),
  obligationsRef: ref,
  canonicalAllocation:canonicalBasis.optional(),
  controlDemand:z.object({schema:z.literal("finnor.r5.control-demand.v1"),
    dimensions:z.array(z.object({dimensionId:id,totalResourceId:id.nullable(),occupancyResourceId:id.nullable()}).strict()).max(16),
    humanSecondsByOperator:z.record(quantity),staffing:z.literal("NO_EXISTING_EMPLOYMENT_OR_BENEFIT_CHANGE"),
    terminalLiabilityResourceId:id.nullable()}).strict().optional(),
  owner: z.object({ tenantId: id, principalId: id, workId: id, workRevision: id, originalEpisodeId: id,
    originalBudgetGrantRef: ref, originalDeadline: z.string().datetime(),
    dependencies: z.array(z.object({ key: id, revision: z.number().int().min(0) }).strict()).max(4096) }).strict(),
  limits: z.object({ maxProgrammeOptions: z.number().int().min(1).max(100000),
    maxEncodingBytes: z.number().int().min(1024).max(8388608), native: R2RequestSchema.innerType().shape.budget }).strict(),
}).strict();

export function parseCoalitionProblem(value: unknown): CoalitionProblem {
  const p = CoalitionProblemSchema.parse(value), n = p.dates.length;
  const ids = p.parties.map(party => party.id), worlds = p.worlds.map(world => world.id);
  const resources = p.resources.map(resource => resource.id), operators = p.grammar.operators.map(op => op.id);
  const sameKeys = (record: object, expected: string[]) =>
    JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...expected].sort());
  for (const group of [ids, worlds, resources, operators, p.events.map(event => event.id)])
    requireCoalition(new Set(group).size === group.length, "DUPLICATE_ORIGINAL_IDENTITY");
  if(p.controlDemand){
    const control=p.controlDemand;
    requireCoalition(sameKeys(control.humanSecondsByOperator,operators)&&
      Object.values(control.humanSecondsByOperator).every(value=>q(value).n>=0n),"ORIGINAL_COMPLETE_HUMAN_DEMAND");
    requireCoalition(new Set(control.dimensions.map(binding=>binding.dimensionId)).size===control.dimensions.length&&
      control.dimensions.every(binding=>[binding.totalResourceId,binding.occupancyResourceId].every(id=>id===null||resources.includes(id)))&&
      (control.terminalLiabilityResourceId===null||resources.includes(control.terminalLiabilityResourceId)),
      "ORIGINAL_CONTROL_RESOURCE_MAPPING");
  }
  requireCoalition(p.dates.every((date, i) => !i || date > p.dates[i - 1]!), "ORIGINAL_DATE_ORDER");
  requireCoalition(p.discountFactors.length === n && p.discountFactors.every(v => q(v).compare(q("0")) > 0), "DISCOUNT_BASIS");
  requireCoalition(!p.model.omittedMechanisms.length, "UNSUPPORTED_OMITTED_SPILLOVER_MECHANISM");
  for (const party of p.parties) {
    requireCoalition(sameKeys(party.outsideOptions, worlds) && sameKeys(party.settledCash, worlds), "COMPLETE_PARTY_WORLD_BASIS");
    requireCoalition(Object.values(party.settledCash).every(values => values.length === n), "COMPLETE_PARTY_CASH_DATES");
  }
  for (const resource of p.resources) {
    requireCoalition(sameKeys(resource.available, worlds) &&
      Object.values(resource.available).every(values => values.length === n && values.every(v => q(v).compare(q("0")) >= 0)), "COMPLETE_ORIGINAL_RESOURCE_BASIS");
  }
  for (const event of p.events) {
    requireCoalition(event.availableDate < n && new Set(event.tokens).size === event.tokens.length, "ORIGINAL_EVENT_DOMAIN");
    requireCoalition(p.worlds.every(world => event.tokens.includes(world.eventTokens[event.id]!)), "COMPLETE_ORIGINAL_EVENT_WORLDS");
  }
  for (const transfer of p.transfers) {
    const event = p.events.find(event => event.id === transfer.eventId);
    requireCoalition(event && event.tokens.includes(transfer.token) &&
      event.availableDate <= transfer.date && transfer.date < n, "LAWFUL_OBSERVABLE_TRANSFER_DATE");
    requireCoalition(sameKeys(transfer.bounds, ids) &&
      Object.values(transfer.bounds).every(([lo, hi]) => q(lo).compare(q(hi)) <= 0), "ORIGINAL_DIVISION_BOUNDS");
  }
  for (const op of p.grammar.operators) {
    requireCoalition(op.minMembers <= op.maxMembers &&
      [...op.eligibleParties, ...op.requiredParties, ...op.consentRequired].every(party => ids.includes(party)) &&
      op.requiresAfter.every(id => operators.includes(id)), "ORIGINAL_OPERATOR_DOMAIN");
    for (const grants of op.grantChoices)
      requireCoalition(sameKeys(grants, resources) &&
        Object.values(grants).every(values => values.length === n && values.every(v => q(v).compare(q("0")) >= 0)), "ORIGINAL_GRANT_CHOICES");
    for (const equation of [...op.equations, ...op.costs]) {
      requireCoalition(ids.includes(equation.ownerPartyId) && equation.unit === p.unit &&
        equation.currency === p.currency && equation.date < n, "ORIGINAL_ITEM_ACCOUNTING");
      for (const term of equation.terms)
        requireCoalition(p.worlds.every(world => term.coefficientId in world.coefficients), "COMPLETE_ORIGINAL_MODEL_COEFFICIENTS");
    }
  }
  if (p.objective.kind === "EXPECTED") {
    requireCoalition(sameKeys(p.objective.probabilities, worlds) &&
      Object.values(p.objective.probabilities).every(v => q(v).compare(q("0")) >= 0), "QUALIFIED_JOINT_LAW");
    const total = Object.values(p.objective.probabilities).reduce((sum, v) => sum.add(q(v)), q("0"));
    requireCoalition(total.compare(q("1")) === 0, "QUALIFIED_JOINT_LAW_NORMALIZATION");
  }
  return p;
}
