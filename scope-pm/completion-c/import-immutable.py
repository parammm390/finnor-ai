#!/usr/bin/env python3
"""Apply only original phase deltas to the published foundation, never a baseline."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
SOURCES = "refs/completion-c/sources/p5-canonical"
PHASES = {
    "API": ("970b8d66e", SOURCES),
    "FRONTEND": ("970b8d66e", SOURCES),
    "LEDGER_S8": ("d8d72f8f37f20761e7cd7d8517b80acaa124115a", "970b8d66e"),
    "P4": ("970b8d66e", "5f757bee3"),
    "P1": ("5f757bee3", "fb003abd3"),
    "P2": ("fb003abd3", "94423a17a"),
    "P5": ("94423a17a", SOURCES),
}
FRONTEND_PATHS = {
    "src/components/centropy/canvas/CanvasDocument.tsx",
    "src/components/centropy/canvas/ComputeSearchPanel.tsx",
    "src/components/centropy/canvas/EvidenceWorkbench.tsx",
    "src/components/centropy/canvas/InterfaceSynthesisPanel.tsx",
    "src/components/centropy/canvas/ProgramSynthesisPanel.tsx",
    "src/components/centropy/canvas/canvas-compose.ts",
    "src/components/centropy/canvas/canvas-contract.ts",
    "src/components/centropy/canvas/interface-client.ts",
    "src/components/centropy/canvas/program-grammar.ts",
    "src/components/centropy/shell/CentropyWorkspace.tsx",
    "src/components/centropy/shell/centropy.css",
}
DEFER = {
    "finnor-os/package-lock.json", "package-lock.json",
    "finnor-os/packages/db/migration-head.ts",
    "finnor-os/packages/db/migrations-bundle.ts",
    "finnor-os/apps/supplier-canary/api/index.mjs",
    "infra/deployment/production.contract.json",
    "finnor-os/openapi.json", "finnor-os/docs/authz-matrix.md",
    "src/lib/jarvis/openapi-types.ts",
    "src/lib/centropy/capability-manifest.generated.json",
    "docs/release/generated/action-manifest.json",
}


def git(*args, check=True):
    result = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True,
                            check=check, timeout=90)
    return result.stdout if result.returncode == 0 else b""


def relevant(path):
    return path.startswith((
        "finnor-os/packages/", "finnor-os/apps/worker/", "finnor-os/scripts/p1/",
        "finnor-os/scripts/p2/", "finnor-os/scripts/p3/",
        "finnor-os/scripts/p4/", "finnor-os/scripts/p5/",
        "finnor-os/scripts/m1/", "finnor-os/tests/",
    ))


def main():
    phase = sys.argv[1]
    attempt = sys.argv[2] if len(sys.argv) > 2 else "01"
    if not attempt.isdecimal() or len(attempt) != 2:
        raise RuntimeError("Attempt must be a two-digit immutable receipt suffix")
    if phase == "S8":
        # Authentic local S8 source, absent on the published S7 foundation.
        # No unrelated private S baseline is substituted.
        parent, head = None, git("rev-parse", "970b8d66e^{commit}").decode().strip()
        all_paths = git("ls-tree", "-r", "--name-only", head).decode().splitlines()
        selected = [p for p in all_paths if p.startswith((
            "finnor-os/packages/capability-evolution/",
            "finnor-os/scripts/s8/"))]
        selected = [p for p in selected if not (ROOT / p).exists()]
        patch = git("diff", "--binary", "--full-index", "--no-renames",
                    "4b825dc642cb6eb9a060e54bf8d69288fbee4904", head, "--", *selected)
        deferred = []
    else:
        parent, head = PHASES[phase]
        parent = git("rev-parse", parent + "^{commit}").decode().strip()
        head = git("rev-parse", head + "^{commit}").decode().strip()
        paths = git("diff", "--name-only", parent, head).decode().splitlines()
        selected, deferred = [], []
        for p in paths:
            if phase == "LEDGER_S8":
                (selected if p == "finnor-os/scripts/s7/ledger-fixture.mts" else deferred).append(p)
                continue
            if phase == "FRONTEND":
                (selected if p in FRONTEND_PATHS else deferred).append(p)
                continue
            if phase == "API":
                if p == "finnor-os/apps/api/app/api/company-brain/[operation]/route.ts":
                    selected.append(p)
                else:
                    deferred.append(p)
                continue
            if (not relevant(p) or p in DEFER or p.startswith("finnor-os/packages/db/migrations/")
                    or p.startswith("scope-pm/") or p.startswith("evidence/")
                    or p.startswith("docs/release/generated/")):
                deferred.append(p)
            else:
                selected.append(p)
        patch = git("diff", "--binary", "--full-index", "--no-renames",
                    parent, head, "--", *selected)
    if not selected:
        raise RuntimeError("No source delta selected; refusing unrestricted diff")
    if git("diff", "--name-only", "--diff-filter=U").strip():
        raise RuntimeError("Resolve prior integration conflicts before the next batch")
    out = HERE / "evidence" / "integration"
    out.mkdir(parents=True, exist_ok=True)
    prefix = phase + "-" + attempt
    patch_path = out / (prefix + "-original-delta.patch")
    with patch_path.open("xb") as stream:
        stream.write(patch)
    rows = []
    for p in selected:
        target = git("rev-parse", head + ":" + p, check=False).decode().strip()
        previous = (git("rev-parse", parent + ":" + p, check=False).decode().strip()
                    if parent else None)
        integration = git("rev-parse", ":" + p, check=False).decode().strip()
        rows.append({"path": p, "originalPreimage": previous,
                     "originalPostimage": target, "integrationPreimage": integration})
    receipt = {"phase": phase, "parent": parent, "head": head,
               "patchSha256": hashlib.sha256(patch).hexdigest(),
               "selected": rows, "deferred": deferred,
               "claim": "SOURCE_IMPORT_NOT_SEMANTIC_OR_BEHAVIOURAL_QUALIFICATION"}
    with (out / (prefix + "-import.json")).open("x") as stream:
        stream.write(json.dumps(receipt, indent=2) + "\n")
    # A conflict is a stop for inspection, not permission for --theirs.
    result = subprocess.run(["git", "-C", str(ROOT), "apply", "--3way",
                             str(patch_path)], capture_output=True, timeout=90)
    with (out / (prefix + "-apply.log")).open("xb") as stream:
        stream.write(result.stdout + result.stderr)
    print(json.dumps({"phase": phase, "paths": len(selected),
                      "deferred": len(deferred), "exitCode": result.returncode,
                      "conflicts": git("diff", "--name-only", "--diff-filter=U").decode().splitlines()}))
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
