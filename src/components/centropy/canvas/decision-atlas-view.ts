import { z } from "zod"
const ref=z.object({owner:z.string(),id:z.string(),version:z.string(),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)})
const affine=z.object({a:z.array(z.string()).max(4),b:z.string()})
const facet=z.object({expression:affine,relation:z.enum(["LE","LT","EQ"])})
const node=z.discriminatedUnion("kind",[
  z.object({id:z.string(),kind:z.literal("SPLIT"),expression:affine,negative:z.string(),zero:z.string(),positive:z.string()}),
  z.object({id:z.string(),kind:z.literal("CELL"),geometry:z.object({affineDimension:z.number(),witness:z.array(z.string()),slack:z.string()}),
    label:z.object({policies:z.array(z.object({policyId:z.string(),feasible:z.boolean(),violatedConstraintId:z.string().nullable(),
      bindingConstraintIds:z.array(z.string())})),winnerPolicyId:z.string().nullable(),tiedPolicyIds:z.array(z.string())})}),
  z.object({id:z.string(),kind:z.literal("EMPTY")}),
  z.object({id:z.string(),kind:z.literal("GAP"),reason:z.string()}),
])
const parameter=z.object({id:z.string(),unit:z.string(),currency:z.string().nullable(),owner:z.enum(["BUSINESS_OWNER","S5"]),
  lower:z.string(),upper:z.string(),valueSource:z.string()})
const family=z.object({ref,root:z.object({entityType:z.string(),entityId:z.string().uuid()}),evidenceVersionId:z.string().uuid(),grantRef:ref,cancellationRef:ref,
  input:z.object({familyRef:ref,modelRef:ref,domainRef:ref,work:z.object({id:z.string().uuid(),inputId:z.string().uuid(),inputDigest:z.string()}),
    source:z.object({familyKey:z.string(),modelKey:z.string(),domain:z.object({parameters:z.array(parameter),facets:z.array(facet)}),
      assumptions:z.array(z.string()),qualification:z.literal("MODEL_RELATIVE_EXACT_UNADMITTED"),policies:z.array(z.object({id:z.string(),ref}))})})})
const parameters=z.object({ref,familyRef:ref,revision:z.number().int(),values:z.array(z.string())})
export const DecisionAtlasQueryViewSchema=z.object({
  schema:z.literal("finnor.r7.query.v1"),ref,buildId:z.string().uuid(),workId:z.string().uuid(),parameterRef:ref,
  disposition:z.enum(["COVERED","NAMED_FAMILY_INFEASIBLE","GAP","OUTSIDE_DOMAIN","INVALIDATED","UNSUPPORTED","UNKNOWN","FULL_FAMILY_CHECKED","UNRESOLVED"]),
  cellId:z.string().nullable(),atlasCoverage:z.enum(["COMPLETE","PARTIAL","UNKNOWN"]),reasons:z.array(z.string()),
  choice:z.object({schema:z.literal("finnor.s4.exact-affine-choice.v1"),ref,policyId:z.string(),nodeId:z.string(),
    action:z.object({id:z.string(),kind:z.enum(["INQUIRE","INTERVENE","WAIT","STOP"]),cost:z.string(),tailLiability:z.string(),humanSeconds:z.string()}),
    parameters:z.array(z.string()),robustValue:z.string(),tiedPolicyIds:z.array(z.string()),worstWorldIds:z.array(z.string()),
    ownerChecks:z.object({current:z.literal(true),fullFamilyOptimizerInvoked:z.boolean()}),executionAuthorityGranted:z.literal(false)}).nullable(),
  fallback:z.object({mode:z.string(),admitted:z.literal(false),fullFamilyEvaluations:z.number()}).nullable(),
  costs:z.object({wallMs:z.number(),membershipPredicates:z.number(),fullFamilyEvaluations:z.number(),money:z.null()}),executionAuthorityGranted:z.literal(false),
})
export const DecisionAtlasContextViewSchema=z.object({workId:z.string().uuid(),family:family.nullable(),parameters:parameters.nullable(),
  effectiveValues:z.array(z.string()).nullable(),parameterSources:z.array(z.object({parameterId:z.string(),owner:z.enum(["BUSINESS_OWNER","S5"]),ref})),
  builds:z.array(z.object({id:z.string().uuid(),status:z.string()})),lastQuery:DecisionAtlasQueryViewSchema.nullable()})
export const DecisionAtlasBuildViewSchema=z.object({buildId:z.string().uuid(),workId:z.string().uuid(),status:z.string(),deadlineAt:z.string(),
  failure:z.object({code:z.string(),requirement:z.string().optional()}).nullable(),
  atlas:z.object({ref,proposal:z.object({root:z.string(),boundaryRule:z.literal("NEGATIVE_ZERO_POSITIVE_EXACT"),
    coverage:z.enum(["COMPLETE","PARTIAL"]),nodes:z.array(node).max(1024)}),
    check:z.object({status:z.literal("ACCEPTED"),predicate:z.string(),acceptedCellIds:z.array(z.string()),gapIds:z.array(z.string())}),
    envelope:z.object({grammar:z.literal("NAMED_FAMILY_ONLY"),assumptions:z.array(z.string())}),executionAuthorityGranted:z.literal(false)}).nullable()})
export type DecisionAtlasContextView=z.infer<typeof DecisionAtlasContextViewSchema>
export type DecisionAtlasQueryView=z.infer<typeof DecisionAtlasQueryViewSchema>
export type DecisionAtlasBuildView=z.infer<typeof DecisionAtlasBuildViewSchema>
/** Read-only presentation of an already accepted split path, not a new checker. */
export function acceptedCellView(atlas:NonNullable<DecisionAtlasBuildView["atlas"]>,cellId:string|null){
  type Predicate={expression:z.infer<typeof affine>;relation:"LT"|"EQ"|"GT"}
  const nodes=new Map(atlas.proposal.nodes.map(n=>[n.id,n])),seen=new Set<string>(),
    pending:Array<{id:string;predicates:Predicate[]}>= [{id:atlas.proposal.root,predicates:[]}]
  while(pending.length){
    const current=pending.pop()!
    if(seen.has(current.id))continue
    seen.add(current.id);const n=nodes.get(current.id)
    if(n?.id===cellId&&n.kind==="CELL")return {node:n,predicates:current.predicates}
    if(n?.kind==="SPLIT")for(const [id,relation]of [[n.negative,"LT"],[n.zero,"EQ"],[n.positive,"GT"]] as const)
      pending.push({id,predicates:[...current.predicates,{expression:n.expression,relation}]})
  }
  return null
}
