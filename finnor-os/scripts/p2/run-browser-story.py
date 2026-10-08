"""Orchestrate the one real browser story immediately after owner fixture readiness.
The original P1 episode deadline is unchanged. No business response is substituted.
"""
import hashlib,json,os,pathlib,subprocess,sys,time,urllib.request
from datetime import datetime,timezone
scripts=pathlib.Path(__file__).resolve().parent
output=pathlib.Path(sys.argv[1]).resolve()
if output.exists():raise SystemExit('New immutable output directory required')
fixture_command=[sys.executable,str(scripts/'run-browser-fixture.py'),str(output)]
browser_command=[sys.executable,str(scripts/'browser-e2e.py'),str(output/'browser')]
started=datetime.now(timezone.utc).isoformat()
fixture=subprocess.Popen(fixture_command,env=os.environ.copy())
failure=None;browser_exit=None
try:
 end=time.monotonic()+180
 while not (output/'browser'/'fixture.json').exists():
  if fixture.poll() is not None:raise RuntimeError('OWNER_FIXTURE_STOPPED_BEFORE_READY')
  if time.monotonic()>=end:raise RuntimeError('OWNER_FIXTURE_READINESS_TIMEOUT')
  time.sleep(.1)
 with (output/'browser-driver.log').open('w') as log:
  browser_exit=subprocess.run(browser_command,env=os.environ.copy(),stdout=log,stderr=subprocess.STDOUT,timeout=480).returncode
except Exception as error:failure=str(error)
finally:
 try:
  request=urllib.request.Request('http://127.0.0.1:4693/stop',data=b'{}',headers={'content-type':'application/json'},method='POST')
  urllib.request.urlopen(request,timeout=10).close()
 except Exception:pass
 try:fixture_exit=fixture.wait(timeout=60)
 except subprocess.TimeoutExpired:
  fixture.terminate();fixture_exit=fixture.wait(timeout=15);failure=failure or 'FIXTURE_SHUTDOWN_TIMEOUT'
 receipt={'schema':'finnor.p2.browser-story-driver.v1','startedAt':started,'finishedAt':datetime.now(timezone.utc).isoformat(),'fixtureCommand':fixture_command,'browserCommand':browser_command,'driverSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'fixtureExitCode':fixture_exit,'browserExitCode':browser_exit,'failure':failure,'qualification':'LOCAL_AUTH_SERVICE_ACTUAL_UI_API_QUEUE_RLS_OWNERS; NOT_HOSTED_SUPABASE_OR_PROTECTED_EXECUTION'}
 output.mkdir(exist_ok=True);(output/'story-driver-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
 raise SystemExit(0 if not failure and browser_exit==0 and fixture_exit==0 else 1)
