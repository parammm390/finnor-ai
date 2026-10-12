import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const os = join(repo, "finnor-os");
const scope = join(repo, "scope-frontier5/x1-institutional-programme-compiler");
const manifest = JSON.parse(readFileSync(join(scope, "verification-plan.json"), "utf8"));
const profile = JSON.parse(readFileSync(join(scope, "profile.json"), "utf8"));
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? null : args[at + 1] ?? null;
};
const stage = option("--stage");
const only = option("--check");
const ownerCase=option('--case');
const ownerCases={owners:{'one-duty':{count:'1',mode:'api'},'128-duty':{count:'128',mode:'api'},
  heterogeneous:{count:'1',mode:'heterogeneous'},canonical:{count:'1',mode:'canonical'}},
  lifecycle:{material:{count:'1',mode:'material'},recovery:{count:'1',mode:'recovery'},
    contention:{count:'1',mode:'contention'},unsupported:{count:'1',mode:'unsupported'},
    'cancel-observed':{count:'1',mode:'cancel_observed'}},mounted:{mounted:{count:'1',mode:'mounted'}}};
const selectedOwnerCase=ownerCase?ownerCases[stage]?.[ownerCase]:null;
const named = manifest.stages.find((entry) => entry.id === stage);
if (!named || args.length%2!==0||new Set(args.filter((_,i)=>i%2===0)).size!==args.length/2
    ||args.some((arg, i) => i%2===0&&!['--stage','--check','--evidence','--case'].includes(arg))
    || (only && !["typecheck", "lint"].includes(only))||ownerCase&&!selectedOwnerCase
    ||selectedOwnerCase&&only||ownerCases[stage]&&!selectedOwnerCase) {
  console.error("Use --stage <frozen-stage> [--case <registered-owner-case>] [--check typecheck|lint] [--evidence <fresh-private-directory>]");
  process.exit(2);
}
const root = manifest.privateEvidenceRoot;
mkdirSync(root, { recursive: true, mode: 0o700 });
const privateRoot = realpathSync(root);
const destination = resolve(option("--evidence") ?? join(privateRoot, `verify-${stage}-${Date.now()}-${randomUUID()}`));
if (!destination.startsWith(privateRoot + sep) || existsSync(destination) || realpathSync(dirname(destination)) !== privateRoot) {
  console.error("Evidence must be a new direct child of the registered private evidence root");
  process.exit(2);
}
mkdirSync(destination, { mode: 0o700 });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pin = (path) => ({ path: relative(repo, path), sha256: sha(readFileSync(path)) });
const git = (...command) => {
  const result = spawnSync("git", ["-C", repo, ...command], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Git read failed: ${command.join(" ")}`);
  return result.stdout.trim();
};
const changed = git("status", "--porcelain=v1", "-uall").split("\n").filter(Boolean).map((line) => line.slice(3));
const sourcePins = changed.filter((path) => existsSync(join(repo, path))).map((path) => pin(join(repo, path)));
for (const path of [
  "finnor-os/packages/private-equity/src/institution-program/contracts.ts",
  "finnor-os/packages/private-equity/src/institution-qualification/scoring.ts",
  "finnor-os/packages/private-equity/src/institution-qualification/contracts.ts",
  "finnor-os/packages/private-equity/src/institution-qualification/administration.ts",
  "finnor-os/scripts/frontier5/x1/qualification-admin.mts",
  "finnor-os/scripts/frontier5/x1/qualification-cases.mts",
  "finnor-os/scripts/frontier5/x1/reference/qualification-contract.md",
  "finnor-os/packages/private-equity/src/institution-program/checker.ts",
  "finnor-os/packages/private-equity/src/institution-program/checker-process.ts",
  "finnor-os/packages/private-equity/src/institution-program/checker-raw.ts",
  "finnor-os/packages/private-equity/src/institution-program/source-decoder.ts",
  "finnor-os/packages/private-equity/src/institution-program/reconstruction.ts",
  "finnor-os/packages/private-equity/src/institution-program/owner-admission.ts",
  "finnor-os/packages/private-equity/src/institution-program/responsibility.ts",
  "finnor-os/packages/private-equity/src/institution-program/resource-demand.ts",
  "finnor-os/packages/private-equity/src/allocation-store.ts",
  "finnor-os/packages/db/migrations/0173_x1_institution_s5_reservations.sql",
  "finnor-os/packages/db/migration-head.ts",
  "finnor-os/scripts/frontier5/x1/responsibility-cases.mts",
  "finnor-os/scripts/frontier5/x1/responsibility-finish-cases.mts",
  "finnor-os/scripts/frontier5/x1/reference/responsibility-finish-contract.md",
  "finnor-os/packages/private-equity/src/program-synthesis/institution.ts",
  "finnor-os/packages/private-equity/src/program-synthesis/contracts.ts",
  "finnor-os/packages/private-equity/src/program-synthesis/plan.ts",
  "finnor-os/packages/private-equity/src/program-synthesis/owners.ts",
  "finnor-os/packages/private-equity/src/program-synthesis/api.ts",
  "finnor-os/packages/private-equity/src/program-synthesis/worker.ts",
  "finnor-os/packages/private-equity/src/program-synthesis/store.ts",
  "finnor-os/packages/orchestration/src/objective-loop.ts",
  "finnor-os/scripts/frontier5/x1/reference/responsibility-contract.md",
  "finnor-os/scripts/frontier5/x1/reference/responsibility-expectations.json",
  "finnor-os/packages/private-equity/src/institution-program/source-authority.ts",
  "finnor-os/packages/private-equity/src/institution-program/installed-source.ts",
  "finnor-os/packages/private-equity/src/index.ts",
  "finnor-os/packages/db/migrations/0172_x1_institution_source_authority.sql",
  "finnor-os/packages/db/migrations-bundle.ts",
  "finnor-os/packages/private-equity/package.json",
  "finnor-os/package-lock.json",
  "finnor-os/scripts/frontier5/x1/verify.mjs",
  'finnor-os/scripts/frontier5/x1/run-owner-slice.mts',
  'finnor-os/scripts/frontier5/x1/authenticated-api-fixture.mts',
  'finnor-os/scripts/frontier5/x1/physical-owner-worker.mts',
  'finnor-os/scripts/frontier5/x1/owner-source-corpus.mts',
  'finnor-os/scripts/frontier5/x1/canonical-owner-corpus.mts',
  'finnor-os/scripts/frontier5/x1/institution-method-plan.mts',
  'finnor-os/scripts/frontier5/x1/tsconfig.p1-contract.json',
  'finnor-os/packages/private-equity/src/institution-program/baseline.ts',
  'finnor-os/packages/private-equity/src/institution-program/worker.ts',
  'finnor-os/packages/private-equity/src/institution-program/store.ts',
  'finnor-os/packages/private-equity/src/institution-program/api.ts',
  'finnor-os/packages/private-equity/src/institution-program/meter.ts',
  'finnor-os/packages/capability-evolution/src/institution-consumer.ts',
  'finnor-os/packages/capability-evolution/src/institution-port.ts',
  "finnor-os/scripts/frontier5/x1/eslint.config.mjs",
  "finnor-os/scripts/frontier5/x1/tsconfig.oracle.json",
  "finnor-os/scripts/frontier5/x1/kernel.mts",
  "finnor-os/scripts/frontier5/x1/checker-command.mts",
  "finnor-os/scripts/frontier5/x1/review-cases.mts",
  "finnor-os/scripts/frontier5/x1/native-cases.mts",
  "finnor-os/scripts/frontier5/x1/native-finish-cases.mts",
  "finnor-os/scripts/frontier5/x1/creation-native-cases.mts",
  "finnor-os/scripts/frontier5/x1/transport-cases.mts",
  "finnor-os/scripts/frontier5/x1/admission-finish-cases.mts",
  "finnor-os/scripts/frontier5/x1/reference/native-finish-contract.md",
  "finnor-os/scripts/frontier5/x1/reference/admission-finish-contract.md",
  "finnor-os/scripts/frontier5/x1/reference/creation-native-contract.md",
  "finnor-os/scripts/frontier5/x1/reference/owner-currentness-contract.md",
  "finnor-os/scripts/frontier5/x1/reference/owner-live-packet.md",
  "finnor-os/scripts/frontier5/x1/protocol-cases.mts",
  "finnor-os/scripts/frontier5/x1/reconstruction-cases.mts",
  "finnor-os/scripts/frontier5/x1/reference/original-input.json",
  "finnor-os/scripts/frontier5/x1/reference/expected-ledger.json",
  "finnor-os/scripts/frontier5/x1/reference/challenges.json",
  "finnor-os/scripts/frontier5/x1/reference/base-candidate.json",
  "finnor-os/scripts/frontier5/x1/reference/native-input.json",
  "finnor-os/scripts/frontier5/x1/reference/native-expectations.json",
  "finnor-os/scripts/frontier5/x1/reference/native-contract.md",
]) if (!sourcePins.some((entry) => entry.path === path)) sourcePins.push(pin(join(repo, path)));
const free = (() => { const fs = statfsSync(repo, { bigint: true }); return fs.bavail * fs.bsize; })();
const record = {
  schema: "finnor.frontier5.x1.offline-evidence.v1", stage, check: only,
  ownerCase,selectedOwnerCase,
  startedAt: new Date().toISOString(), status: "NOT_RUN", source: {
    commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
    dirty: sourcePins, userInstructionFileUnstaged: changed.includes("AGENTS.md"),
  },
  runtime: { node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch,
    lock: pin(join(os, "package-lock.json")), profile: pin(join(scope, "profile.json")),
    oracle: pin(join(scope, "oracle-contract.md")), failureModel: pin(join(scope, "failure-model.md")),
    verificationPlan: pin(join(scope, "verification-plan.json")) },
  inputs: ["reference/original-input.json", "reference/base-candidate.json", "reference/expected-ledger.json",
    "reference/challenges.json"].map((path) => pin(join(os, "scripts/frontier5/x1", path))),
  originalFailure: "oracle-precode-3697f0c2/missing-interface.log",
  capacity: { freeBytes: free.toString(), liveMinimumFreeBytes: String(manifest.limits.liveMinimumFreeBytes),
    finalBuildMinimumFreeBytes: String(manifest.limits.finalBuildMinimumFreeBytes) },
  limits: { wallSeconds: manifest.limits.smallCheckWallSeconds, kernelHeapMiB: manifest.limits.kernelNodeHeapMiB,
    smallHeapMiB: manifest.limits.smallCheckNodeHeapMiB, outputBytes: manifest.limits.smallCheckOutputBytes },
  commands: [], pending: manifest.stages.filter((entry) => entry.live).map((entry) => entry.id),
  authority: "development-only; no protected custody or owner/effect admission",
};
const save = () => writeFileSync(join(destination, "run.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const finish = (status, exit, reason) => {
  record.status = status; record.endedAt = new Date().toISOString(); record.reason = reason;
  record.rerun = `node finnor-os/scripts/frontier5/x1/verify.mjs --stage ${stage}${ownerCase?` --case ${ownerCase}`:''}${only ? ` --check ${only}` : ""} --evidence <new-private-directory>`;
  save();
  console.log(JSON.stringify({ status, stage, reason, evidence: destination, commands: record.commands.map(({ label, exitCode }) => ({ label, exitCode })) }));
  process.exit(exit);
};
if (free < BigInt(manifest.limits.smallCheckOutputBytes + 100 * 1024 * 1024)) {
  finish("CAPACITY_REFUSED", 2, "Less than bounded small-check output plus 100 MiB free; no command launched");
}
if (named.live || stage === "installed" || stage === "diagnostic") {
  if (free < BigInt(stage === "installed" ? manifest.limits.finalBuildMinimumFreeBytes : manifest.limits.liveMinimumFreeBytes)) {
    finish("CAPACITY_REFUSED", 2, "Registered live/build disk floor not met; no service or build launched");
  }
  if(selectedOwnerCase){
    const leaf=join(destination,'owner'),argv=['--max-old-space-size=1536','./node_modules/tsx/dist/cli.mjs','scripts/frontier5/x1/run-owner-slice.mts'];
    const started=Date.now();
    record.schema='finnor.frontier5.x1.named-owner-evidence.v1';
    record.limits={wallSeconds:880,driverWallSeconds:840,workerWallSeconds:600,nodeHeapMiB:1536,
      outputBytes:manifest.limits.smallCheckOutputBytes,sharedDiskGrowthBytes:manifest.limits.liveEpisodeIncrementalDiskBytes,
      sampledOwnedRssStopBytes:manifest.limits.localSampledProcessMemoryStopBytes};
    record.authority='actual disposable authenticated API/queue/worker/canonical owners; no protected qualification or production authority';
    if(stage==='mounted')console.log(JSON.stringify({status:'WAITING_ACTUAL_BROWSER',evidence:leaf,
      fixture:join(leaf,'mounted-private-fixture.json'),originalLimitsUnchanged:true,credentialsMustRemainPrivate:true}));
    const child=spawnSync(process.execPath,argv,{cwd:os,encoding:'utf8',timeout:880000,maxBuffer:manifest.limits.smallCheckOutputBytes,
      killSignal:'SIGTERM',env:{PATH:'/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',HOME:join(leaf,'home'),TMPDIR:'/tmp',
        LANG:'en_US.UTF-8',CI:'1',LOG_LEVEL:'silent',TSX_DISABLE_CACHE:'1',NEXT_TELEMETRY_DISABLED:'1',
        FINNOR_X1_OWNER_EVIDENCE:leaf,FINNOR_X1_OWNER_CASE:selectedOwnerCase.count,FINNOR_X1_OWNER_MODE:selectedOwnerCase.mode}});
    const output=(child.stdout??'')+(child.stderr??'');
    writeFileSync(join(destination,'owner-driver.log'),output,{flag:'wx',mode:0o600});
    record.commands.push({label:'actual-owner:'+ownerCase,argv:[process.execPath,...argv],cwd:os,
      exitCode:child.status,signal:child.signal,elapsedMs:Date.now()-started,outputSha256:sha(output),outputBytes:Buffer.byteLength(output)});
    let result;try{result=JSON.parse(readFileSync(join(leaf,'results.json'),'utf8'));}catch{finish('FAIL_OR_INTERRUPTED',1,'Owner result absent; actual process interruption/failure retained, no restart or PASS');}
    record.ownerResult={path:join(leaf,'results.json'),sha256:sha(readFileSync(join(leaf,'results.json'))),
      status:result.status,sourceUnchanged:result.sourceUnchanged,cases:result.results.map(r=>({id:r.id,status:r.status}))};
    if(child.error||child.status!==0||result.status!=='PASS_LOCAL_OWNER_SLICE'||result.sourceUnchanged!==true
      ||result.source.commit!==record.source.commit)finish('FAIL',1,'Exact named actual owner case failed; raw evidence retained');
    finish('DEVELOPMENT_NAMED_OWNER_CASE_PASS',0,'Only the named actual owner case passed; complete groups/final installation/protected qualification remain unestablished');
  }
  finish("NOT_IMPLEMENTED_NOT_RUN", 2, "This live stage still lacks its complete installed/diagnostic driver; never report PASS");
}
const run = (label, binary, argv, cwd, heapMiB) => {
  const started = Date.now();
  const child = spawnSync(binary, [`--max-old-space-size=${heapMiB}`, ...argv], {
    cwd, encoding: "utf8", timeout: manifest.limits.smallCheckWallSeconds * 1000,
    maxBuffer: 1024 * 1024, env: { ...process.env, NODE_OPTIONS: "" },
  });
  const text = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  writeFileSync(join(destination, `${label}.log`), text.slice(0, 1024 * 1024), { flag: "wx", mode: 0o600 });
  const step = { label, argv: [binary, ...argv], exitCode: child.status, signal: child.signal,
    elapsedMs: Date.now() - started, outputSha256: sha(text), outputBytes: Buffer.byteLength(text) };
  record.commands.push(step);
  if (child.error || child.status !== 0) finish("FAIL", 1, `${label} failed; original output retained in ${label}.log`);
};
if (stage === "kernel" || stage === "scrutiny") {
  run("kernel", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/kernel.mts"], os, manifest.limits.kernelNodeHeapMiB);
  run("protocols", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/protocol-cases.mts"], os, manifest.limits.kernelNodeHeapMiB);
  run("reconstruction", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/reconstruction-cases.mts"], os, manifest.limits.kernelNodeHeapMiB);
  run("checker-review", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/review-cases.mts"], os, manifest.limits.kernelNodeHeapMiB);
  run("native-corpus", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/native-cases.mts"], os, manifest.limits.kernelNodeHeapMiB);
  run("native-finish", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/native-finish-cases.mts"], os, manifest.limits.kernelNodeHeapMiB);
  run("native-creation", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/creation-native-cases.mts"], os, manifest.limits.kernelNodeHeapMiB);
  run("process-transport", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/transport-cases.mts"], os, manifest.limits.kernelNodeHeapMiB);
  run("admission-finish", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/admission-finish-cases.mts"], os, manifest.limits.kernelNodeHeapMiB);
  run("responsibility", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/responsibility-cases.mts"], os, manifest.limits.kernelNodeHeapMiB);
  run("responsibility-finish", process.execPath, ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/responsibility-finish-cases.mts"], os, manifest.limits.kernelNodeHeapMiB);
}
if (stage === "static" || stage === "scrutiny") {
  if (!only || only === "typecheck") {
    run("x1-owner-typecheck", process.execPath, ["./node_modules/typescript/bin/tsc", "-p", "scripts/frontier5/x1/tsconfig.oracle.json",
      "--noUnusedLocals", "false", "--noUnusedParameters", "false"], os, manifest.limits.smallCheckNodeHeapMiB);
    run("runner-syntax", process.execPath, ["--check", "finnor-os/scripts/frontier5/x1/verify.mjs"], repo, manifest.limits.smallCheckNodeHeapMiB);
  }
  if (!only || only === "lint") {
    run("oracle-lint", process.execPath, ["node_modules/eslint/bin/eslint.js", "--config",
      "finnor-os/scripts/frontier5/x1/eslint.config.mjs", "--max-warnings=0",
      "finnor-os/packages/private-equity/src/institution-program/contracts.ts",
      "finnor-os/packages/private-equity/src/institution-program/checker.ts",
      "finnor-os/packages/private-equity/src/institution-program/checker-process.ts",
      "finnor-os/packages/private-equity/src/institution-program/checker-raw.ts",
      "finnor-os/packages/private-equity/src/institution-program/source-decoder.ts",
      "finnor-os/packages/private-equity/src/institution-program/reconstruction.ts",
      "finnor-os/packages/private-equity/src/institution-program/owner-admission.ts",
      "finnor-os/packages/private-equity/src/institution-program/responsibility.ts",
      "finnor-os/packages/private-equity/src/institution-program/resource-demand.ts",
      "finnor-os/packages/private-equity/src/allocation-store.ts",
      "finnor-os/packages/private-equity/src/institution-program/source-authority.ts",
      "finnor-os/packages/private-equity/src/institution-program/installed-source.ts",
      "finnor-os/scripts/frontier5/x1/kernel.mts",
      "finnor-os/scripts/frontier5/x1/protocol-cases.mts",
      "finnor-os/scripts/frontier5/x1/reconstruction-cases.mts",
      "finnor-os/scripts/frontier5/x1/responsibility-cases.mts"], repo, manifest.limits.smallCheckNodeHeapMiB);
    run("responsibility-finish-lint", process.execPath, ["node_modules/eslint/bin/eslint.js", "--config",
      "finnor-os/scripts/frontier5/x1/eslint.config.mjs", "--max-warnings=0",
      "finnor-os/scripts/frontier5/x1/responsibility-finish-cases.mts",
      "finnor-os/packages/private-equity/src/program-synthesis/institution.ts",
      "finnor-os/packages/private-equity/src/program-synthesis/contracts.ts",
      "finnor-os/packages/private-equity/src/program-synthesis/plan.ts",
      "finnor-os/packages/private-equity/src/program-synthesis/owners.ts",
      "finnor-os/packages/private-equity/src/program-synthesis/api.ts",
      "finnor-os/packages/private-equity/src/program-synthesis/worker.ts",
      "finnor-os/packages/private-equity/src/program-synthesis/store.ts",
      "finnor-os/packages/orchestration/src/objective-loop.ts"], repo, manifest.limits.smallCheckNodeHeapMiB);
    run("checker-command-lint", process.execPath, ["node_modules/eslint/bin/eslint.js", "--config",
      "finnor-os/scripts/frontier5/x1/eslint.config.mjs", "--max-warnings=0",
      "finnor-os/scripts/frontier5/x1/review-cases.mts",
      "finnor-os/scripts/frontier5/x1/native-cases.mts",
      "finnor-os/scripts/frontier5/x1/native-finish-cases.mts",
      "finnor-os/scripts/frontier5/x1/creation-native-cases.mts",
      "finnor-os/scripts/frontier5/x1/transport-cases.mts",
      "finnor-os/scripts/frontier5/x1/admission-finish-cases.mts",
      "finnor-os/scripts/frontier5/x1/checker-command.mts"], repo, manifest.limits.smallCheckNodeHeapMiB);
  }
}
if (stage === "qualification-contract") {
  run("qualification-scorer-contract", process.execPath,
    ["./node_modules/tsx/dist/cli.mjs", "scripts/frontier5/x1/qualification-cases.mts"], os, manifest.limits.kernelNodeHeapMiB);
}
if (stage !== "kernel" && stage !== "static" && stage !== "scrutiny" && stage !== "qualification-contract") {
  finish("NOT_IMPLEMENTED_NOT_RUN", 2, "This frozen stage has no implementation in this feature");
}
if (stage === "scrutiny") {
  finish("INCOMPLETE_NOT_RUN", 2, "Offline kernel/static passed; required owner, mounted, installed and protected stages have no evidence");
}
finish("DEVELOPMENT_OFFLINE_PASS", 0,
  "Selected bounded offline commands passed; owner persistence, installed bytes and protected qualification remain NOT RUN");
