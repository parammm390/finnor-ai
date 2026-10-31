"""Owning W1 browser journey. Real UI/auth/API/worker/SQL, no business mocks."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlparse
from datetime import datetime, timezone

base = Path(sys.argv[1]).resolve(strict=True)
fixture = json.loads((base / "fixture.json").read_text())
output = base / "run"
output.mkdir(exist_ok=False)
cli = Path(os.environ.get("FINNOR_AGENT_BROWSER") or shutil.which("agent-browser")).resolve(strict=True)
cdp = os.environ.get("FINNOR_W1_HEADED_CDP")
session = os.environ.get("FINNOR_W1_HEADED_SESSION")
if not cdp or not session or not session.startswith("w1-headed-"):
    raise SystemExit("SEPARATELY_OWNED_HEADED_BROWSER_REQUIRED")
environment = {k: v for k, v in os.environ.items() if k in ("HOME", "PATH", "TMPDIR")}
config = output / "agent-browser.json"
config.write_text("{}\n")
required = [
    "same-Work-no-automatic-submit", "explicit-native-execution", "actual-policy-and-unknown-cost",
    "canonical-reload", "delayed-thread-response", "company-and-Work-switch",
    "offline-reconnect", "actual-token-refresh", "logout-new-sign-in",
    "different-principal-no-resurrection", "source-correction", "revoked-access",
]
commands, steps = [], []
started = datetime.now(timezone.utc).isoformat()


def browser(*arguments):
    command = [str(cli), "--config", str(config), "--session", session, "--json"]
    command += ["--cdp", cdp]
    command += list(map(str, arguments))
    run = subprocess.run(command, env=environment, text=True, capture_output=True, timeout=45)
    try:
        result = json.loads(run.stdout)
    except ValueError:
        result = {"stdout": run.stdout}
    safe = [str(cli), "<separately-owned-headed>", *map(str, arguments)]
    if arguments and (arguments[0] == "fill" or arguments[:2] == ("keyboard", "type")):
        safe[-1] = "<disposable-field-value>"
    commands.append({"command": safe, "exitCode": run.returncode, "response": result,
                     "stderr": run.stderr, "at": datetime.now(timezone.utc).isoformat()})
    if run.returncode or result.get("success") is False:
        raise AssertionError(str(result))
    return result.get("data", result)


def evaluate(expression):
    assert not any(word in expression for word in
        ("dispatchEvent", "pushState", "replaceState", "localStorage", "sessionStorage",
         ".click(", ".focus(", ".setAttribute(", ".value=")), "READ_ONLY_DOM_INSPECTION_ONLY"
    result = browser("eval", expression)
    return result.get("result", result) if isinstance(result, dict) else result


def until(predicate, seconds=35):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(.25)
    raise AssertionError("ACTUAL_MOUNTED_OBSERVER_TIMEOUT")


def control(path, body=None):
    request = urllib.request.Request("http://127.0.0.1:4693" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"}, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode() or "{}")


def dom():
    return evaluate("""(()=>{
      const p=document.querySelector('.ct-economic-orchestration');
      const p2=document.querySelector('.ct-compute-search');
      return {present:!!p,work:p?.getAttribute('data-orchestration-work')??null,
       search:p?.getAttribute('data-orchestration-search')??null,text:p?.innerText??'',
       values:Object.fromEntries(Array.from(p?.querySelectorAll('dl > div')??[]).map(x=>
        [x.querySelector('dt')?.innerText,x.querySelector('dd')?.innerText])),
       proof:p?.querySelector('details[open] [data-compute-proof]')?.innerText??null,
       eligibleProgramIds:Array.from(p?.querySelector('select')?.options??[]).map(x=>x.value),
       p2Text:p2?.innerText??'',overlay:!!document.querySelector('[data-nextjs-dialog]'),
       timeOrigin:performance.timeOrigin,url:location.href};
    })()""")


def no_private_values():
    state = dom()
    return state if not state["values"] and not state["proof"] else None


def accepted():
    state = dom()
    return state if state["values"] == {"netEquity": "43 USD", "leverage": "3.5 multiple"} else None


def save():
    complete = [s["id"] for s in steps if s["status"] == "PASS"] == required
    result = {"schema": "finnor.w1.mounted-e2e.v1", "startedAt": started,
        "finishedAt": datetime.now(timezone.utc).isoformat(),
        "status": "PASS_LOCAL" if complete else "FAIL", "required": required, "steps": steps,
        "commands": commands, "runtime": {"cli": str(cli),
            "cliSha256": hashlib.sha256(cli.read_bytes()).hexdigest(),
            "assignedDesktop": False, "ownedHeaded": True, "headless": False,
            "UIActions": "CDP_MOUSE_KEYBOARD_AND_VISIBLE_NAVIGATION_NO_STATE_INJECTION"},
        "profile": "LOCAL_SIGNED_AUTH_ACTUAL_API_RESTRICTED_PHYSICAL_WORKER_AND_CANONICAL_SQL",
        "protectedAdmission": False, "hostedSupabaseQualified": False, "costUSD": None,
        "rerun": "python3 finnor-os/scripts/postz-w1/headed-mounted-run.py <new absolute evidence>"}
    (output / "results.json").write_text(json.dumps(result, indent=2) + "\n")
    return complete


def step(name, action):
    try:
        observed = action()
        assert not dom()["overlay"], "ACTUAL_NEXT_RUNTIME_ERROR_OVERLAY"
        steps.append({"id": name, "status": "PASS", "observed": observed})
    except Exception as error:
        try:
            failed_dom = dom()
        except Exception as observer_error:
            failed_dom = {"observerError": str(observer_error)}
        steps.append({"id": name, "status": "FAIL", "error": str(error), "dom": failed_dom})
        try:
            (output / (name + ".auth.json")).write_text(json.dumps(control("/auth-observation"), indent=2) + "\n")
            diagnostic = evaluate("""(()=>({ready:document.readyState,bodyText:document.body.innerText,
              authResources:performance.getEntriesByType('resource').filter(x=>new URL(x.name).pathname.startsWith('/auth/v1/'))
               .map(x=>({path:new URL(x.name).pathname,duration:x.duration,status:x.responseStatus,bytes:x.transferSize}))}))()""")
            (output / (name + ".load.json")).write_text(json.dumps(diagnostic, indent=2) + "\n")
        except Exception:
            pass
        raise
    finally:
        try:
            browser("screenshot", str(output / (name + ".png")))
            (output / (name + ".dom.json")).write_text(json.dumps(browser("snapshot", "-i", "-c"), indent=2))
        except Exception:
            pass
        save()


def sign_in(credentials, initial=False):
    if initial:
        browser("open", "http://127.0.0.1:4690/centropy/login")
    else:
        browser("find", "role", "link", "click", "--name", "Sign in", "--exact")
    until(lambda: evaluate("!!document.querySelector('input[type=email]')"))
    for field in ("email", "password"):
        browser("click", "input[type=" + field + "]")
        browser("press", "Meta+A")
        browser("keyboard", "type", credentials[field])
    browser("find", "role", "button", "click", "--name", "Sign in")
    until(lambda: evaluate("location.pathname==='/centropy'"))


def sign_out():
    browser("find", "label", "Account menu", "click")
    browser("find", "role", "button", "click", "--name", "Sign out")
    return until(no_private_values)


def navigate_thread(target, title):
    before = dom()["timeOrigin"]
    browser("find", "role", "button", "click", "--name", "Investigations", "--exact")
    browser("find", "role", "button", "click", "--name", title)
    path = urlparse(target["url"]).path
    until(lambda: evaluate("location.pathname===" + json.dumps(path)))
    assert dom()["timeOrigin"] == before, "SCOPE_CHANGE_MUST_KEEP_THE_LIVE_DOCUMENT"


def return_to_original():
    navigate_thread(fixture, "W1 original allocated Work")
    return until(accepted)


def focus_transition():
    before = dom()
    label = "w1-focus-" + str(len(commands))
    browser("tab", "new", "--label", label, "about:blank")
    browser("tab", "close", label)
    until(lambda: evaluate("document.visibilityState==='visible'"))
    after = dom()
    assert after["url"] == before["url"] and after["timeOrigin"] == before["timeOrigin"]


def release_and_observe(delay_id):
    control("/release-read", {})
    def completed():
        return next((row for row in control("/delay-status")["history"]
                     if row["id"] == delay_id and row["finishedAt"]), None)
    observation = until(completed)
    assert observation["status"] == 200 and observation["workId"] == fixture["workId"]
    released_ms = datetime.fromisoformat(observation["releasedAt"].replace("Z", "+00:00")).timestamp() * 1000
    # Observe completion of a real browser fetch after release, not just the
    # fixture's res.end call or an assertion made before the old bytes arrived.
    expression = """performance.getEntriesByType('resource').some(entry=>
      new URL(entry.name).pathname==='/api/centropy/company-brain/economic-orchestration-projection'&&
      entry.responseStatus===200&&performance.timeOrigin+entry.responseEnd>=""" + str(released_ms) + ")"
    until(lambda: evaluate(expression))
    browser("wait", "--load", "networkidle")
    assert no_private_values(), "DELAYED_OLD_RESPONSE_MUST_NOT_RESTORE_PRIVATE_VALUES"
    return {"delay": observation, "afterCompletedBrowserFetch": dom()}


try:
    def initial():
        sign_in(fixture, initial=True)
        navigate_thread(fixture, "W1 original allocated Work")
        def eligible():
            state = dom()
            return state if state["work"] == fixture["workId"] and \
                "Run economic orchestration" in state["text"] else None
        state = until(eligible)
        assert not state["values"]
        assert fixture["programId"] in state["eligibleProgramIds"], "M1_FRESH_ELIGIBLE_PROGRAMME_REQUIRED"
        assert "ADAPTIVE" in evaluate("Array.from(document.querySelectorAll('.ct-compute-search option')).map(x=>x.value).join(',')")
        observation = control("/observation")
        assert not observation["plans"], "RENDER_MUST_NOT_SUBMIT_THE_NEW_ORIGINAL_PROGRAM"
        historical = {row["id"] for row in observation["historicalPlans"]}
        projections = [row for row in control("/traffic-observation")["traffic"]
                       if row.get("projection") and row["projection"]["workId"] == fixture["workId"]]
        stale = [row for response in projections for row in response["projection"]["searches"]
                 if row["searchId"] in historical and row.get("status") == "INVALIDATED"]
        assert stale, "M1_ACTUAL_INVALIDATED_HISTORICAL_SEARCH_REQUIRED"
        return {"dom": state, "canonical": observation,
                "M1": {"staleHistoricalSearches": stale, "freshProgrammeRetained": fixture["programId"]}}
    step(required[0], initial)

    def execute():
        browser("scrollintoview", ".ct-economic-orchestration")
        browser("find", "role", "button", "click", "--name", "Run economic orchestration")
        state = until(accepted, 85)
        observation = control("/observation")
        assert observation["oracle"]["equity"] == "43"
        assert observation["program"][0]["status"] == "TESTED"
        assert state["work"] == fixture["workId"]
        assert state["search"] == observation["plans"][0]["id"]
        assert "USD cost is unknown" in state["text"]
        assert "model-relative" in state["text"]
        return {"dom": state, "independentSql": observation}
    step(required[1], execute)

    def witness():
        browser("find", "role", "button", "click", "--name", "Inspect orchestration evidence")
        def proof_visible():
            state = dom()
            return state if state["proof"] else None
        state = until(proof_visible)
        proof = json.loads(state["proof"])
        assert proof["computeGrant"]["owner"] == "S5"
        assert proof["costs"]["usd"] is None
        assert proof["nativeReader"]["measurementGaps"]
        assert proof["orchestrationPolicyRef"]["contentDigest"] in control("/observation")["capsuleDigests"]
        assert evaluate("document.activeElement?.hasAttribute('data-compute-proof')")
        independent = control("/native-oracle")
        assert independent["status"] == "PASS"
        return {"proof": proof, "focused": True, "independentNative": independent}
    step(required[2], witness)

    def reload_original():
        before = dom()
        browser("open", fixture["url"])  # Never reload the desktop application.
        state = until(accepted)
        assert state["search"] == before["search"] and state["work"] == before["work"]
        return state
    step(required[3], reload_original)

    def delayed_thread():
        delay = control("/delay-read", {"workId": fixture["workId"]})
        focus_transition()
        until(lambda: control("/delay-status")["waiting"])
        origin = dom()["timeOrigin"]
        navigate_thread(fixture["other"], "W1 empty thread")
        state = until(no_private_values)
        assert state["work"] != fixture["workId"]
        after = release_and_observe(delay["id"])
        assert after["afterCompletedBrowserFetch"]["timeOrigin"] == origin
        return {"other": state, "completedOldResponse": after, "restored": return_to_original()}
    step(required[4], delayed_thread)

    def switch_scope():
        states = []
        for target, title in ((fixture["otherCompany"], "W1 separate company"),
                              (fixture["otherWork"], "W1 separate Work")):
            navigate_thread(target, title)
            state = until(no_private_values)
            assert state["search"] in (None, "none")
            states.append(state)
            return_to_original()
        return states
    step(required[5], switch_scope)

    def reconnect():
        browser("set", "offline", "on")
        try:
            state = until(no_private_values)
        finally:
            browser("set", "offline", "off")
        return {"offline": state, "reconstructed": until(accepted)}
    step(required[6], reconnect)

    def refresh_token():
        before = control("/auth-observation")
        focus_transition()
        def refreshed():
            observed = control("/auth-observation")
            return observed if observed["refreshes"] > before["refreshes"] and \
                observed["distinctTokenDigests"] > before["distinctTokenDigests"] else None
        after = until(refreshed, 100)
        state = until(accepted)
        assert after["distinctTokenDigests"] > before["distinctTokenDigests"]
        return {"before": before, "after": after, "dom": state}
    step(required[7], refresh_token)

    def logout_signin():
        out = sign_out()
        sign_in(fixture)
        return {"signedOut": out, "restored": return_to_original()}
    step(required[8], logout_signin)

    def principal():
        origin = dom()["timeOrigin"]
        delay = control("/delay-read", {"workId": fixture["workId"]})
        focus_transition()
        until(lambda: control("/delay-status")["waiting"])
        sign_out()
        sign_in(fixture["otherPrincipal"])
        # Browser Back is a real user action to the previous private route.
        # The login link and redirect used the actual same-document router.
        browser("back")
        until(lambda: evaluate("location.pathname===" + json.dumps(urlparse(fixture["url"]).path)))
        state = until(no_private_values)
        after = release_and_observe(delay["id"])
        assert after["afterCompletedBrowserFetch"]["timeOrigin"] == origin
        # The second principal has its own real thread so its account control is usable.
        navigate_thread(fixture["otherPrincipal"], "W1 other principal")
        until(lambda: evaluate("!!document.querySelector('.ct-account')"))
        sign_out()
        sign_in(fixture)
        return {"foreignPrincipal": state, "restored": return_to_original(),
                "completedOldResponse": after, "transport": control("/auth-observation")}
    step(required[9], principal)

    def correction():
        corrected = control("/correct", {})
        state = until(no_private_values)
        assert "invalidat" in state["text"].lower() or state["search"] in (None, "none")
        return {"ownerCorrection": corrected, "dom": state}
    step(required[10], correction)

    def revoke():
        control("/revoke", {})
        focus_transition()
        def revoked():
            state = no_private_values()
            return state if state and state["search"] in (None, "none") else None
        return until(revoked)
    step(required[11], revoke)
finally:
    try:
        browser("set", "offline", "off")
    except Exception:
        pass
    try:
        control("/release-read", {})
        control("/stop", {})
    except Exception:
        pass
    try:
        browser("close")
    except Exception:
        pass
    complete = save()
    print(json.dumps({"output": str(output), "complete": complete,
                      "steps": [{"id": s["id"], "status": s["status"]} for s in steps]}))
    if not complete:
        raise SystemExit(1)
