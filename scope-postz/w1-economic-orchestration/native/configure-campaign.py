"""Write exact local runtime pins; validation does not execute a W1 campaign."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import sys
from campaign_runtime import GIB, host_facts, load_config, sha


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--requirements", required=True, type=Path)
    parser.add_argument("--python", required=True, type=Path)
    parser.add_argument("--scientific-attestation", required=True, type=Path)
    parser.add_argument("--node", type=Path, default=shutil.which("node"))
    parser.add_argument("--uv", type=Path, default=shutil.which("uv"))
    parser.add_argument("--npm-cli", type=Path, default=shutil.which("npm"))
    parser.add_argument("--agent-browser", type=Path, default=shutil.which("agent-browser"))
    parser.add_argument("--chrome", type=Path, required=True)
    parser.add_argument("--control-custody-root", type=Path, required=True)
    parser.add_argument("--control-sidecar", type=Path, required=True)
    parser.add_argument("--coordination-directory", type=Path, required=True)
    parser.add_argument("--npm-cache", type=Path, default=Path.home() / ".npm")
    parser.add_argument("--uv-cache", type=Path, required=True)
    parser.add_argument("--cold-additional-bytes", type=int, required=True)
    parser.add_argument("--emitted-forecast-bytes", type=int, required=True)
    parser.add_argument("--heavy-forecast-bytes", type=int, default=768 * 1024 ** 2)
    parser.add_argument("--seal-forecast-bytes", type=int, default=512 * 1024 ** 2)
    parser.add_argument("--lane-budget-bytes", type=int, default=4 * GIB)
    parser.add_argument("--capacity-basis", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[3]
    assert args.output.is_absolute() and not args.output.exists()
    assert not args.output.resolve().is_relative_to(root), "PRIVATE_RUNTIME_CONFIGURATION_MUST_BE_OUTSIDE_SOURCE"

    def pin(path, *, preserve_entry=False):
        assert path is not None, "ACTUAL_REQUIRED_TOOL_PATH_MISSING"
        path = path.absolute() if preserve_entry else path.resolve(strict=True)
        return {"path": str(path), "sha256": sha(path)}

    recovery = json.loads((Path(__file__).parent / "recovery-inputs/pins.json").read_text())
    config = {"schema": "finnor.w1.campaign-runtime.v1", "requirements": pin(args.requirements),
        "runtimes": {"node": pin(args.node), "python": pin(args.python, preserve_entry=True), "uv": pin(args.uv),
            "npmCli": pin(args.npm_cli), "agentBrowser": pin(args.agent_browser), "chrome": pin(args.chrome)},
        "scientificAttestation": pin(args.scientific_attestation),
        "structuralInputs": "scope-postz/w1-economic-orchestration/native/structural-inputs",
        "workspaceParent": str(Path("/tmp").resolve()),
        "packageCaches": {"npm": str(args.npm_cache.absolute()), "uv": str(args.uv_cache.absolute())},
        "resourcePolicy": {"coordinationDirectory": str(args.coordination_directory.absolute()),
            "heavyLockPath": "/tmp/finnor-w123-local-heavy.lock" if sys.platform == "darwin" else
                "/home/factory-user/mission/evidence/locks/w123-heavy.lock",
            "globalDiskFloorBytes": 3 * GIB, "laneNetNewBudgetBytes": args.lane_budget_bytes,
            "lockWaitSeconds": 1200, "maximumLoadFraction": 0.5, "minimumAvailableMemoryBytes": 2 * GIB},
        "limits": {"campaignSeconds": 28800, "fastSeconds": 120, "integrationSeconds": 1200,
            "recoveryPairSeconds": 1800, "emittedSeconds": 2400, "coldSeconds": 5400, "sealSeconds": 600,
            "nodeHeapMiB": 2048, "coldAdditionalFilesystemBytes": args.cold_additional_bytes},
        "stageForecastBytes": {"fast": 16 * 1024 ** 2, "heavy": args.heavy_forecast_bytes,
            "emitted": args.emitted_forecast_bytes, "cold": args.cold_additional_bytes, "seal": args.seal_forecast_bytes},
        "recoveryPairs": [{key: value for key, value in pair.items() if key != "originalGitObjectProvenance"}
            for pair in recovery["recoveryPairs"]],
        "privateCustody": {"root": str(args.control_custody_root.resolve(strict=True)),
            "controlSidecar": pin(args.control_sidecar)}, "engineeringCapacityBasis": args.capacity_basis}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
        stream.write(json.dumps(config, indent=2) + "\n")
    validated = load_config(args.output, root)
    print(json.dumps({"status": "CONFIG_WRITTEN_AND_VALIDATED_NOT_FROZEN", "path": str(args.output),
        "sha256": validated.digest, "host": host_facts(root), "createdAt": datetime.now(timezone.utc).isoformat(),
        "campaignExecuted": False, "allOwningAndColdGates": "NOT_RUN"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
