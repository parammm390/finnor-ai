"""Prewarm Next, then run the actual W1 fixture and assigned Desktop journey."""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

root = Path(__file__).resolve().parents[3]
assert len(sys.argv) == 2, "New absolute mounted evidence directory required"
output = Path(sys.argv[1]).resolve()
assert output.is_absolute()
output.mkdir(parents=True, exist_ok=False)
if not os.environ.get("FACTORY_DESKTOP_CDP_PORT") or not os.environ.get("AGENT_BROWSER_CDP") or not os.environ.get("AGENT_BROWSER_SESSION"):
    raise SystemExit("ASSIGNED_DESKTOP_PANE_AND_SESSION_REQUIRED")
node = Path(os.environ["FINNOR_TEST_NODE"]).resolve(strict=True)
python = Path(os.environ["FINNOR_TEST_PYTHON"]).absolute()
python.resolve(strict=True)
cli = Path(os.environ["FINNOR_AGENT_BROWSER"]).resolve(strict=True)
scripts = root / "finnor-os/scripts/postz-w1"
base_env = {k: v for k, v in os.environ.items() if k in ("HOME", "PATH", "TMPDIR")}
frontend_env = {**base_env, "NODE_ENV": "development", "CI": "1", "NEXT_TELEMETRY_DISABLED": "1",
    "NEXT_PUBLIC_OS_API_URL": "http://127.0.0.1:4691", "NEXT_PUBLIC_SUPABASE_URL": "http://127.0.0.1:4692",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY": "disposable-local-auth-key"}
font = root / "public/fonts/Satoshi-Regular.woff2"
font_fixture = output / "offline-font-assets.cjs"
font_fixture.write_text("""// Typography-only fixture; never a business response.
module.exports = new Proxy({}, {get(_target, key) {
  if (typeof key !== 'string' || !key.startsWith('https://fonts.googleapis.com/css2?')) return undefined;
  const family = new URL(key).searchParams.get('family').split(':')[0];
  if (!['Outfit', 'Manrope', 'IBM Plex Mono'].includes(family)) throw Error('UNREGISTERED_FONT_ASSET');
  return `/* latin */\\n@font-face { font-family: '${family}'; font-style: normal; font-weight: 100 900; font-display: swap; src: url(""" +
    str(font) + """) format('woff2'); }`;
}});
""")
frontend_env["NEXT_FONT_GOOGLE_MOCKED_RESPONSES"] = str(font_fixture)
runtime_env = {**base_env, "FINNOR_TEST_NODE": str(node), "FINNOR_TEST_PYTHON": str(python),
    "FINNOR_AGENT_BROWSER": str(cli), **{k: os.environ[k] for k in
        ("FACTORY_DESKTOP_CDP_PORT", "AGENT_BROWSER_CDP", "AGENT_BROWSER_SESSION")}}
frontend_command = [str(node), "--import=" + str(scripts / "read-network-guard.mjs"),
    str(root / "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "4690"]
fixture_command = [sys.executable, str(scripts / "native-run.py"), str(output / "backend"), "--mounted"]
browser_command = [sys.executable, str(scripts / "mounted-e2e.py"), str(output / "backend/browser")]
started = datetime.now(timezone.utc).isoformat()
clock = time.monotonic()
frontend = fixture = browser_driver = None
browser_exit = fixture_exit = None
failure = None
preparation_seconds = None
browser_network_restore = None
cleanup_config = output / "cleanup-agent-browser.json"
cleanup_config.write_text("{}\n")

def stop(process):
    if process is not None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=10)

try:
    with (output / "frontend.log").open("w") as frontend_log:
        frontend = subprocess.Popen(frontend_command, cwd=root, env=frontend_env, stdout=frontend_log, stderr=subprocess.STDOUT, start_new_session=True)
        until = time.monotonic() + 180
        for path in ("/centropy/login", "/centropy/investigations/11111111-1111-4111-8111-111111111111"):
            while True:
                remaining = until - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("ACTUAL_NEXT_PREWARM_DEADLINE")
                if frontend.poll() is not None:
                    raise RuntimeError("ACTUAL_NEXT_STOPPED_BEFORE_PREWARM")
                try:
                    with urllib.request.urlopen("http://127.0.0.1:4690" + path, timeout=min(120, remaining)) as response:
                        if response.status != 200:
                            raise RuntimeError("ACTUAL_NEXT_PREWARM_STATUS_" + str(response.status))
                    if time.monotonic() >= until:
                        raise RuntimeError("ACTUAL_NEXT_PREWARM_DEADLINE")
                    break
                except (ConnectionError, urllib.error.URLError) as error:
                    if isinstance(error, urllib.error.HTTPError) or time.monotonic() >= until:
                        raise RuntimeError("ACTUAL_NEXT_PREWARM_FAILED_" + str(error)) from error
                    time.sleep(.25)
        preparation_seconds = time.monotonic() - clock
        with (output / "fixture-launch.log").open("w") as fixture_log:
            fixture = subprocess.Popen(fixture_command, cwd=root, env=runtime_env, stdout=fixture_log, stderr=subprocess.STDOUT, start_new_session=True)
            until = time.monotonic() + 180
            while not (output / "backend/browser/fixture.json").exists():
                if fixture.poll() is not None:
                    raise RuntimeError("ACTUAL_W1_FIXTURE_STOPPED_BEFORE_READY")
                if time.monotonic() >= until:
                    raise RuntimeError("ACTUAL_W1_FIXTURE_READINESS_TIMEOUT")
                time.sleep(.1)
            with (output / "browser-driver.log").open("w") as browser_log:
                browser_driver = subprocess.Popen(browser_command, cwd=root, env=runtime_env,
                    stdout=browser_log, stderr=subprocess.STDOUT, start_new_session=True)
                browser_exit = browser_driver.wait(timeout=300)
            fixture_exit = fixture.wait(timeout=60)
except Exception as error:
    failure = str(error)
finally:
    stop(browser_driver)
    try:
        restored = subprocess.run([str(cli), "--config", str(cleanup_config), "--session",
            runtime_env["AGENT_BROWSER_SESSION"], "--cdp", runtime_env["AGENT_BROWSER_CDP"],
            "--json", "set", "offline", "off"], env=runtime_env, capture_output=True, text=True, timeout=20)
        browser_network_restore = {"exitCode": restored.returncode, "status": "RESTORED" if restored.returncode == 0 else "FAILED"}
        if restored.returncode:
            failure = failure or "ASSIGNED_BROWSER_NETWORK_RESTORE_FAILED"
    except Exception as error:
        browser_network_restore = {"status": "FAILED", "error": str(error)}
        failure = failure or "ASSIGNED_BROWSER_NETWORK_RESTORE_FAILED"
    try:
        request = urllib.request.Request("http://127.0.0.1:4693/stop", data=b"{}",
            headers={"content-type": "application/json"}, method="POST")
        urllib.request.urlopen(request, timeout=5).close()
    except Exception:
        pass
    stop(fixture)
    stop(frontend)
    if fixture is not None and fixture_exit is None:
        fixture_exit = fixture.returncode
    receipt = {"schema": "finnor.w1.mounted-runner.v1", "startedAt": started,
        "finishedAt": datetime.now(timezone.utc).isoformat(), "totalSeconds": time.monotonic() - clock,
        "preparationSeconds": preparation_seconds, "fixtureExitCode": fixture_exit, "browserExitCode": browser_exit,
        "failure": failure, "assignedDesktop": True, "originalEpisodeDeadlineExtended": False,
        "browserNetworkRestore": browser_network_restore,
        "commands": {"frontend": frontend_command, "fixture": fixture_command, "browser": browser_command},
        "typographyFixture": {"profile": "EXISTING_LOCAL_FONT_BYTES_ONLY_NOT_BUSINESS_MOCKING",
            "fontPath": str(font.relative_to(root)), "fontSha256": hashlib.sha256(font.read_bytes()).hexdigest(),
            "fixtureSha256": hashlib.sha256(font_fixture.read_bytes()).hexdigest()},
        "driverSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "costUSD": None,
        "qualification": "LOCAL_SIGNED_AUTH_ACTUAL_NEXT_API_RLS_PHYSICAL_WORKER_SQL_NOT_HOSTED_OR_PROTECTED"}
    (output / "mounted-runner-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(receipt))
    raise SystemExit(0 if not failure and browser_exit == 0 and fixture_exit == 0 else 1)
