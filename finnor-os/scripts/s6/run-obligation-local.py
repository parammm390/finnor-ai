"""Existing disposable DB only; credentials are explicitly test authority."""
import os,pathlib,subprocess,json,hashlib,datetime,urllib.parse,uuid
repo=pathlib.Path(__file__).resolve().parents[3]
out=pathlib.Path(os.environ.get('FINNOR_S6_OBLIGATION_EVIDENCE_DIR',str(repo/'scope-6/scope-evidence/obligation-owner-second')))
out.mkdir(parents=True,exist_ok=False)
env={k:v for k,v in os.environ.items() if k in ('PATH','HOME','TMPDIR')}
env.update(NODE_ENV='test',CI='1',LOG_LEVEL='silent',AUTH_DEV_BYPASS='1',RATE_LIMIT_PER_MINUTE='100000',FINNOR_TEST_MANAGED_EXTENSIONS='omit',FINNOR_S6_OBLIGATION_EVIDENCE_DIR=str(out),FINNOR_S4_POLICY_STORE=str(out/'ordinary-policies'),FINNOR_S3_MODEL_STORE=str(out/'ordinary-models'),FINNOR_S3_PYTHON='/tmp/finnor-s3-python/bin/python',FINNOR_S5_PYTHON='/tmp/finnor-s3-python/bin/python',DATABASE_URL=os.environ['FINNOR_S6_DATABASE_URL'],FINNOR_S6_ADMIN_DATABASE_URL=os.environ['FINNOR_S6_ADMIN_DATABASE_URL'])
if os.environ.get('FINNOR_S6_DISPATCH_PROOF')=='1':
 env['FINNOR_S6_DISPATCH_PROOF']='1'
if os.environ.get('FINNOR_S6_OBLIGATION_CASE_FILTER'):
 env['FINNOR_S6_OBLIGATION_CASE_FILTER']=os.environ['FINNOR_S6_OBLIGATION_CASE_FILTER']
workspace=repo/'finnor-os'
if os.environ.get('FINNOR_S6_FRESH_DATABASE')=='1':
 database_name='s6_obligation_'+uuid.uuid4().hex
 original_admin=urllib.parse.urlsplit(env['FINNOR_S6_ADMIN_DATABASE_URL'])
 if original_admin.hostname not in ('127.0.0.1','localhost','::1'):
  raise ValueError('Fresh obligation evidence databases must be disposable local targets')
 provision_env={k:v for k,v in env.items()}
 provision_env['DATABASE_URL']=env['FINNOR_S6_ADMIN_DATABASE_URL']
 provision_env['FINNOR_S6_TEST_DATABASE_NAME']=database_name
 code="import pg from 'pg'; const c=new pg.Client({connectionString:process.env.DATABASE_URL}); await c.connect(); const n=process.env.FINNOR_S6_TEST_DATABASE_NAME; if(!/^s6_obligation_[a-f0-9]{32}$/.test(n))throw Error('INVALID_DISPOSABLE_DATABASE'); await c.query('CREATE DATABASE '+n); await c.end();"
 subprocess.run(['node','--input-type=module','-e',code],cwd=workspace,env=provision_env,check=True,capture_output=True,text=True)
 for key in ('DATABASE_URL','FINNOR_S6_ADMIN_DATABASE_URL'):
  url=urllib.parse.urlsplit(env[key]);env[key]=urllib.parse.urlunsplit(url._replace(path='/'+database_name))
 migration_env={**env,'DATABASE_URL':env['FINNOR_S6_ADMIN_DATABASE_URL']}
 with (out/'migration.log').open('w') as log:
  subprocess.run(['node','--import=tsx','packages/db/migrate.ts'],cwd=workspace,env=migration_env,stdout=log,stderr=subprocess.STDOUT,check=True)
def snapshot():
 paths=[workspace/'package-lock.json',workspace/'tsconfig.base.json']
 for base in ['packages','apps','scripts/s3','scripts/s5','scripts/s6']:
  paths.extend(p for p in (workspace/base).rglob('*') if p.is_file() and 'node_modules' not in p.parts and '.next' not in p.parts and (p.suffix in ['.ts','.tsx','.mts','.mjs','.py','.sql'] or p.name=='package.json'))
 return {str(p.relative_to(workspace)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(set(paths))}
command=['node','--import=tsx','scripts/s6/run-obligation-e2e.mts']
manifest={'schema':'finnor.s6.obligation-owner-run.v1','startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'cwd':str(workspace),'command':command,'node':subprocess.check_output(['node','--version'],text=True).strip(),'sources':snapshot(),'configuration':{k:env[k] for k in ['NODE_ENV','CI','AUTH_DEV_BYPASS','FINNOR_TEST_MANAGED_EXTENSIONS']},'selection':env.get('FINNOR_S6_OBLIGATION_CASE_FILTER','FULL_REGISTERED_RUN'),'qualification':'ACTUAL_OWNER_HANDLERS_AND_DISPOSABLE_DATABASE; DEVELOPMENT_AUTHENTICATION; NO_PROTECTED_ADMISSION_OR_LIVE_PROVIDER'}
target=urllib.parse.urlsplit(env['DATABASE_URL']);manifest['databaseTarget']={'host':target.hostname,'port':target.port,'database':target.path.lstrip('/'),'role':target.username,'retained':True}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2))
with (out/'runner.log').open('w') as log:
 run=subprocess.run(command,cwd=workspace,env=env,stdout=log,stderr=subprocess.STDOUT)
manifest.update(finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),exitCode=run.returncode,sourcesUnchanged=snapshot()==manifest['sources'])
(out/'manifest.json').write_text(json.dumps(manifest,indent=2))
print(json.dumps({'output':str(out),'exitCode':run.returncode,'sourcesUnchanged':manifest['sourcesUnchanged']}))
raise SystemExit(run.returncode if manifest['sourcesUnchanged'] else 2)
