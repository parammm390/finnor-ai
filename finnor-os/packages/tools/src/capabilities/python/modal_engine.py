"""Trusted Modal SDK control plane. SDK credentials never enter the sandbox."""
import contextlib
import hashlib
import importlib.metadata
import inspect
import json
import math
import os
from pathlib import Path
import re
import sys
import time


creation_started = False


def run(payload):
    global creation_started
    os.environ["MODAL_CONFIG_PATH"] = "/dev/null"
    os.environ["MODAL_SERVER_URL"] = payload.get("serverUrl", "https://api.modal.com,https://api.modal2.com")
    import modal
    bootstrap = Path(__file__).with_name("modal_bootstrap.py").read_bytes()
    bootstrap_digest = hashlib.sha256(bootstrap).hexdigest()
    if payload.get("op") == "probe":
        signature = inspect.signature(modal.Sandbox.create)
        required = ["block_network", "cpu", "memory", "timeout", "secrets", "volumes", "include_oidc_identity_token", "image", "app", "client"]
        if not all(name in signature.parameters for name in required):
            raise ValueError("MODAL_SDK_CONTRACT_MISMATCH")
        return {"schema": "finnor.modal-sdk-probe.v1", "version": importlib.metadata.version("modal"), "requiredCreateParameters": required,
            "bootstrapSha256": bootstrap_digest, "qualification": "INSTALLED_OFFICIAL_SDK_CONTRACT_ONLY_NOT_SANDBOX_ISOLATION"}
    token_id, token_secret = payload.get("tokenId"), payload.get("tokenSecret")
    if not isinstance(token_id, str) or not token_id or not isinstance(token_secret, str) or not token_secret:
        raise ValueError("MODAL_CREDENTIALS_REQUIRED")
    deadline = payload.get("deadlineAt")
    if not isinstance(deadline, (int, float)) or deadline <= time.time() * 1000:
        raise ValueError("MODAL_DEADLINE_EXCEEDED")
    client = modal.Client.from_credentials(token_id, token_secret)
    operation = payload.get("op")
    if operation == "create":
        if bootstrap_digest != payload.get("bootstrapSha256"):
            raise ValueError("MODAL_BOOTSTRAP_IDENTITY_MISMATCH")
        app = modal.App.lookup(payload["appName"], client=client, create_if_missing=False)
        image = modal.Image.from_id(payload["imageId"], client=client)
        creation_started = True
        sandbox = modal.Sandbox.create("python", "-I", "-B", "-c", bootstrap.decode(), str(int(deadline)), app=app, client=client, image=image,
            name=payload["name"], tags={"finnor_run_id": payload["runId"], "finnor_bootstrap_sha256": bootstrap_digest},
            env={}, secrets=[], volumes={}, network_file_systems={}, block_network=True, include_oidc_identity_token=False,
            cpu=(1.0, 1.0), memory=(512, 512), runtime="gvisor", timeout=max(1, min(300, math.ceil((deadline - time.time() * 1000) / 1000))),
            encrypted_ports=[], unencrypted_ports=[], h2_ports=[], verbose=False)
        return {"sandboxId": sandbox.object_id, "bootstrapSha256": bootstrap_digest, "imageId": payload["imageId"],
            "configuredPolicy": {"networkBlocked": True, "cpus": 1, "memoryMiB": 512, "secrets": 0, "volumes": 0, "oidcToken": False}}
    sandbox_id = payload.get("sandboxId", "")
    if not isinstance(sandbox_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", sandbox_id):
        raise ValueError("MODAL_SANDBOX_ID_INVALID")
    sandbox = modal.Sandbox.from_id(sandbox_id, client=client)
    if operation == "supply":
        text = json.dumps(payload["program"], allow_nan=False, separators=(",", ":")) + "\n"
        if len(text.encode()) > 16_777_216:
            raise ValueError("MODAL_PROGRAM_TOO_LARGE")
        sandbox.stdin.write(text)
        sandbox.stdin.write_eof()
        sandbox.stdin.drain()
        return {"sandboxId": sandbox_id, "inputAcknowledged": True}
    if operation == "terminate":
        sandbox.terminate()
        return {"sandboxId": sandbox_id, "terminationAcknowledged": True}
    if operation not in ("poll", "status"):
        raise ValueError("MODAL_OPERATION_INVALID")
    exit_code = sandbox.poll()
    if operation == "status":
        return {"sandboxId": sandbox_id, "status": "running" if exit_code is None else "completed", **({"bootstrapExitCode": exit_code} if exit_code is not None else {})}
    if exit_code is None:
        return {"sandboxId": sandbox_id, "status": "running"}
    captured = {}
    try:
        for name, limit in [("stdout", 2_000_000), ("stderr", 131_072)]:
            chunks, size = [], 0
            for chunk in getattr(sandbox, name):
                size += len(chunk.encode())
                if size > limit:
                    raise ValueError("MODAL_CONTROL_OUTPUT_LIMIT")
                chunks.append(chunk)
            captured[name] = "".join(chunks)
    finally:
        sandbox.terminate()
    return {"sandboxId": sandbox_id, "status": "completed", "bootstrapExitCode": exit_code, "stdout": captured["stdout"], "stderr": captured["stderr"],
        "terminationAcknowledged": True, "backend": {"provider": "modal", "sdkVersion": importlib.metadata.version("modal")}}


if __name__ == "__main__":
    request = {}
    try:
        request = json.loads(sys.stdin.buffer.read(16_777_217))
        with contextlib.redirect_stdout(sys.stderr):
            result = run(request)
        print(json.dumps({"ok": True, "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "result": result}, allow_nan=False, separators=(",", ":")))
    except ModuleNotFoundError:
        print(json.dumps({"ok": False, "code": "MODAL_DEPENDENCY_UNAVAILABLE", "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "dispatchDisposition": "NOT_DISPATCHED" if request.get("op") == "create" and not creation_started else "UNKNOWN"}))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"MODAL_[A-Z_]+", str(error)) else "MODAL_CONTROL_OUTCOME_UNKNOWN"
        before_create = request.get("op") == "create" and not creation_started
        if before_create and code == "MODAL_CONTROL_OUTCOME_UNKNOWN":
            code = "MODAL_CREATE_NOT_DISPATCHED"
        print(json.dumps({"ok": False, "code": code, "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "dispatchDisposition": "NOT_DISPATCHED" if before_create else "UNKNOWN"}))
