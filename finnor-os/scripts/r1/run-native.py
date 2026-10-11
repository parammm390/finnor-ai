"""Frozen finite R1 proof entry point. Scrubbed environment; private evidence."""
import hashlib,json,os,pathlib,subprocess,sys
from datetime import datetime,timezone
backend=pathlib.Path(__file__).resolve().parents[2]
check=sys.argv[1] if len(sys.argv)>1 else "owners"
scripts={"mathematical":["scripts/r1/run-mathematical.mts"],"owners":["scripts/r1/run-owners.mts","owners"],"lifecycle":["scripts/r1/run-owners.mts","lifecycle"],"browser":["scripts/r1/run-owners.mts","browser"],"runtime":["scripts/r1/run-owners.mts","runtime"],"inherited":["scripts/r1/run-gates.py","inherited"],"release":["scripts/r1/run-gates.py","release"]}
if check not in scripts:raise SystemExit("Check has no implemented driver: "+check)
required=("FINNOR_R1_EVIDENCE_DIR","FINNOR_TEST_NODE","FINNOR_TEST_PYTHON")
if any(not os.environ.get(k) for k in required):raise SystemExit("Set "+", ".join(required)+" to owned private output and verified runtime paths")
out=pathlib.Path(os.environ["FINNOR_R1_EVIDENCE_DIR"]).resolve()
out.mkdir(parents=True,exist_ok=True)
if (out/"driver-receipt.json").exists():raise SystemExit("Immutable output already contains a run receipt")
node=pathlib.Path(os.environ["FINNOR_TEST_NODE"]).resolve(strict=True)
python=pathlib.Path(os.environ["FINNOR_TEST_PYTHON"]).absolute()
python.resolve(strict=True)
env={k:v for k,v in os.environ.items() if k in ("HOME","PATH","TMPDIR")}
env.update(NODE_ENV="test",CI="1",LOG_LEVEL="silent",AUTH_DEV_BYPASS="0",FINNOR_TEST_MANAGED_EXTENSIONS="omit",FINNOR_P4_PROFILE="ordinary_disposable",FINNOR_M1_PROFILE="DISPOSABLE_NATIVE",FINNOR_R1_EVIDENCE_DIR=str(out),FINNOR_S3_PYTHON=str(python),FINNOR_S5_PYTHON=str(python),FINNOR_R1_PYTHON=str(python),P3_GOVERNORS="1",RATE_LIMIT_PER_MINUTE="100000",OPENBLAS_NUM_THREADS="1",OMP_NUM_THREADS="1")
env['FINNOR_COMMIT_SHA']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=backend,text=True).strip()
env.update(FINNOR_BUILD_ID='finnor-'+env['FINNOR_COMMIT_SHA'][:12],FINNOR_VERSION='0.1.0+'+env['FINNOR_COMMIT_SHA'][:12],FINNOR_RELEASE_SOURCE='ordinary-development-with-retained-source-overlay')
if os.environ.get("FINNOR_R1_CASE_FILTER"):env["FINNOR_R1_CASE_FILTER"]=os.environ["FINNOR_R1_CASE_FILTER"]
if check in ('inherited','release'):
 env.update(FINNOR_TEST_NODE=str(node),FINNOR_TEST_PYTHON=str(python))
 command=[str(python),*scripts[check]]
else:command=[str(node),"--import=tsx",*scripts[check]]
receipt={"schema":"finnor.r1.native-rerun.v1","startedAt":datetime.now(timezone.utc).isoformat(),"command":command,"cwd":str(backend),"environmentNames":sorted(env),"caseFilter":env.get("FINNOR_R1_CASE_FILTER"),"executables":[{"path":str(p),"sha256":hashlib.sha256(p.read_bytes()).hexdigest()} for p in (node,python)],"driverSha256":hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),"status":"NOT_RUN","qualification":"Ordinary real development proof, no protected qualification or business effects"}
if check=="mathematical":
 freeze_command=[str(node),"--import=tsx","--input-type=module","-e","const {r1SourceCut}=await import('./packages/private-equity/src/r1/runtime.ts'); console.log(JSON.stringify(await r1SourceCut()));"]
 frozen=subprocess.run(freeze_command,cwd=backend,env=env,capture_output=True,text=True,timeout=30)
 if frozen.returncode:
  (out/"source-freeze-failure.json").write_text(json.dumps({"command":freeze_command,"exitCode":frozen.returncode,"stderr":frozen.stderr},indent=2)+"\n")
  raise SystemExit("Actual mathematical source freeze failed")
 source=json.loads(frozen.stdout)
 snapshot=out/"source-cut";snapshot.mkdir()
 for item in source['files']:
  b=(backend.parent/item['path']).read_bytes()
  if hashlib.sha256(b).hexdigest()!=item['sha256']:raise SystemExit("Source changed during mathematical freeze")
  target=snapshot/item['path'];target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b)
 (out/"pre-run-freeze.json").write_text(json.dumps({"source":source,"commit":env['FINNOR_COMMIT_SHA'],"tree":subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=backend,text=True).strip(),"frozenAt":datetime.now(timezone.utc).isoformat(),"sourceSnapshot":"source-cut","command":freeze_command},indent=2)+"\n")
with (out/"runner.log").open("w") as log:
 try:
  run=subprocess.run(command,cwd=backend,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=1800 if check=="mathematical" else 3660 if check in ('inherited','release') else 3600)
  receipt["exitCode"]=run.returncode
 except subprocess.TimeoutExpired:receipt.update(exitCode=124,failure="DRIVER_WALL_CEILING")
results=out/("mathematical-results.json" if check=="mathematical" else "results.json")
if results.exists():
 r=json.loads(results.read_text());cases=r.get("records",r.get("results",[]))
 receipt["counts"]={s:sum(c.get("status")==s for c in cases) for s in ("PASS","FAIL","NOT_RUN")}
 if not receipt["counts"]["PASS"] or receipt["counts"]["FAIL"]:receipt["exitCode"]=receipt["exitCode"] or 1
else:receipt.update(exitCode=receipt["exitCode"] or 1,failure="MISSING_DECISIVE_RECEIPT")
receipt.update(status="PASS_LOCAL" if receipt["exitCode"]==0 else "FAIL",finishedAt=datetime.now(timezone.utc).isoformat())
(out/"driver-receipt.json").write_text(json.dumps(receipt,indent=2)+"\n")
print(json.dumps(receipt))
raise SystemExit(receipt["exitCode"])
