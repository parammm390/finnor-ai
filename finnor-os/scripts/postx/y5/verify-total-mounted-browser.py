"""Real assigned-pane v2 E2E. Contract: total-mounted-browser-contract.md."""
import argparse
import hashlib
import json
import os
import pathlib
import select
import shutil
import subprocess
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("evidence")
parser.add_argument("--authenticated", action="store_true")
parser.add_argument("--exclusive-browser-grant", action="store_true", required=True)
parser.add_argument("--workspace-root", default=str(pathlib.Path(__file__).resolve().parents[4]))
args = parser.parse_args()
workspace = pathlib.Path(args.workspace_root).resolve()
assert workspace.is_dir()
evidence = pathlib.Path(args.evidence).resolve()
assert evidence.is_relative_to(workspace), "Evidence must remain inside this workspace"
ready = json.loads((evidence / "mounted-ready.json").read_text())
typed = ready["typed"]
assert typed["schema"] == "finnor.y5.total-mounted-context.v1"
assert ready["productionFrontend"] and not ready["authBypass"] and not ready["projectionHost"]
assert os.environ.get("FACTORY_DESKTOP_CDP_PORT") and os.environ.get("AGENT_BROWSER_CDP")
assert os.environ.get("AGENT_BROWSER_SESSION"), "Preserve the parent's assigned visible session"
browser = shutil.which("agent-browser") or str(pathlib.Path.home() / ".factory/bin/agent-browser")
assert pathlib.Path(browser).is_file()
base = [browser, "--cdp", os.environ["AGENT_BROWSER_CDP"]]
control_dir = pathlib.Path(ready["controlDirectory"]).resolve()
assert control_dir.is_relative_to(evidence)
run_tag = uuid.uuid4().hex
out = evidence / ("total-browser-" + run_tag)
out.mkdir(mode=0o700)
started = time.monotonic()
deadline = started + 600
cleanup_deadline = None
actions, checks = [], []
held = intercepted = suspended = False
sequence = 0
pattern = ready["origin"] + "/api/centropy/**"
seeds = {seed["name"]: seed for seed in ready["seeds"]}
panel_selector = '.ct-uniform-algorithm:visible'
use_label = "Use proved typed algorithm on recorded task Work"
report = {
    "schema": "finnor.y5.total-assigned-browser.v1", "status": "IN_PROGRESS",
    "build": ready["frontendIdentity"], "activation": "NATIVE_FOCUS_ENTER_OR_POINTER_ONLY",
    "inputSha256": hashlib.sha256((evidence / "mounted-ready.json").read_bytes()).hexdigest(),
    "helperSha256": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
    "authenticatedContinuation": args.authenticated, "authBypass": False,
    "protectedAdmission": False, "productionActive": False,
    "crossPrincipalLogin": "NOT_RUN", "hostedAuth": "NOT_QUALIFIED",
    "runningNativeCancellation": "NOT_TESTED_QUEUED_ONLY",
    "actions": actions, "checks": checks,
}


def save(name, value):
    path = out / name
    path.write_text(value if isinstance(value, str) else json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)
    return path


def run(*command, sensitive=False):
    if cleanup_deadline is not None:
        assert command == ("network", "unroute", pattern), "Cleanup cannot advance product work"
    remaining = (cleanup_deadline or deadline) - time.monotonic()
    assert remaining > 0, "ORIGINAL_600_SECOND_BROWSER_DEADLINE"
    begin = time.monotonic()
    action = {"command": command[0], "arguments": ["REDACTED_LOGIN_INPUT"] if sensitive else list(command[1:]),
              "wallMs": None, "exitCode": None}
    actions.append(action)
    try:
        result = subprocess.run(base + list(command), capture_output=True, text=True,
                                timeout=min(45, remaining))
        action.update(exitCode=result.returncode,
                      stdoutSha256=hashlib.sha256(result.stdout.encode()).hexdigest())
        if not sensitive:
            save("action-%03d.txt" % len(actions), result.stdout + "\n" + result.stderr)
        assert result.returncode == 0, result.stderr or result.stdout
        return result.stdout.strip()
    finally:
        action["wallMs"] = round((time.monotonic() - begin) * 1000)


def snapshot(name=None, screenshot=False):
    data = json.loads(run("--json", "snapshot", "-i"))["data"]
    if name:
        save(name + ".txt", data["snapshot"] + "\n")
    if screenshot:
        path = out / (name + ".png")
        run("screenshot", str(path))
        assert path.is_file() and path.stat().st_size > 0, "ACTUAL_SCREENSHOT_REQUIRED"
        path.chmod(0o600)
    return data


def element(role, name, prefix=False):
    refs = snapshot()["refs"]
    found = [key for key, value in refs.items() if value["role"] == role and
             (value["name"].startswith(name) if prefix else value["name"] == name)]
    assert len(found) == 1, "Expected unique visible %s %s, got %s" % (role, name, found)
    return "@" + found[0]


def button(name, prefix=False):
    run("focus", element("button", name, prefix))
    run("press", "Enter")
    snapshot()


def fill(name, value, sensitive=False):
    run("fill", element("textbox", name), value, sensitive=sensitive)
    if not sensitive:
        snapshot()


def disclosure(name):
    snapshot()
    run("click", panel_selector + " summary:text-is(" + json.dumps(name) + ")")
    snapshot()


def waitjs(expression):
    expression = expression.replace("document.querySelector('.ct-uniform-algorithm')",
                                   "Array.from(document.querySelectorAll('.ct-uniform-algorithm')).find(e=>e.getClientRects().length)")
    run("wait", "--fn", expression)


def watched(path, predicate, seconds=30):
    target = path if path.exists() else path.parent
    fd = os.open(str(target), os.O_RDONLY)
    queue = select.kqueue()
    queue.control([select.kevent(fd, filter=select.KQ_FILTER_VNODE,
                  flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                  fflags=select.KQ_NOTE_WRITE | select.KQ_NOTE_RENAME)], 0, 0)
    until = min(cleanup_deadline or deadline, time.monotonic() + seconds)
    try:
        while True:
            try:
                value = json.loads(path.read_text())
                if predicate(value):
                    return value
            except (FileNotFoundError, json.JSONDecodeError):
                pass
            remaining = until - time.monotonic()
            assert remaining > 0, "CONTROL_ACK_DEADLINE:" + path.name
            queue.control(None, 1, remaining)
    finally:
        queue.close()
        os.close(fd)


def control(operation, **fields):
    global sequence
    if cleanup_deadline is not None:
        assert operation in ("release-read", "resume-principal"), "Cleanup-only operation"
    sequence += 1
    name = "total-browser-%s-%03d-%s" % (run_tag, sequence, operation)
    with (control_dir / (name + ".json")).open("x") as output:
        json.dump({"operation": operation, **fields}, output)
    value = watched(control_dir / (name + ".result.json"), lambda value: True)
    save(name + ".json", value)
    return value["canonical"]


def panel():
    return run("get", "text", panel_selector)


def canvas():
    refs = snapshot()["refs"]
    if not any(value["role"] == "main" and value["name"] == "Investigation Canvas"
               for value in refs.values()):
        button("Canvas")
    waitjs("!!document.querySelector('[aria-label=\"Focus Enterprise application\"]:not([disabled])')")
    button("Focus Enterprise application")
    waitjs("!!document.querySelector('.ct-uniform-algorithm')")


def open_seed(name):
    run("open", ready["origin"] + "/centropy/investigations/" + seeds[name]["threadId"])
    waitjs("!!document.querySelector('[aria-label=\"CENTROPY conversation\"], [aria-label=\"Investigation Canvas\"]')")
    canvas()
    waitjs("document.querySelector('.ct-uniform-algorithm')?.getAttribute('data-y5-work')===" +
           json.dumps(seeds[name]["workId"]))


def checked():
    waitjs("document.querySelector('.ct-uniform-algorithm')?.getAttribute('data-y5-id')===" +
           json.dumps(ready["discoveryId"]))
    assert "CHECKED" in panel()


def private_clear():
    waitjs("!document.querySelector('.ct-uniform-algorithm') || "
           "document.querySelector('.ct-uniform-algorithm').getAttribute('data-y5-id')==='none'")


def unchanged(before, after):
    assert before["effects"] == after["effects"]
    assert before["reservations"] == after["reservations"]


def additive_oracle(values):
    definition = typed["specification"]["definition"]
    assert definition["safe"] == {"op": "LE", "left": {"op": "INT", "value": "0"},
                                  "right": {"op": "VAR", "index": 0}}
    assert definition["advance"] == {"op": "ADD", "left": {"op": "VAR", "index": 0},
                                     "right": {"op": "VAR", "index": 1}}
    prefix, minimum = 0, 0
    for value in values:
        assert str(int(value)) == value, "CANONICAL_EXACT_INTEGER_REQUIRED"
        prefix += int(value)
        minimum = min(minimum, prefix)
    return str(-minimum)


try:
    if not args.authenticated:
        run("open", ready["origin"] + "/centropy/login")
        snapshot("login-before")
        fill("EMAIL", typed["loginEmail"], sensitive=True)
        fill("PASSWORD", "r1-disposable-only", sensitive=True)
        button("Sign in")
        waitjs("location.pathname!=='/centropy/login'")
    open_seed("checked")
    checked()
    text = panel()
    assert "Semantic acceptance: PUBLIC_DEVELOPMENT" in text
    assert typed["specification"]["sourceRef"]["contentDigest"] in text
    snapshot("checked-definition", screenshot=True)
    before = control("snapshot")
    assert before["discovery"]["use_count"] == 2, "Original owner two-use oracle must run first"
    checks.append({"id": "real-installed-work-definition", "status": "PASS"})

    draft = typed["tasks"][1]["workId"][:-3]
    mark = before["transportSequence"]
    fill("Recorded task Work ID", draft)
    polled = control("await-polls", after=mark)
    assert run("get", "value", element("textbox", "Recorded task Work ID")) == draft
    reads = [entry for entry in polled["transport"] if entry["path"].endswith("/read")]
    assert reads and all(not entry["input"].get("includeCapsule") and
                         not entry["input"].get("includeHistory") for entry in reads)
    assert all(entry["responseBytes"] <= 262144 for entry in reads if entry["complete"])
    snapshot("draft-after-two-lightweight-polls", screenshot=True)
    checks.append({"id": "actual-draft-and-lightweight-polls", "status": "PASS"})

    button("Load proof evidence")
    waitjs("document.querySelector('.ct-uniform-algorithm')?.innerText.includes('Proof evidence explicitly loaded')")
    disclosure("Theorem, implementation, imports, axioms and reuse")
    assert before["discovery"]["result_digest"] in panel()
    loaded = control("snapshot")
    assert any(entry["complete"] and entry["status"] == 200 and
               entry["input"].get("includeCapsule") is True and
               entry["input"].get("includeHistory") is True
               for entry in loaded["transport"] if entry["path"].endswith("/read"))
    snapshot("explicit-owner-proof", screenshot=True)
    checks.append({"id": "real-lazy-capsule-evidence", "status": "PASS"})

    previous = loaded
    for index, task in enumerate(typed["tasks"]):
        expected = additive_oracle(task["values"])
        assert expected == task["expected"]
        fill("Recorded task Work ID", task["workId"])
        button(use_label)
        waitjs("document.querySelector('.ct-uniform-algorithm')?.innerText.includes(" +
               json.dumps('"value": "' + expected + '"') + ")")
        after = control("snapshot")
        new = [use for use in after["uses"] if use["id"] not in {use["id"] for use in previous["uses"]}]
        assert len(new) == 1 and new[0]["status"] == "COMPLETE"
        body = new[0]["body"]
        assert body["status"] == "CHECKED" and body["actualMethod"] == "Y5_SAME_LEAN_TOTAL_DEFINITION"
        assert body["result"]["value"] == expected and body["originalCheck"]["feasible"]
        assert body["result"]["operations"] >= 0
        assert not body["reservationCreated"] and body["s6EffectsCreated"] == []
        assert not body["protectedAdmission"] and not body["executionAuthorityGranted"]
        text = panel()
        assert "Exact least feasible initial integer: " + expected in text
        assert "Counted AST and fold operations: " + str(body["result"]["operations"]) in text
        assert after["discovery"]["use_count"] == previous["discovery"]["use_count"] + 1
        unchanged(before, after)
        snapshot("typed-use-%d" % (index + 1), screenshot=True)
        checks.append({"id": "real-typed-use-%d" % (index + 1), "status": "PASS",
                       "useId": new[0]["id"], "expected": expected,
                       "nativeOperations": body["result"]["operations"]})
        previous = after

    held = True
    held_mark = control("hold-read")["transportSequence"]
    button("Reload uniform algorithm")
    control("await-held")
    button("Investigations")
    button(seeds["fresh"]["title"], prefix=True)
    waitjs("location.pathname.endsWith(" + json.dumps(seeds["fresh"]["threadId"]) + ")")
    canvas()
    waitjs("document.querySelector('.ct-uniform-algorithm')?.innerText.includes('No uniform algorithm discovery')")
    control("release-read")
    held = False
    control("await-late-read", after=held_mark)
    assert run("get", "attr", panel_selector, "data-y5-work") == seeds["fresh"]["workId"]
    private_clear()
    text = panel()
    assert ready["discoveryId"] not in text
    assert typed["specification"]["sourceRef"]["contentDigest"] not in text
    assert not any(value["name"] == "Recorded task Work ID" for value in snapshot()["refs"].values())
    snapshot("fresh-after-real-late-read", screenshot=True)
    unchanged(before, control("snapshot"))
    checks.append({"id": "real-held-read-work-switch", "status": "PASS"})

    open_seed("checked")
    checked()
    intercepted = True
    run("network", "route", pattern, "--abort")
    button("Reload uniform algorithm")
    private_clear()
    snapshot("actual-transport-loss", screenshot=True)
    run("network", "unroute", pattern)
    intercepted = False
    button("Refresh Canvas sources")
    canvas()
    checked()
    checks.append({"id": "transport-clear-real-reconnect", "status": "PASS"})

    open_seed("cancel")
    waitjs("document.querySelector('.ct-uniform-algorithm')?.innerText.includes('No uniform algorithm discovery')")
    fill("Recorded task Work ID", typed["cancel"]["taskWorkId"])
    button("Queue typed discovery under original Work")
    waitjs("document.querySelector('.ct-uniform-algorithm')?.innerText.includes('QUEUED')")
    queued = control("snapshot")
    assert len(queued["relatedDiscoveries"]) == 1
    campaign = queued["relatedDiscoveries"][0]
    assert campaign["status"] == "QUEUED" and campaign["attempt_count"] == 0
    disclosure("Cancel or P7 invalidate, retaining history and costs")
    button("Cancel original discovery")
    waitjs("document.querySelector('.ct-uniform-algorithm')?.innerText.includes('CANCELLED')")
    cancelled = control("snapshot")
    stopped = cancelled["relatedDiscoveries"][0]
    assert stopped["status"] == "CANCELLED" and stopped["generation"] > campaign["generation"]
    for key in ("attempt_count", "use_count", "max_attempts", "max_uses", "deadline_at"):
        assert stopped[key] == campaign[key]
    assert any(event["discovery_id"] == stopped["id"] and event["kind"] == "CANCELLED"
               for event in cancelled["cancellationEvents"])
    unchanged(before, cancelled)
    snapshot("actual-queued-cancellation", screenshot=True)
    checks.append({"id": "real-ui-submit-and-queued-cancel", "status": "PASS", "discoveryId": stopped["id"]})

    open_seed("checked")
    checked()
    save("current-phase.json", {"status": "CURRENT_PHASE_CHECKS_COMPLETE", "checks": checks})
    control("finish-phase")
    watched(evidence / "mounted-phase.json", lambda value: value["phase"] == "withdrawn", 180)
    button("Reload uniform algorithm")
    waitjs("document.querySelector('.ct-uniform-algorithm')?.innerText.includes('not current')")
    assert not any(value["name"] == use_label for value in snapshot()["refs"].values())
    snapshot("original-owner-withdrawal", screenshot=True)
    checks.append({"id": "original-source-p7-no-use", "status": "PASS"})

    suspended = True
    control("suspend-principal")
    button("Reload uniform algorithm")
    private_clear()
    snapshot("real-principal-revocation", screenshot=True)
    assert ready["discoveryId"] not in run("read")
    restored = control("resume-principal")
    suspended = False
    assert next(user for user in restored["principals"] if user["id"] == ready["principal"])["status"] == "active"
    unchanged(before, restored)
    checks.append({"id": "real-principal-revocation-restored", "status": "PASS"})
    final = control("snapshot")
    assert final["discovery"]["use_count"] == before["discovery"]["use_count"] + 2
    for entry in final["transport"]:
        if entry["path"].endswith("/consume-total"):
            assert set(entry["input"]) == {"discoveryId", "taskWorkId", "idempotencyKey"}
        if entry["path"].endswith("/submit-total"):
            assert set(entry["input"]) == {"schema", "root", "workId", "taskWorkId", "idempotencyKey", "limits", "baselineManifestRef"}
    control("finish-phase")
    report["status"] = "PASS_SCOPED_FUNCTIONAL_TYPED_BROWSER_NOT_PROTECTED_QUALIFICATION"
except Exception as error:
    report["status"] = "BLOCKED" if "pane is hidden" in str(error) else "FAIL"
    report["error"] = str(error)
    raise
finally:
    cleanup_deadline = time.monotonic() + 15
    cleanup = []
    for active, operation in ((intercepted, "unroute"), (held, "release-read"), (suspended, "resume-principal")):
        if active:
            try:
                if operation == "unroute":
                    run("network", "unroute", pattern)
                    intercepted = False
                else:
                    control(operation)
                    if operation == "release-read":
                        held = False
                    else:
                        suspended = False
                cleanup.append({"operation": operation, "status": "RESTORED"})
            except Exception as error:
                cleanup.append({"operation": operation, "status": "FAIL", "error": str(error)})
    report["cleanup"] = {"maxWallMs": 15000, "episodeRenewed": False, "receipts": cleanup,
                         "remainingFaults": {"intercepted": intercepted, "held": held, "suspended": suspended}}
    if any((intercepted, held, suspended)) and report["status"].startswith("PASS"):
        report["status"] = "FAIL_CLEANUP"
    report["wallMs"] = round((time.monotonic() - started) * 1000)
    save("report.json", report)
    print(json.dumps({"status": report["status"], "evidence": str(out), "checks": checks}))
