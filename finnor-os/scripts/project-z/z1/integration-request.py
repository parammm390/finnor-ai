"""Emit exact shared-file requests. Never applies them to a worktree.

The coordinator owns integration, migration names, collisions and activation.
Reconstruction may apply these verified bytes only in a new validation copy.
"""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[4]
GENERATED = (
    "finnor-os/openapi.json",
    "src/lib/centropy/capability-manifest.generated.json",
    "src/lib/centropy/openapi-types.ts",
    "src/lib/jarvis/openapi-types.ts",
    "src/lib/centropy/human-forms.generated.json",
    "docs/centropy/capability-coverage.json",
    "finnor-os/packages/private-equity/src/enterprise-applications/source-manifest.generated.ts",
    "finnor-os/packages/private-equity/src/policy-learning/source-manifest.generated.ts",
    "finnor-os/packages/private-equity/src/system-identification/source-manifest.generated.ts",
    "finnor-os/packages/private-equity/src/system-identification/core-child.generated.mjs",
    "finnor-os/packages/epistemic-runtime/src/strategic-response/source-manifest.generated.ts",
    "next-env.d.ts",
    "finnor-os/apps/api/next-env.d.ts",
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=True) + "\n").encode()


def replace(source, old, new, count=1):
    if source.count(old) != count:
        raise ValueError("SHARED_PREIMAGE_ANCHOR_CHANGED:" + old[:100])
    return source.replace(old, new)


def requested_files(root):
    result = {}

    def edit(path, fn, reason):
        original = (root / path).read_text()
        result[path] = (original.encode(), fn(original).encode(), reason)

    def api(source):
        source = "import { SharedWorkOperations, readSharedWorkBody, handleSharedWorkOperation, sharedWorkResponseError } from '@finnor/private-equity/src/project-z/z1-shared-work/api';\n" + source
        return replace(source, "  try {const route=await params;\n", """  try {const route=await params;
    if(SharedWorkOperations.some(operation=>operation===route.operation)){
      try{
        const auth=await requireContext(req),body=await readSharedWorkBody(req);
        const result=await handleSharedWorkOperation({auth},route.operation,body);
        return response(result.body,result.status);
      }catch(error){const mapped=sharedWorkResponseError(error);return mapped?response(mapped.body,mapped.status):requestError(error);}
    }
""")
    edit("finnor-os/apps/api/app/api/company-brain/[operation]/route.ts", api,
         "Existing authenticated company-brain delegate, authentication before bounded JSON body.")

    def worker(source):
        source = "import { createSharedWorkJobHandler, createSharedWorkProjectionJobHandler } from '../../../packages/orchestration/src/project-z/z1-shared-work/worker';\n" + source
        return replace(source, "  const queue = new JobQueue();\n", """  const queue = new JobQueue();
  queue.register('run_shared_work_program_v1',createSharedWorkJobHandler(),PRODUCTION_JOB_CONTRACTS.run_shared_work_program_v1);
  queue.register('consume_shared_work_projection_v1',createSharedWorkProjectionJobHandler(),PRODUCTION_JOB_CONTRACTS.consume_shared_work_projection_v1);
""")
    edit("finnor-os/apps/worker/src/index.ts", worker, "Two concrete canonical handlers; coordinator serializes registry collisions with Z2.")
    edit("finnor-os/packages/db/compute-contract.ts", lambda source: replace(source,
         "export const PRODUCTION_JOB_CONTRACTS = {\n", """export const PRODUCTION_JOB_CONTRACTS = {
  run_shared_work_program_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "Z1 exact shared programme with independent original-Work checking; conserved original S5 parents, no effects or protected authority.", {leaseRecovery:"immediate_after_expiry"}),
  consume_shared_work_projection_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "Z1 admitted original S3/S4 use, transactional native acknowledgement and costs; no executable handoff.", {leaseRecovery:"immediate_after_expiry"}),
"""), "Trusted fixed INTERACTIVE classification and fenced idempotent expired-lease recovery.")

    def allocation(source):
        source = replace(source, "AND p.demand IS NULL ORDER BY s.reservation_id LIMIT 257",
                         "AND p.demand IS NULL AND p.problem->>\\'schema\\' IS DISTINCT FROM \\'finnor.s5.z1-original-work-problem.v1\\' ORDER BY s.reservation_id LIMIT 257")
        return replace(source, "  if(outstanding.length>256)throw new AllocationContractError", """  const shared=(await c.query('SELECT * FROM finnor_os.z1_s5_outstanding()')).rows;
  if(shared.length>256)throw new AllocationContractError('LIMIT_EXCEEDED','S5 shared occupation bound exceeded');
  for(const row of shared)outstanding.push({reservationRef:row.reservation_ref,
    certificateRef:row.certificate_ref,envelopes:row.envelopes,status:row.status,policyRefs:[],effectRefs:[]});
  if(outstanding.length>256)throw new AllocationContractError""")
    edit("finnor-os/packages/private-equity/src/allocation-store.ts", allocation,
         "Include opaque complete cross-principal Z1 occupation exactly once in the canonical S5 snapshot. Requires schema in same integration.")

    def mount(source):
        source = replace(source, 'import { usePrivateRequestScope } from "../lib/use-private-request-scope"\n',
                         'import { usePrivateRequestScope } from "../lib/use-private-request-scope"\nimport { SharedWorkPanel } from "../../../../finnor-os/packages/private-equity/src/project-z/z1-shared-work/work-panel"\n')
        return replace(source, "      <ClosingProgrammePanel key={workId}", """      {root?.entityType === "pe_deal" ? <SharedWorkPanel key={`z1:${scope.key}`} root={{entityType:"pe_deal",entityId:root.entityId}} workId={workId} /> : null}
      <ClosingProgrammePanel key={workId}""")
    edit("src/components/centropy/world/WorldWorkRecord.tsx", mount, "Mount on the existing authenticated, scoped original Work record, pe_deal only.")

    def manifest(source):
        source = replace(source, "const delegatedRegistries = [\n",
                         'const delegatedRegistries = [\n  ["SharedWorkOperations", "project-z/z1-shared-work/api.ts"],\n')
        source = replace(source, "const companyBrainReads = new Set([",
                         'const companyBrainReads = new Set([\n  "z1-read-shared-work", "z1-project-original-work",')
        source = replace(source, "const operationClasses = new Map()\n",
                         'const operationClasses = new Map()\noperationClasses.set("company-brain/z1-cancel-shared-work", "CONTROL")\n')
        source = replace(source, "const humanOnlyPatterns = [\n",
                         'const humanOnlyPatterns = [\n  /^company-brain\\/z1-admit-shared-work$/,\n')
        return replace(source, '      path.startsWith("company-brain/response-")?',
                       '      path.startsWith("company-brain/z1-")?["work","company-brain","authority","source"]:\n      path.startsWith("company-brain/response-")?')
    edit("scripts/centropy/generate-capability-manifest.mjs", manifest,
         "Derive the six actual operations, exact READ/CONTROL classes, ordinary human admission and existing invalidation tags.")

    def openapi(source):
        source = """import { SharedWorkOperations, SharedWorkOperationSchemas } from "../packages/private-equity/src/project-z/z1-shared-work/api";
import { ExpressionSchema as SharedWorkExpressionSchema, PredicateSchema as SharedWorkPredicateSchema } from "../packages/epistemic-runtime/src/project-z/z1-shared-work/contracts";
""" + source
        source = replace(source,
            'override:def=>def===ApplicationExpressionSchema._def?{$ref:"#/components/schemas/X3Expression"}:ignoreOverride',
            'override:def=>def===ApplicationExpressionSchema._def?{$ref:"#/components/schemas/X3Expression"}:\n   def===SharedWorkExpressionSchema._def?{$ref:"#/components/schemas/Z1Expression"}:\n   def===SharedWorkPredicateSchema._def?{$ref:"#/components/schemas/Z1Predicate"}:ignoreOverride')
        source = replace(source, 'const applicationComponents={schemas:Object.fromEntries([\n',
                         'const applicationComponents={schemas:Object.fromEntries([\n ...Object.entries(SharedWorkOperationSchemas).map(([name,schema])=>[name,applicationSchema(schema)]),\n ["Z1Expression",applicationSchema((SharedWorkExpressionSchema._def as z.ZodLazyDef).getter())],\n ["Z1Predicate",applicationSchema((SharedWorkPredicateSchema._def as z.ZodLazyDef).getter())],\n')
        return replace(source, 'paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum.push(...APPLICATION_OPERATIONS);',
            """(paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum as string[]).push(...SharedWorkOperations);
for(const operation of SharedWorkOperations){
 Object.assign(paths,{["/api/company-brain/"+operation]:{post:{
  security:secured,requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/"+operation}}}},
  responses:{
   "200":{description:"Current scoped original Work result, exact shared request, ordinary checked-derivation admission, retained costs or cancellation. Never business completion or effects."},
   "400":{description:"Strict finite typed data-only request required."},"401":{description:"Current signed bearer required before reading the body."},
   "403":{description:"Current original owner authority or explicit disposable profile unavailable."},
   "409":{description:"Original identity, currentness, generation or idempotency conflict."},
   "413":{description:"Bounded body exceeded."},"422":{description:"Exact original budget, independent checking or native prerequisite unavailable."}
  }
 }}});
}
paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum.push(...APPLICATION_OPERATIONS);""")
    edit("finnor-os/scripts/generate-openapi.ts", openapi,
         "Generate exact six-operation schemas and named recursive typed expressions/predicates, not nested any.")

    def proxy(source):
        return replace(source, """      const body = await req.text();
      if (body.length > 2_000_000) return proxyError("Request body too large", 413);""", """      let body: string;
      if (segments.length === 2 && segments[0] === "company-brain" && [
        "z1-reserve-original-budget","z1-submit-shared-work","z1-read-shared-work",
        "z1-admit-shared-work","z1-project-original-work","z1-cancel-shared-work",
      ].includes(segments[1]!)) {
        const maximum = 134217728, reader = req.body?.getReader();
        if (!reader) return proxyError("JSON request body required", 400);
        const chunks: Uint8Array[] = []; let bytes = 0;
        const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 5000);
        const expired = new Promise<never>((_resolve,reject) => deadline.signal.addEventListener("abort",() => {
          void reader.cancel().catch(() => undefined); reject(new Error("Z1 body deadline"));
        },{once:true}));
        try {
          for (;;) {
            const chunk = await Promise.race([reader.read(),expired]); if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maximum) return proxyError("Request body too large", 413);
            chunks.push(chunk.value);
          }
          body = new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks));
        } catch { return proxyError("Bounded JSON body unavailable", 400); }
        finally { clearTimeout(timer); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      } else {
        body = await req.text();
        if (body.length > 2_000_000) return proxyError("Request body too large", 413);
      }""")
    edit("src/app/api/centropy/[...path]/route.ts", proxy,
         "Preserve the locked 128 MiB bounded signed-change intake through the existing authenticated proxy. Other routes retain their existing cap.")

    def root_config(source):
        source = replace(source, '  if (process.env.NODE_ENV !== "development") return ""',
                         '  if (process.env.NODE_ENV !== "development" && !(process.env.FINNOR_Z1_INSTALLED_DEVELOPMENT === "1" &&\n    process.env.FINNOR_ENVIRONMENT === "ordinary_disposable" && process.env.FINNOR_Z1_PROFILE === "ordinary_disposable")) return ""')
        source = replace(source, 'process.env.FINNOR_X1_FRONTEND_INSTALL === "1" ? {',
                         '(process.env.FINNOR_X1_FRONTEND_INSTALL === "1" || process.env.FINNOR_Z1_FRONTEND_INSTALL === "1") ? {', 2)
        return replace(source, 'distDir: ".next-x1-install",',
                       'distDir: process.env.FINNOR_Z1_FRONTEND_INSTALL === "1" ? ".next-z1-install" : ".next-x1-install",')
    edit("next.config.mjs", root_config, "Explicit separate installed-development standalone build, no X1 evidence reuse; compiled disposable local Auth CSP.")
    def frontend_types(source):
        value = json.loads(source)
        for path in [".next-z1-install/types/**/*.ts", ".next-z1-install/dev/types/**/*.ts"]:
            if path not in value["include"]:
                value["include"].append(path)
        return json.dumps(value, indent=2) + "\n"
    edit("tsconfig.json", frontend_types, "Include the separately installed frontend's actual generated route types.")

    def api_config(source):
        source = replace(source, 'import { dirname, relative } from "node:path";',
                         'import { dirname, relative, resolve } from "node:path";')
        source = replace(source, 'const nextConfig = {\n', """const z1TraceFiles = (() => {
  if (process.env.FINNOR_Z1_PACKAGE_BUILD !== "1") return [];
  const base = "../../packages/private-equity/src/project-z/z1-shared-work/";
  const manifest = JSON.parse(readFileSync(new URL(base+"installed-source-files.json",import.meta.url),"utf8"));
  if (manifest.schema !== "finnor.z1.native-source-files.v1" || !Array.isArray(manifest.files) ||
      manifest.files.length < 30 || manifest.files.length > 20000) throw new Error("Z1_WHOLE_OWNER_TRACE_MANIFEST_REQUIRED");
  return [base+"installed-source.json",base+"installed-source-files.json",...manifest.files.map(file => {
    if (typeof file.path !== "string" || file.path.startsWith("/") || file.path.split("/").some(part=>part==="."||part==="..") ||
        /[\\\\%?#\\u0000-\\u001f]/.test(file.path)) throw new Error("Z1_TRACE_PATH_REQUIRED");
    // These are literal filenames, not glob patterns. In particular Next
    // catch-all and route-group names must not become character classes.
    return [...relative(fileURLToPath(new URL("./",import.meta.url)),resolve(repositoryRoot,file.path))]
      .map(character => "[]{}()*?!+@".includes(character) ? String.fromCharCode(92)+character : character).join("");
  })];
})();

const nextConfig = {
""")
        return replace(source, '      "./lib/**/*.ts",',
                       '      "./lib/**/*.ts",\n      "../../packages/**/project-z/z1-shared-work/*.tsx",\n      "../../scripts/project-z/z1/**/*",\n      ...z1TraceFiles,')
    edit("finnor-os/apps/api/next.config.mjs", api_config,
         "Trace every declared whole-owner source file and native Python/TS/SQL/stamps into the API artifact; canonical source-custody rewrites stay intact.")

    def coverage(source):
        source = replace(source, 'const root = resolve(import.meta.dirname, "../..")\n', """const root = resolve(import.meta.dirname, "../..")
// A verified reconstruction carries its source identity, not hidden Git objects.
const sourceBaseCommit = (() => {
  if (existsSync(join(root,".git"))) return execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim()
  const input=JSON.parse(readFileSync(join(root,"finnor-os/packages/private-equity/src/project-z/z1-shared-work/reconstruction-input.json"),"utf8"))
  if (input.schema!=="finnor.z1.reconstruction-input.v1" || !/^[a-f0-9]{40}$/.test(input.sourceCommit))
    throw new Error("DECLARED_RECONSTRUCTION_SOURCE_IDENTITY_REQUIRED")
  return input.sourceCommit
})()
""")
        return replace(source, 'sourceBaseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),',
                       'sourceBaseCommit,')
    edit("scripts/centropy/audit-capability-coverage.mjs", coverage,
         "Permit the existing coverage checker to consume declared reconstruction identity without a borrowed/hidden Git repository.")
    return result


def emit(root, output, generated_root=None, migration_name=None):
    if not root.is_absolute() or not output.is_absolute() or output.exists():
        raise ValueError("ABSOLUTE_SOURCE_AND_NEW_REQUEST_DIRECTORY_REQUIRED")
    changes = requested_files(root)
    generated_receipts = []
    if generated_root:
        if not generated_root.is_absolute() or generated_root == root:
            raise ValueError("SEPARATE_GENERATED_VALIDATION_COPY_REQUIRED")
        for path, (_before, after, _reason) in changes.items():
            if (generated_root / path).read_bytes() != after:
                raise ValueError("GENERATED_COPY_REQUESTED_SOURCE_MISMATCH:" + path)
        for path in GENERATED:
            before, after = (root / path).read_bytes(), (generated_root / path).read_bytes()
            generated_receipts.append({"path": path, "sha256": sha(after), "changed": before != after})
            if before != after:
                changes[path] = (before, after, "Output of the existing generator in the separately installed validation copy.")
    schema = (root / "finnor-os/scripts/project-z/z1/shared-schema.sql").read_bytes()
    if migration_name:
        if not re.fullmatch(r"[0-9]{4}[a-z]?_[a-z0-9_]+\.sql", migration_name):
            raise ValueError("EXACT_COORDINATOR_ASSIGNED_MIGRATION_FILENAME_REQUIRED")
        migration = "finnor-os/packages/db/migrations/" + migration_name
        if (root / migration).exists():
            raise ValueError("COORDINATOR_MIGRATION_FILENAME_ALREADY_EXISTS")
        # This command emits a request only. The caller, not this phase, assigns
        # the identity. The ordinary bundler must then run in the validation copy.
        changes[migration] = (None, schema, "Caller-supplied coordinator-assigned filename, never phase-allocated.")
        if generated_root:
            path = "finnor-os/packages/db/migrations-bundle.ts"
            changes[path] = ((root / path).read_bytes(), (generated_root / path).read_bytes(),
                             "Existing migration bundler output, with the exact coordinator-assigned complete filename.")
    output.mkdir(mode=0o700)
    records, diff = [], []
    for path, (before, after, reason) in sorted(changes.items()):
        destination = output / "postimages" / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(after)
        records.append({"path": path, "preimageSha256": sha(before) if before is not None else None,
                        "preimageBytes": len(before) if before is not None else None,
                        "postimageSha256": sha(after), "postimageBytes": len(after),
                        "postimage": "postimages/" + path, "reason": reason})
        diff.extend(difflib.unified_diff((before or b"").decode().splitlines(keepends=True),
                    after.decode().splitlines(keepends=True), fromfile="a/" + path if before is not None else "/dev/null",
                    tofile="b/" + path))
    patch = "".join(diff).encode()
    (output / "shared-integration.patch").write_bytes(patch)
    document = {
        "schema": "finnor.z1.integration-request.v1", "status": "REQUESTED_NOT_APPLIED_OR_ACCEPTED",
        "sourceCommit": subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip(),
        "sourceTree": subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD^{tree}"], text=True).strip(),
        "sharedPatchSha256": sha(patch), "files": records, "generatedOutputs": generated_receipts,
        "schemaProposal": {"path": "finnor-os/scripts/project-z/z1/shared-schema.sql",
                           "sha256": sha(schema), "bytes": len(schema), "assignedMigration": migration_name,
                           "state": "COORDINATOR_FILENAME_AND_BUNDLE_REQUIRED" if not migration_name else "REQUEST_ONLY_NOT_EXECUTED"},
        "activation": {"databaseInitialized": False, "sqlExecuted": False, "grantsExecuted": False,
                       "production": False, "protectedAdmission": False},
    }
    (output / "request.json").write_bytes(encoded(document))
    return document


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--generated-root", type=Path)
    parser.add_argument("--coordinator-assigned-migration")
    args = parser.parse_args()
    value = emit(args.source, args.output, args.generated_root, args.coordinator_assigned_migration)
    print(json.dumps({"status": value["status"], "files": len(value["files"]),
                      "sharedPatchSha256": value["sharedPatchSha256"],
                      "migrationState": value["schemaProposal"]["state"]}))


if __name__ == "__main__":
    main()
