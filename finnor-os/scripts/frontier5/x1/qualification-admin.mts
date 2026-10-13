import { readFileSync, writeFileSync, mkdirSync, realpathSync, statSync, statfsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import { digest } from "../../../packages/capability-evolution/src/contracts";
import { validateQualificationRegistration, assessInstitutionQualification } from "../../../packages/private-equity/src/institution-qualification/administration";
import {executeReplaySlice,executeLiveObservationSlice,validateExecutionJournal,IndependentReadProjection} from './qualification-runtime.mts';
import {bindOriginalNativeWorker} from './qualification-native-administration.mts';
import {NativeWorkerControl} from './qualification-native-worker.mts';
import {installedDevelopmentRuntime} from '../../../packages/private-equity/src/institution-program/installed-runtime';
import {installedInstitutionCompilerIdentity} from '../../../packages/capability-evolution/src/institution-port';
import {closePool} from '@finnor/db';
import {collectQualificationObservation} from './qualification-observation-collection.mts';

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const args = process.argv.slice(2), command = args[0];
const value = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
if (!["plan", "launch", "observe", "resume", "assess",'replay','live','native-control','collect'].includes(command ?? ""))
  throw Error("USE_REGISTERED_PLAN_LAUNCH_OBSERVE_RESUME_ASSESS_REPLAY_LIVE_NATIVE_CONTROL_COMMAND");
const controlPath = value("--control"), destination = value("--evidence"), trustedHash = value("--trust-sha256");
if (!controlPath || !isAbsolute(controlPath) || !destination || !isAbsolute(destination)
    || !/^[a-f0-9]{64}$/.test(trustedHash ?? "")) throw Error("PINNED_ABSOLUTE_CONTROL_EVIDENCE_AND_OWNER_TRUST_HASH_REQUIRED");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const read = (path: string, limit = 64 * 1024 * 1024) => {
  if (!isAbsolute(path) || statSync(path).size > limit) throw Error("QUALIFICATION_PRIVATE_INPUT_BOUND");
  return readFileSync(path);
};
const pin = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const Control = z.object({ schema: z.literal("finnor.x1.qualification-control.v1"),
  registration: pin, trustPolicy: pin, publicInputs: pin,
  oracleLedgers: z.array(pin).length(10), observationPackets: z.array(pin).max(10000),
  lifecycleCostPacket: pin.optional(), privateEvidenceRoot: z.string(),
  deliveryReceipts: z.array(pin).max(1280).optional(),
  executionJournal:pin.optional(),independentReadProjections:pin.optional(),
  executionEvidenceRoot:z.string().optional(),executionCursorPath:z.string().optional(),
}).strict();
const controlBytes = read(controlPath, 1024 * 1024), control = Control.parse(JSON.parse(controlBytes.toString("utf8")));
if (control.trustPolicy.sha256 !== trustedHash) throw Error("INDEPENDENT_OWNER_TRUST_POLICY_PIN_CHANGED");
const pinned = (p: z.infer<typeof pin>) => {
  const bytes = read(p.path); if (sha(bytes) !== p.sha256) throw Error("QUALIFICATION_INPUT_PREIMAGE_CHANGED");
  return JSON.parse(bytes.toString("utf8"));
};
const profile = JSON.parse(readFileSync(join(repo, "scope-frontier5/x1-institutional-programme-compiler/profile.json"), "utf8"));
const registration = pinned(control.registration), policy = pinned(control.trustPolicy);
const registered = validateQualificationRegistration({ protocol: registration, trustPolicy: policy, profile });
const root = realpathSync(control.privateEvidenceRoot);
if (!destination.startsWith(root + "/")) throw Error("PRIVATE_QUALIFICATION_EVIDENCE_DESTINATION_REQUIRED");
mkdirSync(destination, { mode: 0o700 });
const out = realpathSync(destination);
if (!out.startsWith(root + "/")) throw Error("PRIVATE_EVIDENCE_REALPATH_ESCAPED");
let outputBytes = 0;
const save = (name: string, body: unknown) => {
  const bytes = Buffer.from(JSON.stringify(body, null, 2) + "\n"); outputBytes += bytes.length;
  if (outputBytes > 64 * 1024 * 1024) throw Error("ORIGINAL_QUALIFICATION_OUTPUT_BOUND_EXHAUSTED");
  writeFileSync(join(out, name), bytes, { flag: "wx", mode: 0o600 });
};
const profileDigest = digest(profile), started = performance.now();
save("freeze.json", { schema: "finnor.x1.qualification-command-freeze.v1", command,
  at: new Date().toISOString(), controlSha256: sha(controlBytes), profileDigest,
  protocolDigest: registered.protocolDigest, custodyPolicyDigest: registered.custodyPolicyDigest,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repo, encoding: "utf8" }).trim(),
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  authority: "EXISTING_OWNER_SUPPLIED_POLICY_NO_NEW_KEYS_GRANTS_OR_QUALIFICATION_RECEIPTS" });
if(['launch','observe','resume','replay','live','native-control','collect'].includes(command??'')){
  const limits=JSON.parse(readFileSync(join(repo,'scope-frontier5/x1-institutional-programme-compiler/verification-plan.json'),'utf8')).limits;
  const disk=statfsSync(repo,{bigint:true});
  if(disk.bavail*disk.bsize<BigInt(limits.liveMinimumFreeBytes))throw Error('X1_FROZEN_LIVE_CAPACITY_REFUSED');
}

if(command==='collect'){
  if(!control.independentReadProjections||!control.executionEvidenceRoot||!control.executionCursorPath)
    throw Error('ORIGINAL_PINNED_NATIVE_OWNER_SELECTORS_AND_CURSOR_REQUIRED');
  const executionRoot=realpathSync(control.executionEvidenceRoot);
  if(!executionRoot.startsWith(root+'/')||!control.executionCursorPath.startsWith(executionRoot+'/'))
    throw Error('PRIVATE_ORIGINAL_OBSERVATION_CURSOR_REQUIRED');
  const envelope=registered.protocol.envelopes.validation;
  const projections=z.array(IndependentReadProjection).min(10).max(160).parse(pinned(control.independentReadProjections));
  const collection=await executeLiveObservationSlice({projections,evidenceRoot:executionRoot,cursorPath:control.executionCursorPath,
    protocolDigest:registered.protocolDigest,candidateCutDigest:digest(registered.protocol.candidateCut),
    allocationConventionDigest:registered.protocol.allocationConventionDigest,durationSeconds:Number(value('--seconds')??30),pollIntervalMs:1000,
    limits:{ref:envelope.ref,registrationDigest:digest(envelope),maxAcquisitionCalls:envelope.maxAcquisitionCalls,
      maxAggregateWallMs:envelope.maxWallSeconds*1000,maxOutputBytes:64*1024*1024}});
  const history:Array<Awaited<ReturnType<typeof import('./qualification-runtime.mts').collectIndependentOwnerRead>>>=[];
  for(const ref of collection.state.segments.flatMap(segment=>segment.receiptRefs).filter(ref=>ref.path.startsWith('live-owner-'))){
    const draft=pinned({path:join(executionRoot,ref.path),sha256:ref.sha256});history.push(draft);
  }
  outputBytes+=collection.state.resources.outputBytes;
  const result=await collectQualificationObservation({drafts:history,environmentIds:registered.protocol.environments.map(e=>e.id),
    expectedSelectorCount:projections.length,save});
  save('native-observation-execution.json',{resources:collection.state.resources,segment:collection.segment,
    originalCursorPath:control.executionCursorPath,aggregateAllowanceRetained:true,sevenElapsedDaysEstablished:false,signature:null});
  console.log(JSON.stringify({status:'NATIVE_OWNER_OBSERVATION_DRAFT_RECORDED',evidence:out,snapshotCount:result.snapshotCount,
    allSelectorsObserved:result.allSelectorsObserved,qualificationEstablished:false}));
}else if(command==='replay'||command==='live'){
  if(!control.executionEvidenceRoot||!control.executionCursorPath)throw Error('ORIGINAL_REGISTERED_EXECUTION_PATHS_REQUIRED');
  const executionRoot=realpathSync(control.executionEvidenceRoot);
  if(!executionRoot.startsWith(root+'/')||!control.executionCursorPath.startsWith(executionRoot+'/'))
    throw Error('PRIVATE_ORIGINAL_EXECUTION_CURSOR_REQUIRED');
  const envelope=registered.protocol.envelopes[command==='replay'?'replay':'soak'];
  const limits={ref:envelope.ref,registrationDigest:digest(envelope),maxAcquisitionCalls:envelope.maxAcquisitionCalls,
    maxAggregateWallMs:envelope.maxWallSeconds*1000,maxOutputBytes:64*1024*1024};
  const recoveryDigest=value('--recover-lock-sha256');
  const recovery=recoveryDigest?{expectedLockDigest:z.string().regex(/^[a-f0-9]{64}$/).parse(recoveryDigest)}:undefined;
  if(command==='replay'){
    if(!control.executionJournal)throw Error('INDEPENDENT_PINNED_EXECUTION_JOURNAL_REQUIRED');
    const rawJournal=pinned(control.executionJournal);
    const executionJournal=rawJournal.schema==='finnor.x1.qualification-execution-journal-draft.v1'
      ?{schema:'finnor.x1.qualification-execution-journal.v1',protocolDigest:registered.protocolDigest,
        candidateCutDigest:rawJournal.candidateCutDigest,allocationConventionDigest:rawJournal.allocationConventionDigest,
        environments:rawJournal.environments}:rawJournal;
    const journal=validateExecutionJournal(executionJournal,{
      protocolDigest:registered.protocolDigest,candidateCutDigest:digest(registered.protocol.candidateCut),
      allocationConventionDigest:registered.protocol.allocationConventionDigest,environments:registered.protocol.environments});
    const seconds=Number(value('--seconds')??180),maxEvents=Number(value('--max-events')??128);
    if(!Number.isInteger(seconds)||seconds<1||seconds>840)throw Error('FINITE_REPLAY_COMMAND_QUANTUM_REQUIRED');
    const result=await executeReplaySlice({journal,cursorPath:control.executionCursorPath,evidenceRoot:executionRoot,
      deadlineAt:Date.now()+seconds*1000,limits,maxEvents,...(recovery?{recovery}:{})});
    save('execution-result.json',{command,submitted:result.submitted,
      completeExpectedEventCoverage:result.completeExpectedEventCoverage,resources:result.cursor.resources,
      cursorPath:control.executionCursorPath,replicaTimeIsNotElapsedLiveTime:true,protectedQualificationEstablished:false});
  }else{
    if(!control.independentReadProjections)throw Error('REGISTERED_INDEPENDENT_OWNER_SELECTORS_REQUIRED');
    const raw=pinned(control.independentReadProjections);
    const projections=z.array(IndependentReadProjection).min(10).max(160).parse(raw);
    if(projections.some(p=>!registered.protocol.environments.some(e=>e.id===p.environmentId)))
      throw Error('REGISTERED_OBSERVER_ENVIRONMENT_CHANGED');
    const result=await executeLiveObservationSlice({projections,cursorPath:control.executionCursorPath,evidenceRoot:executionRoot,
      protocolDigest:registered.protocolDigest,candidateCutDigest:digest(registered.protocol.candidateCut),
      allocationConventionDigest:registered.protocol.allocationConventionDigest,durationSeconds:Number(value('--seconds')??30),
      pollIntervalMs:1000,limits,...(recovery?{recovery}:{})});
    save('execution-result.json',{command,segment:result.segment,resources:result.state.resources,
      cursorPath:control.executionCursorPath,sevenElapsedDaysEstablished:false,protectedQualificationEstablished:false});
  }
  console.log(JSON.stringify({status:'FINITE_AUTHENTICATED_EXECUTION_RECORDED',command,evidence:out,
    cursorPath:control.executionCursorPath,protectedQualificationEstablished:false}));
}else if (command === "assess") {
  const assessment = assessInstitutionQualification({ protocol: registration, trustPolicy: policy, profile,
    oracles: control.oracleLedgers.map(pinned), observationPackets: control.observationPackets.map(pinned),
    ...(control.lifecycleCostPacket ? { lifecycleCostPacket: pinned(control.lifecycleCostPacket) } : {}) });
  save("assessment.json", assessment);
  console.log(JSON.stringify({ disposition: assessment.disposition, registeredGatesPassed: assessment.registeredGatesPassed,
    evidence: out, s8AdmissionIssued: false, productionActive: false }));
} else {
  const Input = z.object({ environmentId: z.string().min(1), tenantId: z.string().uuid(),
    principalId: z.string().uuid(), origin: z.string().url(), tokenEnvironmentVariable: z.string().regex(/^FINNOR_X1_QUAL_TOKEN_[A-Z0-9_]+$/),
    workId: z.string().uuid(), workInputId: z.string().uuid(), grantIds: z.array(z.string().uuid()).min(1).max(16),
    idempotencyKey: z.string().min(1).max(160),
  }).strict();
  const PublicInputs = z.object({ schema: z.literal("finnor.x1.qualification-public-inputs.v1"),
    environments: z.array(z.object({ environmentId: z.string(), inputs: z.array(Input).min(1).max(128) }).strict()).length(10),
  }).strict();
  const publicInputs = PublicInputs.parse(pinned(control.publicInputs));
  if (new Set(publicInputs.environments.map(e => e.environmentId)).size !== 10)
    throw Error("X1_PUBLIC_INPUT_ENVIRONMENT_DUPLICATE");
  const all = publicInputs.environments.flatMap(environment => {
    const spec = registered.protocol.environments.find(e => e.id === environment.environmentId);
    if (!spec || digest(environment) !== spec.publicInputDigest) throw Error("X1_REGISTERED_PUBLIC_WORK_HANDLES_CHANGED");
    for (const input of environment.inputs) {
      const url = new URL(input.origin);
      if (input.environmentId !== environment.environmentId || input.principalId !== registered.protocol.candidatePrincipalId
          || url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
          || url.username || url.password || url.search || url.hash || url.pathname !== "/")
        throw Error("X1_AUTHORIZED_DISPOSABLE_LOCAL_ENDPOINT_AND_PRINCIPAL_REQUIRED");
    }
    return environment.inputs;
  });
  if (new Set(all.map(i => JSON.stringify([i.tenantId, i.workId]))).size !== all.length)
    throw Error("X1_ORIGINAL_QUALIFICATION_WORK_DUPLICATE");
  if(command==='native-control'){
    try{
      if(!control.executionEvidenceRoot||!control.executionCursorPath)throw Error('ORIGINAL_REGISTERED_NATIVE_EXECUTION_PATHS_REQUIRED');
      const executionRoot=realpathSync(control.executionEvidenceRoot);
      if(!executionRoot.startsWith(root+'/')||!control.executionCursorPath.startsWith(executionRoot+'/'))
        throw Error('PRIVATE_ORIGINAL_NATIVE_WORKER_CURSOR_REQUIRED');
      const phase=z.enum(['replay','soak']).parse(value('--phase')),envelope=registered.protocol.envelopes[phase];
      const installed=installedDevelopmentRuntime(),method=await installedInstitutionCompilerIdentity();
      const runtime=installed?{mode:'COMPILED_DEVELOPMENT' as const,digest:installed.manifestDigest}
        :{mode:'SOURCE_DEVELOPMENT' as const,digest:sha(readFileSync(join(repo,'finnor-os/scripts/frontier5/x1/physical-owner-worker.mts')))};
      const cut=installed?.manifest.source??{commit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
        tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:repo,encoding:'utf8'}).trim()};
      if(cut.commit!==registered.protocol.candidateCut.commit||cut.tree!==registered.protocol.candidateCut.tree
        ||runtime.digest!==registered.protocol.candidateCut.runtimeDigest
        ||method.ref.contentDigest!==registered.protocol.candidateCut.compilerMethodDigest
        ||sha(readFileSync(join(repo,'finnor-os/package-lock.json')))!==registered.protocol.candidateCut.dependencyLockDigest)
        throw Error('REGISTERED_ACTUAL_NATIVE_SOURCE_METHOD_LOCK_OR_RUNTIME_CHANGED');
      const registration=await bindOriginalNativeWorker({protocolDigest:registered.protocolDigest,candidateCutDigest:digest(registered.protocol.candidateCut),
        allocationConventionDigest:registered.protocol.allocationConventionDigest,runtime,phase,
        envelope:{ref:envelope.ref,registrationDigest:digest(envelope),maxNativeDeliveries:envelope.maxNativeDeliveries,
          maxAggregateWallMs:envelope.maxWallSeconds*1000,maxOutputBytes:64*1024*1024},
        owners:all.map(input=>({owner:{origin:input.origin,tenantId:input.tenantId,principalId:input.principalId,
          tokenEnvironmentVariable:input.tokenEnvironmentVariable},workId:input.workId})),
        deadlineAt:Date.now()+Math.min(180,envelope.maxWallSeconds)*1000});
      const workerControl=NativeWorkerControl.parse({schema:'finnor.x1.qualification-native-worker-control.v1',registration,
        evidenceRoot:executionRoot,cursorPath:control.executionCursorPath,durationSeconds:Number(value('--seconds')??30)});
      save('native-worker-control.json',workerControl);
      save('native-worker-launch-packet.json',{controlPath:join(out,'native-worker-control.json'),
        controlSha256:sha(readFileSync(join(out,'native-worker-control.json'))),runtime,phase,
        workerEntrypoint:installed?installed.entrypoint('worker'):join(repo,'finnor-os/scripts/frontier5/x1/physical-owner-worker.mts'),
        environmentNames:['DATABASE_URL','AUTH_DEV_BYPASS','FINNOR_P4_PROFILE','FINNOR_X1_QUAL_NATIVE_CONTROL','FINNOR_X1_QUAL_NATIVE_CONTROL_SHA256'],
        authority:'REUSE_EXISTING_RESTRICTED_WORKER_DATABASE_BINDING_AND_ORIGINAL_NATIVE_QUEUE',
        originalCursorRetained:true,admissionOrQualificationIssued:false,moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null});
      console.log(JSON.stringify({status:'PINNED_ACTUAL_NATIVE_WORKER_CONTROL_WRITTEN',evidence:out,phase,launched:false,
        originalEpisodes:registration.originalEpisodes.length,qualificationEstablished:false}));
    }finally{await closePool();}
  }else if (command === "plan") {
    save("launch-observe-resume.json", { status: "READY_FOR_OWNER_AUTHORIZED_TEST_SERVICES_NOT_RUN",
      protocolId: registered.protocol.id, environments: registered.protocol.environments.map(e => ({ id: e.id,
        sourceClasses: e.systems.map(s => s.sourceClass), oracleDigest: e.oracleDigest,
        replayJournalCommitment: e.replayJournalCommitment })),
      originalWorkHandles: all, originalEnvelopes: registered.protocol.envelopes,
      replay: "Independent replay owner advances the registered 30-day event journal against real admitted services; signed observations retain all original assignments.",
      soak: "Independent live observer retains seven actual elapsed days; record monotonic segments, outages, original grant/deadline and all costs. No accelerated replica substitution.",
      next: "Run launch once per original frozen Work; observe retrieves candidate outputs without scoring them. Resume keeps the same request only. Collect independently signed owner/provider packets, pin them in a new control and run assess.",
      missingExternalAssets: ["existing authorized service credentials", "protected inaccessible oracle custody", "independent provider/canonical observer", "actual elapsed soak", "complete lifecycle costs"],
      noProtectedQualificationOrAdmissionIssued: true });
    console.log(JSON.stringify({ status: "PLAN_WRITTEN_NOT_RUN", originalWorks: all.length, evidence: out }));
  } else {
    const limits = JSON.parse(readFileSync(join(repo, "scope-frontier5/x1-institutional-programme-compiler/verification-plan.json"), "utf8")).limits;
    const disk = statfsSync(repo, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(limits.liveMinimumFreeBytes)) throw Error("X1_FROZEN_LIVE_CAPACITY_REFUSED");
    const outcomes = [];
    const delivered = (control.deliveryReceipts ?? []).map(pinned);
    for (const [ordinal, input] of all.entries()) {
      if (performance.now() - started > limits.liveEpisodeWallSeconds * 1000) throw Error("X1_FINITE_ADMIN_COMMAND_WALL_EXHAUSTED");
      const token = process.env[input.tokenEnvironmentVariable];
      if (!token) throw Error("X1_EXISTING_TEST_SERVICE_AUTHENTICATION_REQUIRED");
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const call = async (path: string, body?: unknown) => {
        const response = await fetch(new URL(path, input.origin), { method: body === undefined ? "GET" : "POST",
          headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(20000) });
        const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
        if (!reader) throw Error("X1_AUTHENTICATED_RESPONSE_BODY_REQUIRED");
        for (;;) { const next = await reader.read(); if (next.done) break;
          bytes += next.value.byteLength; if (bytes > 6 * 1024 * 1024) { await reader.cancel(); throw Error("X1_RESPONSE_BYTE_BOUND"); }
          chunks.push(next.value); }
        return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      };
      const me = await call("/api/me");
      if (me.status !== 200 || me.body.tenantId !== input.tenantId
          || (me.body.employeeId ?? me.body.userId) !== input.principalId || me.body.role !== "owner")
        throw Error("X1_AUTHENTICATED_TEST_IDENTITY_UNPASSED");
      const operation = command === "launch" ? "institution-submit" : command === "resume" ? "institution-resume" : "institution-read";
      const receipt = delivered.find(r => digest(r.input) === digest(input)
        && r.operation === "institution-submit" && r.response?.status === 202);
      const requestId = receipt?.response?.body?.requestId;
      if (command !== "launch") {
        if (!z.string().uuid().safeParse(requestId).success) throw Error("X1_SAME_ACCEPTED_REQUEST_HANDLE_REQUIRED");
        const owner = await call("/api/company-brain/institution-read", { requestId });
        if (owner.status !== 200 || owner.body.workId !== input.workId)
          throw Error("X1_ACCEPTED_REQUEST_ORIGINAL_WORK_CHANGED");
      }
      const body = command === "launch" ? { workId: input.workId, workInputId: input.workInputId,
        grantIds: input.grantIds, idempotencyKey: input.idempotencyKey } : { requestId };
      const begin = performance.now();
      try {
        const response = await call(`/api/company-brain/${operation}`, body);
        if (response.status < 300 && response.body.workId !== undefined && response.body.workId !== input.workId)
          throw Error("X1_CANDIDATE_RETURNED_DIFFERENT_WORK");
        save(`candidate-${ordinal}.json`, { input, operation, response,
          elapsedMs: performance.now() - begin, oracleExposed: false, independentPostconditionEstablished: false });
        outcomes.push({ environmentId: input.environmentId, workId: input.workId,
          requestId: response.body.requestId ?? requestId ?? null, status: response.status,
          disposition: response.status < 300 ? "CANDIDATE_RESPONSE_ONLY" : "REFUSED", responseDigest: digest(response.body) });
      } catch (error) {
        outcomes.push({ environmentId: input.environmentId, workId: input.workId, requestId: requestId ?? null,
          disposition: "UNKNOWN_RETAIN_ORIGINAL_KEY_NO_FRESH_GRANT", predicate: String((error as Error).message) });
        save(`uncertain-${ordinal}.json`, { input, operation, originalKeyRetained: true, elapsedMs: performance.now() - begin });
      }
    }
    save("outcomes.json", { command, outcomes, elapsedMs: performance.now() - started,
      validatorCostUsd: null, validatorHumanSeconds: null, aggregatePeakMemoryBytes: null,
      qualification: "CANDIDATE_HTTP_COLLECTION_NOT_INDEPENDENT_OBSERVATION", oracleExposed: false });
    console.log(JSON.stringify({ status: "FINITE_CANDIDATE_COMMAND_RECORDED", evidence: out,
      independentPostconditionOrQualificationEstablished: false }));
  }
}
