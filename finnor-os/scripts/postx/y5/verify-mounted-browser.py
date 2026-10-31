"""U1 real assigned-pane keyboard E2E. See mounted-browser-contract.md."""
import hashlib, json, os, pathlib, select, subprocess, sys, time, uuid

evidence = pathlib.Path(sys.argv[1]).resolve()
ready = json.loads((evidence / 'mounted-ready.json').read_text())
inputs = json.loads((evidence / 'owner-input.json').read_text())
control_dir = pathlib.Path(ready['controlDirectory'])
browser = '/Users/paramdave/.factory/bin/agent-browser'
assert os.environ.get('FACTORY_DESKTOP_CDP_PORT') and os.environ.get('AGENT_BROWSER_CDP')
assert os.environ.get('AGENT_BROWSER_SESSION'), 'Preserve the assigned desktop session'
base = [browser, '--cdp', os.environ['AGENT_BROWSER_CDP']]
started = time.monotonic()
deadline = started + 600
cleanup_deadline = None
actions, checks = [], []
sequence = 0
run_tag = uuid.uuid4().hex[:8]
held = intercepted = suspended = False
pattern = '**/api/centropy/**'
seeds = {item['name']: item for item in ready['seeds']}
report = {'schema': 'finnor.y5.assigned-browser.v1', 'status': 'IN_PROGRESS',
          'build': ready['frontendIdentity'], 'inputSha256': hashlib.sha256(
              (evidence / 'owner-input.json').read_bytes()).hexdigest(),
          'assignedDesktopSession': True, 'authBypass': False,
          'activation': 'RENDERED_DOM_CLICK_AFTER_VISIBLE_NATIVE_KEY_GUARD',
          'authenticatedContinuation': '--authenticated' in sys.argv,
          'screenshots': 'NOT_VERIFIED_PRIOR_CAPTURE_TIMEOUT',
          'crossPrincipalLogin': 'NOT_RUN', 'actions': actions, 'checks': checks}

def save(name, value):
    path = evidence / ('browser-run-' + run_tag + '-' + name)
    path.write_text(value if isinstance(value, str) else json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)

def run(*args):
    if cleanup_deadline is not None:
        assert args == ('network', 'unroute', pattern), 'U1_CLEANUP_ONLY_NO_PRODUCT_WORK'
    remaining = (cleanup_deadline if cleanup_deadline is not None else deadline) - time.monotonic()
    assert remaining > 0, 'U1_ORIGINAL_ORCHESTRATION_DEADLINE'
    begin = time.monotonic()
    result = subprocess.run(base + list(args), capture_output=True, text=True,
                            timeout=min(45, remaining))
    actions.append({'command': args[0], 'exitCode': result.returncode,
                    'wallMs': round((time.monotonic()-begin)*1000),
                    'stdoutSha256': hashlib.sha256(result.stdout.encode()).hexdigest()})
    assert result.returncode == 0, result.stderr or result.stdout
    return result.stdout.strip()

def snapshot(name=None):
    data = json.loads(run('--json', 'snapshot', '-i'))['data']
    if name:
        save('browser-' + name + '.txt', data['snapshot'] + '\n')
    return data

def element(role, name, prefix=False):
    refs = snapshot()['refs']
    found = [key for key, value in refs.items() if value['role'] == role and
             (value['name'].startswith(name) if prefix else value['name'] == name)]
    assert len(found) == 1, 'Expected one rendered %s %s, got %s' % (role, name, found)
    return '@' + found[0]

def button(name, prefix=False):
    run('focus', element('button', name, prefix))
    run('press', 'Shift')
    run('eval', """(() => {
      const name=%s, prefix=%s;
      const found=Array.from(document.querySelectorAll('button')).filter(b=>{
       const label=(b.getAttribute('aria-label')||b.textContent||'').trim().replace(/\\s+/g,' ');
       return !b.disabled&&b.getClientRects().length&&(prefix?label.startsWith(name):label===name);
      });
      if(found.length!==1)throw Error('U1_UNIQUE_RENDERED_BUTTON_REQUIRED');
      found[0].click(); return {activated:name,method:'RENDERED_DOM_CLICK'};
    })()""" % (json.dumps(name), 'true' if prefix else 'false'))

def waitjs(expression):
    run('wait', '--fn', expression)

def watched(path, predicate, seconds=30):
    """Await bounded filesystem events, not a background process/status poll."""
    target = path if path.exists() else path.parent
    fd = os.open(str(target), os.O_RDONLY)
    queue = select.kqueue()
    queue.control([select.kevent(fd, filter=select.KQ_FILTER_VNODE,
        flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
        fflags=select.KQ_NOTE_WRITE | select.KQ_NOTE_RENAME)], 0, 0)
    until = min(cleanup_deadline if cleanup_deadline is not None else deadline,
                time.monotonic() + seconds)
    try:
        while True:
            try:
                value = json.loads(path.read_text())
                if predicate(value):
                    return value
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            remaining = until - time.monotonic()
            assert remaining > 0, 'U1_CONTROL_ACK_DEADLINE:' + path.name
            queue.control(None, 1, remaining)
    finally:
        queue.close()
        os.close(fd)

def control(operation):
    global sequence
    if cleanup_deadline is not None:
        assert operation in ('release-read', 'resume-principal'), 'U1_CLEANUP_ONLY_NO_PHASE_ADVANCE'
        assert time.monotonic() < cleanup_deadline, 'U1_CLEANUP_DRAIN_DEADLINE'
    sequence += 1
    name = 'browser-%s-%02d-%s' % (run_tag, sequence, operation)
    with (control_dir / (name + '.json')).open('x') as output:
        json.dump({'operation': operation}, output)
    return watched(control_dir / (name + '.result.json'), lambda value: True)['canonical']

def panel():
    return run('get', 'text', '.ct-uniform-algorithm') if run('get', 'count', '.ct-uniform-algorithm') != '0' else run('read')

def canvas():
    if not any(value['role'] == 'main' and value['name'] == 'Investigation Canvas'
               for value in snapshot()['refs'].values()):
        button('Canvas')
    waitjs("!!document.querySelector('[aria-label=\"Focus Enterprise application\"]:not([disabled])')")
    button('Focus Enterprise application')
    waitjs("!!document.querySelector('.ct-uniform-algorithm')")

def checked():
    waitjs("document.querySelector('.ct-uniform-algorithm')?.getAttribute('data-y5-id')===" +
           json.dumps(ready['discoveryId']))

def private_clear():
    waitjs("!document.querySelector('.ct-uniform-algorithm') || " +
           "document.querySelector('.ct-uniform-algorithm').getAttribute('data-y5-id')==='none'")

try:
    if '--authenticated' not in sys.argv:
        run('open', ready['origin'] + '/centropy/login')
        run('fill', element('textbox', 'EMAIL'), 'y5-public-development@s5.example.test')
        run('fill', element('textbox', 'PASSWORD'), 'r1-disposable-only')
        button('Sign in')
        waitjs("location.pathname!=='/centropy/login'")
    run('open', ready['origin'] + '/centropy/investigations/' + seeds['checked']['threadId'])
    waitjs("!!document.querySelector('[aria-label=\"CENTROPY conversation\"], [aria-label=\"Investigation Canvas\"]')")
    canvas()
    checked()
    before = control('snapshot')
    save('browser-current.txt', panel())
    assert 'CHECKED' in panel()
    checks.append({'id': 'real-auth-work-canvas', 'status': 'PASS'})

    run('focus', '.ct-uniform-algorithm > details:nth-of-type(1) > summary')
    run('press', 'Enter')
    run('fill', element('textbox', 'Complete current allocation input JSON'),
        json.dumps(inputs['request']['allocation'], separators=(',', ':')))
    button('Use proved algorithm with fresh original-space checks')
    waitjs("document.querySelector('.ct-uniform-algorithm')?.innerText.includes('\"objective\": \"5\"')")
    after = control('snapshot')
    assert after['discovery']['use_count'] == before['discovery']['use_count'] + 1
    new = [use for use in after['uses'] if use['id'] not in {u['id'] for u in before['uses']}]
    assert len(new) == 1 and new[0]['status'] == 'COMPLETE'
    body = new[0]['body']
    assert body['result']['check']['feasible'] and body['result']['check']['objective'] == '5'
    assert body['actualMethod'] == json.loads((evidence / 'use.json').read_text())['actualMethod']
    assert after['effects'] == before['effects'] and after['reservations'] == before['reservations']
    save('browser-use-response.txt', panel())
    checks.append({'id': 'actual-proved-use-original-space-sql', 'status': 'PASS', 'useId': new[0]['id']})

    held = True
    control('hold-read')
    button('Reload uniform algorithm')
    for attempt in range(8):
        barrier = control('snapshot')
        if barrier['heldResponseWaiting']:
            break
    assert barrier['heldResponseWaiting'], 'Actual original-owner read must reach the held wire'
    button('Investigations')
    button(seeds['fresh']['title'], prefix=True)
    waitjs("location.pathname.endsWith(" + json.dumps(seeds['fresh']['threadId']) + ")")
    canvas()
    waitjs("document.querySelector('.ct-uniform-algorithm')?.innerText.includes('No uniform algorithm discovery')")
    assert run('get', 'attr', '.ct-uniform-algorithm', 'data-y5-work') == seeds['fresh']['workId']
    control('release-read')
    held = False
    private_clear()
    assert ready['discoveryId'] not in panel()
    save('browser-fresh-after-late-read.txt', panel())
    unchanged = control('snapshot')
    assert unchanged['discovery']['use_count'] == after['discovery']['use_count']
    assert unchanged['effects'] == after['effects'] and unchanged['reservations'] == after['reservations']
    checks.append({'id': 'actual-late-read-work-switch', 'status': 'PASS'})

    run('open', ready['origin'] + '/centropy/investigations/' + seeds['checked']['threadId'])
    canvas()
    checked()
    intercepted = True
    run('network', 'route', pattern, '--abort')
    button('Reload uniform algorithm')
    private_clear()
    save('browser-transport-unavailable.txt', panel())
    run('network', 'unroute', pattern)
    intercepted = False
    button('Refresh Canvas sources')
    canvas()
    checked()
    save('browser-reconnected.txt', panel())
    checks.append({'id': 'real-transport-loss-clear-and-reconnect', 'status': 'PASS'})
    control('finish-phase')
    watched(evidence / 'mounted-phase.json', lambda value: value['phase'] == 'withdrawn', 180)
    button('Reload uniform algorithm')
    checked()
    waitjs("document.querySelector('.ct-uniform-algorithm')?.innerText.includes('not current')")
    assert not any(value['name'] == 'Use proved algorithm with fresh original-space checks'
                   for value in snapshot()['refs'].values())
    save('browser-p7-withdrawn.txt', panel())
    checks.append({'id': 'p7-s8-s6-currentness-and-no-use', 'status': 'PASS'})
    withdrawn = control('snapshot')

    suspended = True
    control('suspend-principal')
    button('Reload uniform algorithm')
    private_clear()
    save('browser-principal-suspended.txt', run('read'))
    assert ready['discoveryId'] not in run('read')
    checks.append({'id': 'actual-principal-revocation-private-clear', 'status': 'PASS'})
    control('resume-principal')
    suspended = False
    restored = control('snapshot')
    assert next(user for user in restored['principals'] if user['id'] == ready['principal'])['status'] == 'active'
    assert any(row['status'] == 'compiled' for row in restored['effects'])
    assert any(row['status'] == 'UNKNOWN_OUTCOME' for row in restored['reservations'])
    assert restored['effects'] == withdrawn['effects'] and restored['reservations'] == withdrawn['reservations']
    control('finish-phase')
    report['status'] = 'PASS_SCOPED_FUNCTIONAL_BROWSER_NOT_PROTECTED_QUALIFICATION'
except Exception as error:
    report['status'] = 'BLOCKED' if 'pane is hidden' in str(error) else 'FAIL'
    report['error'] = str(error)
    raise
finally:
    cleanup_deadline = time.monotonic() + 15
    report['cleanup'] = {'scope': 'OWN_INTERCEPTION_HELD_READ_DISPOSABLE_PRINCIPAL_ONLY',
                         'maxWallMs': 15000, 'episodeRenewed': False, 'receipts': [],
                         'possiblyAppliedFaults': {'intercepted': intercepted, 'held': held, 'suspended': suspended}}
    if intercepted:
        try:
            run('network', 'unroute', pattern)
            intercepted = False
            report['cleanup']['receipts'].append({'operation': 'unroute', 'status': 'RESTORED'})
        except Exception as error:
            report['interceptionCleanupError'] = str(error)
    if held:
        try:
            control('release-read')
            held = False
            report['cleanup']['receipts'].append({'operation': 'release-read', 'status': 'RESTORED'})
        except Exception as error:
            report['heldReadCleanupError'] = str(error)
    if suspended:
        try:
            control('resume-principal')
            suspended = False
            report['cleanup']['receipts'].append({'operation': 'resume-principal', 'status': 'RESTORED'})
        except Exception as error:
            report['principalCleanupError'] = str(error)
    if any(key in report for key in ('interceptionCleanupError', 'heldReadCleanupError', 'principalCleanupError')):
        if report['status'].startswith('PASS'):
            report['status'] = 'FAIL_CLEANUP'
    report['cleanup']['remainingFaults'] = {'intercepted': intercepted, 'held': held, 'suspended': suspended}
    report['wallMs'] = round((time.monotonic() - started) * 1000)
    report['protectedAdmission'] = False
    report['productionActive'] = False
    save('browser-report.json', report)
    print(json.dumps({'status': report['status'], 'wallMs': report['wallMs'], 'checks': checks}))
