"""Finite W2 campaign entrypoint. Explicit offline installs, no remote activation.

The outer guard owns the heavy lease and actual host envelope. Native-bound and
recovery additionally use their shared exact-output/body supervisor. No child,
restart, build, or resource wait renews an existing business deadline.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import stat
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / "scope-postz/w1-economic-orchestration/native"))
from campaign_runtime import ResourcePolicy, host_facts

HARNESS_SOURCE_PATHS = (
    "scope-postz/w2-accountable-workforce/run-job.py",
    "scope-postz/w2-accountable-workforce/qualify.py",
    "scope-postz/w2-accountable-workforce/freeze-harness.py",
    "scope-postz/w2-accountable-workforce/run-qualification-controls.py",
    "scope-postz/w2-accountable-workforce/run-review-regression-controls.py",
    "scope-postz/w2-accountable-workforce/cold_packet.py",
    "scope-postz/w2-accountable-workforce/cold-seal.py",
    "scope-postz/w2-accountable-workforce/cold-stage.py",
    "scope-postz/w2-accountable-workforce/qualification/campaign-profiles.json",
    "scope-postz/w2-accountable-workforce/verification-plan.json",
    "scope-postz/w2-accountable-workforce/dynamic/structural-contract.json",
    "scope-postz/w1-economic-orchestration/native/campaign_runtime.py",
    "finnor-os/scripts/postz-w2/owned-campaign-supervisor.mts",
    "finnor-os/scripts/postz-w2/run-supervision-controls.mts",
    "finnor-os/scripts/postz-w2/fixtures/supervision-control-body.mts",
    "finnor-os/scripts/postz-w2/run-native-bound-e2e.mts",
    "finnor-os/scripts/postz-w2/run-native-recovery-e2e.mts",
    "finnor-os/scripts/postz-w2/native-bound-body.mts",
    "finnor-os/scripts/postz-w2/native-recovery-body.mts",
    "finnor-os/scripts/postz-w2/run-native-e2e.mts",
    "finnor-os/scripts/postz-w2/mounted-fixture.mts",
    "finnor-os/scripts/postz-w2/physical-worker.mts",
    "finnor-os/scripts/postz-w2/run-domain-e2e.mts",
    "finnor-os/scripts/postz-w2/run-dynamic-e2e.mts",
    "finnor-os/scripts/postz-w2/run-structural-e2e.mts",
    "finnor-os/scripts/postz-w2/tsconfig.native.json",
    "finnor-os/scripts/postz-w2/build-development.mjs",
    "finnor-os/scripts/frontier5/x1/build-development.mjs",
    "scripts/postz-w2/build-frontend.mjs",
    "scripts/frontier5/x1/build-frontend.mjs",
    "scripts/frontier5/x1/finalize-frontend.mjs",
    "scripts/frontier5/x1/frontend-generated-inputs.mjs",
    "scripts/frontier5/x1/frontend-tracing-root.mjs",
    "scripts/frontier5/x1/frontend-host.mjs",
    "scripts/postz-w2/agent-browser-client.mjs",
    "scripts/postz-w2/browser-provenance-observer.mjs",
    "scripts/postz-w2/browser-owner-observer.m",
    "scripts/postz-w2/browser-campaign-coordinator.mjs",
    "scripts/postz-w2/cdp-browser.mjs",
    "scripts/postz-w2/run-cdp-native.mjs",
    "scripts/postz-w2/cold-compare.mjs",
)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def freeze_pin(path):
    path = Path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise ValueError("REGULAR_FROZEN_HARNESS_INPUT_REQUIRED")
    return {"path": str(path), "sha256": sha(path), "bytes": info.st_size, "mode": stat.S_IMODE(info.st_mode)}


def read_private_json(file, expected_sha):
    path = Path(file)
    if (not path.is_absolute() or ".." in path.parts or str(path) != str(file)
            or not re.fullmatch(r"[a-f0-9]{64}", expected_sha or "")):
        raise ValueError("CANONICAL_PRIVATE_JSON_AND_INDEPENDENT_PIN_REQUIRED")

    def no_aliases():
        for component in (path, *path.parents):
            if stat.S_ISLNK(component.lstat().st_mode):
                raise ValueError("PRIVATE_JSON_SYMLINK_ANCESTRY_REFUSED")

    def identity(info):
        return (info.st_dev, info.st_ino, info.st_size, info.st_mode, info.st_uid,
                info.st_mtime_ns, info.st_ctime_ns)

    no_aliases()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(descriptor)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
                or stat.S_IMODE(before.st_mode) != 0o600 or not 0 < before.st_size <= 1048576):
            raise ValueError("BOUNDED_OWNER_PRIVATE_JSON_REQUIRED")
        chunks, count = [], 0
        while True:
            block = os.read(descriptor, min(65536, 1048577 - count))
            if not block:
                break
            chunks.append(block)
            count += len(block)
            if count > before.st_size:
                raise ValueError("PRIVATE_JSON_CHANGED_DURING_READ")
        no_aliases()
        body = b"".join(chunks)
        if (identity(before) != identity(os.fstat(descriptor))
                or identity(before) != identity(path.lstat()) or count != before.st_size
                or hashlib.sha256(body).hexdigest() != expected_sha):
            raise ValueError("EXACT_PRIVATE_JSON_BYTES_AND_IDENTITY_REQUIRED")
        return json.loads(body)
    finally:
        os.close(descriptor)


def iso_milliseconds(value):
    if not isinstance(value, str):
        raise ValueError("ACTUAL_TIMESTAMP_REQUIRED")
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("ACTUAL_TIMEZONE_TIMESTAMP_REQUIRED")
    return stamp.timestamp() * 1000


class FrozenHarness:
    """External prelaunch pins, also checked for the still-active controller."""
    def __init__(self, file, expected_sha, root, node, policy_file=None):
        self.file, self.expected_sha, self.root = Path(file), expected_sha, Path(root)
        if not self.file.is_absolute() or not re.fullmatch(r"[a-f0-9]{64}", expected_sha or ""):
            raise ValueError("EXTERNAL_PRELAUNCH_HARNESS_PIN_REQUIRED")
        if self.file.is_symlink() or self.file.stat().st_size > 1048576 or sha(self.file) != expected_sha:
            raise ValueError("EXACT_EXTERNAL_HARNESS_MANIFEST_REQUIRED")
        self.manifest = json.loads(self.file.read_text())
        if self.manifest.get("schema") != "finnor.w2.prelaunch-harness-freeze.v1" \
                or set(self.manifest.get("sources", {})) != set(HARNESS_SOURCE_PATHS):
            raise ValueError("COMPLETE_INDEPENDENT_HARNESS_SOURCE_PINSET_REQUIRED")
        tools = self.manifest["tools"]
        for name, actual in (("node", Path(node).resolve(strict=True)), ("python", Path(sys.executable).resolve(strict=True))):
            if tools[name]["path"] != str(actual):
                raise ValueError("EXACT_PREDECLARED_RUNTIME_BINARY_REQUIRED")
        for name in ("git", "ps"):
            selected = shutil.which(name)
            if not selected or str(Path(selected).resolve(strict=True)) != tools[name]["path"]:
                raise ValueError("EXACT_PREDECLARED_HOST_OBSERVER_TOOL_REQUIRED")
        self.policy_file = Path(policy_file).resolve(strict=True) if policy_file else None
        declared_policy = self.manifest.get("resourcePolicy")
        if bool(self.policy_file) != bool(declared_policy) or self.policy_file and declared_policy["path"] != str(self.policy_file):
            raise ValueError("EXACT_PRELAUNCH_RESOURCE_POLICY_REQUIRED")
        self.tool_identity = {}
        self.verify(all_tools=True)
        actual = subprocess.check_output(["git", "-C", str(self.root), "rev-parse", "HEAD", "HEAD^{tree}"],
                                         text=True, timeout=10).splitlines()
        if actual != [self.manifest["source"]["commit"], self.manifest["source"]["tree"]]:
            raise ValueError("ACTUAL_INDEPENDENTLY_FROZEN_SOURCE_COMMIT_REQUIRED")
        for name, row in tools.items():
            info = Path(row["path"]).stat()
            self.tool_identity[name] = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_mode)

    def verify(self, all_tools=False):
        if self.file.is_symlink() or sha(self.file) != self.expected_sha:
            raise RuntimeError("ACTIVE_HARNESS_MANIFEST_CHANGED")
        for name, row in self.manifest["sources"].items():
            actual = freeze_pin(self.root / name)
            if any(actual[key] != row[key] for key in ("sha256", "bytes", "mode")):
                raise RuntimeError("ACTIVE_EXECUTING_HARNESS_SOURCE_CHANGED")
        if self.policy_file and freeze_pin(self.policy_file) != self.manifest["resourcePolicy"]:
            raise RuntimeError("ACTIVE_FROZEN_RESOURCE_POLICY_CHANGED")
        for name, row in self.manifest["tools"].items():
            path = Path(row["path"])
            if all_tools:
                if freeze_pin(path) != row:
                    raise RuntimeError("ACTIVE_FROZEN_TOOL_BINARY_CHANGED")
            elif name in self.tool_identity:
                info = path.lstat()
                if (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_mode) != self.tool_identity[name]:
                    raise RuntimeError("ACTIVE_FROZEN_TOOL_IDENTITY_CHANGED")


def redacted_log(data):
    value = data.decode("utf-8", errors="replace")
    value = re.sub(r"(?i)\b(?:https?|wss?|postgres(?:ql)?)://[^\s<>\"']+", "[REDACTED_URL]", value)
    value = re.sub(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [REDACTED]", value)
    value = re.sub(r'(?i)("(?:password|access_token|refresh_token|authorization|cookie|token)"\s*:\s*)"[^"]*"',
                   r'\1"[REDACTED]"', value)
    value = re.sub(r"(?i)\b((?:password|access_token|refresh_token|authorization|cookie|token)=)[^&\s]+",
                   r"\1[REDACTED]", value)
    return value.encode("utf-8")[:2097152]


def source_cut():
    def git(*args):
        return subprocess.check_output(["git", "-C", str(ROOT), *args], timeout=10)
    additional = git("ls-files", "--others", "--exclude-standard", "-z").decode().split("\0")
    # Evidence-private basenames never enter the source freeze; generated
    # artifacts/ are already excluded by gitignore (verified empirically).
    private_names = {".job-owner.json", ".campaign-owner.json", ".owner.json", ".process-group.json",
                     "mounted-private-fixture.json", "driver.log"}
    pins = []
    for name in sorted(filter(None, additional)):
        path = ROOT / name
        if path.name.startswith(".env") or path.name in private_names:
            continue
        if path.is_file() and not path.is_symlink():
            if path.stat().st_size > 268435456:
                raise RuntimeError("UNTRACKED_SOURCE_FILE_TOO_LARGE:" + name)
            pins.append({"path": name, "sha256": sha(path)})
    return {"commit": git("rev-parse", "HEAD").decode().strip(),
            "tree": git("rev-parse", "HEAD^{tree}").decode().strip(),
            "diffSha256": hashlib.sha256(git("diff", "HEAD", "--binary")).hexdigest(), "additionalSource": pins}


def process_rows():
    lines = subprocess.check_output(["ps", "-ww", "-axo", "pid=,ppid=,pgid=,rss=,lstart=,command="],
                                    text=True, timeout=2, env={**os.environ, "LC_ALL": "C"}).splitlines()
    rows = []
    for line in lines:
        match = re.fullmatch(r"\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+"
                            r"(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)", line)
        if match:
            rows.append({"pid": int(match[1]), "parent": int(match[2]), "group": int(match[3]),
                         "residentBytes": int(match[4]) * 1024,
                         "birth": " ".join(match[5].split()), "command": match[6]})
    if not rows:
        raise RuntimeError("ACTUAL_PROCESS_BIRTH_OBSERVER_REQUIRED")
    return rows


def same_process(left, right):
    return all(left[key] == right[key] for key in ("pid", "group", "birth"))


def observe_owned(child, known, groups):
    rows = process_rows()
    parents = {row["pid"] for row in rows if row["pid"] in known and same_process(known[row["pid"]], row)}
    if child and child.poll() is None:
        parents.add(child.pid)
    while True:
        added = {row["pid"] for row in rows if row["parent"] in parents}
        if added.issubset(parents):
            break
        parents |= added
    observed = [row for row in rows if row["pid"] in parents]
    for row in observed:
        previous = known.get(row["pid"])
        if previous and not same_process(previous, row):
            raise RuntimeError("OWNED_PROCESS_IDENTITY_CHANGED")
        known[row["pid"]] = row
        groups.add(row["group"])
    return observed


def evidence_bytes(root, exclusions):
    total = 0
    for directory, directories, files in os.walk(root, followlinks=False):
        directories[:] = [name for name in directories if name not in exclusions]
        for name in directories + files:
            if name in exclusions:
                continue
            path = Path(directory) / name
            try:
                mode = path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(mode.st_mode):
                raise RuntimeError("ACTUAL_ARTIFACT_POPULATION_MUST_NOT_CONTAIN_LINKS")
            if stat.S_ISREG(mode.st_mode):
                total += mode.st_size
    return total


def canonical_origin(value):
    from urllib.parse import urlsplit
    origin = urlsplit(value)
    if (origin.scheme != "http" or origin.hostname != "127.0.0.1" or not origin.port
            or origin.username or origin.password or origin.path not in ("", "/") or origin.query or origin.fragment):
        raise ValueError("EXACT_LOOPBACK_FRONTEND_ORIGIN_REQUIRED")
    return origin.scheme + "://" + origin.netloc


def command_for(args, profile, output, node):
    backend = ROOT / "finnor-os"
    environment = {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "TMPDIR")
                   if key in os.environ}
    environment.update(NODE_OPTIONS="", FINNOR_W2_EVIDENCE_ROOT=str(output / "campaign"),
                       NEXT_TELEMETRY_DISABLED="1")
    for key in ("FACTORY_DESKTOP_CDP_PORT", "AGENT_BROWSER_CDP", "AGENT_BROWSER_SESSION", "AGENT_BROWSER_PIN_TAB",
                "FINNOR_AGENT_BROWSER_BIN"):
        if key in os.environ:
            environment[key] = os.environ[key]
    if args.backend:
        environment["FINNOR_W2_INSTALLATION"] = str(Path(args.backend).resolve(strict=True))
    if args.frontend:
        environment["FINNOR_W2_FRONTEND_INSTALLATION"] = str(Path(args.frontend).resolve(strict=True))
    if args.origin:
        environment["FINNOR_W2_FRONTEND_ORIGIN"] = canonical_origin(args.origin)
    base = [str(node), "--max-old-space-size=" + str(profile["heapMiB"])]
    case = args.case
    if case == "cold-seal":
        if not all((args.cache, args.npm_cli, args.baseline_native, args.baseline_installation, args.origin)):
            raise ValueError("EXPLICIT_COLD_SEAL_ASSETS_AND_BASELINE_REQUIRED")
        return [sys.executable, "-B", str(ROOT / "scope-postz/w2-accountable-workforce/cold-seal.py"),
                "--source", str(ROOT), "--output", str(output / "packet"), "--cache", args.cache,
                "--baseline-native", args.baseline_native, "--baseline-installation", args.baseline_installation,
                "--npm-cli", args.npm_cli, "--node", str(node), "--origin", canonical_origin(args.origin),
                "--forecast-bytes", str(args.forecast_bytes)], ROOT, environment
    cold_cases = {"cold-prepare": "prepare", "cold-root-install": "root-install",
                  "cold-backend-install": "backend-install", "cold-compatibility": "compatibility"}
    if case in cold_cases:
        if not args.packet or not args.packet_sha256:
            raise ValueError("EXACT_SEALED_PACKET_AND_SHA256_REQUIRED")
        command = [sys.executable, "-B", str(ROOT / "scope-postz/w2-accountable-workforce/cold-stage.py"),
                   "--action", cold_cases[case], "--packet", args.packet, "--packet-sha256", args.packet_sha256,
                   "--output", str(output / "campaign")]
        for flag, value in (("--prepared", args.prepared), ("--backend", args.backend), ("--fresh-native", args.fresh_native)):
            if value:
                command += [flag, value]
        return command, ROOT, environment
    if case == "supervision":
        return base + ["--experimental-strip-types", str(backend / "scripts/postz-w2/run-supervision-controls.mts"),
                       "--output", str(output / "controls")], ROOT, environment
    if case == "types":
        return base + [str(backend / "node_modules/typescript/bin/tsc"), "-p",
                       "scripts/postz-w2/tsconfig.native.json", "--pretty", "false"], backend, environment
    if case in ("backend-build", "frontend-build"):
        frontend = case == "frontend-build"
        command = base + [str(ROOT / ("scripts/postz-w2/build-frontend.mjs" if frontend
                                      else "finnor-os/scripts/postz-w2/build-development.mjs")),
                          "--output", str(output / ("frontend" if frontend else "backend"))]
        if frontend:
            if not args.origin:
                raise ValueError("COMPILED_FRONTEND_ORIGIN_REQUIRED")
            command += ["--origin", canonical_origin(args.origin)]
        return command, ROOT, environment
    if case == "mounted":
        if not args.backend or not args.frontend or not args.origin:
            raise ValueError("ACTUAL_INSTALLED_BACKEND_FRONTEND_AND_ORIGIN_REQUIRED")
        for destination, file_arg, hash_arg in (
            ("FINNOR_W2_CAMPAIGN_OWNER", "campaign_owner", "campaign_owner_sha256"),
            ("FINNOR_W2_HARNESS_MANIFEST", "harness_manifest", "harness_manifest_sha256"),
            ("FINNOR_W2_BROWSER_OBSERVER_TEMPLATE", "browser_observer_template", "browser_observer_template_sha256"),
            ("FINNOR_W2_BROWSER_OBSERVER_GRANT", "browser_observer_grant", "browser_observer_grant_sha256"),
        ):
            file, expected = getattr(args, file_arg, None), getattr(args, hash_arg, None)
            if (not isinstance(file, str) or not Path(file).is_absolute() or ".." in Path(file).parts
                    or str(Path(file)) != file or not re.fullmatch(r"[a-f0-9]{64}", expected or "")):
                raise ValueError("EXACT_CURRENT_CAMPAIGN_BROWSER_REFERENCE_REQUIRED")
            environment[destination], environment[destination + "_SHA256"] = file, expected
        environment["FINNOR_W2_JOB_OWNER"] = str(output / ".job-owner.json")
        environment["FINNOR_W2_JOB_OWNER_SHA256"] = sha(output / ".job-owner.json")
        return base + [str(ROOT / "scripts/postz-w2/run-cdp-native.mjs")], ROOT, environment
    filenames = {"domain": "run-domain-e2e.mts", "dynamic": "run-dynamic-e2e.mts",
                 "structural": "run-structural-e2e.mts", "native": "run-native-e2e.mts",
                 "bound": "run-native-bound-e2e.mts", "recovery": "run-native-recovery-e2e.mts"}
    if case in ("domain", "dynamic", "structural"):
        environment["FINNOR_W2_" + case.upper() + "_EVIDENCE_ROOT"] = str(output / "campaign")
    command = base + ["--import=tsx", str(backend / "scripts/postz-w2" / filenames[case])]
    if case in ("bound", "recovery"):
        command += ["--output", str(output / "campaign")]
    return command, backend, environment


def check_mounted_browser_gate(report, output, context):
    if context is None or sys.platform != "darwin":
        raise RuntimeError("ACTUAL_DARWIN_CURRENT_CAMPAIGN_GATE_CONTEXT_REQUIRED")
    args, claim, harness = context
    proof = report.get("browserProvenance", {})
    scope = proof.get("scope", {})
    owner = read_private_json(args.campaign_owner, args.campaign_owner_sha256)
    job_body = (json.dumps(claim) + "\n").encode()
    job_hash = hashlib.sha256(job_body).hexdigest()
    if read_private_json(output / ".job-owner.json", job_hash) != claim:
        raise RuntimeError("ORIGINAL_MOUNTED_JOB_CLAIM_REQUIRED")
    inputs = read_private_json(output / "browser-observer-inputs-current.json", scope.get("inputsSha256"))
    campaign = inputs.get("campaign", {})
    references = (
        ("owner", args.campaign_owner, args.campaign_owner_sha256),
        ("jobOwner", str(output / ".job-owner.json"), job_hash),
        ("harnessManifest", args.harness_manifest, args.harness_manifest_sha256),
        ("template", args.browser_observer_template, args.browser_observer_template_sha256),
        ("executionGrant", args.browser_observer_grant, args.browser_observer_grant_sha256),
    )
    if (owner.get("schema") != "finnor.w2.campaign-output-owner.v2" or owner.get("platform") != "darwin"
            or owner.get("uid") != os.getuid() or inputs.get("schema") != "finnor.w2.browser-observer-inputs.v2"
            or any(campaign.get(name, {}).get("path") != file
                   or campaign.get(name, {}).get("sha256") != expected for name, file, expected in references)):
        raise RuntimeError("EXACT_CURRENT_CAMPAIGN_PRODUCER_REFERENCES_REQUIRED")
    expected_scope = {
        "inputsSha256": scope.get("inputsSha256"),
        "campaignOwnerSha256": args.campaign_owner_sha256,
        "campaignNonceSha256": hashlib.sha256(owner["nonce"].encode()).hexdigest(),
        "jobOwnerSha256": job_hash, "jobNonceSha256": hashlib.sha256(claim["nonce"].encode()).hexdigest(),
        "templateSha256": args.browser_observer_template_sha256,
        "executionGrantSha256": args.browser_observer_grant_sha256,
        "harnessManifestSha256": args.harness_manifest_sha256,
        "campaignPlatform": "darwin", "campaignOutputDevice": owner["device"], "campaignOutputInode": owner["inode"],
        "jobOutputDevice": claim["device"], "jobOutputInode": claim["inode"],
        "sourceCommit": harness["source"]["commit"], "sourceTree": harness["source"]["tree"],
        "targetIdSha256": inputs["assignment"]["targetIdSha256"],
        "locationSha256": inputs["assignment"]["locationSha256"],
    }
    expected_binding = {
        "platform": "darwin", "uid": owner["uid"], "creatorPid": owner["pid"],
        "createdAtUnixMs": owner["createdAtUnixMs"], "nonceSha256": expected_scope["campaignNonceSha256"],
        "outputDevice": owner["device"], "outputInode": owner["inode"],
        "jobCreatorPid": claim["pid"], "jobNonceSha256": expected_scope["jobNonceSha256"],
        "jobOutputDevice": claim["device"], "jobOutputInode": claim["inode"],
    }
    if campaign.get("binding") != expected_binding:
        raise RuntimeError("CURRENT_CAMPAIGN_AND_JOB_CLAIM_TUPLE_REQUIRED")
    browser_sources = (
        "scripts/postz-w2/agent-browser-client.mjs",
        "scripts/postz-w2/browser-provenance-observer.mjs",
        "scripts/postz-w2/browser-owner-observer.m",
        "scripts/postz-w2/browser-campaign-coordinator.mjs",
        "scripts/postz-w2/cdp-browser.mjs",
        "scripts/postz-w2/run-cdp-native.mjs",
    )
    source_hashes = {name: harness["sources"][name]["sha256"] for name in browser_sources}
    tool_hashes = {name: harness["tools"][name]["sha256"]
                   for name in ("node", "agentBrowser", "browserObserver", "browserExecutable")}
    pre_start = read_private_json(output / "campaign/browser-provenance-current.json",
                                 report.get("browserPreStartProofSha256"))
    now = datetime.now(timezone.utc).timestamp() * 1000
    checked = iso_milliseconds(report.get("browserProvenanceValidatedAt"))
    for actual, consumed in ((pre_start, iso_milliseconds(pre_start.get("completedAt"))), (proof, checked)):
        observed = iso_milliseconds(actual.get("observedAt"))
        completed = iso_milliseconds(actual.get("completedAt"))
        host = actual.get("observerHost", {})
        if (actual.get("schema") != "finnor.w2.assigned-browser-provenance.v2"
                or actual.get("source") != "ACTUAL_SUPPORTED_ASSIGNED_TARGET_NATIVE_OS_NONCE_BRIDGE_V1"
                or actual.get("status") != "PASS" or actual.get("browser", {}).get("headed") is not True
                or actual.get("browser", {}).get("separatelyLaunched") is not True
                or any(actual.get("predicates", {}).get(name, {}).get("status") != "PASS"
                       for name in ("VISIBLE_EXTERNAL", "SESSION_TARGET_BOUND", "SEPARATE_LAUNCH_PROVEN"))
                or actual.get("cleanup", {}).get("status") != "PASS"
                or actual.get("cleanup", {}).get("titleRestored") is not True
                or actual.get("cleanup", {}).get("markerRemoved") is not True
                or actual.get("tools") != tool_hashes or actual.get("sources") != source_hashes
                or any(actual.get("scope", {}).get(key) != value for key, value in expected_scope.items())
                or actual.get("assignedEndpointSha256") != inputs["assignment"]["endpointSha256"]
                or actual.get("assignedSessionSha256") != inputs["assignment"]["sessionSha256"]
                or host.get("platform") != "darwin"
                or host.get("topology") != "DARWIN_SAME_HOST_CAMPAIGN_AND_OBSERVER_V1"
                or not re.fullmatch(r"[a-f0-9]{64}", host.get("bootSha256", ""))
                or host.get("campaignOwnerProcess", {}).get("pid") != owner["pid"]
                or host.get("mountedJobOwnerProcess", {}).get("pid") != claim["pid"]
                or not owner["createdAtUnixMs"] <= observed <= completed <= consumed <= now + 1000
                or consumed - observed > 300000 or completed - observed > 120000
                or not 0 < actual.get("elapsedMs", 0) <= 120000
                or actual.get("childrenAttempted", {}).get("native") != 3
                or not 0 < actual.get("childrenAttempted", {}).get("supportedCli", 0) <= 10):
            raise RuntimeError("ACTUAL_CURRENT_V2_THREE_PREDICATE_BROWSER_GATE_REQUIRED")
    if (proof.get("browser") != report.get("browser")
            or pre_start["observerHost"] != proof["observerHost"]
            or iso_milliseconds(pre_start["observedAt"]) > iso_milliseconds(proof["observedAt"])
            or not report.get("steps") or checked > iso_milliseconds(report["steps"][0].get("at"))):
        raise RuntimeError("PRE_START_TO_CURRENT_BROWSER_SCOPE_AND_ORDER_REQUIRED")
    # Current at consumption. The unchanged complete mounted body may exceed
    # five minutes; its later terminal time must not manufacture staleness.


def check_artifacts(case, profile, output, installed, mounted_context=None):
    if case == "types":
        return {"status": "PASS", "qualification": "SEMANTIC_TYPES_ONLY", "files": []}
    if case == "supervision":
        directory = output / "controls"
    elif case in ("bound", "recovery", "domain", "dynamic") or case in (
            "cold-prepare", "cold-root-install", "cold-backend-install", "cold-compatibility"):
        directory = output / "campaign"
    elif case == "cold-seal":
        directory = output / "packet"
    elif case in ("backend-build", "frontend-build"):
        directory = output / ("frontend" if case == "frontend-build" else "backend")
    else:
        candidates = [path.parent for path in (output / "campaign").glob("*/" + profile["report"])]
        if len(candidates) != 1:
            raise RuntimeError("EXACT_ONE_OWNED_CAMPAIGN_REPORT_REQUIRED")
        directory = candidates[0]
    required = list(profile["required"])
    if case in ("domain", "dynamic"):
        reports = list(directory.glob(profile["report"]))
        if len(reports) != 1:
            raise RuntimeError("EXACT_ONE_OWNED_CAMPAIGN_REPORT_REQUIRED")
        report_path = reports[0]
        required.append(report_path.name)
    else:
        report_path = directory / profile["report"]
    if case == "native" and installed:
        required.append("installed-source-custody-byte-change-and-restoration.json")
    if case == "structural":
        contract = json.loads((ROOT / "scope-postz/w2-accountable-workforce/dynamic/structural-contract.json").read_text())
        required += [family["id"] + "-" + str(variant) + ".json" for family in contract["families"] for variant in range(8)]
    pins = []
    for name in required:
        path = directory / name
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(directory.resolve()):
            raise RuntimeError("REQUIRED_REGULAR_OWNED_ARTIFACT_MISSING:" + name)
        pins.append({"path": path.relative_to(output).as_posix(), "bytes": path.stat().st_size, "sha256": sha(path)})
    report = json.loads(report_path.read_text())
    if case == "cold-seal":
        if report.get("schema") != "finnor.w2.sealed-cold-packet.v1":
            raise RuntimeError("ACTUAL_SEALED_COLD_PACKET_REQUIRED")
    elif case in ("backend-build", "frontend-build"):
        expected = "finnor.postz.w2." + ("frontend" if case == "frontend-build" else "development") + "-installation.v1"
        if report.get("schema") != expected or report.get("productionActive") is not False:
            raise RuntimeError("ACTUAL_W2_DEVELOPMENT_INSTALLATION_REQUIRED")
        # Installed manifest closure: every declared file/link verified by
        # bytes, and the on-disk population must be exactly the declaration
        # plus the known post-manifest receipts.
        declared_files = {}
        for row in report.get("files", []):
            if not isinstance(row.get("path"), str) or row["path"] in declared_files \
                    or not re.fullmatch(r"[a-f0-9]{64}", row.get("sha256", "")) or not isinstance(row.get("bytes"), int):
                raise RuntimeError("INSTALLATION_MANIFEST_FILE_ROWS_INVALID")
            declared_files[row["path"]] = row
        declared_links = {}
        for row in report.get("links", []):
            if not isinstance(row.get("path"), str) or row["path"] in declared_links or not isinstance(row.get("target"), str):
                raise RuntimeError("INSTALLATION_MANIFEST_LINK_ROWS_INVALID")
            declared_links[row["path"]] = row["target"]
        extras = {report_path.relative_to(directory).as_posix()}
        if case == "frontend-build":
            extras.add("build-resources.json")
            receipt = report.get("buildReceipt", {})
            receipt_path = directory / "build-resources.json"
            if (receipt.get("path") != "build-resources.json" or not receipt_path.is_file()
                    or receipt_path.is_symlink() or sha(receipt_path) != receipt.get("sha256")):
                raise RuntimeError("FRONTEND_BUILD_RECEIPT_BYTES_REQUIRED")
        found_files, found_links = set(), set()
        for dirpath, dirnames, filenames in os.walk(directory):
            for name in dirnames + filenames:
                candidate = Path(dirpath) / name
                rel = candidate.relative_to(directory).as_posix()
                entry_mode = candidate.lstat().st_mode
                if stat.S_ISDIR(entry_mode):
                    continue
                if stat.S_ISLNK(entry_mode):
                    found_links.add(rel)
                    if declared_links.get(rel) != os.readlink(candidate):
                        raise RuntimeError("UNDECLARED_OR_CHANGED_INSTALLED_LINK:" + rel)
                elif stat.S_ISREG(entry_mode):
                    found_files.add(rel)
                    row = declared_files.get(rel)
                    if row is None:
                        if rel not in extras:
                            raise RuntimeError("UNDECLARED_INSTALLED_FILE:" + rel)
                    elif row["bytes"] != candidate.stat().st_size or row["sha256"] != sha(candidate):
                        raise RuntimeError("INSTALLED_FILE_BYTES_CHANGED:" + rel)
                else:
                    raise RuntimeError("UNEXPECTED_INSTALLED_SPECIAL_FILE:" + rel)
        if found_files != set(declared_files) | extras or found_links != set(declared_links):
            raise RuntimeError("INSTALLED_FILE_POPULATION_INCOMPLETE")
    elif report.get("status") != "PASS":
        raise RuntimeError("ACTUAL_DRIVER_REPORT_DID_NOT_PASS")
    if case in ("domain", "dynamic"):
        cases = report.get("cases", [])
        if len(cases) < profile["minimumCases"] or any(row.get("ok") is not True for row in cases):
            raise RuntimeError("ALL_ORIGINAL_SYNTHETIC_CASES_REQUIRED")
        if report.get("sourceClass") != "SYNTHETIC":
            raise RuntimeError("SYNTHETIC_BOUNDARY_MUST_REMAIN_EXPLICIT")
    if case == "structural":
        if any(report.get(key) != value for key, value in
               (("observedFamilies", 16), ("observedCases", 128), ("freshOriginals", 256))):
            raise RuntimeError("SIXTEEN_FAMILIES_EIGHT_EACH_256_FRESH_ORIGINALS_REQUIRED")
    if "maximumOutputBytes" in profile:
        exclusions = json.loads((Path(__file__).parent / "qualification/campaign-profiles.json").read_text())["privateExclusions"]
        if evidence_bytes(directory, exclusions) > profile["maximumOutputBytes"]:
            raise RuntimeError("ORIGINAL_ACTUAL_ARTIFACT_OUTPUT_BOUND")
    if case == "native":
        if report.get("actualOrdinaryAuthentication") is not True or report.get("actualRestrictedRoles") is not True:
            raise RuntimeError("ACTUAL_ORDINARY_AUTHENTICATION_AND_RESTRICTED_ROLES_REQUIRED")
    if case in ("native", "bound", "recovery"):
        cleanup = json.loads((directory / "cleanup.json").read_text())
        steps = cleanup.get("steps", cleanup.get("closers", [])) if isinstance(cleanup, dict) else cleanup
        if not steps or any(row.get("status") != "PASS" for row in steps):
            raise RuntimeError("ALL_REAL_OWNED_CLOSERS_MUST_PASS")
    if case in ("bound", "recovery"):
        supervision = report.get("supervision", {})
        if not (supervision.get("cleanupStatus") == "PASS" and supervision.get("ownedProcessGroupStopped") is True
                and supervision.get("postgresStopped") is True and supervision.get("artifactWritten") is True):
            raise RuntimeError("ACTUAL_FULL_BODY_SUPERVISION_REQUIRED")
    if case == "recovery":
        expected = {row["id"] for row in json.loads((directory / "frozen-contract.json").read_text())["cases"]}
        observed = report.get("results", [])
        if len(observed) != 7 or {row["id"] for row in observed} != expected or any(row["status"] != "PASS" for row in observed):
            raise RuntimeError("ALL_SEVEN_ORIGINAL_RECOVERY_CASES_REQUIRED")
    if case == "mounted":
        original = ["mounted-original-compile-and-verified-completion", "work-switch-withdrawal",
                    "same-tenant-principal-withdrawal", "foreign-tenant-withdrawal", "offline-private-withdrawal",
                    "delayed-revoked-response-withdrawal"]
        if report.get("assertions") != original or report.get("profile") != "ORIGINAL_COMPLETE_MOUNTED":
            raise RuntimeError("ALL_SIX_ORIGINAL_MOUNTED_PREDICATES_REQUIRED")
        if report.get("source") != "ACTUAL_SUPPORTED_AGENT_BROWSER_ASSIGNED_CDP_DOM":
            raise RuntimeError("ACTUAL_SUPPORTED_ASSIGNED_BROWSER_PROVENANCE_REQUIRED")
        check_mounted_browser_gate(report, output, mounted_context)
        native = json.loads((directory / "report.json").read_text())
        cleanup = json.loads((directory / "cleanup.json").read_text())
        if (native.get("status") != "PASS" or native.get("installedRuntime") is not True
                or native.get("actualOrdinaryAuthentication") is not True or native.get("actualRestrictedRoles") is not True
                or native.get("mountedReadback", {}).get("status") != "PASS"
                or native.get("mountedReadback", {}).get("compiled") is not True
                or not native.get("results") or any(row.get("status") != "PASS" for row in native["results"])
                or cleanup.get("status") != "PASS" or not cleanup.get("steps")
                or any(row.get("status") != "PASS" for row in cleanup["steps"])):
            raise RuntimeError("ACTUAL_INSTALLED_NATIVE_MOUNTED_CHAIN_AND_CLEANUP_REQUIRED")
        for name in ("nonowner-participant-workspace-exact-own-contracts",
                     "participant-natural-expiry-and-fresh-exact-mounted-consent"):
            if not any(step["name"] == name for step in report.get("steps", [])):
                raise RuntimeError("ACTUAL_PARTICIPANT_DOM_STEP_REQUIRED")
    return {"status": "PASS", "directory": directory.relative_to(output).as_posix(), "files": pins,
            "policy": "EXPLICIT_ALLOWLIST_NO_PRIVATE_FIXTURE_OWNER_NONCE_DATABASE_OR_BROWSER_PROFILE"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--heavy", action="store_true")
    parser.add_argument("--resource-policy")
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--backend")
    parser.add_argument("--frontend")
    parser.add_argument("--origin")
    parser.add_argument("--packet")
    parser.add_argument("--packet-sha256")
    parser.add_argument("--prepared")
    parser.add_argument("--cache")
    parser.add_argument("--npm-cli")
    parser.add_argument("--baseline-native")
    parser.add_argument("--baseline-installation")
    parser.add_argument("--fresh-native")
    parser.add_argument("--forecast-bytes", type=int)
    parser.add_argument("--browser-observer-template")
    parser.add_argument("--browser-observer-template-sha256")
    parser.add_argument("--browser-observer-grant")
    parser.add_argument("--browser-observer-grant-sha256")
    parser.add_argument("--campaign-owner")
    parser.add_argument("--campaign-owner-sha256")
    parser.add_argument("--harness-manifest")
    parser.add_argument("--harness-manifest-sha256")
    args = parser.parse_args()
    profile_path = Path(__file__).parent / "qualification/campaign-profiles.json"
    profiles = json.loads(profile_path.read_text())
    profile = profiles["profiles"][args.case]
    if bool(profile["heavy"]) != args.heavy:
        raise ValueError("EXPLICIT_HEAVY_CLASSIFICATION_REQUIRED")
    output = Path(args.output)
    if not output.is_absolute() or ".." in output.parts:
        raise ValueError("NEW_ABSOLUTE_OUTPUT_REQUIRED")
    try:
        output.mkdir(mode=0o700)
    except FileExistsError:
        print(json.dumps({"status": "FAIL", "reason": "OUTPUT_ALREADY_CLAIMED", "childSpawned": False, "artifactWritten": False}))
        return 1
    identity = output.stat()
    nonce = os.urandom(32).hex()
    claim = {"schema": "finnor.w2.job-output-owner.v1", "pid": os.getpid(), "nonce": nonce,
             "output": str(output.resolve()), "device": identity.st_dev, "inode": identity.st_ino}
    claim_path = output / ".job-owner.json"
    with os.fdopen(os.open(claim_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        stream.write(json.dumps(claim) + "\n")

    def require_claim():
        now = output.lstat()
        if (not stat.S_ISDIR(now.st_mode) or output.is_symlink() or claim_path.is_symlink()
                or (now.st_dev, now.st_ino) != (identity.st_dev, identity.st_ino)
                or json.loads(claim_path.read_text()) != claim):
            raise RuntimeError("OWNED_JOB_OUTPUT_CLAIM_LOST")

    started = time.monotonic()
    record = {"schema": "finnor.w2.finite-job.v1", "status": "FAIL", "case": args.case,
              "startedAt": datetime.now(timezone.utc).isoformat(), "limits": profile,
              "profileSha256": sha(profile_path), "executedHost": {"platform": sys.platform, "machine": os.uname().machine},
              "qualification": profiles["qualification"], "separateGates": {name: "NOT_ESTABLISHED" for name in profiles["separateGates"]},
              "cleanup": {"status": "NOT_RUN"}, "artifacts": {"status": "NOT_RUN"}, "childSpawned": False, "timedOut": False}
    child = None
    lease = None
    groups = set()
    owned = {}
    interrupted = []
    raw_output = bytearray()
    harness = None

    def drain():
        if child is None or child.stdout is None:
            return
        while True:
            try:
                block = os.read(child.stdout.fileno(), 65536)
            except BlockingIOError:
                return
            if not block:
                return
            available = 2097152 - len(raw_output)
            raw_output.extend(block[:available])
            if len(block) > available:
                raise RuntimeError("ORIGINAL_DRIVER_LOG_LIMIT")

    def interrupt(signum, _frame):
        interrupted.append(signum)
        if child is not None and child.poll() is None:
            require_claim()
            try:
                os.killpg(child.pid, signal.SIGCONT)
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    def wall_expired(_signum, _frame):
        record["timedOut"] = True
        interrupt(signal.SIGALRM, _frame)
        raise RuntimeError("ORIGINAL_WHOLE_JOB_WALL")
    previous = {sig: signal.signal(sig, interrupt) for sig in (signal.SIGTERM, signal.SIGINT)}
    previous_alarm = signal.signal(signal.SIGALRM, wall_expired)
    try:
        require_claim()
        node = Path(args.node).resolve(strict=True)
        if not node.is_file() or not os.access(node, os.X_OK):
            raise ValueError("ACTUAL_NODE_EXECUTABLE_REQUIRED")
        if args.heavy and not args.harness_manifest:
            raise ValueError("INDEPENDENT_PRELAUNCH_HARNESS_FREEZE_REQUIRED")
        if args.harness_manifest:
            harness = FrozenHarness(args.harness_manifest, args.harness_manifest_sha256, ROOT, node, args.resource_policy)
            record["harnessManifestSha256"] = args.harness_manifest_sha256
        policy = None
        if args.heavy:
            if not args.resource_policy:
                raise ValueError("FROZEN_APPROVED_RESOURCE_POLICY_REQUIRED")
            policy_file = Path(args.resource_policy).resolve(strict=True)
            policy = ResourcePolicy.parse(json.loads(policy_file.read_text()))
            record["resourcePolicy"] = policy.record()
            record["resourcePolicySha256"] = sha(policy_file)
            flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
            lease = os.fdopen(os.open(policy.heavyLockPath, flags, 0o600), "r+")
            wait_until = time.monotonic() + policy.lockWaitSeconds
            while True:
                require_claim()
                harness.verify()
                if interrupted:
                    raise RuntimeError("HEAVY_LEASE_INTERRUPTED")
                try:
                    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= wait_until:
                        raise RuntimeError("ORIGINAL_HEAVY_LEASE_WAIT_EXHAUSTED")
                    time.sleep(0.1)
        record["sourceBefore"] = source_cut()
        record["runtimes"] = {"node": {"path": str(node), "sha256": sha(node)},
                              "python": {"path": str(Path(sys.executable).resolve()), "sha256": sha(Path(sys.executable).resolve())}}
        command, cwd, environment = command_for(args, profile, output, node)
        if harness:
            environment["FINNOR_W2_GIT_BIN"] = harness.manifest["tools"]["git"]["path"]
        record["command"], record["cwd"] = command, str(cwd)
        before = host_facts(output)
        record["hostBefore"] = before
        free_before = before["filesystem"]["freeBytes"]

        def capacity():
            facts = host_facts(output)
            if policy:
                if facts["filesystem"]["freeBytes"] < max(policy.globalDiskFloorBytes, profile.get("minimumStartDiskBytes", 0)):
                    raise RuntimeError("ORIGINAL_GLOBAL_DISK_FLOOR")
                if free_before - facts["filesystem"]["freeBytes"] > policy.laneNetNewBudgetBytes:
                    raise RuntimeError("ORIGINAL_LANE_NET_NEW_DISK_BOUND")
                if facts["memory"]["availableBytes"] < policy.minimumAvailableMemoryBytes:
                    raise RuntimeError("ORIGINAL_AVAILABLE_MEMORY_FLOOR")
                if facts["loadAverage"][0] > facts["cpuCapacity"] * policy.maximumLoadFraction:
                    raise RuntimeError("ORIGINAL_HOST_CPU_FLOOR")
            return facts
        capacity()
        if args.forecast_bytes is not None:
            if (not policy or args.forecast_bytes <= 0 or args.forecast_bytes > policy.laneNetNewBudgetBytes
                    or free_before - args.forecast_bytes < policy.globalDiskFloorBytes):
                raise RuntimeError("COMPLETE_DECLARED_STAGE_FORECAST_NOT_ADMITTED")
            record["forecastNetNewBytes"] = args.forecast_bytes
        elif profile.get("requiresForecast"):
            raise RuntimeError("DECLARED_COLD_STAGE_DISK_FORECAST_REQUIRED")
        require_claim()
        if interrupted:
            raise RuntimeError("OWNED_JOB_INTERRUPTED_BEFORE_SPAWN")
        deadline = time.monotonic() + profile["wallSeconds"]
        signal.setitimer(signal.ITIMER_REAL, profile["wallSeconds"])
        child = subprocess.Popen(command, cwd=cwd, env=environment, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, start_new_session=True)
        os.set_blocking(child.stdout.fileno(), False)
        groups.add(child.pid)
        record.update(childPid=child.pid, childSpawned=True, peakObservedOwnedProcessBytes=None, processMemorySamples=0)
        while True:
            drain()
            observed = observe_owned(child, owned, groups)
            if observed and record["processMemorySamples"] == 0:
                sample = {"schema": "finnor.w2.first-owned-process-observation.v1",
                          "processes": [{key: row[key] for key in ("pid", "parent", "group", "birth")} for row in observed],
                          "classification": "OWNED_PROCESS_IDENTITY_NOT_BUSINESS_EVIDENCE"}
                sample_path = output / "owned-process-first-sample.json"
                with os.fdopen(os.open(sample_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
                    stream.write(json.dumps(sample) + "\n")
                record["firstOwnedProcessSampleSha256"] = sha(sample_path)
            if harness:
                harness.verify()
            if observed:
                record["processMemorySamples"] += 1
                record["peakObservedOwnedProcessBytes"] = max(record["peakObservedOwnedProcessBytes"] or 0,
                                                               sum(row["residentBytes"] for row in observed))
            # The light contract limits each real child, not the sum of
            # independently supervised controls plus their live neighbor.
            light_child_exceeded = any(row["residentBytes"] > 256 * 1024 ** 2 for row in observed)
            if args.heavy and (record["peakObservedOwnedProcessBytes"] or 0) > 6442450944 or not args.heavy and light_child_exceeded:
                raise RuntimeError("ORIGINAL_OWNED_PROCESS_MEMORY_STOP")
            # Profiles with an original output bound are enforced during the
            # run, not only by the final population check.
            if "maximumOutputBytes" in profile:
                produced = evidence_bytes(output, profiles["privateExclusions"])
                if produced > profile["maximumOutputBytes"]:
                    raise RuntimeError("ORIGINAL_ACTUAL_ARTIFACT_OUTPUT_BOUND")
            if interrupted:
                raise RuntimeError("OWNED_JOB_INTERRUPTED")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("ORIGINAL_WHOLE_JOB_WALL")
            try:
                record["childExitCode"] = child.wait(timeout=min(1, remaining))
                drain()
                break
            except subprocess.TimeoutExpired:
                record["hostLast"] = capacity()
        if record["childExitCode"] != 0:
            raise RuntimeError("ACTUAL_DRIVER_NONZERO_EXIT")
        record["artifacts"] = check_artifacts(args.case, profile, output, bool(args.backend),
            (args, claim, harness.manifest) if args.case == "mounted" else None)
        after = source_cut()
        record["sourceAfter"] = after
        if harness:
            harness.verify(all_tools=True)
        if args.case != "frontend-build" and after != record["sourceBefore"]:
            raise RuntimeError("ACTUAL_FROZEN_SOURCE_CHANGED")
        record["status"] = "PASS"
    except Exception as error:
        signal.setitimer(signal.ITIMER_REAL, 0)
        record["status"] = "FAIL"
        record["failure"] = {"type": type(error).__name__, "predicate": str(error) if re.fullmatch(r"[A-Z0-9_:./-]{1,256}", str(error)) else "RUNNER_OWNER_BOUNDARY_FAILED"}
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        cleanup_errors = []
        if child is not None:
            try:
                require_claim()
                # TERM first allows the reusable inner supervisor its real cleanup.
                if child.poll() is None:
                    observe_owned(child, owned, groups)
                    try:
                        os.killpg(child.pid, signal.SIGCONT)
                    except ProcessLookupError:
                        pass
                    if child.poll() is None:
                        try:
                            os.killpg(child.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                    cleanup_until = time.monotonic() + 12
                    while child.poll() is None and time.monotonic() < cleanup_until:
                        observe_owned(child, owned, groups)
                        try:
                            child.wait(timeout=min(0.25, max(0.001, cleanup_until - time.monotonic())))
                        except subprocess.TimeoutExpired:
                            pass
                    if child.poll() is None:
                        observe_owned(child, owned, groups)
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        child.wait(timeout=3)
            except Exception:
                cleanup_errors.append("OWNED_PRIMARY_GROUP_CLEANUP_FAILED")
            # A disappearing primary or earlier group never skips later groups.
            for group in sorted(groups):
                try:
                    require_claim()
                    live = process_rows()
                    matching = [row for row in live if row["group"] == group]
                    if not matching:
                        continue
                    if any(row["pid"] not in owned or not same_process(owned[row["pid"]], row) for row in matching):
                        cleanup_errors.append("OWNED_GROUP_IDENTITY_CHANGED")
                        continue
                    record["status"] = "FAIL"
                    try:
                        os.killpg(group, signal.SIGCONT)
                    except ProcessLookupError:
                        continue
                    # Continuing a group can let it exit. Recheck identity.
                    matching = [row for row in process_rows() if row["group"] == group]
                    if not matching:
                        continue
                    if any(row["pid"] not in owned or not same_process(owned[row["pid"]], row) for row in matching):
                        cleanup_errors.append("OWNED_GROUP_IDENTITY_CHANGED")
                        continue
                    try:
                        os.killpg(group, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                except Exception:
                    cleanup_errors.append("OWNED_GROUP_CLEANUP_FAILED")
            try:
                until = time.monotonic() + 3
                while any(row["group"] in groups for row in process_rows()) and time.monotonic() < until:
                    time.sleep(0.05)
                if any(row["group"] in groups for row in process_rows()):
                    cleanup_errors.append("OWNED_PROCESS_GROUP_STILL_LIVE")
            except Exception:
                cleanup_errors.append("OWNED_GROUP_FINAL_CHECK_FAILED")
        if cleanup_errors:
            record["status"] = "FAIL"
        try:
            require_claim()
            drain()
            if child is not None and child.stdout is not None:
                child.stdout.close()
            data = redacted_log(raw_output)
            with os.fdopen(os.open(output / "driver.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
                stream.write(data)
            record["driverLog"] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                                   "classification": "PRIVATE_REDACTED_NOT_ARTIFACT_ALLOWLIST"}
        except Exception:
            record["status"] = "FAIL"
            cleanup_errors.append("OWNED_BOUNDED_LOG_FINALIZATION_FAILED")
        record["cleanup"] = {"status": "FAIL" if cleanup_errors else "PASS", "errors": cleanup_errors,
                             "observedOwnedGroupCount": len(groups)}
        if harness:
            try:
                harness.verify(all_tools=True)
                record["finalHarnessIntegrity"] = "PASS"
            except Exception:
                record["status"] = "FAIL"
                record["finalHarnessIntegrity"] = "FAIL"
                record.setdefault("failure", {"type": "RuntimeError", "predicate": "ACTIVE_FROZEN_HARNESS_CHANGED"})
        if lease is not None:
            lease.close()
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        signal.signal(signal.SIGALRM, previous_alarm)
        record.update(finishedAt=datetime.now(timezone.utc).isoformat(), elapsedSeconds=time.monotonic() - started,
                      runnerSha256=sha(Path(__file__)))
        try:
            require_claim()
            path = output / "job-result.json"
            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
                stream.write(json.dumps(record, indent=2) + "\n")
            print(json.dumps({"status": record["status"], "case": args.case, "artifact": str(path),
                              "cleanup": record["cleanup"], "failure": record.get("failure")}))
        except Exception:
            print(json.dumps({"status": "FAIL", "reason": "OWNED_JOB_CLAIM_OR_RECEIPT_WRITE_FAILED", "artifactWritten": False}))
            return 1
    return 0 if record["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
