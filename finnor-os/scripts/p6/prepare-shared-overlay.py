"""Create exact-C shared-boundary proposal. Does not change those source files."""
import difflib
import hashlib
import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[3]
DEST = REPO / "scope-pm/phase-12-p6-procedure-induction/handoff"
BASE = "a72b4f402cfa1bbf51e518891db2d893b9a71aca"
changes = {}


def replace(path, old, new):
    original = subprocess.check_output(["git", "-C", str(REPO), "show", f"{BASE}:{path}"]).decode()
    current = changes.get(path, original)
    if current.count(old) != 1:
        raise RuntimeError(f"Exact unique preimage required: {path}: {old[:80]}")
    changes[path] = current.replace(old, new, 1)


p = "finnor-os/packages/private-equity/src/program-synthesis/contracts.ts"
replace(p, "import { z } from 'zod';",
        "import { z } from 'zod';\nimport {ProcedureUseSchema} from '../procedure-induction/use-contracts';")
replace(p, " computeSearch:z.literal('P2_REQUIRED').optional(),",
        " procedure:ProcedureUseSchema.optional(),\n computeSearch:z.literal('P2_REQUIRED').optional(),")
p = "finnor-os/packages/private-equity/src/program-synthesis/api.ts"
replace(p, "import {z} from 'zod';",
        "import {z} from 'zod';\nimport {requireProcedureMode} from '../procedure-induction/admission';")
replace(p, " const request=parseHarnessRequest(body);await authorize",
        " const request=parseHarnessRequest(body);if(request.procedure)requireProcedureMode(request.procedure);await authorize")
p = "finnor-os/packages/private-equity/src/program-synthesis/store.ts"
replace(p, "import {resolveEconomicBindings} from './owners';",
        "import {resolveEconomicBindings} from './owners';\nimport {assertProcedureProgrammeCurrent} from '../procedure-induction/programme';")
replace(p, " if(c)await read(c);else await tx(ctx,read,true);",
        " if(c)await read(c);else await tx(ctx,read,true);\n await assertProcedureProgrammeCurrent(ctx,q,c,lock);")
p = "finnor-os/packages/private-equity/src/live-recompilation/api.ts"
replace(p, "import { randomUUID } from 'node:crypto';",
        "import { randomUUID } from 'node:crypto';\n"
        "import {assertProcedureContinuationIntake} from '../procedure-induction/continuation';")
replace(p, "    try { await assertProgramCurrent(ctx, q, c, true); }",
        "    try { await assertProcedureContinuationIntake(ctx, q, c, true); }")
p = "finnor-os/packages/private-equity/src/program-synthesis/worker.ts"
replace(p, "import {executeHarnessCandidate} from './execution';",
        "import {executeHarnessCandidate} from './execution';\nimport {tryProcedureCandidate} from '../procedure-induction/programme';")
replace(p,
        "  const adaptive=saved?null:await advanceProgramSearch(ctx,q,program,input,d);if(adaptive?.waiting)return;",
        "  const procedure=saved||!request.procedure?null:await tryProcedureCandidate(ctx,q,program,input,d,request.procedure);\n"
        "  const adaptive=saved||procedure?null:await advanceProgramSearch(ctx,q,program,input,d);if(adaptive?.waiting)return;")
replace(p, "  }else if(adaptive?.selected){",
        "  }else if(procedure){\n"
        "   selected=procedure;program.independentChecks=selected.checks;\n"
        "   program.observableBranches=await tx(ctx,c=>observeAcceptedBranches(c,request.acceptance,input,d.witnesses.map(w=>w.id)),true);\n"
        "   await durableNode(ctx,q,solveNode.id,{selectedModule:selected.moduleId,values:selected.values,checks:selected.checks,inputDigest:sha(input),sourceResultDigest:d.result!.digest,programCheckpoint:program});\n"
        "  }else if(adaptive?.selected){")
p = "finnor-os/apps/api/app/api/company-brain/[operation]/route.ts"
replace(p, "import {handleContinuationOperation,CONTINUATION_OPERATIONS} from '@finnor/private-equity/src/live-recompilation/api';",
        "import {handleContinuationOperation,CONTINUATION_OPERATIONS} from '@finnor/private-equity/src/live-recompilation/api';\n"
        "import {handleProcedureOperation,PROCEDURE_OPERATIONS} from '@finnor/private-equity/src/procedure-induction/api';")
# This exact native dispatch preserves requireContext(), rate limits and no-store.
original = subprocess.check_output(["git", "-C", str(REPO), "show", f"{BASE}:{p}"]).decode()
dispatch = next(line for line in original.splitlines() if "CONTINUATION_OPERATIONS" in line and "includes" in line)
replace(p, dispatch, dispatch + "\n    if ((PROCEDURE_OPERATIONS as readonly string[]).includes(route.operation)) { const result=await handleProcedureOperation(ctx,route.operation,body);return response(result.body,result.status); }")
p = "finnor-os/apps/worker/src/index.ts"
replace(p, "import {runProgrammeContinuationJob} from '@finnor/private-equity/src/live-recompilation/worker';",
        "import {runProgrammeContinuationJob} from '@finnor/private-equity/src/live-recompilation/worker';\n"
        "import {runProcedureInductionJob} from '@finnor/private-equity/src/procedure-induction/worker';")
replace(p, "  const queue = new JobQueue();",
        "  const queue = new JobQueue();\n"
        "  queue.register('run_procedure_induction_v1',runProcedureInductionJob,PRODUCTION_JOB_CONTRACTS.run_procedure_induction_v1);")
p = "finnor-os/packages/db/compute-contract.ts"
replace(p, "export const PRODUCTION_JOB_CONTRACTS = {",
        'export const PRODUCTION_JOB_CONTRACTS = {\n'
        '  run_procedure_induction_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "P6 ordinary structural induction, no custody/admission grant."),')
p = "src/components/centropy/canvas/ProgramSynthesisPanel.tsx"
replace(p, "import {ContinuationPanel} from './ContinuationPanel'",
        "import {ContinuationPanel} from './ContinuationPanel'\nimport {ProcedureInductionPanel} from './ProcedureInductionPanel'")
replace(p, " const pinned=search.get('programId')",
        " const [procedure,setProcedure]=useState<{identity:string;id:string}|null>(null)\n"
        " const chooseProcedure=useCallback((id:string|null)=>{setProcedure(id?{identity,id}:null);if(id)setMode('ordinary_disposable')},[identity])\n"
        " const selectedProcedure=procedure?.identity===identity?procedure.id:null\n"
        " const pinned=search.get('programId')")
replace(p, "validAt,mode,proposalSource,idempotencyKey:crypto.randomUUID()",
        "validAt,mode,proposalSource,...(selectedProcedure?{procedure:{capsuleId:selectedProcedure,mode}}:{}),idempotencyKey:crypto.randomUUID()")
replace(p, " {workId?<ContinuationPanel",
        " <ProcedureInductionPanel root={root} workId={workId} threadId={threadId} onSelect={chooseProcedure}/>\n"
        " {selectedProcedure?<p data-selected-procedure={selectedProcedure}>Selected disposable procedure {selectedProcedure}. Currentness, applicability and the original grant are checked on execution. Protected use remains unavailable.</p>:null}\n"
        " {workId?<ContinuationPanel")
p = "finnor-os/scripts/generate-openapi.ts"
replace(p, 'import { CONTINUATION_OPERATIONS } from "../packages/private-equity/src/live-recompilation/api";',
        'import { CONTINUATION_OPERATIONS } from "../packages/private-equity/src/live-recompilation/api";\n'
        'import { PROCEDURE_OPERATIONS, PROCEDURE_OPERATION_SCHEMAS } from "../packages/private-equity/src/procedure-induction/api";')
replace(p, "...M1_OPERATIONS, ...CONTINUATION_OPERATIONS, ...DELIBERATION_OPERATIONS",
        "...M1_OPERATIONS, ...CONTINUATION_OPERATIONS, ...PROCEDURE_OPERATIONS, ...DELIBERATION_OPERATIONS")
replace(p, "for (const operation of DELIBERATION_OPERATIONS) {",
        'for (const operation of PROCEDURE_OPERATIONS) {\n'
        '  Object.assign(paths, { ["/api/company-brain/" + operation]: { post: {\n'
        '    security: secured, requestBody: json(PROCEDURE_OPERATION_SCHEMAS[operation]), responses: {\n'
        '      "200": { description: "Authorized ordinary procedure preimage or lifecycle receipt; no admission" },\n'
        '      "202": { description: "Bounded ordinary induction accepted on original Work" },\n'
        '      "400": { description: "Strict bounded procedure schema rejected" },\n'
        '      "404": { description: "Absent or unauthorized principal-scoped procedure resource" },\n'
        '      "422": { description: "Rights, currentness, grant or unsupported protected-port predicate unpassed" },\n'
        '    },\n'
        '  } } });\n'
        '}\n\nfor (const operation of DELIBERATION_OPERATIONS) {')
p = "scripts/centropy/generate-capability-manifest.mjs"
replace(p, '  ["CONTINUATION_OPERATIONS", "live-recompilation/api.ts"],',
        '  ["CONTINUATION_OPERATIONS", "live-recompilation/api.ts"],\n'
        '  ["PROCEDURE_OPERATIONS", "procedure-induction/api.ts"],')
replace(p, '  "continuation-read", "continuation-projection",',
        '  "continuation-read", "continuation-projection",\n'
        '  "procedure-experience", "procedure-induction-read", "procedure-read", "procedure-component", "procedure-projection", "procedure-admission-request", "procedure-interface", "procedure-costs",')
replace(p, "const control = controls.test(path) || ",
        'const control = controls.test(path) || path === "company-brain/procedure-induction-cancel" || ')
p = "finnor-os/packages/private-equity/src/index.ts"
original = subprocess.check_output(["git", "-C", str(REPO), "show", f"{BASE}:{p}"]).decode()
replace(p, original, original + "\n// Ordinary P6 consumer port. Admission remains S8-owned and unavailable here.\n"
        "export {PROCEDURE_OPERATIONS,PROCEDURE_OPERATION_SCHEMAS,submitProcedureInduction,handleProcedureOperation} from './procedure-induction/api';\n"
        "export type {ProcedureCapsule,EpisodeCut} from './procedure-induction/contracts';\n")

DEST.mkdir(parents=True, exist_ok=True)
patches = []
manifest = []
for path, changed in sorted(changes.items()):
    original = subprocess.check_output(["git", "-C", str(REPO), "show", f"{BASE}:{path}"]).decode()
    patches.append(f"diff --git a/{path} b/{path}\n")
    patches.extend(difflib.unified_diff(original.splitlines(keepends=True),
                                      changed.splitlines(keepends=True),
                                      fromfile="a/" + path, tofile="b/" + path))
    manifest.append({"path": path, "preimage": hashlib.sha256(original.encode()).hexdigest(),
                     "proposed": hashlib.sha256(changed.encode()).hexdigest()})
patch = "".join(patches)
(DEST / "shared-native.exact-c.patch").write_text(patch)
(DEST / "shared-native-preimages.json").write_text(json.dumps({
    "schema": "finnor.p6.shared-native-proposal.v1", "base": BASE,
    "tree": "ca56b7b91d5a449bbe3a3dd7317c73da712fd5a3",
    "patchDigest": hashlib.sha256(patch.encode()).hexdigest(), "files": manifest,
    "status": "PROPOSED_NOT_SERIAL_OWNER_ADOPTED", "publishedMigrationsChanged": False,
    "order": ["owned-p6-source", "serial-unumbered-sql-allocation",
              "shared-native.exact-c.patch", "owner-reviewed-s8-port-and-release"],
}, indent=2) + "\n")
print(json.dumps({"patch": str(DEST / "shared-native.exact-c.patch"), "files": len(changes)}))
