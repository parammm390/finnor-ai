"""One scoped UI trajectory through agent-browser and the actual native backend.
No routing, business API, authorizer or mathematical oracle is mocked.
"""
import hashlib,json,os,pathlib,subprocess,sys,time,urllib.request
from datetime import datetime,timezone
base=pathlib.Path(sys.argv[1]).resolve();fixture=json.loads((base/'fixture.json').read_text());output=base/'run';output.mkdir(exist_ok=False)
cli=pathlib.Path(os.environ['FINNOR_AGENT_BROWSER']).resolve(strict=True);chrome=pathlib.Path(os.environ['FINNOR_BROWSER_EXECUTABLE']).resolve(strict=True)
session='finnor-p2-'+str(os.getpid());config=output/'agent-browser.json';config.write_text('{}\n')
env={k:v for k,v in os.environ.items() if k in ('HOME','PATH','TMPDIR')}
env['AGENT_BROWSER_EXECUTABLE_PATH']=str(chrome)
commands=[];steps=[];started=datetime.now(timezone.utc).isoformat()
def cli_call(*args):
 cmd=[str(cli),'--config',str(config),'--session',session,'--json',*map(str,args)]
 p=subprocess.run(cmd,capture_output=True,text=True,env=env,timeout=45)
 try:r=json.loads(p.stdout)
 except:r={'stdout':p.stdout}
 commands.append({'argv':cmd,'exitCode':p.returncode,'response':r,'stderr':p.stderr,'at':datetime.now(timezone.utc).isoformat()})
 if p.returncode or r.get('success') is False:raise AssertionError(str(r))
 return r.get('data',r)
def value(expression):
 r=cli_call('eval',expression)
 return r.get('result',r) if isinstance(r,dict) else r
def until(predicate,seconds=35):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  r=predicate()
  if r:return r
  time.sleep(.25)
 raise AssertionError('ACTUAL_UI_OBSERVER_TIMEOUT')
def control(path,body=None,method='POST'):
 request=urllib.request.Request('http://127.0.0.1:4693'+path,data=json.dumps(body or {}).encode() if method=='POST' else None,headers={'content-type':'application/json'},method=method)
 with urllib.request.urlopen(request,timeout=20) as r:
  content=r.read().decode();return json.loads(content) if content else {}
def dom():
 return value("(()=>{const p=document.querySelector('.ct-compute-search');return {present:!!p,work:p?.getAttribute('data-compute-work'),search:p?.getAttribute('data-compute-search'),text:p?.innerText??'',values:Object.fromEntries(Array.from(p?.querySelectorAll('dl > div')??[]).map(x=>[x.querySelector('dt')?.innerText,x.querySelector('dd')?.innerText])),proof:!!p?.querySelector('details[open] [data-compute-proof]'),overlay:!!document.querySelector('[data-nextjs-dialog]'),url:location.href}})()")
def save():
 (output/'results.json').write_text(json.dumps({'schema':'finnor.p2.browser-e2e.v1','startedAt':started,'generatedAt':datetime.now(timezone.utc).isoformat(),'status':'FAIL' if any(s['status']=='FAIL' for s in steps) else 'PASS_LOCAL','profile':fixture['profile'],'hostedSupabaseQualified':False,'expected':fixture['expected'],'steps':steps,'commands':commands,'runtime':{'cli':str(cli),'cliSha256':hashlib.sha256(cli.read_bytes()).hexdigest(),'chrome':str(chrome),'chromeSha256':hashlib.sha256(chrome.read_bytes()).hexdigest()},'rerun':'Start P2 disposable browser fixture and frontend at4690; python finnor-os/scripts/p2/browser-e2e.py EVIDENCE_DIR/browser'},indent=2)+'\n')
def step(name,fn):
 try:steps.append({'id':name,'status':'PASS','observed':fn()})
 except Exception as e:steps.append({'id':name,'status':'FAIL','error':str(e)});raise
 finally:
  try:cli_call('screenshot',str(output/(name+'.png')),'--full');(output/(name+'.dom.json')).write_text(json.dumps(cli_call('snapshot'),indent=2))
  except Exception:pass
  save()
try:
 def sign_in():
  cli_call('open','http://127.0.0.1:4690/centropy/login');snap=cli_call('snapshot','-i');email_ref=next(k for k,v in snap['refs'].items() if v['role']=='textbox' and v['name'].casefold()=='email');cli_call('fill','@'+email_ref,fixture['email']);snap=cli_call('snapshot','-i');password_ref=next(k for k,v in snap['refs'].items() if v['role']=='textbox' and v['name'].casefold()=='password');cli_call('fill','@'+password_ref,fixture['password']);cli_call('find','role','button','click','--name','Sign in');until(lambda:value("location.pathname==='/centropy'"));cli_call('open',fixture['url']);cli_call('snapshot','-i');d=until(lambda:dom() if dom().get('work')==fixture['workId'] else None);assert not d['overlay'];assert not d['values'];return d
 step('same-Work-owner-bound-canvas',sign_in)
 def execute():
  until(lambda:value("!!document.querySelector('.ct-compute-search button')"));cli_call('scrollintoview','.ct-compute-search');snap=cli_call('snapshot','-i');ref=next(k for k,v in snap['refs'].items() if v['role']=='button' and v['name']=='Run allocated computation');cli_call('click','@'+ref);d=until(lambda:dom() if dom().get('values')=={'netEquity':'43 USD','leverage':'3.5 multiple'} else None,65);oracle=control('/observation',method='GET');assert oracle['oracle']['equity']=='43';assert d['work']==fixture['workId'];assert d['search']==oracle['plans'][0]['id'];assert oracle['plans'][0]['status']=='STOPPED';assert 'USD cost is unknown' in d['text'];assert 'heuristic' in d['text'];return {'dom':d,'independentDatabaseOracle':oracle}
 step('executed-search-independent-values-and-cost',execute)
 def proof():
  snap=cli_call('snapshot','-i');ref=next(k for k,v in snap['refs'].items() if v['role']=='button' and v['name']=='Inspect computation evidence');cli_call('focus','@'+ref);focused_before=value("document.activeElement?.textContent");assert 'Inspect computation evidence' in focused_before;cli_call('press','Space');d=until(lambda:dom() if dom().get('proof') else None,5);text=value("document.querySelector('[data-compute-proof]').innerText");assert 'computeGrant' in text and 'S5' in text and 'native:p2' in text;focused=value("document.activeElement?.hasAttribute('data-compute-proof')");assert focused;return {'text':text,'focusedBefore':focused_before,'focused':focused}
 step('keyboard-allocation-quota-witness',proof)
 def reload():
  before=dom();cli_call('reload');d=until(lambda:dom() if dom().get('values')=={'netEquity':'43 USD','leverage':'3.5 multiple'} else None);assert d['work']==before['work'];assert d['search']==before['search'];return d
 step('durable-same-Work-reload',reload)
 def mobile():
  cli_call('set','viewport','375','812');cli_call('find','role','button','click','--name','Canvas');d=until(lambda:dom() if dom().get('values')=={'netEquity':'43 USD','leverage':'3.5 multiple'} else None);cli_call('scrollintoview','.ct-compute-search');size=value('({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,inner:innerWidth,height:innerHeight})');assert size['client']==375 and size['inner']==375 and size['height']==812;assert size['scroll']<=size['client']+1;cli_call('screenshot',str(output/'mobile-375-viewport.png'));cli_call('set','viewport','1440','1100');return {'dom':d,'size':size}
 step('mobile-375',mobile)
 def late():
  control('/delay-read',{'workId':fixture['workId']});until(lambda:control('/delay-status',method='GET').get('waiting'),20);cli_call('open',fixture['other']['url']);cli_call('snapshot','-i');d=until(lambda:dom() if dom().get('work')=='none' else None);assert not d['values'];control('/release-read');time.sleep(.3);assert not dom()['values'];assert dom()['work']=='none';cli_call('open',fixture['url']);restored=until(lambda:dom() if dom().get('values')=={'netEquity':'43 USD','leverage':'3.5 multiple'} else None);assert restored['work']==fixture['workId'];return {'other':d,'restored':restored,'actualDelayedResponseRefused':True}
 step('late-authenticated-response-cannot-cross-thread',late)
 def corrected():
  correction=control('/correct');d=until(lambda:dom() if not dom().get('values') and 'invalidated' in dom().get('text','').lower() else None,30);assert not d['values'];return {'correction':correction,'dom':d}
 step('source-correction-withholds-current-values',corrected)
 def revoked():
  control('/revoke');d=until(lambda:dom() if dom().get('search')=='none' and not dom().get('values') and 'Inspect computation evidence' not in dom().get('text','') else None,30);assert not d['values'];assert 'Inspect computation evidence' not in d.get('text','');return d
 step('revoked-access-clears-private-witness',revoked)
 errors=cli_call('errors');steps.append({'id':'actual-page-errors','status':'PASS' if not errors.get('errors',[]) else 'FAIL','observed':errors});assert not errors.get('errors',[])
except Exception as e:
 print(str(e),file=sys.stderr)
 if not any(s['status']=='FAIL' for s in steps):steps.append({'id':'unhandled-browser-boundary','status':'FAIL','error':str(e)})
finally:
 save()
 try:cli_call('close')
 except Exception:pass
 try:control('/release-read');control('/stop')
 except Exception:pass
 save();print(json.dumps({'output':str(output),'steps':[{k:s.get(k) for k in ['id','status','error']}for s in steps]}))
 if any(s['status']=='FAIL' for s in steps):raise SystemExit(1)
