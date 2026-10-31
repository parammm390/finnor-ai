"""Emit a preimage-bound coordinator request. Never modify shared source."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import importlib.util

_arity_spec = importlib.util.spec_from_file_location("z2_native_arity", Path(__file__).with_name("native-arity-spec.py"))
_arity = importlib.util.module_from_spec(_arity_spec)
_arity_spec.loader.exec_module(_arity)


BASE = "684d805e471836a720aa6741a3128eca17d28202"
PRODUCT_LOCK = "61d9881ca8059d24d057d1e00d5436ef2059de7889ccd1fd2f92a630075bcebf"
EXECUTION_PACK = "4419731d2544d1c07fe275ec8071d5d783273942ca9947eda2ff6b4e2dffb9db"
OWNER = "finnor-os/packages/private-equity/src/"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def specifications():
    wiring = [
        {
            "path": "finnor-os/apps/worker/src/index.ts",
            "symbols": ["createWorker", "construct_interaction_protocol_v1"],
            "callers": ["Existing JobQueue physical claim/delivery/heartbeat"],
            "failureWithout": "The registered native worker ignores Z2_REQUIRED and can publish a unilateral-only result.",
            "edits": [
                ("import {constructInteractionProtocolJob} from '../../../packages/private-equity/src/interaction-synthesis/worker';",
                 "import {dispatchInteractionProtocolJob,configureZ2ReplayWorker,z2ReplayWorkerMode} from '../../../packages/private-equity/src/project-z/z2-coalitions/worker';"),
                ("queue.register('construct_interaction_protocol_v1',constructInteractionProtocolJob,",
                 "queue.register('construct_interaction_protocol_v1',dispatchInteractionProtocolJob,"),
                ("  const queue = new JobQueue();\n",
                 "  const queue = new JobQueue();\n"
                 "  if (configureZ2ReplayWorker(queue,PRODUCTION_JOB_CONTRACTS.construct_interaction_protocol_v1)) return queue;\n"),
                ('  const certificationMode = process.env.FINNOR_ENVIRONMENT?.trim() === "staging" && process.env.P3_DISABLE_PROACTIVE_SCHEDULER?.trim() === "1";',
                 '  const certificationMode = z2ReplayWorkerMode() || (process.env.FINNOR_ENVIRONMENT?.trim() === "staging" && process.env.P3_DISABLE_PROACTIVE_SCHEDULER?.trim() === "1");'),
                ('reason: "P3 staging certification mode"', 'reason: z2ReplayWorkerMode() ? "Z2 exclusive disposable replay" : "P3 staging certification mode"'),
            ],
        },
        {
            "path": OWNER+"interaction-synthesis/store.ts",
            "symbols": ["currentChangesTx", "checkedProtocolTx"],
            "callers": ["Y3 admission/read/download/compare/resume", "interaction-port current admission",
                        "S4 continuation and Y1 programme effect guard"],
            "failureWithout": "Legacy native consumers can use a Z2-marked protocol without its current independent coalition certificate.",
            "edits": [
                ("import {productRuntimeIdentity} from './product-runtime';",
                 "import {productRuntimeIdentity} from './product-runtime';\n"
                 "import {coalitionChangesTx,assertCoalitionCurrentTx} from '../project-z/z2-coalitions/guard';"),
                (" if(Date.now()>=row.deadline_at.getTime())changes.push('deadline');\n return [...new Set(changes)];",
                 " if(Date.now()>=row.deadline_at.getTime())changes.push('deadline');\n"
                 " changes.push(...await coalitionChangesTx(c,row));\n return [...new Set(changes)];"),
                (" if((await currentChangesTx(ctx,c,row)).length)fail('Y3_PROTOCOL_DEPENDENCIES_CHANGED');\n return row;",
                 " if((await currentChangesTx(ctx,c,row)).length)fail('Y3_PROTOCOL_DEPENDENCIES_CHANGED');\n"
                 " await assertCoalitionCurrentTx(c,row);\n return row;"),
                ("request.problem.participants[0].principalId!==principal(ctx)",
                 "request.problem.participants[0]?.principalId!==principal(ctx)"),
            ],
        },
        {
            "path": OWNER+"interaction-synthesis/execution-guard.ts",
            "symbols": ["termsTx"],
            "callers": ["currentRunTx", "consent acceptance", "assertInteractionProgrammeCurrentTx"],
            "failureWithout": "A terms preimage omitting or substituting the coalition meaning could reach the original effect boundary.",
            "edits": [
                ("import {sourceClaimTx} from './store';",
                 "import {sourceClaimTx} from './store';\n"
                 "import {assertCoalitionTerms} from '../project-z/z2-coalitions/guard';\n"
                 "import {assertParticipantWorksTx} from '../project-z/z2-coalitions/participant-work-guard';"),
                ("  fail('Y3_EXACT_CURRENT_TERMS_REQUIRED');\n return found;",
                 "  fail('Y3_EXACT_CURRENT_TERMS_REQUIRED');\n assertCoalitionTerms(row,found);\n return found;"),
                (" if(expected&&!same([...ids].sort(),[...expected].sort()))fail('Y3_ORIGINAL_CONSENT_HEADS_CHANGED');\n return ids;",
                 " if(expected&&!same([...ids].sort(),[...expected].sort()))fail('Y3_ORIGINAL_CONSENT_HEADS_CHANGED');\n"
                 " await assertParticipantWorksTx(c,row,terms);\n return ids;"),
            ],
        },
        {
            "path": OWNER+"interaction-synthesis/continuation.ts",
            "symbols": ["visibleTerms", "createInteractionTerms"],
            "callers": ["Existing participant-local terms, consent, run and effect APIs"],
            "failureWithout": "Participants cannot inspect or consent to the exact Z2 claim and excluded threat classes in their original terms.",
            "edits": [
                ("import {withS5PortfolioTransaction as transaction} from '../allocation-store';",
                 "import {withS5PortfolioTransaction as transaction} from '../allocation-store';\n"
                 "import {coalitionTermsBinding,assertCoalitionTerms} from '../project-z/z2-coalitions/guard';\n"
                 "import {ensureParticipantWork} from '../project-z/z2-coalitions/participant-work';\n"
                 "import {participantWorkViewTx} from '../project-z/z2-coalitions/participant-work-guard';"),
                ("export function visibleTerms(row:ProtocolRow,terms:InteractionTerms){\n const effects=",
                 "export function visibleTerms(row:ProtocolRow,terms:InteractionTerms){\n"
                 " assertCoalitionTerms(row,terms);\n const effects="),
                (" return {schema:terms.schema,ref:terms.ref,id:terms.id,protocolId:terms.protocolId,protocolRef:terms.protocolRef,revision:terms.revision,",
                 " return {...coalitionTermsBinding(row),schema:terms.schema,ref:terms.ref,id:terms.id,protocolId:terms.protocolId,protocolRef:terms.protocolRef,revision:terms.revision,"),
                (" const body:Omit<InteractionTerms,'ref'>={schema:'finnor.s4.interaction-terms.v1',id:randomUUID(),protocolId:row.id,",
                 " const body:Omit<InteractionTerms,'ref'>={...coalitionTermsBinding(row),schema:'finnor.s4.interaction-terms.v1',id:randomUUID(),protocolId:row.id,"),
                ("   terms:terms?visibleTerms(row,terms):null,consents,runs:runs.slice(0,32),truncated:runs.length>32,",
                 "   terms:terms?visibleTerms(row,terms):null,\n"
                 "   ...(terms?await participantWorkViewTx(c,row,terms,principal(ctx)):{}),\n"
                 "   consents,runs:runs.slice(0,32),truncated:runs.length>32,"),
                (" developmentOnly();const input=ConsentSchema.parse(raw);\n return transaction(ctx,async c=>{",
                 " developmentOnly();const input=ConsentSchema.parse(raw);\n const result=await transaction(ctx,async c=>{"),
                ("  return {consent:body,replayed:false};\n });\n}\nexport async function startInteraction",
                 "  return {consent:body,replayed:false};\n });\n"
                 " if(input.scope==='TERMS'&&input.decision==='ACCEPT')\n"
                 "  return {...result,participantWork:await ensureParticipantWork(ctx,input.protocolId,input.termsRef)};\n"
                 " return result;\n}\nexport async function startInteraction"),
            ],
        },
        {
            "path": "finnor-os/apps/api/app/api/company-brain/[operation]/route.ts",
            "symbols": ["POST", "CoalitionOperations", "handleCoalitionOperation"],
            "callers": ["Existing signed-bearer Company Brain route", "CENTROPY authenticated proxy"],
            "failureWithout": "Coalition submit/read are unreachable; direct API or process calls are not a native Work flow.",
            "edits": [
                ("import {InteractionOperations,handleInteractionOperation,readInteractionBody} from '@finnor/private-equity/src/interaction-synthesis/api';",
                 "import {InteractionOperations,handleInteractionOperation,readInteractionBody} from '@finnor/private-equity/src/interaction-synthesis/api';\n"
                 "import {CoalitionOperations,handleCoalitionOperation} from '@finnor/private-equity/src/project-z/z2-coalitions/api';"),
                ("    if(InteractionOperations.some(operation=>operation===route.operation)){",
                 "    if(CoalitionOperations.some(operation=>operation===route.operation)){\n"
                 "      const auth=await requireContext(req),body=await readInteractionBody(req);\n"
                 "      const result=await handleCoalitionOperation({auth},route.operation,body);\n"
                 "      return response(result.body,result.status);\n    }\n"
                 "    if(InteractionOperations.some(operation=>operation===route.operation)){"),
            ],
        },
        {
            "path": "scripts/centropy/generate-capability-manifest.mjs",
            "symbols": ["delegatedRegistries", "companyBrainReads"],
            "callers": ["CENTROPY resolveProductRoute", "Generated human form and coverage catalogues"],
            "failureWithout": "The authenticated frontend proxy rejects the new operations even when the backend dispatches them.",
            "edits": [
                ('  ["InteractionOperations", "interaction-synthesis/api.ts"],',
                 '  ["InteractionOperations", "interaction-synthesis/api.ts"],\n'
                 '  ["CoalitionOperations", "project-z/z2-coalitions/api.ts"],'),
                ('  "interaction-read", "interaction-list", "interaction-artifact", "interaction-compare", "interaction-local", "interaction-run-read",',
                 '  "interaction-read", "interaction-list", "interaction-artifact", "interaction-compare", "interaction-local", "interaction-run-read",\n'
                 '  "coalition-read",'),
            ],
        },
        {
            "path": "finnor-os/scripts/generate-openapi.ts",
            "symbols": ["components", "InteractionOperations route expansion"],
            "callers": ["OpenAPI clients", "Generated human forms and strict request schemas"],
            "failureWithout": "Generated client/form contracts omit the new bounded data-only operations.",
            "edits": [
                ('import {InteractionOperationSchemas,InteractionOperations} from "../packages/private-equity/src/interaction-synthesis/api";',
                 'import {InteractionOperationSchemas,InteractionOperations} from "../packages/private-equity/src/interaction-synthesis/api";\n'
                 'import {CoalitionOperationSchemas,CoalitionOperations} from "../packages/private-equity/src/project-z/z2-coalitions/api";'),
                (' ...Object.entries(InteractionOperationSchemas).map(([name,schema])=>[name,applicationSchema(schema)]),',
                 ' ...Object.entries(InteractionOperationSchemas).map(([name,schema])=>[name,applicationSchema(schema)]),\n'
                 ' ...Object.entries(CoalitionOperationSchemas).map(([name,schema])=>[name,applicationSchema(schema)]),'),
                ('(paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum as string[]).push(...InteractionOperations);\nfor(const operation of InteractionOperations){',
                 '(paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum as string[]).push(...InteractionOperations,...CoalitionOperations);\n'
                 'for(const operation of [...InteractionOperations,...CoalitionOperations]){'),
            ],
        },
        {
            "path": "finnor-os/apps/api/next.config.mjs",
            "symbols": ["outputFileTracingIncludes"],
            "callers": ["Actual Next API function packaging and canonical source custody"],
            "failureWithout": "The emitted API omits Z2 process profiles or participant Work source assets.",
            "edits": [
                ('      "../../packages/private-equity/src/interaction-synthesis/profile.json",',
                 '      "../../packages/private-equity/src/interaction-synthesis/profile.json",\n'
                 '      "../../packages/epistemic-runtime/src/project-z/z2-coalitions/**/*",\n'
                 '      "../../packages/private-equity/src/project-z/z2-coalitions/**/*",\n'
                 '      "../../packages/orchestration/src/project-z/z2-coalitions/**/*",'),
                ('    if (isServer) {\n',
                 '    if (isServer) {\n'
                 '      // Keep actual emitted CJS module identity separate from canonical source custody.\n'
                 '      config.node = { ...config.node, __filename: false, __dirname: false };\n'),
                ('  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },',
                 '  experimental: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] },\n'
                 '    ...(process.env.FINNOR_Z2_BUILD_GRAPH === "1" ? { cpus: 1, webpackMemoryOptimizations: true } : {}),\n'
                 '  },'),
            ],
        },
        {
            "path": "finnor-os/Dockerfile.worker",
            "symbols": ["dependencies canonical UI source copy"],
            "callers": ["Native worker runtime owner-source pinning"],
            "failureWithout": "The worker image lacks the exact mounted interaction component pinned by Z2.",
            "edits": [
                ('COPY src/components/centropy/canvas/IdentifiedSystemPanel.tsx /app/src/components/centropy/canvas/IdentifiedSystemPanel.tsx',
                 'COPY src/components/centropy/canvas/IdentifiedSystemPanel.tsx /app/src/components/centropy/canvas/IdentifiedSystemPanel.tsx\n'
                 'COPY src/components/centropy/canvas/InteractionProtocolPanel.tsx /app/src/components/centropy/canvas/InteractionProtocolPanel.tsx'),
            ],
        },
        {
            "path": "src/components/centropy/canvas/InteractionProtocolPanel.tsx",
            "symbols": ["paths", "keyed", "InteractionProtocolPanel", "wipe", "original-model form"],
            "callers": ["Existing mounted WorldWorkRecord interaction panel"],
            "failureWithout": "The mounted owner form can only queue ordinary Y3 synthesis, not the stronger Z2 request.",
            "edits": [
                ("z.enum(['P0','P1'])", "z.enum(['P0','P1','P2','P3'])", 2),
                ("const Terms=z.object({ref:Ref,id:z.string().uuid(),revision:z.number().int(),validUntil:z.string()}).passthrough()",
                 "const CoalitionTerms=z.object({schema:z.literal('finnor.project-z.z2.terms-contract.v1'),certificateRef:Ref,\n"
                 " incentiveConcept:z.string(),coalitionLimit:z.string(),excludedThreatClasses:z.array(z.string()),\n"
                 " actualCompliance:z.literal('UNKNOWN'),privateProofDataIncluded:z.literal(false),protectedAdmission:z.literal(false),\n"
                 " productionActivated:z.literal(false),executionAuthorityGranted:z.literal(false)}).passthrough()\n"
                 "const Terms=z.object({ref:Ref,id:z.string().uuid(),revision:z.number().int(),validUntil:z.string(),\n"
                 " coalition:CoalitionTerms.optional()}).passthrough()"),
                ("const paths={\n submit:'interaction-submit',",
                 "const paths={\n coalitionSubmit:'coalition-submit',submit:'interaction-submit',"),
                (" terms:Terms.nullable(),consents:z.array(z.unknown()),runs:",
                 " terms:Terms.nullable(),participantWork:z.object({workId:z.string().uuid(),workInputId:z.string().uuid(),\n"
                 "  originalWorkId:z.string().uuid(),originalEpisodeId:z.string().uuid(),termsRef:Ref,participant:z.string(),\n"
                 "  originalBudgetOnly:z.literal(true),actualCompliance:z.literal('UNKNOWN'),executionAuthorityGranted:z.literal(false)}).nullable().optional(),\n"
                 " participantWorkStatus:z.string().optional(),consents:z.array(z.unknown()),runs:"),
                ("const keyed=new Set<Operation>(['submit','terms',",
                 "const keyed=new Set<Operation>(['submit','coalitionSubmit','terms',"),
                ("  [online,setOnline]=useState(true)",
                 "  [online,setOnline]=useState(true),[coalitionRequired,setCoalitionRequired]=useState(false)"),
                ("setSpecification('');setReservation('');setObservation('')}",
                 "setSpecification('');setReservation('');setObservation('');setCoalitionRequired(false)}"),
                ("<form onSubmit={e=>jsonForm(e,'submit',specification,",
                 "<form onSubmit={e=>jsonForm(e,coalitionRequired?'coalitionSubmit':'submit',specification,"),
                ("    <label>Original problem, fixed Y1 lowering and canonical source bindings JSON<textarea",
                 "    <label><input type=\"checkbox\" checked={coalitionRequired} disabled={busy||!!pending.current}\n"
                 "     onChange={e=>setCoalitionRequired(e.target.checked)}/>Require ex-ante correlated coalition checks</label>\n"
                 "    {coalitionRequired?<p>Development request for two to four participants. Checks cover ex-ante correlated joint local contingent deviations in every supplied model. No interim coalition-proof, later-formation, MASE or Abraham guarantee. Actual compliance is unknown.</p>:null}\n"
                 "    <label>Original problem, fixed Y1 lowering and canonical source bindings JSON<textarea"),
                ("disabled={busy}>Queue dynamic synthesis</button>",
                 "disabled={busy}>{coalitionRequired?'Queue coalition-resilient synthesis':'Queue dynamic synthesis'}</button>"),
                ("  {enabled&&shown?<><p>{shown.local.participant}",
                 "  {enabled&&shown?<>\n"
                 "   {shown.local.participantWorkStatus?<section aria-label=\"Your canonical participant Work\">\n"
                 "    <h5>Your canonical participant Work</h5><p>{shown.local.participantWorkStatus}</p>\n"
                 "    {shown.local.participantWork?<><p>Work {shown.local.participantWork.workId}. Original episode {shown.local.participantWork.originalEpisodeId}.</p>\n"
                 "     <p>Uses only the original budget and exact terms. No new reservation or effect authority. Actual compliance: UNKNOWN.</p></>:null}\n"
                 "   </section>:null}\n"
                 "   <p>{shown.local.participant}"),
                ("   {terms&&shown.local.current?<><details open><summary>Exact current terms, no effect authority</summary>",
                 "   {terms?.coalition&&shown.local.current?<section aria-label=\"Coalition incentive contract\">\n"
                 "    <h5>Exact coalition incentive contract</h5><p>Ex-ante correlated joint local contingent deviations, all nonempty coalitions through the original participant count.</p>\n"
                 "    <p>Concept: {terms.coalition.incentiveConcept}. Scope: {terms.coalition.coalitionLimit}.</p>\n"
                 "    <p>Excluded: {terms.coalition.excludedThreatClasses.join(', ')}. Actual compliance: UNKNOWN.</p>\n"
                 "    <p>Certificate {terms.coalition.certificateRef.contentDigest}. No private proof data, protected admission or effect authority.</p>\n"
                 "   </section>:null}\n"
                 "   {terms&&shown.local.current?<><details open><summary>Exact current terms, no effect authority</summary>"),
            ],
        },
    ]
    wiring.append({
        "path": "scripts/centropy/audit-capability-coverage.mjs",
        "symbols": ["sourceBaseCommit", "executedProofIndex"],
        "callers": ["Existing canonical coverage generation and --check during isolated whole-owner rebuild"],
        "failureWithout": "An isolated source rebuild borrows parent Git and reads unrelated raw historical owner proofs.",
        "edits": [
            ('import { readCanonicalPlanner } from "./canonical-planner.mjs"',
             'import { readCanonicalPlanner } from "./canonical-planner.mjs"\n'
             'import { readIsolatedCoverageSourceMetadata } from "../../finnor-os/scripts/project-z/z2/coverage-source-metadata.mjs"'),
            ('const root = resolve(import.meta.dirname, "../..")',
             'const root = resolve(import.meta.dirname, "../..")\nconst isolatedSourceMetadata = readIsolatedCoverageSourceMetadata(root)'),
            ('const proofFiles = walk("docs/centropy/evidence")',
             'const proofFiles = isolatedSourceMetadata ? isolatedSourceMetadata.executedProofIndex : walk("docs/centropy/evidence")'),
            ('sourceBaseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()',
             'sourceBaseCommit: isolatedSourceMetadata?.sourceBaseCommit ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()'),
            ('executedProofIndex: proofFiles, limitations:',
             'executedProofIndex: proofFiles, executedProofIndexMode: isolatedSourceMetadata ? "DECLARED_BASELINE_INDEX_NOT_REOBSERVED" : "CURRENT_FILES_READ", '
             'sourceBuildProvenance: isolatedSourceMetadata ? {metadataSha256:isolatedSourceMetadata.sha256,baselineCoverageSha256:isolatedSourceMetadata.baselineCoverageSha256,'
             'baselineIndexSourceCommit:isolatedSourceMetadata.baselineIndexSourceCommit,nativeOwnerExecuted:false,protectedAdmission:false} : null, limitations:'),
        ],
    })
    for spec in wiring:
        if spec["path"] == OWNER+"interaction-synthesis/continuation.ts":
            _arity.extend_continuation(spec)
    return wiring + _arity.specifications()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--evidence-dir", required=True)
    parser.add_argument("--supersedes", help="Prior packet directory whose identical shared patch this refreshes")
    args = parser.parse_args()
    repo, out = Path(args.repo), Path(args.evidence_dir)
    if not repo.is_absolute() or not out.is_absolute():
        raise ValueError("Absolute repository and evidence paths required")
    repo, out = repo.resolve(), out.resolve()
    out.relative_to(repo/"scope-z/phase-evidence/z2")
    rendered, files = [], []
    for spec in specifications():
        path = repo/spec["path"]
        before = path.read_text()
        after = before
        for edit in spec["edits"]:
            old, new, count = (*edit, 1) if len(edit) == 2 else edit
            if after.count(old) != count:
                raise ValueError("Exact preimage count mismatch: "+spec["path"]+" : "+repr(old)+
                                 " expected "+str(count)+" actual "+str(after.count(old)))
            after = after.replace(old, new, count)
        rendered.extend(difflib.unified_diff(before.splitlines(True), after.splitlines(True),
            fromfile="a/"+spec["path"], tofile="b/"+spec["path"], n=3))
        files.append({k:v for k,v in spec.items() if k != "edits"} |
            {"preimageSha256":sha(before.encode()),"proposedPostimageSha256":sha(after.encode())})
    patch = "".join(rendered).encode()
    owned = {}
    for prefix in [
        "finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions",
        "finnor-os/packages/private-equity/src/project-z/z2-coalitions",
        "finnor-os/packages/orchestration/src/project-z/z2-coalitions",
        "finnor-os/scripts/project-z/z2",
    ]:
        directory = repo/prefix
        if directory.exists():
            owned.update({str(p.relative_to(repo)):sha(p.read_bytes()) for p in sorted(directory.iterdir())
                          if p.is_file() and p.suffix in (".ts",".py",".mjs",".json",".md")})
    generated = [
        "finnor-os/openapi.json", "src/lib/centropy/openapi-types.ts", "src/lib/jarvis/openapi-types.ts",
        "src/lib/centropy/capability-manifest.generated.json", "src/lib/centropy/human-forms.generated.json",
        "docs/centropy/capability-coverage.json",
    ]
    manifest = {
        "schema":"finnor.project-z.z2.coordinator-wiring-request.v1",
        "requestId":"Z2_NATIVE_OWNER_WIRING_06_ISOLATED_SOURCE_PROVENANCE","from":"Z2","to":"coordinator",
        "status":"REQUESTED_NOT_APPLIED","sourceBase":BASE,"productLockDigest":PRODUCT_LOCK,
        "executionPackDigest":EXECUTION_PACK,"patchSha256":sha(patch),"files":files,
        "ownedSourceSha256":owned,
        "generatedOutputPreimages":{p:sha((repo/p).read_bytes()) for p in generated},
        **({"supersedesPacket":args.supersedes,"supersedeScope":"OWNED_SOURCE_PINS_ONLY_SHARED_PATCH_BYTE_IDENTICAL"} if args.supersedes else {}),
        "regeneration":"Coordinator-only writers after serialized source integration; no generated output was edited here",
        "newMigrations":[],"newResourceAdmissionEffectLedgers":[],
        "compatibility":"Unmarked jobs and ordinary native requests keep their Y3 path. The native exact finite domain extends to two through four participants without changing the continuation/common-tremble algorithms. Marked rows fail closed at original currentness, admission, terms and effect boundaries. Existing exact terms/consents remain immutable.",
        "importCycleAvoidance":"The native owner imports guard.ts, not Z2 store.ts. guard.ts imports no native store, continuation or worker implementation.",
        "packaging":"Ship both full Z2 leaf directories and native asset closure, not only emitted JavaScript. Set and record the four FINNOR_Z2/FINNOR_Y3 asset-root variables to actual installed paths; preserve source and executing-module pins separately. No production activation requested.",
        "guideReceipt":"scope-z/phase-evidence/z2/next-guides/receipt.json",
        "finiteChecksRequired":[
            "Verify every preimage, git apply --check, then coordinator review before any shared write",
            "Regenerate OpenAPI, clients, capability manifest, human forms and coverage; run existing corresponding --check commands",
            "Bounded native/API/worker/frontend type/build checks with actual exit receipts",
            "Real authenticated same-Work useful positive through queue, claim fence, both checkers, artifact, admission, terms and participant-local UI reload",
            "Native unmarked-job regression and marked missing/forged/stale certificate rejection through legacy API, admission, local run and Y1 effect callers",
            "Exact terms coalition scope substitution/omission rejection and both original terms/effect consents without private proof leakage",
            "Compatible checked coalition fallback on the same original problem/episode and rejection of unilateral-only or changed-economics fallback",
            "Physical owned worker kills at durable claim, checkpoint/artifact and partial consent with original IDs, attempts, deadline, fences, resources and UNKNOWN retained",
            "Separately installed whole-owner reconstruction and repeated mounted authenticated use, not process-library entrypoints",
        ],
        "remaining":"Shared integration is REQUESTED_NOT_APPLIED. Consult the current-source-bound structural, graph, installed and native replay receipts separately. Authenticated native recovery/mounted execution and protected qualification are not implied by source or build validation. This packet is not a controller PASS.",
    }
    out.mkdir(parents=True, exist_ok=False)
    (out/"coordinator.patch").write_bytes(patch)
    (out/"request.json").write_text(json.dumps(manifest,indent=2)+"\n")
    print(json.dumps({"requestId":manifest["requestId"],"status":manifest["status"],
        "files":len(files),"patchSha256":manifest["patchSha256"],"evidence":str(out)}))


if __name__ == "__main__":
    main()
