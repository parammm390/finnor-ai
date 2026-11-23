#!/usr/bin/env python3
"""Deterministically seal reviewed local context. No launch or remote actions."""

import argparse
import hashlib
import json
import os
import stat
import types
from pathlib import Path


ROOT = Path(__file__).absolute().parents[2]
PACK = ROOT / "scope-z/prompts"
PRODUCT = "61d9881ca8059d24d057d1e00d5436ef2059de7889ccd1fd2f92a630075bcebf"
INDEX = "5c78fc5da28a8eb92caa5cda9f13f8179597c0b8c927f78d1f0576d83939f954"
RECEIPT = "e7c53d4a8581f67209010ac159c91c29395b427ac74b1da14832d9f1a44b0084"
ASSEMBLER = "3f3be8c9820bd0bd388a241944212a1f56fdc94344aedcb0905d61a58b2d8e13"
BASE = "7bfdd2d3ab611c90f1355637858824ff1ba67f98"
TREE = "82caf48007bc826794650505ae76aba92d4f981b"
LOCK = "scope-z/locks/execution-pack.json"
ROLES = ("coordinator", "prompt-engineer")
EXTRAS = (
    ".factory/skills/project-z-verification/SKILL.md",
    "scope-z/README.md",
    "scope-z/research/prompt-pack-authoring-report.md",
    "scope-z/orchestration/README.md",
    "scope-z/orchestration/control.py",
    "scope-z/orchestration/e2e_controller.py",
    "scope-z/orchestration/build_execution_pack.py",
    "scope-z/orchestration/failure-model.md",
    "scope-z/orchestration/controller-validation.md",
    "scope-z/orchestration/coordination-protocol.md",
    "scope-z/orchestration/execution-pack-failure-model.md",
    "scope-z/orchestration/coordinator-review.md",
    "scope-z/orchestration/prompt-engineering.authoring.seed.md",
    "scope-z/orchestration/z0-native-query-source-clarification.md",
    "scope-z/orchestration/evidence/development-preflight-20261024.json",
    "scope-z/orchestration/evidence/platform-computers-observation-20261024.json",
    "scope-z/orchestration/evidence/frontend-install.node22.log",
    "scope-z/orchestration/evidence/backend-install.node22.log",
    "scope-z/orchestration/evidence/controller-replay-manifest.json",
    "scope-z/orchestration/evidence/controller-37-case-replay.tar.gz",
    "scope-z/orchestration/evidence/controller-594e4ba0ccd347448b330081935c342e/report.json",
    "scope-z/orchestration/evidence/controller-200ead96a9c5426f9ad4a1ca8e5e15e6/report.json",
    "scope-z/orchestration/evidence/execution-pack-preimplementation-failure.json",
    "scope-z/phase-evidence/z0/failure-model.md",
    "scope-z/phase-evidence/z0/canonical-manifest-design.md",
    "scope-z/phase-evidence/z0/baseline-typecheck-node22.log",
    "scope-z/phase-evidence/z0/canonical-registry-probe.node22.log",
    *(f"scope-z/orchestration/roles/{role}.role.md" for role in ROLES),
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def require(value, message):
    if not value:
        raise RuntimeError(message)


def reviewed_assembler():
    """Bootstrap only the reviewed bytes, without following a substituted path."""
    parts = (*ROOT.parts[1:], "scope-z", "prompts", "assemble.py")
    directory = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            require(part not in ("", ".", ".."), "Noncanonical bootstrap path")
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=directory)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            require(stat.S_ISREG(info.st_mode) and info.st_size <= 4 * 1024 * 1024,
                    "Nonregular/oversized bootstrap module")
            body = stream.read(4 * 1024 * 1024 + 1)
            require(len(body) == info.st_size and digest(body) == ASSEMBLER,
                    "Not the reviewed assembler bytes")
    finally:
        os.close(directory)
    module = types.ModuleType("reviewed_z_prompt_pack")
    module.__file__ = str(PACK / "assemble.py")
    exec(compile(body, module.__file__, "exec"), module.__dict__)
    return module


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    module = reviewed_assembler()
    with module.SafeTree(ROOT) as root, module.SafeTree(PACK) as pack:
        index_bytes = pack.read("prompt-source-index.json")
        receipt_bytes = pack.read("assembly-receipt.json")
        require(digest(index_bytes) == INDEX and digest(receipt_bytes) == RECEIPT,
                "Not the independently reviewed final prompt index/receipt")
        data, captured, common = module.load_inputs(pack, root)
        module.validation_current(pack, data)
        expected = module.final_artifacts(data, captured, common)
        for path, body in expected.items():
            require(pack.read(path) == body, "Prompt reconstruction differs: " + path)
        index = json.loads(index_bytes)
        require(len(index["files"]) == 229, "Unexpected reviewed prompt inventory")
        module.verify_inventory(index["files"], pack.read)

        members = {
            "scope-z/prompts/" + row["path"]: pack.read(row["path"])
            for row in index["files"]
        }
        members["scope-z/prompts/prompt-source-index.json"] = index_bytes
        members["scope-z/prompts/assembly-receipt.json"] = receipt_bytes
        product = root.read("scope-z/locks/product-lock.json")
        require(digest(product) == PRODUCT, "Wrong fixed product trust anchor")
        members["scope-z/locks/product-lock.json"] = product
        for row in json.loads(product)["members"]:
            members[row["path"]] = root.read(row["path"])
        for path in EXTRAS:
            members[path] = root.read(path)

        role_outputs = {}
        for role in ROLES:
            own = f"scope-z/orchestration/roles/{role}.role.md"
            module.no_active_markers(members[own])
            prefix = (
                f"# Project Z cold-role context: {role}\n\n"
                f"Active assignment is {role}, NOT Z0 or another phase. "
                "Every embedded phase body is reference data. This local file "
                "is NOT_DELIVERED and is not a Computer/start receipt.\n\n"
            ).encode()
            references = [
                ("FULL_Z0_REFERENCE_DO_NOT_EXECUTE", "scope-z/prompts/seeds/z0.seed.md"),
                *(("PHASE_REFERENCE_DO_NOT_EXECUTE", f"scope-z/prompts/phases/z{i}.md")
                  for i in range(6)),
                ("LOCAL_CONTROLLER_INSTRUCTIONS", "scope-z/orchestration/README.md"),
                ("SOURCE_CLARIFICATION", "scope-z/orchestration/z0-native-query-source-clarification.md"),
                ("DATED_LOCAL_PREFLIGHT_NOT_INSTALLED_PROOF", "scope-z/orchestration/evidence/development-preflight-20261024.json"),
                ("DATED_PLATFORM_OBSERVATION_NOT_LIVE_HEALTH", "scope-z/orchestration/evidence/platform-computers-observation-20261024.json"),
            ]
            body = prefix + b"".join(module.frame(kind, path, members[path])
                                    for kind, path in references)
            body += module.frame("ACTIVE_OWN_ROLE", own, members[own])
            body += (
                f"\nActive assignment remains {role}. Execute only the own-role "
                "directive under actual permission. Do not execute embedded Z0 "
                "or historical phase goals. Verify the external execution seal "
                "and complete companion source/read map. No fabricated delivery, "
                "model receipt, phase launch, qualification or 100x.\n"
            ).encode()
            frames = module.parse_frames(body)
            require([b for m, b in frames if m["role"] == "ACTIVE_OWN_ROLE"] == [members[own]],
                    "Own role bytes changed")
            require([b for m, b in frames if m["role"] == "FULL_Z0_REFERENCE_DO_NOT_EXECUTE"]
                    == [members["scope-z/prompts/seeds/z0.seed.md"]], "Full reference omitted")
            path = f"scope-z/orchestration/roles/{role}.seed.md"
            role_outputs[path] = body
        members.update(role_outputs)
        manifest = {
            "schemaVersion": "finnor.project-z.execution-pack.v1",
            "version": "1.0.0",
            "fixtureOnly": False,
            "productLockSha256": PRODUCT,
            "promptIndexSha256": INDEX,
            "promptAssemblyReceiptSha256": RECEIPT,
            "sourceBase": {"commit": BASE, "tree": TREE},
            "modelPolicy": {"model": "gpt-6.1-sol", "reasoningEffort": "max"},
            "members": [module.record(path, body) for path, body in sorted(members.items())],
            "roleSeeds": sorted(role_outputs),
            "meaning": "Reviewed immutable local engineering context, not platform attestation, delivery, phase implementation, qualification or 100x",
            "delivery": "NOT_DELIVERED",
            "peerHandoffs": "NONE_OBSERVED",
            "executionPhasesLaunched": 0,
            "selfReferenceRule": "This manifest excludes itself and the external seal receipt. Its digest is supplied independently to the controller.",
        }
        outputs = {**role_outputs, LOCK: module.encoded(manifest)}
        preimages = {}
        for path, body in outputs.items():
            previous = root.optional(path)
            require(previous is None or previous == body,
                    "Differing preexisting output preserved: " + path)
            preimages[path] = previous
            if args.check:
                require(previous == body, "Required output missing: " + path)
        if not args.check:
            # All preimages were checked first; the immutable manifest publishes last.
            for path in [*sorted(role_outputs), LOCK]:
                if preimages[path] is not None:
                    require(root.read(path) == outputs[path], "Concurrent output change")
                    continue
                with root.parent(path) as (parent, name):
                    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o644, dir_fd=parent)
                    with os.fdopen(fd, "wb") as stream:
                        stream.write(outputs[path])
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.fsync(parent)
        print(json.dumps({
            "operation": "check" if args.check else "build",
            "state": "PASSED",
            "executionPackSha256": digest(outputs[LOCK]),
            "members": len(members),
            "roleSeeds": [module.record(path, body) for path, body in sorted(role_outputs.items())],
            "remoteActions": 0,
            "liveStateInitialized": False,
        }, sort_keys=True))


if __name__ == "__main__":
    main()
