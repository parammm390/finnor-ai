"""Built production UI, separately owned headed Chrome, original mounted story."""
from datetime import datetime, timezone
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / "finnor-os/scripts/postz-w1"
assert len(sys.argv) == 2
OUTPUT = Path(sys.argv[1])
assert OUTPUT.is_absolute() and not OUTPUT.exists()
OUTPUT.mkdir(parents=True)
NODE = Path(os.environ["FINNOR_TEST_NODE"]).resolve(strict=True)
PYTHON = Path(os.environ["FINNOR_TEST_PYTHON"]).absolute()
PYTHON.resolve(strict=True)
CLI = Path(os.environ["FINNOR_AGENT_BROWSER"]).resolve(strict=True)
CHROME = Path(os.environ["FINNOR_W1_CHROME"]).resolve(strict=True)
BASE_ENV = {k: v for k, v in os.environ.items() if k in ("HOME", "PATH", "TMPDIR", "LANG", "LC_ALL")}
DIST = ROOT / ".next-x1-install"
assert not DIST.exists(), "SEAL_OR_REMOVE_ONLY_PREVIOUS_TASK_OWNED_BUILD_BEFORE_NEW_EPOCH"
started = datetime.now(timezone.utc).isoformat()
clock = time.monotonic()
processes = []
proxy = None
proxy_thread = None
profile = None
failure = None
browser_exit = fixture_exit = None
proxy_traffic = []
receipt = {"schema": "finnor.w1.headed-built-mounted-runner.v1", "status": "NOT_RUN",
    "startedAt": started, "originalEpisodeDeadlineExtended": False, "assignedDesktopTouched": False,
    "headless": False, "costUSD": None, "completeDescendantUsage": None,
    "qualification": "LOCAL_SIGNED_AUTH_BUILT_NEXT_ACTUAL_API_WORKER_SQL_NOT_HOSTED_OR_PROTECTED"}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def stop(process):
    if process is None:
        return
    if process.returncode is not None:
        return  # A build reaped minutes ago no longer owns a reusable PID.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait(timeout=10)


def launch(command, environment, log_name, cwd=ROOT):
    log = (OUTPUT / log_name).open("x")
    try:
        process = subprocess.Popen(command, cwd=cwd, env=environment, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
    finally:
        log.close()
    processes.append(process)
    return process


def wait_http(url, process, seconds=60):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if process.poll() is not None:
            raise RuntimeError("OWNED_SERVER_STOPPED_BEFORE_READY")
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return
        except (ConnectionError, urllib.error.URLError, TimeoutError):
            pass
        time.sleep(.1)
    raise RuntimeError("FINITE_SERVER_READINESS_TIMEOUT")


def control(path):
    request = urllib.request.Request("http://127.0.0.1:4693" + path, data=b"{}",
        headers={"content-type": "application/json"}, method="POST")
    urllib.request.urlopen(request, timeout=5).close()


class LoopbackProxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass  # Never log bearer headers, passwords, cookies or refresh tokens.

    def relay(self):
        began = time.monotonic()
        auth = self.path.split("?", 1)[0].startswith("/auth/v1/")
        port = 4692 if auth else 4689
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=70)
        blocked = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
                   "te", "trailer", "transfer-encoding", "upgrade"}
        status = 502
        total = 0
        sent_headers = False
        try:
            length = int(self.headers.get("content-length", "0"))
            if length < 0 or length > 8 * 1024 * 1024:
                self.send_error(413)
                return
            body = self.rfile.read(length) if length else None
            headers = {key: value for key, value in self.headers.items()
                       if key.lower() not in blocked}
            connection.request(self.command, self.path, body, headers)
            response = connection.getresponse()
            status = response.status
            self.send_response(status, response.reason)
            for key, value in response.getheaders():
                if key.lower() not in blocked:
                    self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()
            sent_headers = True
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                total += len(chunk)
        except (OSError, http.client.HTTPException):
            if not sent_headers:
                self.send_error(502, "Loopback transport unavailable")
        finally:
            self.close_connection = True
            connection.close()
            proxy_traffic.append({"method": self.command, "path": self.path.split("?", 1)[0],
                "destinationPort": port, "status": status, "bytes": total,
                "seconds": time.monotonic() - began, "auth": auth,
                "rawCredentialsRecorded": False})

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = relay


def interrupted(signum, _frame):
    raise RuntimeError("RUNNER_INTERRUPTED_" + str(signum))


for sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, interrupted)

try:
    power = subprocess.run(["/usr/bin/pmset", "-g", "batt"], text=True, capture_output=True, timeout=10)
    lid = subprocess.run(["/usr/sbin/ioreg", "-r", "-k", "AppleClamshellState"],
                         text=True, capture_output=True, timeout=10)
    assert power.returncode == 0 and "'AC Power'" in power.stdout, "AC_POWER_REQUIRED"
    assert lid.returncode == 0 and '"AppleClamshellState" = No' in lid.stdout, "OPEN_LID_REQUIRED"
    receipt["powerPrecondition"] = {"AC": True, "openLid": True, "persistentSettingsChanged": False}
    launch(["/usr/bin/caffeinate", "-i", "-s", "-w", str(os.getpid())], BASE_ENV, "sleep-assertion.log")
    commit = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
    build_id = "w1-" + commit
    font = ROOT / "public/fonts/Satoshi-Regular.woff2"
    font_fixture = OUTPUT / "offline-font-assets.cjs"
    font_fixture.write_text("""module.exports = new Proxy({}, {get(_target, key) {
  if (typeof key !== 'string' || !key.startsWith('https://fonts.googleapis.com/css2?')) return undefined;
  const family = new URL(key).searchParams.get('family').split(':')[0];
  if (!['Outfit', 'Manrope', 'IBM Plex Mono'].includes(family)) throw Error('UNREGISTERED_FONT_ASSET');
  return `/* latin */\\n@font-face { font-family: '${family}'; font-style: normal; font-weight: 100 900; font-display: swap; src: url(""" +
        str(font) + """) format('woff2'); }`;
}});
""")
    frontend_env = {**BASE_ENV, "NODE_ENV": "production", "CI": "1", "NEXT_TELEMETRY_DISABLED": "1",
        "NODE_OPTIONS": "--max-old-space-size=2048", "FINNOR_X1_FRONTEND_INSTALL": "1",
        "FINNOR_BUILD_ID": build_id, "NEXT_PUBLIC_OS_API_URL": "http://127.0.0.1:4691",
        "NEXT_PUBLIC_SUPABASE_URL": "http://127.0.0.1:4690",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY": "disposable-local-auth-key",
        "NEXT_FONT_GOOGLE_MOCKED_RESPONSES": str(font_fixture)}
    build_command = [str(NODE), "--import=" + str(SCRIPTS / "read-network-guard.mjs"),
                     str(ROOT / "node_modules/next/dist/bin/next"), "build", "--webpack"]
    build = launch(build_command, frontend_env, "frontend-build.log")
    receipt["buildExitCode"] = build.wait(timeout=600)
    assert receipt["buildExitCode"] == 0, "PRODUCTION_FRONTEND_BUILD_FAILED"
    assert (DIST / "BUILD_ID").read_text().strip() == build_id, "EMITTED_BUILD_ID_MISMATCH"
    servers = [p for p in (DIST / "standalone").rglob("server.js")
               if "__NEXT_PRIVATE_STANDALONE_CONFIG" in p.read_text(errors="replace")]
    assert len(servers) == 1, "ONE_EMITTED_STANDALONE_SERVER_REQUIRED"
    server = servers[0]
    shutil.copytree(ROOT / "public", server.parent / "public", dirs_exist_ok=True)
    shutil.copytree(DIST / "static", server.parent / DIST.name / "static", dirs_exist_ok=True)
    inventory = [{"path": str(p.relative_to(DIST)), "bytes": p.stat().st_size, "sha256": sha(p)}
                 for p in sorted(DIST.rglob("*")) if p.is_file() and not p.is_symlink()]
    (OUTPUT / "emitted-frontend-files.json").write_text(json.dumps(inventory, indent=2) + "\n")
    receipt["frontend"] = {"sourceCommit": commit, "buildId": build_id, "command": build_command,
        "server": str(server.relative_to(ROOT)), "serverSha256": sha(server),
        "inventorySha256": sha(OUTPUT / "emitted-frontend-files.json"),
        "files": len(inventory), "bytes": sum(row["bytes"] for row in inventory),
        "CSPSourceSha256": sha(ROOT / "next.config.mjs"),
        "M1SourceSha256": sha(ROOT / "src/components/centropy/canvas/ComputeSearchPanel.tsx"),
        "typography": {"substitution": "EXISTING_LOCAL_SATOSHI_BYTES_NOT_BUSINESS_DATA",
                       "fontSha256": sha(font), "fixtureSha256": sha(font_fixture)},
        "buildProfileFlag": "FINNOR_X1_FRONTEND_INSTALL=1 (existing standalone/single-CPU profile)"}
    frontend = launch([str(NODE), "--import=" + str(SCRIPTS / "read-network-guard.mjs"), str(server)],
        {**frontend_env, "PORT": "4689", "HOSTNAME": "127.0.0.1"}, "frontend-server.log", server.parent)
    wait_http("http://127.0.0.1:4689/centropy/login", frontend)
    proxy = ThreadingHTTPServer(("127.0.0.1", 4690), LoopbackProxy)
    proxy.daemon_threads = True
    proxy_thread = threading.Thread(target=proxy.serve_forever, daemon=True)
    proxy_thread.start()
    receipt["proxy"] = {"bind": "127.0.0.1:4690", "authOnlyDestination": "127.0.0.1:4692",
                        "allOtherBytesDestination": "127.0.0.1:4689", "answersReplaced": False}
    profile = Path(tempfile.mkdtemp(prefix="finnor-w1-headed-", dir="/tmp"))
    assert not any(profile.iterdir()), "NEW_EMPTY_PROFILE_REQUIRED"
    session = "w1-headed-" + uuid.uuid4().hex
    chrome_command = [str(CHROME), "--user-data-dir=" + str(profile),
        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
        "--disable-component-update", "--disable-sync", "--disable-default-apps",
        "--proxy-server=http://127.0.0.1:9", "--password-store=basic",
        "--window-size=1440,1000", "about:blank"]
    chrome = launch(chrome_command, BASE_ENV, "owned-chrome.log")
    until = time.monotonic() + 30
    while not (profile / "DevToolsActivePort").exists():
        assert chrome.poll() is None, "OWNED_HEADED_CHROME_STOPPED"
        assert time.monotonic() < until, "OWNED_HEADED_CHROME_READINESS_TIMEOUT"
        time.sleep(.1)
    cdp_port = int((profile / "DevToolsActivePort").read_text().splitlines()[0])
    assert 1024 <= cdp_port <= 65535
    receipt["browser"] = {"binary": str(CHROME), "binarySha256": sha(CHROME), "pid": chrome.pid,
        "profile": str(profile), "profileInitiallyEmpty": True, "session": session,
        "debugBind": "127.0.0.1:" + str(cdp_port), "launchCommand": chrome_command,
        "headed": True, "assignedSessionOverwritten": False}
    runtime = {**BASE_ENV, "FINNOR_TEST_NODE": str(NODE), "FINNOR_TEST_PYTHON": str(PYTHON),
        "FINNOR_AGENT_BROWSER": str(CLI), "FINNOR_W1_HEADED_CDP": str(cdp_port),
        "FINNOR_W1_HEADED_SESSION": session}
    receipt["preparationSeconds"] = time.monotonic() - clock
    fixture = launch([str(PYTHON), str(SCRIPTS / "native-run.py"), str(OUTPUT / "backend"), "--mounted"],
                     runtime, "fixture-launch.log")
    until = time.monotonic() + 180
    while not (OUTPUT / "backend/browser/fixture.json").exists():
        assert fixture.poll() is None, "ACTUAL_W1_FIXTURE_STOPPED_BEFORE_READY"
        assert time.monotonic() < until, "ACTUAL_W1_FIXTURE_READINESS_TIMEOUT"
        time.sleep(.1)
    driver = launch([str(PYTHON), str(SCRIPTS / "mounted-e2e.py"), str(OUTPUT / "backend/browser")],
                    runtime, "browser-driver.log")
    browser_exit = driver.wait(timeout=300)
    fixture_exit = fixture.wait(timeout=60)
    mounted = json.loads((OUTPUT / "backend/browser/run/results.json").read_text())
    native = json.loads((OUTPUT / "backend/w1-runner-receipt.json").read_text())
    assert browser_exit == fixture_exit == native["childExitCode"] == 0, "ALL_ACTUAL_CHILDREN_MUST_EXIT_ZERO"
    assert mounted["status"] == "PASS_LOCAL" and len(mounted["steps"]) == 12, "TWELVE_ORIGINAL_CASES_REQUIRED"
    assert all(row["status"] == "PASS" for row in mounted["steps"])
    assert native["owningArtifactsPass"] and native["independentOracleStatus"] == "PASS"
    receipt.update(status="PASS_LOCAL_HEADED_BUILT_MOUNTED", cases=mounted["steps"],
                   nativeReceiptSha256=sha(OUTPUT / "backend/w1-runner-receipt.json"))
except Exception as error:
    failure = str(error)
    receipt.update(status="FAIL", failure=failure, failureType=type(error).__name__)
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        control("/release-read")
        control("/stop")
    except Exception:
        pass
    receipt["cleanup"] = []
    def close_owned(name, closer):
        row = {"id": name, "status": "PASS"}
        try:
            closer()
        except Exception as error:
            row.update(status="FAIL", failure=repr(error))
            receipt["status"] = "FAIL"
        receipt["cleanup"].append(row)
    for process in reversed(processes):
        close_owned("process-" + str(process.pid), lambda process=process: stop(process))
    if proxy:
        if proxy_thread and proxy_thread.is_alive():
            close_owned("proxy-shutdown", proxy.shutdown)
        close_owned("proxy-close", proxy.server_close)
    if proxy_thread:
        close_owned("proxy-thread", lambda: proxy_thread.join(timeout=5))
        if proxy_thread.is_alive():
            receipt.update(status="FAIL", cleanupFailure="OWNED_PROXY_THREAD_STILL_LIVE")
    if profile:
        assert profile.parent == Path("/tmp"), "ONLY_OWNED_TMP_PROFILE_MAY_BE_REMOVED"
        close_owned("owned-chrome-profile", lambda: shutil.rmtree(profile))
        receipt["profileDeleted"] = not profile.exists()
    receipt.update(finishedAt=datetime.now(timezone.utc).isoformat(),
        totalSeconds=time.monotonic() - clock, browserExitCode=browser_exit, fixtureExitCode=fixture_exit,
        childExitCodes=[{"pid": p.pid, "exitCode": p.returncode} for p in processes],
        driverSha256=sha(Path(__file__)))
    (OUTPUT / "loopback-proxy-traffic.json").write_text(json.dumps(proxy_traffic, indent=2) + "\n")
    (OUTPUT / "headed-mounted-runner-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({k: receipt.get(k) for k in ("status", "failure", "totalSeconds", "profileDeleted",
                                                 "browserExitCode", "fixtureExitCode")}))
raise SystemExit(0 if receipt["status"] == "PASS_LOCAL_HEADED_BUILT_MOUNTED" else 1)
