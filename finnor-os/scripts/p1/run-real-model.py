"""Bounded actual configured model replay; exports names and responses, never keys."""
import os,subprocess,pathlib,json,datetime,re,hashlib,sys
workspace=pathlib.Path(__file__).resolve().parents[2]
output=pathlib.Path(sys.argv[1]).resolve();output.mkdir(exist_ok=False)
configuration=pathlib.Path(sys.argv[2]).resolve()
environment={k:v for k,v in os.environ.items() if k in ('HOME','PATH','TMPDIR')}
for line in configuration.read_text().splitlines():
 match=re.match(r'\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)',line)
 if match and match[1] in {'GROQ_API_KEY','GROQ_MODEL'}:environment[match[1]]=match[2].strip().strip('"\'')
assert {'GROQ_API_KEY','GROQ_MODEL'}.issubset(environment)
if len(sys.argv)>3:
 catalogue=json.loads(pathlib.Path(sys.argv[4]).read_text())
 assert any(m['id']==sys.argv[3] and m.get('active') and 'json_mode' in m.get('supported_features',[]) for m in catalogue['models'])
 environment['GROQ_MODEL']=sys.argv[3]
environment.update(NODE_ENV='test',CI='1',LOG_LEVEL='silent',AUTH_DEV_BYPASS='1',FINNOR_TEST_MANAGED_EXTENSIONS='omit',FINNOR_M1_PROFILE='DISPOSABLE_NATIVE',FINNOR_M1_STORE=str(output/'producer-store'),FINNOR_S3_MODEL_STORE=str(output/'models'),FINNOR_S4_POLICY_STORE=str(output/'policies'),FINNOR_S3_PYTHON='/tmp/finnor-s3-python/bin/python',FINNOR_S5_PYTHON='/tmp/finnor-s3-python/bin/python',P3_GOVERNORS='1',RATE_LIMIT_PER_MINUTE='100000',FINNOR_P1_EVIDENCE_DIR=str(output),LLM_PROVIDER_PLANNING_CONSOLE='groq',LLM_FALLBACKS_PLANNING_CONSOLE='')
profile=os.environ.get('FINNOR_P1_COMPARISON_PROFILE','LEGACY_8S_700')
assert profile in ('LEGACY_8S_700','COMPLETION_30S_2048')
environment['FINNOR_P1_COMPARISON_PROFILE']=profile
python=pathlib.Path(os.environ.get('FINNOR_TEST_PYTHON','/tmp/finnor-s3-python/bin/python')).absolute();python.resolve(strict=True)
environment['FINNOR_S3_PYTHON']=str(python);environment['FINNOR_S5_PYTHON']=str(python)
node=pathlib.Path(os.environ.get('FINNOR_TEST_NODE','/Users/paramdave/.hermes/node/bin/node')).resolve(strict=True)
script='scripts/p1/run-equipped-comparison.mts' if os.environ.get('FINNOR_P1_EQUIPPED_COMPARISON')=='1' else 'scripts/p1/run-real-model-e2e.mts'
command=[str(node),'--import=tsx',script]
receipt={'schema':'finnor.p1.live-model-driver.v1','command':command,'cwd':str(workspace),'environmentNames':sorted(environment),'configuredModel':environment['GROQ_MODEL'],'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceSha256':hashlib.sha256((workspace/command[-1]).read_bytes()).hexdigest(),'driverSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'nodeSha256':hashlib.sha256(node.read_bytes()).hexdigest(),'qualification':'ACTUAL_EXISTING_GROQ_CONFIGURATION; PUBLIC_DEVELOPMENT_ONLY; NO_SEALED_COMPARISON_OR_QUALIFIED_BILLING'}
(output/'driver-start.json').write_text(json.dumps(receipt,indent=2))
with (output/'runner.log').open('w') as log:
 try:r=subprocess.run(command,cwd=workspace,env=environment,stdout=log,stderr=subprocess.STDOUT,timeout=600);receipt['exitCode']=r.returncode
 except subprocess.TimeoutExpired:receipt.update(exitCode=124,failure='DRIVER_TIMEOUT')
receipt['finishedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
if (output/'results.json').exists():
 cases=json.loads((output/'results.json').read_text()).get('results',[]);receipt['counts']={s:sum(c.get('status')==s for c in cases) for s in ('PASS','FAIL','NOT_RUN')}
else:receipt.update(exitCode=1,failure='MISSING_OWNER_RECEIPT')
(output/'driver-receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt));raise SystemExit(receipt['exitCode'])
