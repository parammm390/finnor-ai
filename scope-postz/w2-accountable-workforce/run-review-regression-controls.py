"""Finite source/real-OS controls for W qualification findings, not cold proof."""
import argparse
import copy
import errno
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import runpy
import signal
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
CONFIG_PATHS = (".npmrc", "finnor-os/.npmrc")
CONFIG_BLOB = "51df798a520d03f9313c458c9c67008676b094d0"
CONFIG_SHA = "5602bb233ec1478ef60941257e98dfa8a86c9aeb22a4705aeb4beb15605e8a40"


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(path, value):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(json.dumps(value, indent=2) + "\n")


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def public_row(row):
    return {key: row[key] for key in ("pid", "parent", "group", "birth", "residentBytes")}


def trace_runner(runner, events, argv):
    """Gate scheduling only. All application calls and OS errors stay real."""
    runner, events = Path(runner).resolve(strict=True), Path(events)
    lines = runner.read_text().splitlines()
    cleanup_start = next(i for i, text in enumerate(lines, 1) if text.strip() == "cleanup_errors = []")
    setup = next(i for i, text in enumerate(lines, 1)
                 if text.strip() == 'if observed and record["processMemorySamples"] == 0:')
    observe = next(i for i, text in enumerate(lines, 1)
                   if i > cleanup_start and text.strip() == "observe_owned(child, owned, groups)")
    primary_signal = next(i for i, text in enumerate(lines, 1)
                          if i > cleanup_start and text.strip() == "os.killpg(child.pid, signal.SIGCONT)")
    sweep_signal = {i for i, text in enumerate(lines, 1)
                    if i > cleanup_start and text.strip() == "os.killpg(group, signal.SIGCONT)"}
    final_checks = {i for i, text in enumerate(lines, 1)
                    if i > cleanup_start and 'any(row["group"] in groups for row in process_rows())' in text}
    fired = set()

    def emit(name, value, gate=False):
        if name in fired:
            return
        fired.add(name)
        write(events / (name + ".json"), value)
        if gate:
            until = time.monotonic() + 8
            while not (events / (name + ".release")).exists():
                if time.monotonic() >= until:
                    raise RuntimeError("REAL_OS_SCHEDULING_GATE_DEADLINE")
                time.sleep(0.005)

    def trace(frame, event, argument):
        if frame.f_code.co_filename != str(runner) or frame.f_code.co_name != "main":
            return trace
        local, line = frame.f_locals, frame.f_lineno
        if event == "line":
            if line == setup and "sampled" not in fired:
                child = local.get("child")
                observed = local.get("observed", [])
                if child and any(row["group"] != child.pid for row in observed):
                    emit("sampled", {"primary": child.pid, "groups": sorted(local["groups"]),
                        "owned": [public_row(row) for row in local["owned"].values()]}, True)
            elif "sampled" in fired and line == observe:
                emit("primary-live-check-passed", {"primary": local["child"].pid,
                    "returncodeBeforeOrdinaryObserve": local["child"].returncode}, True)
            elif "sampled" in fired and line == primary_signal:
                emit("primary-signal-boundary", {"primary": local["child"].pid,
                    "returncodeAfterOrdinaryObserve": local["child"].returncode}, True)
            elif "sampled" in fired and line in sweep_signal:
                emit("sweep-" + str(local["group"]), {"group": local["group"], "line": line})
            elif "sampled" in fired and line in final_checks:
                emit("final-live-check", {"line": line})
        elif event == "exception" and line == primary_signal and isinstance(argument[1], ProcessLookupError):
            emit("actual-primary-esrch", {"errno": argument[1].errno, "line": line,
                "operation": "os.killpg(actual_primary_group, SIGCONT)", "mocked": False})
        return trace

    sys.argv = [str(runner)] + argv
    sys.settrace(trace)
    try:
        runpy.run_path(str(runner), run_name="__main__")
    finally:
        sys.settrace(None)


def config_filesystem_controls(seal, stage, fixture, output, selected, refuses):
    cold = seal.packet_lib
    assert fixture is not None and fixture.parent == output.parent and fixture != seal.ROOT
    assert not cold.git(fixture, "status", "--porcelain=v1", "-uall"), "CLEAN_OWNED_CONFIG_FIXTURE_REQUIRED"
    with (output.parent / (fixture.name + ".lock")).open("a") as lease:
        fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
        rows = seal.source_rows(fixture)
        packet = {"source": {"files": rows,
            "identity": {"commit": cold.git(fixture, "rev-parse", "HEAD").decode().strip()}}}
        stage.source_unchanged(fixture, packet)
        row = next(value for value in selected if value["path"] == ".npmrc")
        path = fixture / ".npmrc"
        original = path.read_bytes()
        assert len(original) == 23 and hashlib.sha256(original).hexdigest() == CONFIG_SHA
        cold.verify_public_configuration(fixture, ".npmrc", row)
        home = os.environ.get("HOME")
        try:
            os.environ["HOME"] = str(fixture)
            refuses("home-configuration-context", lambda: cold.verify_public_configuration(fixture, ".npmrc", row))
        finally:
            if home is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = home
        linked_source = output / "source-root-link"
        linked_source.symlink_to(fixture, target_is_directory=True)
        try:
            refuses("source-root-symlink", lambda: cold.verify_public_configuration(linked_source, ".npmrc", row))
        finally:
            linked_source.unlink()
        try:
            path.write_bytes(b"//example.invalid/:_authToken=SYNTHETIC_CONTROL_ONLY\n")
            refuses("changed-secret-shaped-bytes", lambda: cold.verify_public_configuration(fixture, ".npmrc", row))
        finally:
            path.write_bytes(original)
            path.chmod(0o644)
        target = output / "public-config-symlink-target"
        target.write_bytes(original)
        path.unlink()
        try:
            path.symlink_to(target)
            refuses("direct-config-symlink", lambda: cold.verify_public_configuration(fixture, ".npmrc", row))
        finally:
            path.unlink()
            path.write_bytes(original)
            path.chmod(0o644)
        backend, saved = fixture / "finnor-os", fixture / "w2-control-saved-backend"
        assert not saved.exists()
        backend.rename(saved)
        try:
            backend.symlink_to(saved, target_is_directory=True)
            second = next(value for value in selected if value["path"] == "finnor-os/.npmrc")
            refuses("ancestor-config-symlink", lambda:
                    cold.verify_public_configuration(fixture, "finnor-os/.npmrc", second))
        finally:
            backend.unlink()
            saved.rename(backend)
        try:
            cold.git(fixture, "update-index", "--force-remove", "--", ".npmrc")
            refuses("untracked-known-config", lambda: cold.verify_public_configuration(fixture, ".npmrc", row))
        finally:
            cold.git(fixture, "update-index", "--add", "--cacheinfo", "100644," + CONFIG_BLOB + ",.npmrc")
        try:
            cold.git(fixture, "update-index", "--cacheinfo", "100755," + CONFIG_BLOB + ",.npmrc")
            refuses("changed-index-mode", lambda: cold.verify_public_configuration(fixture, ".npmrc", row))
        finally:
            cold.git(fixture, "update-index", "--cacheinfo", "100644," + CONFIG_BLOB + ",.npmrc")
        head = Path(cold.git(fixture, "rev-parse", "--absolute-git-dir").decode().strip()) / "HEAD"
        original_head = head.read_bytes()
        try:
            head.write_bytes(b"ref: refs/heads/nonexistent-w2-config-control\n")
            refuses("absent-head-binding", lambda: cold.verify_public_configuration(fixture, ".npmrc", row))
        finally:
            head.write_bytes(original_head)
        for relative, ignored in (("w2-untracked-config-control/.npmrc", False),
                                  ("artifacts/w2-ignored-config-control/.npmrc", True)):
            private = fixture / relative
            private.parent.mkdir(parents=True, exist_ok=True)
            with private.open("xb") as stream:
                stream.write(b"//example.invalid/:_authToken=SYNTHETIC_CONTROL_ONLY\n")
            private.chmod(0o600)
            try:
                if ignored:
                    cold.git(fixture, "check-ignore", "--", relative)
                observed = seal.source_rows(fixture)
                assert relative not in {value["path"] for value in observed}, "PRIVATE_UNTRACKED_CONFIG_NOT_EXCLUDED"
                refuses("ignored-private-config" if ignored else "untracked-private-config",
                        lambda: stage.source_unchanged(fixture, packet))
            finally:
                private.unlink()
        stage.source_unchanged(fixture, packet)
        assert not cold.git(fixture, "status", "--porcelain=v1", "-uall"), "CONFIG_FIXTURE_NOT_RESTORED"
        return {"status": "PASS", "restoredExactly": True, "archiveOrInstall": False}


def config_control(root, candidate, output, phase, fixture):
    seal = load("review_seal", root / "scope-postz/w2-accountable-workforce/cold-seal.py")
    result = {"sourceRoot": str(candidate), "contentsPrinted": False, "archiveExecuted": False}
    try:
        rows = seal.source_rows(candidate)
        selected = [row for row in rows if row["path"] in CONFIG_PATHS]
        result.update(sourcePopulation=len(rows), configurationRows=selected)
        if phase == "before":
            result["status"] = "NOT_REPRODUCED"
        else:
            assert len(selected) == 2 and all(row["sha256"] == CONFIG_SHA for row in selected)
            cold = seal.packet_lib
            stage = load("review_stage", root / "scope-postz/w2-accountable-workforce/cold-stage.py")
            own_rows = seal.source_rows(root)
            packet = {"source": {"files": own_rows,
                "identity": {"commit": cold.git(root, "rev-parse", "HEAD").decode().strip()}}}
            stage.source_unchanged(root, packet)
            rejected = []

            def refuses(name, action):
                try:
                    action()
                except (ValueError, RuntimeError):
                    rejected.append(name)
                    return
                raise AssertionError("PUBLIC_CONFIG_NEGATIVE_CONTROL_DID_NOT_REFUSE:" + name)

            first = copy.deepcopy(selected[0])
            refuses("missing-public-declaration", lambda: cold.source_path(first["path"]))
            moved = copy.deepcopy(first)
            moved["path"] = "other/.npmrc"
            refuses("same-bytes-wrong-path", lambda: cold.source_path(moved["path"], moved))
            for field, value in (("sha256", "0" * 64), ("bytes", 24), ("mode", 0o755)):
                changed = copy.deepcopy(first)
                changed[field] = value
                refuses("wrong-" + field, lambda changed=changed: cold.source_path(changed["path"], changed))
            for field, value in (("class", "SELF_DECLARED_PUBLIC"), ("gitBlob", "0" * 40)):
                changed = copy.deepcopy(first)
                changed["publicConfiguration"][field] = value
                refuses("wrong-" + field, lambda changed=changed: cold.source_path(changed["path"], changed))
            for name in (".env", ".pypirc", ".git-credentials", "elsewhere/.npmrc"):
                changed = copy.deepcopy(first)
                changed["path"] = name
                refuses("private-" + name.replace("/", "-"), lambda changed=changed:
                        cold.source_path(changed["path"], changed))
            refuses("missing-tracked-config", lambda: cold.validate_source_rows(
                [row for row in own_rows if row["path"] != ".npmrc"]))
            refuses("duplicate-source-row", lambda: cold.validate_source_rows(own_rows + [own_rows[0]]))
            filesystem = config_filesystem_controls(seal, stage, fixture, output, selected, refuses)
            result.update(status="PASS", sourceClosure="PASS", negativeControls=rejected, filesystem=filesystem)
    except (ValueError, RuntimeError) as error:
        predicate = str(error)
        result.update(status="REPRODUCED" if phase == "before" and
            predicate == "PRIVATE_CONFIGURATION_MUST_NOT_ENTER_SOURCE_PACKET" else "FAIL",
            observedPredicate=predicate if predicate.replace("_", "").isalnum() else "OWNER_BOUNDARY_REFUSAL")
    write(output / "source-config-control.json", result)
    return result


def os_control(root, output, phase, node):
    job = load("review_os_job", root / "scope-postz/w2-accountable-workforce/run-job.py")
    events = output / "events"
    events.mkdir(mode=0o700)
    manifest = output / "race-harness.json"
    freeze = subprocess.run([sys.executable, "-B", str(root /
        "scope-postz/w2-accountable-workforce/freeze-harness.py"),
        "--output", str(manifest), "--node", node], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    assert freeze.returncode == 0, "ACTUAL_INDEPENDENT_PREFLIGHT_FREEZE_FAILED"
    original_manifest_sha = sha(manifest)
    runner = root / "scope-postz/w2-accountable-workforce/run-job.py"
    result = {"status": "NOT_REPRODUCED", "phase": phase, "runnerSha256": sha(runner),
        "controllerSha256": sha(__file__), "harnessSha256": original_manifest_sha,
        "schedulingOnlyTrace": True, "killAndPsMocked": False, "qualification": "REAL_OS_CONTROL_ONLY"}
    known, groups, launched, neighbor = {}, set(), None, None
    started = time.monotonic()
    log = output / "traced-runner.log"
    peak_observed_child = 0

    def rows(enforce_bound=True):
        nonlocal peak_observed_child
        observed = job.process_rows()
        for row in observed:
            if row["pid"] in known and not job.same_process(known[row["pid"]], row):
                raise RuntimeError("CONTROL_PROCESS_IDENTITY_CHANGED")
        peak_observed_child = max([peak_observed_child] +
            [row["residentBytes"] for row in observed if row["pid"] in known])
        if enforce_bound and peak_observed_child > 256 * 1024 ** 2:
            raise RuntimeError("CONTROL_ORIGINAL_CHILD_RSS_BOUND")
        return observed

    def gate(name, seconds=8):
        until = min(started + 30, time.monotonic() + seconds)
        while time.monotonic() < until:
            path = events / (name + ".json")
            if path.exists():
                return json.loads(path.read_text())
            if launched.poll() is not None:
                raise RuntimeError("RUNNER_EXITED_BEFORE_REAL_BOUNDARY")
            time.sleep(0.01)
        raise RuntimeError("REAL_OS_BOUNDARY_NOT_OBSERVED")

    def release(name):
        (events / (name + ".release")).touch(exist_ok=True)

    def signal_group(group, signum, cleanup=False):
        current = rows(not cleanup)
        parents = {row["pid"] for row in current if row["pid"] in known}
        while True:
            children = {row["pid"] for row in current if row["parent"] in parents}
            if children.issubset(parents):
                break
            parents |= children
        for row in current:
            if row["pid"] in parents:
                known[row["pid"]] = row
        matching = [row for row in current if row["group"] == group]
        if any(row["pid"] not in known or not job.same_process(known[row["pid"]], row) for row in matching):
            raise RuntimeError("CONTROL_REFUSES_UNFAMILIAR_GROUP")
        if matching:
            try:
                os.killpg(group, signum)
            except ProcessLookupError:
                pass

    def deadline(_signum, _frame):
        raise RuntimeError("ORIGINAL_CONTROL_THIRTY_SECOND_BODY_WALL")

    previous_alarm = signal.signal(signal.SIGALRM, deadline)
    signal.setitimer(signal.ITIMER_REAL, 30)
    try:
        neighbor = subprocess.Popen([sys.executable, "-B", "-c", "import time; time.sleep(45)"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        with log.open("xb") as stream:
            launched = subprocess.Popen([sys.executable, "-B", str(Path(__file__).resolve()),
                "--traced-run", str(runner), str(events), "--case", "supervision",
                "--output", str(output / "race-job"), "--node", node,
                "--harness-manifest", str(manifest), "--harness-manifest-sha256", original_manifest_sha],
                stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        sampled = gate("sampled")
        known.update({row["pid"]: row for row in sampled["owned"]})
        groups.update(sampled["groups"])
        primary = sampled["primary"]
        for group in sorted(groups, key=lambda group: group != primary):
            signal_group(group, signal.SIGSTOP)
        with manifest.open("a") as stream:
            stream.write("\n")
        release("sampled")
        gate("primary-live-check-passed")
        signal_group(primary, signal.SIGKILL)
        time.sleep(0.05)
        release("primary-live-check-passed")
        boundary = gate("primary-signal-boundary")
        until = time.monotonic() + 2
        kernel_esrch = False
        while time.monotonic() < until:
            try:
                os.killpg(primary, 0)
            except ProcessLookupError as error:
                kernel_esrch = error.errno == errno.ESRCH
                break
            time.sleep(0.01)
        residual_before = [row for row in rows() if row["group"] in groups - {primary}]
        result.update(primaryGroup=primary, knownGroups=sorted(groups), boundary=boundary,
            kernelEsrchBeforeResume=kernel_esrch, residualBefore=[public_row(row) for row in residual_before])
        release("primary-signal-boundary")
        launched.wait(timeout=7)
        receipt_path = output / "race-job/job-result.json"
        receipt = json.loads(receipt_path.read_text())
        residual = [row for row in rows() if row["group"] in groups]
        actual_error = events / "actual-primary-esrch.json"
        witnessed = actual_error.exists() and json.loads(actual_error.read_text())["errno"] == errno.ESRCH
        result.update(actualRunnerEsrch=witnessed, cleanupReceipt=receipt["cleanup"],
            jobReceiptSha256=sha(receipt_path), residualAfter=[public_row(row) for row in residual],
            sweepGroups=[json.loads(path.read_text())["group"] for path in events.glob("sweep-*.json")],
            finalLiveCheckVisited=(events / "final-live-check.json").exists(),
            neighborSurvived=neighbor.poll() is None, actualRunnerExit=launched.returncode)
        before_witness = kernel_esrch and witnessed and bool(residual_before) and bool(residual) \
            and receipt["cleanup"]["status"] == "PASS" and neighbor.poll() is None
        after_pass = kernel_esrch and witnessed and bool(residual_before) and not residual \
            and receipt["cleanup"]["status"] == "PASS" and result["finalLiveCheckVisited"] \
            and bool(result["sweepGroups"]) and neighbor.poll() is None
        result["status"] = ("REPRODUCED" if before_witness else "NOT_REPRODUCED") if phase == "before" \
            else ("PASS" if after_pass else "FAIL")
    except Exception as error:
        result["failure"] = str(error) if str(error).replace("_", "").isalnum() else type(error).__name__
        if phase != "before":
            result["status"] = "FAIL"
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_alarm)
        for name in ("sampled", "primary-live-check-passed", "primary-signal-boundary"):
            release(name)
        cleanup_errors = []
        for group in sorted(groups):
            for signum in (signal.SIGCONT, signal.SIGKILL):
                try:
                    signal_group(group, signum, cleanup=True)
                except Exception:
                    cleanup_errors.append("CONTROL_OWNED_GROUP_CLEANUP_REFUSED")
                    break
        for child in (launched, neighbor):
            if child is None:
                continue
            try:
                child.terminate()
                child.wait(timeout=2)
            except ProcessLookupError:
                pass
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=2)
        until = time.monotonic() + 3
        while any(row["group"] in groups for row in rows(False)) and time.monotonic() < until:
            time.sleep(0.03)
        remaining = [public_row(row) for row in rows(False) if row["group"] in groups]
        result["controllerCleanup"] = {"status": "PASS" if not remaining and not cleanup_errors else "FAIL",
            "errors": cleanup_errors, "remaining": remaining}
        result["elapsedSeconds"] = time.monotonic() - started
        result["peakObservedIndividualChildBytes"] = peak_observed_child
        result["maximumAllowedIndividualChildBytes"] = 256 * 1024 ** 2
        result["controllerBodyWallSeconds"] = 30
        write(output / "real-os-cleanup-control.json", result)
    return result


def public_cli_source_root_control(root, candidate, output, phase, node, boundary):
    import hashlib
    import os
    import resource
    import stat
    import subprocess
    import time
    from pathlib import Path

    if phase not in ("before", "after"):
        raise ValueError("EXPLICIT_PUBLIC_CLI_CONTROL_PHASE_REQUIRED")
    if boundary not in ("seal", "stage-root-install", "stage-backend-install"):
        raise ValueError("EXACT_PUBLIC_CLI_CONTROL_BOUNDARY_REQUIRED")
    root, candidate, output = Path(root), Path(candidate), Path(output)
    if (not root.is_absolute() or not candidate.is_absolute() or root.is_symlink()
            or candidate.is_symlink() or not candidate.is_dir()):
        raise ValueError("ACTUAL_OWNED_CLI_CONTROL_ROOTS_REQUIRED")
    sealing = boundary == "seal"
    case = output / ("public-cli-" + boundary + "-root")
    case.mkdir(mode=0o700)
    claim = case.lstat()
    alias = case / "raw-source-root"
    ancestor = case / "raw-source-parent"
    aliases = ((alias, candidate), (ancestor, candidate.parent))
    owned_aliases = []
    script = root / "scope-postz/w2-accountable-workforce" / ("cold-seal.py" if sealing else "cold-stage.py")
    sources = (script, script.with_name("cold_packet.py"))
    ordinary_error = ("ValueError: NEW_ABSOLUTE_PACKET_OUTPUT_REQUIRED" if sealing
                      else "ValueError: NEW_ABSOLUTE_COLD_STAGE_OUTPUT_REQUIRED")
    record = {"status": "FAIL", "phase": phase,
        "boundary": "ACTUAL_COLD_SEAL_CLI" if sealing else "ACTUAL_COLD_STAGE_CLI",
        "action": None if sealing else boundary.removeprefix("stage-"),
        "implementationRoot": str(root), "candidate": str(candidate), "steps": [],
        "sourcePins": [{"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                        "bytes": path.stat().st_size} for path in sources],
        "caseIdentity": {"device": claim.st_dev, "inode": claim.st_ino},
        "rawSymlinkArgument": str(alias),
        "rawAncestorSymlinkArgument": str(ancestor / candidate.name),
        "symlinkArgumentsResolvedBeforeSubprocess": False,
        "ordinaryPreStateChangeError": ordinary_error,
        "productionEscapeFlagAdded": False, "archiveFunctionsOrReceiptsMocked": False,
        "childWallSeconds": 10, "maximumAllowedChildBytes": 268435456,
        "cleanup": {"status": "PASS", "errors": []}}
    started = time.monotonic()
    try:
        for path, target in aliases:
            path.symlink_to(target, target_is_directory=True)
            info = path.lstat()
            owned_aliases.append((path, target, info.st_dev, info.st_ino))
        ancestral_source = ancestor / candidate.name
        if ancestral_source.is_symlink() or not ancestor.is_symlink() or not ancestral_source.is_dir():
            raise RuntimeError("ACTUAL_NONTERMINAL_SYMBOLIC_COMPONENT_REQUIRED")
        record["ancestralFinalComponentIsSymlink"] = False
        cases = (("canonical", candidate), ("raw-symlink", alias),
                 ("raw-ancestor-symlink", ancestral_source))
        for label, source in cases:
            command = [sys.executable, "-B", str(script)]
            if sealing:
                command += ["--source", str(source), "--cache", str(case / "unused-cache"),
                    "--baseline-native", str(case / "unused-baseline-native"),
                    "--baseline-installation", str(case / "unused-baseline-installation"),
                    "--npm-cli", str(case / "unused-npm-cli.js"), "--node", str(node),
                    "--origin", "http://127.0.0.1:43123", "--forecast-bytes", "1048576"]
            else:
                command += ["--action", record["action"], "--prepared", str(source),
                    "--packet", str(case / "unused-packet.json"), "--packet-sha256", "0" * 64]
            command += ["--output", "not-absolute-packet-output"]
            result = subprocess.run(command, cwd=case, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
            if len(result.stdout) + len(result.stderr) > 131072:
                raise RuntimeError("PUBLIC_CLI_CAPTURE_BOUND_EXCEEDED")
            logs = {}
            for stream, data in (("stdout", result.stdout), ("stderr", result.stderr)):
                path = case / (label + "." + stream)
                with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as target:
                    target.write(data)
                logs[stream] = {"path": str(path), "bytes": len(data),
                                "sha256": hashlib.sha256(data).hexdigest()}
            lines = result.stderr.decode("utf-8", errors="replace").splitlines()
            observed = lines[-1] if lines else ""
            expected = ("ValueError: PUBLIC_CONFIGURATION_SYMLINK_REFUSED"
                        if label != "canonical" and phase == "after" else ordinary_error)
            record["steps"].append({"name": label, "argv": command, "exitCode": result.returncode,
                "observedError": observed, "expectedError": expected, "logs": logs})
            if result.returncode != 1 or result.stdout or observed != expected:
                raise RuntimeError("EXACT_PUBLIC_CLI_BOUNDARY_ERROR_REQUIRED")
            if (case / "not-absolute-packet-output").exists():
                raise RuntimeError("PUBLIC_CLI_MUST_NOT_CREATE_PACKET_OUTPUT")
        record["status"] = "REPRODUCED" if phase == "before" else "PASS"
    except Exception as error:
        record["failure"] = type(error).__name__ + ":" + (
            str(error) if str(error).replace("_", "").isalnum() else "PUBLIC_CLI_CONTROL_FAILED")
    finally:
        for path, target, device, inode in reversed(owned_aliases):
            try:
                current = path.lstat()
                if (not stat.S_ISLNK(current.st_mode) or (current.st_dev, current.st_ino) !=
                        (device, inode) or os.readlink(path) != str(target)):
                    raise RuntimeError("OWNED_CLI_ALIAS_CUSTODY_CHANGED")
                path.unlink()
            except Exception as error:
                record["cleanup"]["errors"].append(path.name + ":" + type(error).__name__)
        if record["cleanup"]["errors"]:
            record["cleanup"]["status"] = "FAIL"
            record["status"] = "FAIL"
        maximum = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        record["peakObservedCliChildBytes"] = maximum if sys.platform == "darwin" else maximum * 1024
        if record["peakObservedCliChildBytes"] > record["maximumAllowedChildBytes"]:
            record.update(status="FAIL", failure="PUBLIC_CLI_CHILD_MEMORY_BOUND_EXCEEDED")
        output_created = (case / "not-absolute-packet-output").exists()
        record["packetOutputCreated"] = output_created
        record["archiveOrInstallExecuted"] = "NOT_ESTABLISHED" if output_created else False
        if output_created:
            record.update(status="FAIL", failure="PUBLIC_CLI_PRE_ARCHIVE_BOUNDARY_LOST")
        record["elapsedSeconds"] = time.monotonic() - started
        with os.fdopen(os.open(output / ("public-cli-" + boundary + "-root-control.json"),
                os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as target:
            target.write(json.dumps(record, indent=2) + "\n")
    return record


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--traced-run":
        trace_runner(sys.argv[2], sys.argv[3], sys.argv[4:])
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--phase", required=True, choices=("before", "after"))
    parser.add_argument("--node", required=True)
    parser.add_argument("--configuration-fixture")
    args = parser.parse_args()
    root, candidate, output = Path(args.source).resolve(strict=True), Path(args.candidate).resolve(strict=True), Path(args.output)
    assert output.is_absolute() and ".." not in output.parts
    output.mkdir(mode=0o700)
    fixture = Path(args.configuration_fixture).resolve(strict=True) if args.configuration_fixture else None
    cli = public_cli_source_root_control(root, candidate, output, args.phase, args.node, "seal")
    prepared_root = public_cli_source_root_control(root, candidate, output, args.phase, args.node,
                                                  "stage-root-install")
    prepared_backend = public_cli_source_root_control(root, candidate, output, args.phase, args.node,
                                                     "stage-backend-install")
    config = config_control(root, candidate, output, args.phase, fixture)
    process = os_control(root, output, args.phase, args.node)
    wanted = "REPRODUCED" if args.phase == "before" else "PASS"
    passed = all(result["status"] == wanted for result in (cli, prepared_root, prepared_backend, config, process)) \
        and process["controllerCleanup"]["status"] == "PASS"
    report = {"status": "PASS" if passed else "FAIL", "phase": args.phase,
        "meaning": "EXPECTED_DEFECTS_REPRODUCED" if args.phase == "before" else "SOURCE_AND_REAL_OS_CONTROLS_ONLY",
        "publicCliSourceRoot": cli["status"], "sourceConfig": config["status"], "realOsCleanup": process["status"],
        "publicCliPreparedRoot": {"root-install": prepared_root["status"],
                                 "backend-install": prepared_backend["status"]},
        "controllerCleanup": process["controllerCleanup"], "source": str(root), "candidate": str(candidate),
        "controllerSha256": sha(__file__), "archiveInstallBuildNativeBrowserDatabaseExecuted":
            False if all(result["archiveOrInstallExecuted"] is False
                         for result in (cli, prepared_root, prepared_backend)) else "NOT_ESTABLISHED"}
    write(output / "report.json", report)
    print(json.dumps(report))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
