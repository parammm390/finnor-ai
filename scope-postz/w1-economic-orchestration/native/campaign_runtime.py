"""Parse the one portable campaign configuration before freezing executable work."""
from dataclasses import asdict, dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any

GIB = 1024 ** 3
RUNTIME_NAMES = {"node", "python", "uv", "npmCli", "agentBrowser", "chrome"}
LIMIT_NAMES = {"campaignSeconds", "fastSeconds", "integrationSeconds", "recoveryPairSeconds",
    "coldSeconds", "emittedSeconds", "sealSeconds", "nodeHeapMiB", "coldAdditionalFilesystemBytes"}
FORECAST_NAMES = {"fast", "heavy", "emitted", "cold", "seal"}


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def object_fields(value: Any, fields: set[str], name: str) -> dict:
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("EXACT_CONFIGURATION_FIELDS_REQUIRED:" + name)
    return value


def integer(value: Any, name: str, minimum: int = 1) -> int:
    if type(value) is not int or value < minimum:
        raise ValueError("CONFIGURATION_INTEGER_OUT_OF_RANGE:" + name)
    return value


def text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip() or any(ord(c) < 32 for c in value):
        raise ValueError("NONEMPTY_CONFIGURATION_TEXT_REQUIRED:" + name)
    return value


def absolute(value: Any, name: str) -> Path:
    path = Path(text(value, name))
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("ABSOLUTE_CONFIGURATION_PATH_REQUIRED:" + name)
    return path


def relative(value: Any, name: str) -> str:
    path = Path(text(value, name))
    if path.is_absolute() or ".." in path.parts or path.as_posix() != value:
        raise ValueError("RELATIVE_SOURCE_PATH_REQUIRED:" + name)
    return value


@dataclass(frozen=True)
class FilePin:
    path: Path
    sha256: str

    @classmethod
    def parse(cls, value: Any, name: str, *, executable: bool = False) -> "FilePin":
        row = object_fields(value, {"path", "sha256"}, name)
        path = absolute(row["path"], name)
        digest = text(row["sha256"], name + ".sha256")
        if not re.fullmatch(r"[a-f0-9]{64}", digest) or not path.is_file() or sha(path) != digest:
            raise ValueError("EXACT_CONFIGURATION_FILE_PIN_REQUIRED:" + name)
        if executable and not os.access(path, os.X_OK):
            raise ValueError("EXECUTABLE_CONFIGURATION_FILE_REQUIRED:" + name)
        return cls(path, digest)

    def record(self) -> dict:
        return {"path": str(self.path), "resolvedPath": str(self.path.resolve(strict=True)), "sha256": self.sha256}


@dataclass(frozen=True)
class ResourcePolicy:
    coordinationDirectory: Path
    heavyLockPath: Path
    globalDiskFloorBytes: int
    laneNetNewBudgetBytes: int
    lockWaitSeconds: int
    maximumLoadFraction: float
    minimumAvailableMemoryBytes: int

    @classmethod
    def parse(cls, value: Any) -> "ResourcePolicy":
        fields = {"coordinationDirectory", "heavyLockPath", "globalDiskFloorBytes", "laneNetNewBudgetBytes",
            "lockWaitSeconds", "maximumLoadFraction", "minimumAvailableMemoryBytes"}
        row = object_fields(value, fields, "resourcePolicy")
        coordination = absolute(row["coordinationDirectory"], "coordinationDirectory")
        heavy = absolute(row["heavyLockPath"], "heavyLockPath")
        approved = Path("/tmp/finnor-w123-local-heavy.lock") if sys.platform == "darwin" else Path(
            "/home/factory-user/mission/evidence/locks/w123-heavy.lock")
        if sys.platform not in {"darwin", "linux"} or heavy != approved:
            raise ValueError("ACTUAL_W123_SHARED_HEAVY_LOCK_REQUIRED")
        floor = integer(row["globalDiskFloorBytes"], "globalDiskFloorBytes", 3 * GIB)
        budget = integer(row["laneNetNewBudgetBytes"], "laneNetNewBudgetBytes")
        wait = integer(row["lockWaitSeconds"], "lockWaitSeconds")
        if wait > 1200:
            raise ValueError("ORIGINAL_LOCK_WAIT_BOUND_REQUIRED")
        load = row["maximumLoadFraction"]
        if type(load) not in {int, float} or not math.isfinite(load) or not 0 < load <= 0.5:
            raise ValueError("AT_LEAST_HALF_HOST_CPU_MUST_REMAIN_AVAILABLE")
        memory = integer(row["minimumAvailableMemoryBytes"], "minimumAvailableMemoryBytes")
        return cls(coordination, heavy, floor, budget, wait, float(load), memory)

    def record(self) -> dict:
        return {key: str(value) if isinstance(value, Path) else value for key, value in asdict(self).items()}


@dataclass(frozen=True)
class RecoveryPair:
    id: str
    target: str
    brokenSource: str
    brokenSha256: str
    contract: str
    contractSha256: str

    @classmethod
    def parse(cls, value: Any, root: Path) -> "RecoveryPair":
        fields = {"id", "target", "brokenSource", "brokenSha256", "contract", "contractSha256"}
        row = object_fields(value, fields, "recoveryPair")
        identity = text(row["id"], "recoveryPair.id")
        target = relative(row["target"], "recoveryPair.target")
        broken = relative(row["brokenSource"], "recoveryPair.brokenSource")
        contract = relative(row["contract"], "recoveryPair.contract")
        for path, digest in ((broken, row["brokenSha256"]), (contract, row["contractSha256"])):
            if not (root / path).resolve(strict=True).is_relative_to(root) or (root / path).is_symlink():
                raise ValueError("RECOVERY_SOURCE_ESCAPE")
            FilePin.parse({"path": str(root / path), "sha256": digest}, "recoveryPair." + path)
        if not (root / target).is_file() or (root / target).is_symlink():
            raise ValueError("REGULAR_REPAIRED_TARGET_REQUIRED")
        return cls(identity, target, broken, row["brokenSha256"], contract, row["contractSha256"])


@dataclass(frozen=True)
class CampaignConfig:
    path: Path
    digest: str
    requirements: FilePin
    runtimes: dict[str, FilePin]
    scientificAttestation: FilePin
    structuralInputs: str
    workspaceParent: Path
    packageCaches: dict[str, Path]
    resourcePolicy: ResourcePolicy
    limits: dict[str, int]
    stageForecastBytes: dict[str, int]
    recoveryPairs: tuple[RecoveryPair, ...]
    privateCustodyRoot: Path
    controlSidecar: FilePin
    engineeringCapacityBasis: str


def load_config(path: Path, root: Path) -> CampaignConfig:
    path = path.resolve(strict=True)
    row = object_fields(json.loads(path.read_text()), {"schema", "requirements", "runtimes",
        "scientificAttestation", "structuralInputs", "workspaceParent", "packageCaches", "resourcePolicy", "limits",
        "stageForecastBytes", "recoveryPairs", "privateCustody", "engineeringCapacityBasis"}, "campaign")
    if row["schema"] != "finnor.w1.campaign-runtime.v1":
        raise ValueError("PORTABLE_CAMPAIGN_CONFIGURATION_SCHEMA_REQUIRED")
    runtime_rows = object_fields(row["runtimes"], RUNTIME_NAMES, "runtimes")
    runtimes = {name: FilePin.parse(value, "runtimes." + name, executable=name != "npmCli")
        for name, value in runtime_rows.items()}
    requirements = FilePin.parse(row["requirements"], "requirements")
    scientific = FilePin.parse(row["scientificAttestation"], "scientificAttestation")
    attestation = json.loads(scientific.path.read_text())
    lock = root / "finnor-os/scripts/r3/upstream-requirements.lock"
    if (attestation.get("status") != "PASS" or attestation.get("lockSha256") != sha(lock)
            or attestation.get("pythonEntry") != str(runtimes["python"].path)
            or attestation.get("baseExecutableSha256") != runtimes["python"].sha256
            or attestation.get("completeBaseDistributionAttestation") != "ESTABLISHED_FOR_ENUMERATED_BASE_PREFIX"
            or not attestation.get("baseAssets") or not attestation.get("environmentAssets")):
        raise ValueError("CURRENT_COMPLETE_SCIENTIFIC_ATTESTATION_REQUIRED")
    inputs = relative(row["structuralInputs"], "structuralInputs")
    directory = (root / inputs).resolve(strict=True)
    if not directory.is_relative_to(root) or not directory.is_dir():
        raise ValueError("SOURCE_CONTAINED_STRUCTURAL_INPUTS_REQUIRED")
    inventory = json.loads((directory / "inputs.json").read_text())
    cases = inventory.get("cases", [])
    if (inventory.get("schema") != "finnor.w1.structural-inputs.v1" or inventory.get("families") != 16
            or inventory.get("casesPerFamily") != 8 or len(cases) != 128
            or len({case["id"] for case in cases}) != 128):
        raise ValueError("ORIGINAL_FINITE_STRUCTURAL_POPULATION_REQUIRED")
    counts: dict[str, int] = {}
    for case in cases:
        relative_case = relative(case["path"], "structuralCase")
        case_path = directory / relative_case
        if case_path.is_symlink() or not case_path.resolve(strict=True).is_relative_to(directory):
            raise ValueError("STRUCTURAL_CASE_ESCAPE")
        FilePin.parse({"path": str(case_path), "sha256": case["sha256"]}, "structuralCase")
        counts[case["family"]] = counts.get(case["family"], 0) + 1
    if len(counts) != 16 or set(counts.values()) != {8}:
        raise ValueError("SIXTEEN_COMPLETE_STRUCTURAL_FAMILIES_REQUIRED")
    parent = absolute(row["workspaceParent"], "workspaceParent").resolve(strict=True)
    if parent != Path("/tmp").resolve():
        raise ValueError("OWNED_HANDOFF_PARENT_MUST_BE_TMP")
    caches = {name: absolute(value, "packageCaches." + name) for name, value in
        object_fields(row["packageCaches"], {"npm", "uv"}, "packageCaches").items()}
    policy = ResourcePolicy.parse(row["resourcePolicy"])
    limit_rows = object_fields(row["limits"], LIMIT_NAMES, "limits")
    limits = {name: integer(value, "limits." + name) for name, value in limit_rows.items()}
    if limits["coldAdditionalFilesystemBytes"] < 3 * GIB:
        raise ValueError("COLD_FORECAST_MUST_EXCEED_KNOWN_TWO_GIB_NPM_INPUT_POPULATION")
    if limits["coldAdditionalFilesystemBytes"] > policy.laneNetNewBudgetBytes:
        raise ValueError("COLD_ALLOCATION_MUST_FIT_FROZEN_LANE_BUDGET")
    if limits["nodeHeapMiB"] * 1024 ** 2 > policy.minimumAvailableMemoryBytes:
        raise ValueError("HEAP_MUST_FIT_ACTUAL_MEMORY_ADMISSION")
    forecasts = {name: integer(value, "stageForecastBytes." + name, 0) for name, value in
        object_fields(row["stageForecastBytes"], FORECAST_NAMES, "stageForecastBytes").items()}
    if forecasts["cold"] < limits["coldAdditionalFilesystemBytes"] or any(
            value > policy.laneNetNewBudgetBytes for value in forecasts.values()):
        raise ValueError("STAGE_FORECAST_MUST_FIT_COMPLETE_FROZEN_DISK_ALLOCATION")
    if not isinstance(row["recoveryPairs"], list):
        raise ValueError("EXACT_RECOVERY_PAIRS_REQUIRED")
    pairs = tuple(RecoveryPair.parse(pair, root) for pair in row["recoveryPairs"])
    if [pair.id for pair in pairs] != ["physical", "control"]:
        raise ValueError("BOTH_ORIGINAL_RECOVERY_PAIRS_REQUIRED")
    custody = object_fields(row["privateCustody"], {"root", "controlSidecar"}, "privateCustody")
    custody_root = absolute(custody["root"], "privateCustody.root").resolve(strict=True)
    sidecar = FilePin.parse(custody["controlSidecar"], "privateCustody.controlSidecar")
    if not sidecar.path.resolve().is_relative_to(custody_root):
        raise ValueError("PRIVATE_SIDECAR_MUST_BE_IN_DECLARED_CUSTODY")
    control = json.loads(sidecar.path.read_text())
    originals = control.get("files", [])
    if len(originals) != 53 or sum(pin.get("droidShieldFlagged") is True for pin in originals) != 11:
        raise ValueError("ORIGINAL_CONTROL_53_FILE_11_FLAG_SIDECAR_REQUIRED")
    for pin in originals:
        source = custody_root / relative(pin["path"], "privateControlOriginal")
        if source.is_symlink() or not source.resolve(strict=True).is_relative_to(custody_root) or sha(source) != pin["sha256"]:
            raise ValueError("ORIGINAL_PRIVATE_CONTROL_CUSTODY_CHANGED")
    return CampaignConfig(path, sha(path), requirements, runtimes, scientific, inputs, parent, caches, policy, limits,
        forecasts, pairs, custody_root, sidecar, text(row["engineeringCapacityBasis"], "engineeringCapacityBasis"))


def host_facts(path: Path) -> dict:
    memory: dict[str, Any] = {}
    cpus = len(os.sched_getaffinity(0)) if hasattr(os, "sched_getaffinity") else os.cpu_count()
    if not cpus:
        raise RuntimeError("ACTUAL_CPU_CAPACITY_UNAVAILABLE")
    if sys.platform == "linux":
        meminfo = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            name, value = line.split(":", 1)
            meminfo[name] = int(value.split()[0]) * 1024
        memory = {"totalBytes": meminfo["MemTotal"], "availableBytes": meminfo["MemAvailable"],
            "source": "/proc/meminfo"}
        maximum, used = Path("/sys/fs/cgroup/memory.max"), Path("/sys/fs/cgroup/memory.current")
        if maximum.is_file() and used.is_file() and maximum.read_text().strip() != "max":
            limit, usage = int(maximum.read_text()), int(used.read_text())
            memory.update(cgroupLimitBytes=limit, cgroupUsedBytes=usage)
            memory["totalBytes"] = min(memory["totalBytes"], limit)
            memory["availableBytes"] = min(memory["availableBytes"], max(0, limit - usage))
        quota = Path("/sys/fs/cgroup/cpu.max")
        if quota.is_file():
            limit, period = quota.read_text().split()
            if limit != "max":
                cpus = min(cpus, int(limit) / int(period))
    elif sys.platform == "darwin":
        total = int(subprocess.check_output(["/usr/sbin/sysctl", "-n", "hw.memsize"], text=True, timeout=5))
        output = subprocess.check_output(["/usr/bin/vm_stat"], text=True, timeout=5)
        page_size = re.search(r"page size of (\d+) bytes", output)
        if not page_size:
            raise RuntimeError("ACTUAL_MAC_MEMORY_PAGE_SIZE_UNAVAILABLE")
        pages = {match[1]: int(match[2]) for match in re.finditer(r"^([^:\n]+):\s+(\d+)\.", output, re.MULTILINE)}
        available = sum(pages.get(name, 0) for name in ("Pages free", "Pages inactive", "Pages speculative"))
        memory = {"totalBytes": total, "availableBytes": available * int(page_size[1]),
            "source": "sysctl hw.memsize and vm_stat free/inactive/speculative pages"}
    else:
        raise RuntimeError("SUPPORTED_HOST_PLATFORM_REQUIRED")
    return {"platform": sys.platform, "machine": os.uname().machine, "cpuCapacity": cpus,
        "loadAverage": list(os.getloadavg()), "memory": memory,
        "filesystem": {"path": str(path.resolve()), "freeBytes": shutil.disk_usage(path).free,
            "totalBytes": shutil.disk_usage(path).total}}


def locked_vendor_assets(root: Path) -> list[str]:
    assets = set()
    for name in ("package-lock.json", "finnor-os/package-lock.json"):
        lock = root / name
        def visit(value):
            if isinstance(value, dict):
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)
            elif isinstance(value, str) and value.startswith("file:"):
                path = (lock.parent / value.removeprefix("file:")).resolve(strict=True)
                if not path.is_relative_to(root) or not path.is_file() or path.is_symlink():
                    raise ValueError("LOCKED_LOCAL_DEPENDENCY_MUST_BE_REGULAR_SOURCE_ASSET")
                assets.add(path.relative_to(root).as_posix())
        visit(json.loads(lock.read_text()))
    return sorted(assets)


def runtime_asset_population(prefix: Path) -> list[dict]:
    prefix = prefix.resolve(strict=True)
    assets = []
    for parent, directories, files in os.walk(prefix, followlinks=False):
        for name in sorted(directories + files):
            path = Path(parent) / name
            if path.is_symlink():
                if not path.resolve(strict=True).is_relative_to(prefix):
                    raise ValueError("BOOTSTRAP_DISTRIBUTION_LINK_ESCAPE")
                assets.append({"path": path.relative_to(prefix).as_posix(), "kind": "link", "target": os.readlink(path)})
            elif path.is_file():
                assets.append({"path": path.relative_to(prefix).as_posix(), "kind": "file", "bytes": path.stat().st_size,
                    "sha256": sha(path)})
            elif not path.is_dir():
                raise ValueError("BOOTSTRAP_DISTRIBUTION_SPECIAL_FILE")
    return sorted(assets, key=lambda row: row["path"])
