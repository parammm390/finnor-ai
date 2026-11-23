"""Serial full/installed/cold W2 qualification. Execution requires a separate grant.

Every heavy stage uses run-job.py's canonical lease, policy and original wall.
This coordinator owns no heavy lease while waiting between stages. An original
stage failure terminates the sequence; no install/browser/native fallback exists.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve()
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location("w2_cold_packet", HERE.with_name("cold_packet.py"))
cold = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cold
spec.loader.exec_module(cold)
job = cold.job


def snapshot(root):
    paths = cold.git(root, "ls-files", "-z").decode().split("\0")
    paths += cold.git(root, "ls-files", "--others", "--exclude-standard", "-z").decode().split("\0")
    result = {}
    for name in sorted(set(filter(None, paths))):
        path = root / name
        if path.name.startswith(".env"):
            continue
        if not path.is_file() or path.is_symlink():
            raise ValueError("REGULAR_QUALIFICATION_SOURCE_REQUIRED")
        result[name] = {"sha256": job.sha(path), "bytes": path.stat().st_size}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("full", "cold", "all"), required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--resource-policy", required=True)
    parser.add_argument("--node", required=True)
    parser.add_argument("--origin")
    parser.add_argument("--packet")
    parser.add_argument("--packet-sha256")
    parser.add_argument("--cache")
    parser.add_argument("--npm-cli")
    parser.add_argument("--forecast-bytes", type=int, required=True)
    parser.add_argument("--browser-observer-template", required=True)
    parser.add_argument("--browser-observer-template-sha256", required=True)
    parser.add_argument("--browser-observer-grant", required=True)
    parser.add_argument("--browser-observer-grant-sha256", required=True)
    parser.add_argument("--harness-manifest", required=True)
    parser.add_argument("--harness-manifest-sha256", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    if not output.is_absolute() or ".." in output.parts or output.resolve().is_relative_to(ROOT):
        raise ValueError("NEW_ABSOLUTE_QUALIFICATION_OUTPUT_REQUIRED")
    try:
        output.mkdir(mode=0o700)
    except FileExistsError:
        print(json.dumps({"status": "FAIL", "reason": "QUALIFICATION_OUTPUT_ALREADY_CLAIMED", "childSpawned": False}))
        return 1
    identity = output.lstat()
    claim = {"schema": "finnor.w2.campaign-output-owner.v2", "pid": os.getpid(),
             "nonce": os.urandom(32).hex(), "output": str(output),
             "device": identity.st_dev, "inode": identity.st_ino,
             "platform": sys.platform, "uid": os.getuid(), "createdAtUnixMs": time.time_ns() // 1000000}
    claim_file = output / ".campaign-owner.json"
    with os.fdopen(os.open(claim_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(json.dumps(claim) + "\n")

    def require_claim():
        now = output.lstat()
        if (not stat.S_ISDIR(now.st_mode) or output.is_symlink() or claim_file.is_symlink()
                or (now.st_dev, now.st_ino) != (identity.st_dev, identity.st_ino)
                or json.loads(claim_file.read_text()) != claim):
            raise RuntimeError("QUALIFICATION_OUTPUT_CLAIM_LOST")

    record = {"schema": "finnor.w2.serial-qualification.v1", "status": "FAIL", "mode": args.mode,
              "startedAt": datetime.now(timezone.utc).isoformat(), "stages": [], "cleanup": "NOT_RUN",
              "separateGates": {name: "NOT_ESTABLISHED" for name in (
                  "GENUINE_HUMAN", "PROTECTED_ADMISSION", "FIELD_ACTIVATION", "QUALIFIED_Z_COMPARISON", "ECONOMICS")},
              "qualification": "CONTROLLED_ENGINEERING_ONLY", "artifactAllowlist": [],
              "productionActive": False, "executionAuthorityGranted": False}
    started = time.monotonic()
    total = 14400 if args.mode == "cold" else 28800
    deadline, interrupted = started + total, []
    active = None
    active_owned, active_groups = {}, set()
    cleanup_errors = []
    disk_before = None
    harness = None

    def stop(signum, _frame):
        interrupted.append(signum)
        record.setdefault("firstControllerFault", {"predicate": "ORIGINAL_QUALIFICATION_WALL_OR_INTERRUPT",
                                                   "signal": signum, "elapsedSeconds": time.monotonic() - started})
        raise RuntimeError("ORIGINAL_QUALIFICATION_WALL_OR_INTERRUPT")

    previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM)}
    signal.setitimer(signal.ITIMER_REAL, total)

    def campaign_capacity():
        if harness:
            harness.verify()
        facts = job.host_facts(output)
        free = facts["filesystem"]["freeBytes"]
        if free < policy.globalDiskFloorBytes:
            raise RuntimeError("ORIGINAL_CAMPAIGN_GLOBAL_DISK_FLOOR")
        if disk_before is not None and disk_before - free > policy.laneNetNewBudgetBytes:
            raise RuntimeError("ORIGINAL_COMPLETE_CAMPAIGN_NET_NEW_DISK_BOUND")
        return facts

    def track():
        return job.observe_owned(active, active_owned, active_groups)

    def clean_active():
        nonlocal active
        if active is None:
            return
        require_claim()
        if active.poll() is None:
            try:
                track()
                os.killpg(active.pid, signal.SIGCONT)
                os.killpg(active.pid, signal.SIGTERM)
                cleanup_until = time.monotonic() + 18
                while active.poll() is None and time.monotonic() < cleanup_until:
                    track()
                    try:
                        active.wait(timeout=min(0.25, max(0.001, cleanup_until - time.monotonic())))
                    except subprocess.TimeoutExpired:
                        pass
                if active.poll() is None:
                    track()
                    os.killpg(active.pid, signal.SIGKILL)
                    active.wait(timeout=3)
            except ProcessLookupError:
                pass
        rows = job.process_rows()
        for group in sorted(active_groups):
            members = [row for row in rows if row["group"] == group]
            if not members:
                continue
            if any(row["pid"] not in active_owned or not job.same_process(active_owned[row["pid"]], row)
                   for row in members):
                cleanup_errors.append("QUALIFICATION_GROUP_IDENTITY_UNKNOWN")
                continue
            cleanup_errors.append("QUALIFICATION_STAGE_LEAKED_OWNED_GROUP")
            try:
                os.killpg(group, signal.SIGCONT)
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
        until = time.monotonic() + 3
        while any(row["group"] in active_groups for row in job.process_rows()) and time.monotonic() < until:
            time.sleep(0.05)
        if any(row["group"] in active_groups for row in job.process_rows()):
            cleanup_errors.append("QUALIFICATION_OWNED_GROUP_STILL_LIVE")
        if active.stdout:
            active.stdout.close()
        active = None

    def stage(root, case, extra=(), env_extra=None):
        nonlocal active
        require_claim()
        harness.verify(all_tools=True)
        if interrupted or time.monotonic() >= deadline:
            raise RuntimeError("ORIGINAL_QUALIFICATION_TOTAL_WALL")
        campaign_capacity()
        before = snapshot(root)
        path = output / ("%02d-" % (len(record["stages"]) + 1) + case)
        command = [sys.executable, "-B", str(root / "scope-postz/w2-accountable-workforce/run-job.py"),
                   "--case", case, "--heavy", "--output", str(path), "--resource-policy", str(policy_file),
                   "--node", str(node), "--origin", origin,
                   "--harness-manifest", str(harness.file), "--harness-manifest-sha256", harness.expected_sha, *extra]
        if case == "mounted":
            command += ["--browser-observer-template", args.browser_observer_template,
                        "--browser-observer-template-sha256", args.browser_observer_template_sha256,
                        "--browser-observer-grant", args.browser_observer_grant,
                        "--browser-observer-grant-sha256", args.browser_observer_grant_sha256,
                        "--campaign-owner", str(claim_file), "--campaign-owner-sha256", job.sha(claim_file)]
        env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG",
               "FACTORY_DESKTOP_CDP_PORT", "AGENT_BROWSER_CDP", "AGENT_BROWSER_SESSION", "AGENT_BROWSER_PIN_TAB",
               "FINNOR_AGENT_BROWSER_BIN") if key in os.environ}
        env.update(PYTHONDONTWRITEBYTECODE="1", NEXT_TELEMETRY_DISABLED="1")
        if env_extra:
            env.update(env_extra)
        browser_tool = harness.manifest["tools"].get("agentBrowser")
        if browser_tool:
            env["FINNOR_AGENT_BROWSER_BIN"] = browser_tool["path"]
        active_owned.clear()
        active_groups.clear()
        captured = bytearray()
        primary_failure = None
        next_capacity = time.monotonic()
        status = {"case": case, "output": str(path), "status": "FAIL"}
        record["stages"].append(status)
        try:
            active = subprocess.Popen(command, cwd=root, env=env, stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, start_new_session=True)
            active_groups.add(active.pid)
            os.set_blocking(active.stdout.fileno(), False)
            while True:
                require_claim()
                harness.verify()
                track()
                if time.monotonic() >= next_capacity:
                    campaign_capacity()
                    next_capacity = time.monotonic() + 1
                while True:
                    try:
                        block = os.read(active.stdout.fileno(), 65536)
                    except BlockingIOError:
                        break
                    if not block:
                        break
                    if len(captured) + len(block) > 2097152:
                        raise RuntimeError("QUALIFICATION_STAGE_LOG_BOUND")
                    captured.extend(block)
                if active.poll() is not None:
                    break
                if time.monotonic() >= deadline or interrupted:
                    raise RuntimeError("ORIGINAL_QUALIFICATION_TOTAL_WALL")
                try:
                    active.wait(timeout=0.25)
                except subprocess.TimeoutExpired:
                    pass
            status["exitCode"] = active.returncode
            if active.returncode:
                raise RuntimeError("ACTUAL_QUALIFICATION_STAGE_FAILED:" + case)
            receipt = json.loads((path / "job-result.json").read_text())
            if receipt["status"] != "PASS" or receipt["cleanup"]["status"] != "PASS":
                raise RuntimeError("ACTUAL_STAGE_AND_OWNED_CLEANUP_PASS_REQUIRED")
            after = snapshot(root)
            if case == "frontend-build":
                manifest = json.loads((path / "frontend/w2-frontend-installation.json").read_text())
                changed = {name for name in set(before) | set(after) if before.get(name) != after.get(name)}
                declared = {row["path"]: row for row in manifest["generatedInputDeltas"]}
                if (len(declared) != len(manifest["generatedInputDeltas"]) or not changed.issubset(declared)
                        or any(after.get(name, {}).get("sha256") != row["generatedSha256"]
                               or hashlib.sha256(cold.git(root, "show", "HEAD:" + name)).hexdigest() != row["originalSha256"]
                               for name, row in declared.items())
                        or any(before.get(name, {}).get("sha256") != declared[name]["originalSha256"] for name in changed)):
                    raise RuntimeError("ONLY_EXACT_FINALIZER_OBSERVED_NEXT_DELTAS_ALLOWED")
                status["acceptedNextGeneratedInputDeltas"] = manifest["generatedInputDeltas"]
            elif before != after:
                raise RuntimeError("SEALED_SOURCE_CHANGED_DURING_QUALIFICATION_STAGE")
            for row in receipt["artifacts"]["files"]:
                actual = path / cold.relative(row["path"])
                cold.verify_file(actual, row)
                record["artifactAllowlist"].append({"path": actual.relative_to(output).as_posix(),
                                                    "sha256": row["sha256"], "bytes": row["bytes"]})
            status.update(status="PASS", jobReceiptSha256=job.sha(path / "job-result.json"))
            return path, receipt
        except BaseException as error:
            primary_failure = error
            status["failure"] = {"type": type(error).__name__,
                "predicate": str(error) if re.fullmatch(r"[A-Z0-9_:/.-]{1,256}", str(error)) else "ACTUAL_STAGE_OWNER_BOUNDARY_FAILED"}
            raise
        finally:
            try:
                clean_active()
            except Exception:
                cleanup_errors.append("QUALIFICATION_STAGE_CLOSER_FAILED")
            try:
                if captured:
                    with os.fdopen(os.open(output / (path.name + ".private.log"),
                                          os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
                        stream.write(job.redacted_log(captured))
                receipt_path = path / "job-result.json"
                if receipt_path.is_file() and not receipt_path.is_symlink():
                    record["artifactAllowlist"].append({"path": receipt_path.relative_to(output).as_posix(),
                        "sha256": job.sha(receipt_path), "bytes": receipt_path.stat().st_size})
            except Exception:
                cleanup_errors.append("QUALIFICATION_STAGE_FINALIZATION_FAILED")
            if cleanup_errors:
                status["status"] = "FAIL"
                if primary_failure is None:
                    raise RuntimeError("QUALIFICATION_STAGE_CLEANUP_FAILED")

    try:
        require_claim()
        policy_file = Path(args.resource_policy).resolve(strict=True)
        policy = job.ResourcePolicy.parse(json.loads(policy_file.read_text()))
        record["resourcePolicySha256"] = job.sha(policy_file)
        node = Path(args.node).resolve(strict=True)
        harness = job.FrozenHarness(args.harness_manifest, args.harness_manifest_sha256, ROOT, node, policy_file)
        record["harnessManifest"] = {"path": str(harness.file), "sha256": harness.expected_sha}
        dirty = cold.git(ROOT, "status", "--porcelain=v1", "-uall").decode().splitlines()
        if any(line[3:] != "AGENTS.md" for line in dirty):
            raise ValueError("ACTUAL_CLEAN_COMMITTED_CANDIDATE_REQUIRED_BEFORE_FULL_COLD")
        if args.mode == "all":
            npm_tool = harness.manifest["tools"].get("npmCli")
            if not args.cache or not args.npm_cli or not npm_tool \
                    or str(Path(args.npm_cli).resolve(strict=True)) != npm_tool["path"]:
                raise ValueError("INDEPENDENT_DECLARED_COLD_CACHE_AND_NPM_REQUIRED")
        if sys.platform != "darwin":
            raise ValueError("DARWIN_SAME_HOST_BROWSER_PROFILE_REQUIRED")
        template = job.read_private_json(args.browser_observer_template, args.browser_observer_template_sha256)
        grant = job.read_private_json(args.browser_observer_grant, args.browser_observer_grant_sha256)
        if (template.get("schema") != "finnor.w2.browser-observer-template.v1"
                or template.get("topology") != "DARWIN_SAME_HOST_CAMPAIGN_AND_OBSERVER_V1"
                or template.get("harnessManifestSha256") != harness.expected_sha
                or grant.get("schema") != "finnor.w2.browser-observer-execution-grant.v1"
                or grant.get("purpose") != "EXPLICIT_BOUNDED_MOUNTED_OBSERVATION"
                or grant.get("harnessManifestSha256") != harness.expected_sha
                or grant.get("templateSha256") != args.browser_observer_template_sha256
                or grant.get("campaignOutputSha256") != hashlib.sha256(str(output).encode()).hexdigest()):
            raise ValueError("PINNED_NON_PROOF_ASSIGNMENT_AND_EXPLICIT_GRANT_REQUIRED")
        if not all(name in harness.manifest["tools"] for name in
                   ("node", "agentBrowser", "browserObserver", "browserExecutable")):
            raise ValueError("COMPLETE_INDEPENDENT_BROWSER_OBSERVER_TOOL_PINS_REQUIRED")
        record["browserObservationInputPins"] = {
            "templateSha256": args.browser_observer_template_sha256,
            "executionGrantSha256": args.browser_observer_grant_sha256,
            "campaignOwnerSha256": job.sha(claim_file),
            "status": "PINNED_NON_PROOF_INPUTS_ONLY_NOT_OBSERVED",
        }
        if args.forecast_bytes <= 0 or args.forecast_bytes > policy.laneNetNewBudgetBytes:
            raise ValueError("COMPLETE_QUALIFICATION_DISK_FORECAST_REQUIRED")
        record["hostBefore"] = campaign_capacity()
        disk_before = record["hostBefore"]["filesystem"]["freeBytes"]
        if disk_before - args.forecast_bytes < policy.globalDiskFloorBytes:
            raise ValueError("COMPLETE_QUALIFICATION_FORECAST_MUST_RETAIN_GLOBAL_DISK_FLOOR")
        record["forecastNetNewBytes"] = args.forecast_bytes
        record["initialSource"] = job.source_cut()
        origin = job.canonical_origin(args.origin) if args.origin else None
        packet_file, packet_hash = args.packet, args.packet_sha256
        if args.mode in ("full", "all"):
            if not origin:
                raise ValueError("EXACT_FRONTEND_ORIGIN_REQUIRED")
            for case in ("types", "domain", "dynamic", "structural"):
                stage(ROOT, case)
            backend, _ = stage(ROOT, "backend-build")
            native, native_receipt = stage(ROOT, "native", ["--backend", str(backend / "backend")])
            if args.mode == "all":
                if not args.cache or not args.npm_cli:
                    raise ValueError("EXPLICIT_COLD_CACHE_AND_NPM_DISTRIBUTION_REQUIRED")
                native_dir = native / native_receipt["artifacts"]["directory"]
                sealed, _ = stage(ROOT, "cold-seal", ["--cache", args.cache, "--npm-cli", args.npm_cli,
                    "--baseline-native", str(native_dir), "--baseline-installation", str(backend / "backend"),
                    "--forecast-bytes", str(args.forecast_bytes)])
                packet_file = str(sealed / "packet/cold-packet.json")
                packet_hash = job.sha(packet_file)
            # Seal the committed candidate before Next writes its exactly
            # declared type inputs. The unchanged backend owner refuses those
            # dirty product overlays, so they must not enter a cold source.
            frontend, _ = stage(ROOT, "frontend-build")
            installed = ["--backend", str(backend / "backend"), "--frontend", str(frontend / "frontend")]
            for case in ("bound", "recovery", "mounted"):
                stage(ROOT, case, installed)
        if args.mode in ("cold", "all"):
            cold_started = time.monotonic()
            deadline = min(deadline, cold_started + 14400)
            signal.setitimer(signal.ITIMER_REAL, max(0.001, deadline - time.monotonic()))
            if not packet_file or not packet_hash:
                raise ValueError("EXACT_SEALED_COLD_PACKET_REQUIRED")
            packet_file = str(Path(packet_file).resolve(strict=True))
            packet = cold.inspect_packet(packet_file, packet_hash)
            if args.forecast_bytes < packet["forecastNetNewBytes"]:
                raise ValueError("FULL_SEALED_COLD_NET_NEW_FORECAST_REQUIRED")
            if job.sha(node) != packet["runtime"]["node"]["sha256"]:
                raise ValueError("DECLARED_COLD_NODE_BINARY_REQUIRED")
            if job.sha(Path(sys.executable).resolve()) != packet["runtime"]["python"]["sha256"]:
                raise ValueError("DECLARED_COLD_PYTHON_BINARY_REQUIRED")
            npm_tool = harness.manifest["tools"].get("npmCli")
            if not npm_tool or npm_tool["sha256"] != packet["runtime"]["npmCli"]["sha256"]:
                raise ValueError("INDEPENDENT_DECLARED_NPM_CLI_PIN_REQUIRED")
            origin = packet["frontendOrigin"]
            common = ["--packet", packet_file, "--packet-sha256", packet_hash]
            setup, _ = stage(ROOT, "cold-prepare", common + ["--forecast-bytes", str(args.forecast_bytes)])
            prepared = setup / "campaign"
            fresh_source = prepared / "source"
            cold_env = {"HOME": str(prepared / "home"), "TMPDIR": str(prepared / "tmp")}
            for case in ("cold-root-install", "cold-backend-install"):
                stage(ROOT, case, common + ["--prepared", str(prepared),
                      "--forecast-bytes", str(args.forecast_bytes)], cold_env)
            for case in ("types", "domain", "dynamic", "structural"):
                stage(fresh_source, case, env_extra=cold_env)
            backend, _ = stage(fresh_source, "backend-build", env_extra=cold_env)
            frontend, _ = stage(fresh_source, "frontend-build", env_extra=cold_env)
            installed = ["--backend", str(backend / "backend"), "--frontend", str(frontend / "frontend")]
            native, native_receipt = stage(fresh_source, "native", installed, cold_env)
            for case in ("bound", "recovery", "mounted"):
                stage(fresh_source, case, installed, cold_env)
            native_dir = native / native_receipt["artifacts"]["directory"]
            stage(fresh_source, "cold-compatibility", common + ["--backend", str(backend / "backend"),
                  "--fresh-native", str(native_dir)], cold_env)
            if time.monotonic() - cold_started > 14400:
                raise RuntimeError("ORIGINAL_COLD_TOTAL_WALL")
            cold.verify_installation(backend / "backend")
            cold.verify_installation(frontend / "frontend", frontend=True)
            record["cold"] = {"status": "PASS", "packetSha256": packet_hash,
                              "source": str(fresh_source), "donorApplicationModulesCopied": False}
        record["status"] = "PASS"
    except Exception as error:
        record["failure"] = {"type": type(error).__name__,
            "predicate": str(error) if re.fullmatch(r"[A-Z0-9_:/.-]{1,256}", str(error)) else "QUALIFICATION_OWNER_BOUNDARY_FAILED"}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        try:
            clean_active()
        except Exception:
            cleanup_errors.append("QUALIFICATION_FINAL_CLEANUP_FAILED")
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        if cleanup_errors:
            record["status"] = "FAIL"
        if interrupted:
            record["status"] = "FAIL"
        if harness:
            try:
                harness.verify(all_tools=True)
                record["finalHarnessIntegrity"] = "PASS"
            except Exception:
                record["status"] = "FAIL"
                record["finalHarnessIntegrity"] = "FAIL"
                record.setdefault("failure", {"type": "RuntimeError", "predicate": "ACTIVE_FROZEN_HARNESS_CHANGED"})
        record["cleanup"] = {"status": "FAIL" if cleanup_errors else "PASS", "errors": cleanup_errors}
        record.update(finishedAt=datetime.now(timezone.utc).isoformat(), totalWallSeconds=total,
                      elapsedSeconds=time.monotonic() - started, controllerSha256=job.sha(HERE))
        require_claim()
        receipt = output / "qualification-result.json"
        with os.fdopen(os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
            stream.write(json.dumps(record, indent=2) + "\n")
        print(json.dumps({"status": record["status"], "mode": args.mode, "cleanup": record["cleanup"],
                          "receipt": str(receipt), "stages": len(record["stages"])}))
    return 0 if record["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
