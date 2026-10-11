"""Serial reuse of original owner/release gates; no owner receipts or new unit tests."""
import hashlib,json,os,pathlib,resource,shutil,signal,subprocess,sys,tarfile,time
from datetime import datetime,timezone

backend=pathlib.Path(__file__).resolve().parents[2]
repo=backend.parent
mode=sys.argv[1]
if mode not in ('inherited','release'):raise SystemExit('Unsupported frozen gate group')
out=pathlib.Path(os.environ['FINNOR_R1_EVIDENCE_DIR']).resolve()
node=pathlib.Path(os.environ['FINNOR_TEST_NODE']).resolve(strict=True)
python=pathlib.Path(os.environ['FINNOR_TEST_PYTHON']).absolute()
npm=(node.parent/'../lib/node_modules/npm/bin/npm-cli.js').resolve(strict=True)
sha=lambda b:hashlib.sha256(b).hexdigest()
now=lambda:datetime.now(timezone.utc).isoformat()
out.mkdir(parents=True,exist_ok=True)
if (out/'results.json').exists():raise SystemExit('Immutable gate output already exists')
env={k:v for k,v in os.environ.items() if k in ('HOME','PATH','TMPDIR') or k.startswith('FINNOR_')}
env.update(PATH=str(node.parent)+os.pathsep+str(python.parent)+os.pathsep+env.get('PATH',''),NODE_ENV='test',CI='1',LOG_LEVEL='silent',AUTH_DEV_BYPASS='0',NEXT_TELEMETRY_DISABLED='1',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1')
filters=os.environ.get('FINNOR_R1_CASE_FILTER','').split(',')
filters=[x for x in filters if x]
started=time.monotonic();deadline=started+3600
results=[]

def freeze():
    commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip()
    tree=subprocess.check_output(['git','rev-parse','HEAD^{tree}'],cwd=repo,text=True).strip()
    patch=subprocess.check_output(['git','diff','--binary','HEAD'],cwd=repo)
    base=out/'source-cut';base.mkdir()
    (base/'tracked.patch').write_bytes(patch)
    paths=subprocess.check_output(['git','ls-files','--modified','--others','--exclude-standard','-z'],cwd=repo).decode().split('\0')
    overlay=[];total=0
    for rel in sorted(set(filter(None,paths))):
        p=repo/rel
        try:p.lstat()
        except FileNotFoundError:
            overlay.append({'path':rel,'deleted':True});continue
        b=p.read_bytes();total+=len(b)
        if total>20*1024*1024:raise RuntimeError('R1_RECONSTRUCTION_OVERLAY_BOUND')
        target=base/'dirty'/rel;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b)
        overlay.append({'path':rel,'sha256':sha(b),'bytes':len(b)})
    record={'frozenAt':now(),'commit':commit,'tree':tree,'trackedPatchSha256':sha(patch),'overlay':overlay,'overlayBytes':total,'commandGroup':mode,'caseFilter':filters,'wallCeilingSeconds':3600,'runtime':{'node':str(node),'nodeSha256':sha(node.read_bytes()),'python':str(python),'pythonSha256':sha(python.read_bytes())}}
    (out/'pre-run-freeze.json').write_text(json.dumps(record,indent=2)+'\n')
    return record

def save():
    passed=sum(x['status']=='PASS' for x in results);failed=sum(x['status']=='FAIL' for x in results)
    skipped=sum(x['status']=='NOT_RUN' for x in results)
    usage=resource.getrusage(resource.RUSAGE_CHILDREN)
    record={'schema':'finnor.r1.inherited-release-e2e.v1','group':mode,'generatedAt':now(),'status':'FAIL' if failed else 'PASS_SELECTED_ONLY' if passed and skipped else 'PASS_LOCAL' if passed else 'NOT_RUN','results':results,'source':source,'costs':{'elapsedSeconds':time.monotonic()-started,'childCpuUserSeconds':usage.ru_utime,'childCpuSystemSeconds':usage.ru_stime,'childHighWaterBytes':usage.ru_maxrss*(1 if sys.platform=='darwin' else 1024),'memoryScope':'WRAPPER_CHILD_HIGH_WATER_NOT_AGGREGATE_SIMULTANEOUS_PEAK','usd':None,'humanSeconds':None},'qualification':'ORDINARY_ORIGINAL_SELECTED_OWNER_AND_LOCAL_RELEASE_GATES; NO_HOSTED_CI_LINUX_PROTECTED_OR_ECONOMIC_QUALIFICATION','rerun':'python3 finnor-os/scripts/r1/run-native.py '+mode}
    (out/'results.json').write_text(json.dumps(record,indent=2)+'\n')

def execute(command,cwd,child_env,directory,ceiling):
    with (directory/'runner.log').open('w') as log:
        child=subprocess.Popen(command,cwd=cwd,env=child_env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
        try:code=child.wait(timeout=max(.01,min(ceiling,deadline-time.monotonic())))
        except subprocess.TimeoutExpired:
            if os.getpgid(child.pid)!=child.pid:raise RuntimeError('OWNED_PROCESS_GROUP_MISMATCH')
            os.killpg(child.pid,signal.SIGTERM)
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait()
            return 124,{'ownedPid':child.pid,'reason':'FROZEN_WALL_CEILING','ownedGroupTerminated':True}
    return code,{'ownedPid':child.pid}

def suite(id,command,cwd=repo,extra=None,oracle='Original project command',ceiling=900,owner=False):
    if filters and not any(x in id for x in filters):
        results.append({'id':id,'status':'NOT_RUN','command':command,'oracle':oracle});save();return
    directory=out/id;directory.mkdir();child_env={**env,**(extra or {})};begin=time.monotonic()
    receipt={'id':id,'command':command,'cwd':str(cwd),'environmentNames':sorted(child_env),'startedAt':now(),'oracle':oracle,'wallCeilingSeconds':ceiling,'status':'RUNNING'}
    (directory/'command.json').write_text(json.dumps(receipt,indent=2)+'\n')
    try:
        if time.monotonic()>=deadline:raise RuntimeError('FROZEN_GROUP_WALL_CEILING')
        code,physical=execute(command,cwd,child_env,directory,ceiling)
        observed={'exitCode':code,**physical}
        if owner:
            native=json.loads((directory/'results.json').read_text());cases=native.get('cases',native.get('results',[]))
            observed.update(nativeResults='results.json',cases=[{'id':c['id'],'status':c['status']} for c in cases],nativeQualification=native.get('qualification',native.get('evidenceBoundary')))
            if not cases or any(c['status']!='PASS' for c in cases):code=code or 1
        if id=='api-build' and code==0:
            build=backend/'apps/api/.next';manifest=[]
            for p in sorted(build.rglob('*')):
                if p.is_file() and 'cache' not in p.relative_to(build).parts:
                    b=p.read_bytes();manifest.append({'path':str(p.relative_to(build)),'sha256':sha(b),'bytes':len(b)})
            (directory/'generated-file-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
            with tarfile.open(directory/'generated-api.tar.gz','w:gz') as tar:
                for p in sorted(build.iterdir()):
                    if p.name!='cache':tar.add(p,arcname=p.name)
            observed.update(buildId=(build/'BUILD_ID').read_text().strip(),archiveSha256=sha((directory/'generated-api.tar.gz').read_bytes()),linuxImageProof=False)
        receipt.update(status='PASS' if code==0 else 'FAIL',observed=observed)
    except Exception as error:receipt.update(status='FAIL',observed={'error':str(error),'type':type(error).__name__})
    receipt.update(finishedAt=now(),durationSeconds=time.monotonic()-begin)
    (directory/'command.json').write_text(json.dumps(receipt,indent=2)+'\n');results.append(receipt);save()

source=freeze()
if mode=='inherited':
    for name,script in [('s4','scripts/s4/run-s4-e2e.mts'),('s5','scripts/s5/run-s5-e2e.mts')]:
        directory=out/name
        extra={'AUTH_DEV_BYPASS':'1','FINNOR_TEST_MANAGED_EXTENSIONS':'omit','RATE_LIMIT_PER_MINUTE':'100000',f'FINNOR_{name.upper()}_EVIDENCE_DIR':str(directory),'FINNOR_S4_POLICY_STORE':str(directory/'ordinary-policies'),'FINNOR_S3_MODEL_STORE':str(directory/'ordinary-models'),'FINNOR_S3_PYTHON':str(python),'FINNOR_S5_PYTHON':str(python)}
        suite(name,[str(node),'--import=tsx',script],backend,extra,'UNCHANGED_COMPLETE_ORIGINAL_DRIVER; INHERITED_EXPLICIT_HEADER_AUTH_NOT_R1_AUTH_PROOF',1200,True)
    suite('p7',[str(node),'--import=tsx','scripts/p7/run-native-e2e.mts'],backend,{'FINNOR_P7_EVIDENCE_DIR':str(out/'p7'),'FINNOR_P7_START_HISTORY':'EMPTY'},'SIX_ORIGINAL_SELECTED_NATIVE_STORIES_AND_POSTGRES_NUMERIC_ORACLE; NOT_ALL_34_FAMILIES',1200,True)
else:
    def npm_gate(id,script,cwd=repo,ceiling=600):suite(id,[str(node),str(npm),'run',script],cwd,oracle='Unchanged project '+script,ceiling=ceiling)
    suite('api-build',[str(node),str(npm),'run','build','--workspace=@finnor/api'],backend,{'NODE_ENV':'production'},'ACTUAL_OPTIMIZED_API_BUILD_AND_GENERATED_BYTES; RUNTIME_E2E_SEPARATE',1800)
    npm_gate('backend-typecheck','typecheck',backend)
    npm_gate('root-lint','lint')
    npm_gate('root-workspace','workspace:check')
    npm_gate('capability-manifest','centropy:manifest:check')
    npm_gate('openapi-client','centropy:client:check')
    npm_gate('human-forms','centropy:forms:check')
    npm_gate('authz-matrix','authz:matrix:check',backend)
    npm_gate('active-action-manifest','release:manifest',backend)
    npm_gate('pe-domain-boundary','release:pe-domain-boundary',backend)
    npm_gate('release-truth','release:truth')
    npm_gate('release-security-policy','test:release')
    suite('native-production-secrets',[str(node),'node_modules/vitest/vitest.mjs','run','tests/unit/secrets.test.ts'],backend,oracle='UNCHANGED_ORIGINAL_PRODUCTION_SECRETS_SECURITY_CHECKS')
    npm_gate('root-existing-tests','test:unit')
    suite('root-build',[str(node),str(npm),'run','build'],repo,{'NODE_ENV':'production'},'ACTUAL_DEFAULT_TURBOPACK_OPTIMIZED_ROOT_BUILD',1800)
save()
print(json.dumps({'output':str(out),'status':json.loads((out/'results.json').read_text())['status'],'cases':[{k:r[k] for k in ('id','status')} for r in results]}))
raise SystemExit(1 if any(r['status']=='FAIL' for r in results) or not any(r['status']=='PASS' for r in results) else 0)
