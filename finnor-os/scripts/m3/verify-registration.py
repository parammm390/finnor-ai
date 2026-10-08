"""Audit the documentation contract against independently frozen control bytes.

Failure model: missing/truncated/reworded steps or families; absent boundary,
oracle or evidence maps; retrodated registration; changed historic evidence;
invented numerical criteria; lost provisional predecessor qualification.
This is a source-document contract check, not an economic or product test.
No production imports or runtime setup are needed.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[3]
PHASE = ROOT / "scope-pm/phase-05-m3-capital-program"
CONTROL = Path("/Users/paramdave/.codex/visualizations/2026/10/04/"
               "01a10828-82e3-7572-8d13-530b28a346bf/finnor-pm-control")
INITIAL = "f903f83560be1839071987622cc4670f6f892ad4"
SOURCE_HASHES = {
    "attachment": "4eec2291d197a83876c8a5952b4a080bd8417c9da560d2724492634849289856",
    "prompt": "1f59be16224320f1e42c65cef46559371e90e11c1a56b34741b5f321004674c3",
}
ANCHOR_HASHES = {
    "source-index.json": "d9b292007275b91946ff2888eb8f71414c428cac09b9f963c042a81d646ef500",
    "evidence/phase05-prompt-validation.json": "44a9d4c3e17761fee9df6d5233598456abdefe8644f8dd8164c2fdef1d2d6e40",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"registration-[a-z0-9-]+\.json", args.evidence):
        parser.error("Use a new registration-*.json receipt basename")
    target = PHASE / "scope-evidence" / args.evidence
    if target.exists():
        parser.error("Immutable receipt already exists")
    checks = []

    def check(name, expected, observed):
        checks.append({"name": name, "expected": expected, "observed": observed,
                       "status": "PASS" if expected == observed else "FAIL"})

    attachment = CONTROL / "sources/attachments/pasted-text-3.txt"
    prompt = CONTROL / "prompts/phase-05-m3-capital-program-factory.md"
    a, p = attachment.read_text(), prompt.read_text()
    source_index = json.loads((CONTROL / "source-index.json").read_text())
    indexed = next(x for x in source_index["files"] if x["snapshot"] == str(attachment))
    validated = json.loads((CONTROL / "evidence/phase05-prompt-validation.json").read_text())
    check("Original attachment matches fixed recovered hash", SOURCE_HASHES["attachment"], sha(attachment.read_bytes()))
    check("Delivery05 prompt matches fixed recovered hash", SOURCE_HASHES["prompt"], sha(prompt.read_bytes()))
    for name, expected in ANCHOR_HASHES.items():
        check(f"Fixed control verification anchor: {name}", expected, sha((CONTROL / name).read_bytes()))
    check("Original attachment matches captured source index", indexed["sha256"], sha(attachment.read_bytes()))
    check("Delivery05 prompt matches prior validation receipt", validated["sha256"], sha(prompt.read_bytes()))
    steps_section = a[a.index("1. Define a typed programme grammar"):a.index("type CapitalProgram")]
    steps = re.findall(r"^\d+\. (.+)$", steps_section, re.M)
    check("Eight governing construction steps", 8, len(steps))
    families_section = p[p.index("1. **Unsupplied structure"):p.index("## 11.")]
    families = re.findall(r"^\d+\. \*\*.+?(?=\n\n\d+\. \*\*|\n\n\Z)", families_section, re.M | re.S)
    check("34 complete governing case definitions", 34, len(families))
    docs = {name: (PHASE / name).read_text() for name in
            ["phase-plan.md", "failure-model.md", "requirement-map.md", "preregistration.md"]}
    check("Original steps verbatim in active phase plan", 8,
          sum(f"{i}. {text}" in docs["phase-plan.md"] for i, text in enumerate(steps, 1)))
    check("Original families verbatim in active failure model", 34,
          sum(text in docs["failure-model.md"] for text in families))
    for kind, count in [("Step", 8), ("Family", 34)]:
        rows = re.findall(rf"^\| {kind} (\d+) \| (.+) \|$", docs["requirement-map.md"], re.M)
        check(f"{kind} map covers each original position exactly once",
              list(range(1, count + 1)), sorted(int(n) for n, _ in rows))
        check(f"{kind} rows have boundary, independent oracle, evidence and status",
              count, sum(len(row.split(" | ")) == 4 and all(row.split(" | ")) for _, row in rows))
    for name, text in docs.items():
        check(f"{name}: no missing-definition placeholders", False,
              bool(re.search(r"original (?:definition|boundary|wording).*UNSET|"
                             r"UNSET.*original definition|31 of 34 positions.*UNSET", text, re.I)))
        check(f"{name}: explicit post-implementation correction", True,
              "post-implementation documentation correction" in text)
    for criterion in ["R0", "epsilon", "sample size", "independent held-out seal"]:
        check(f"Independent {criterion} remains UNSET", True,
              f"| {criterion} | UNSET |" in docs["preregistration.md"])
    check("Base still provisional and final M1 join pending", True,
          "PROVISIONAL" in docs["phase-plan.md"] and "final M1 join remains pending" in docs["phase-plan.md"])
    excerpts = {
        "original-m3-section.txt": "\n".join(a.splitlines()[148:183]) + "\n",
        "delivery05-eight-steps.md": p[p.index("## 7."):p.index("## 8.")],
        "delivery05-case-families.md": families_section,
        "delivery05-output.md": p[p.index("## 5."):p.index("## 6.")],
        "delivery05-gate.md": p[p.index("## 12."):p.index("## 13.")],
    }
    # The blank line separating the following source section is not part of
    # the excerpt. Keep every requirement byte and its terminal newline.
    excerpts = {name: text.rstrip("\n") + "\n" for name, text in excerpts.items()}
    for name, expected in excerpts.items():
        path = PHASE / "governing-registration" / name
        check(f"Exact governing excerpt: {name}", sha(expected.encode()),
              sha(path.read_bytes()) if path.exists() else None)
    provenance_path = PHASE / "governing-registration/provenance.json"
    provenance = json.loads(provenance_path.read_text()) if provenance_path.exists() else {}
    for path, expected in [(attachment, SOURCE_HASHES["attachment"]), (prompt, SOURCE_HASHES["prompt"])]:
        entry = next((x for x in provenance.get("sources", []) if x["path"] == str(path)), {})
        check(f"Provenance source hash: {path.name}", expected, entry.get("sha256"))
    for name, expected in ANCHOR_HASHES.items():
        check(f"Provenance verification anchor: {name}", expected,
              provenance.get("verificationAnchors", {}).get(str(CONTROL / name)))
    for name, text in excerpts.items():
        check(f"Provenance excerpt hash: {name}", sha(text.encode()),
              provenance.get("excerpts", {}).get(name, {}).get("sha256"))
    check("Recovery explicitly postdates initial native implementation",
          "POST_IMPLEMENTATION_DOCUMENTATION_CORRECTION_NOT_RETROACTIVE_REGISTRATION",
          provenance.get("classification"))
    check("Recovery identifies immutable first native commit", INITIAL,
          provenance.get("initialNativeCommit"))
    check("Recovery preserves UNPASSED GateM3", "UNPASSED", provenance.get("originalGateM3"))
    check("Recovery preserves all numeric unknowns",
          {"R0": "UNSET", "epsilon": "UNSET", "sampleSize": "UNSET", "independentSeal": "UNSET"},
          provenance.get("numericUnknowns"))
    check("Base receipt remains unchanged", provenance.get("baseReceiptSha256", "MISSING"),
          sha((PHASE / "base-receipt.json").read_bytes()))
    check("Provisional base receipt remains untracked", [],
          git("ls-files", "--", "scope-pm/phase-05-m3-capital-program/base-receipt.json").decode().splitlines())
    historic = {}
    for raw in git("ls-tree", "-r", "--name-only", INITIAL,
                   "scope-pm/phase-05-m3-capital-program/scope-evidence").decode().splitlines():
        original = git("show", f"{INITIAL}:{raw}")
        current = (ROOT / raw).read_bytes()
        historic[raw] = {"sha256": sha(current), "initialSha256": sha(original)}
        check(f"Immutable historical evidence: {Path(raw).name}", sha(original), sha(current))
    for name in docs:
        original = git("show", f"{INITIAL}:scope-pm/phase-05-m3-capital-program/{name}")
        archived = PHASE / "registration-history" / name
        check(f"Original registration archived unchanged: {name}", sha(original),
              sha(archived.read_bytes()) if archived.exists() else None)
    receipt = {
        "schema": "finnor.m3.registration-audit.v1",
        "observedAt": datetime.now(timezone.utc).isoformat(),
        "qualification": "DOCUMENTATION_PROVENANCE_ONLY_NOT_NATIVE_OR_PRODUCT_GATE",
        "sourceCommit": git("rev-parse", "HEAD").decode().strip(),
        "sourceTree": git("rev-parse", "HEAD^{tree}").decode().strip(),
        "inputs": {str(path): sha(path.read_bytes()) for path in
                   [attachment, prompt, CONTROL / "source-index.json",
                    CONTROL / "evidence/phase05-prompt-validation.json",
                    Path(__file__).resolve(), *[PHASE / name for name in docs],
                    *([provenance_path] if provenance_path.exists() else [])]},
        "historicalEvidence": historic,
        "checks": checks,
        "passed": sum(x["status"] == "PASS" for x in checks),
        "failed": sum(x["status"] == "FAIL" for x in checks),
        "rerun": f"python3 {Path(__file__).resolve()} --evidence registration-audit-new.json",
        "limitations": ["No production changes or economic rerun in this audit",
                        "Full registration repair occurred after initial implementation",
                        "Provisional predecessor; final committed M1 join pending",
                        "Original GateM3 remains UNPASSED"],
    }
    with target.open("x") as out:
        json.dump(receipt, out, indent=2)
        out.write("\n")
    for item in checks:
        print(f'{item["status"]} {item["name"]}')
    print(f'{receipt["passed"]} PASS / {receipt["failed"]} FAIL; evidence {target}')
    return int(receipt["failed"] != 0)


if __name__ == "__main__":
    sys.exit(main())
