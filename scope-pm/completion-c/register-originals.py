#!/usr/bin/env python3
"""Retain every original clause; no automatic qualification from text capture."""
import hashlib
import json
from pathlib import Path

CONTROL = Path("/Users/paramdave/.codex/visualizations/2026/10/04/"
               "01a10828-82e3-7572-8d13-530b28a346bf/finnor-pm-control")
HERE = Path(__file__).resolve().parent
ISSUED = [
    ("P4", "phase-01-p4-evidence-execution-delivered-recovered.md", "A"),
    ("M1", "phase-02-m1-decision-slice-factory-parallel.md", "A"),
    ("P3", "phase-03-p3-branch-fabric-factory-parallel.md", "B"),
    ("P1", "phase-04-p1-program-synthesis.md", "A"),
    ("M3", "phase-05-m3-capital-program-factory.md", "B"),
    ("M4", "phase-06-m4-counterexample-search-factory.md", "B"),
    ("P2", "phase-07-p2-compute-search-codex.md", "A"),
    ("M2", "phase-08-m2-deliberation-controller-codex.md", "A"),
    ("P7", "phase-09-p7-live-recompilation-factory.md", "C"),
    ("P5", "phase-10-p5-interface-synthesis-factory.md", "C"),
]


def write(name, value):
    data = (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()
    path = HERE / name
    temporary = path.with_suffix(path.suffix + ".pending")
    temporary.write_bytes(data)
    temporary.replace(path)
    assert path.read_bytes() == data


def main():
    requirements, sources, gates = [], [], []
    copies = HERE / "evidence" / "normative"
    copies.mkdir(parents=True, exist_ok=True)
    for delivery, (phase, filename, owner) in enumerate(ISSUED, 1):
        path = CONTROL / "prompts" / filename
        before = path.read_bytes()
        digest = hashlib.sha256(before).hexdigest()
        (copies / filename).write_bytes(before)
        assert path.read_bytes() == before == (copies / filename).read_bytes()
        lines = before.decode().splitlines()
        sources.append({"delivery": delivery, "phase": phase, "path": str(path),
                        "sha256": digest, "bytes": len(before), "lines": len(lines),
                        "copiedPath": str((copies / filename).relative_to(HERE))})
        # Include prose, tables, types, failure families, instructions and gates.
        # Deliberately overinclusive: this is a clause-level denominator, not
        # a favourable selection of recognised numbered requirements.
        for number, text in enumerate(lines, 1):
            if not text.strip():
                continue
            requirements.append({
                "id": f"{phase}-original-L{number}", "phase": phase,
                "source": {"path": str(path), "sha256": digest, "line": number},
                "verbatim": text, "semanticOwner": phase,
                "implementationOwner": f"TRACK_{owner}",
                "integrationOwner": "TRACK_C", "implementation": None,
                "primaryValidation": None, "finalIntegrationSource": None,
                "finalRuntime": None, "execution": "NOT_RUN",
                "integration": "UNASSESSED", "independentQualification": "UNQUALIFIED",
                "productionField": "UNQUALIFIED", "gateAdmissionOutcome": "UNKNOWN",
            })
        gates.append({
            "id": "Gate" + phase, "phase": phase, "originalMission": str(path),
            "originalSha256": digest, "denominator": "COMPLETE_ORIGINAL_AND_COMMON_CONTRACTS",
            "mandatoryPredicates": [
                {"id": r["id"], "source": r["source"], "verbatim": r["verbatim"],
                 "outcome": "UNASSESSED"}
                for r in requirements if r["phase"] == phase
            ],
            "implementation": "UNASSESSED", "execution": "NOT_RUN",
            "integration": "UNQUALIFIED", "independentQualification": "UNQUALIFIED",
            "productionField": "UNQUALIFIED", "passed": False,
            "comparator": None, "numericProtocolFrozen": False,
            "completeCostsReconciled": False, "finalSourceRuntimeMigration": None,
        })
    write("all-ten-requirements.json",
          {"schema": "finnor.completion-c.original-clauses.v1",
           "automaticScoring": False, "sources": sources, "requirements": requirements})
    write("all-ten-gates.json",
          {"schema": "finnor.completion-c.original-gates.v1", "gates": gates,
           "everyMandatoryPredicatePassed": False,
           "floors": {"correctness": 0.95, "regretOrReferenceShortfall": 0.05,
                      "coverageError": 0.02, "coverageLevels": [0.5, 0.8, 0.9, 0.95],
                      "mean90WidthFixedRange": 0.5, "observedProtectedViolations": 0},
           "evidenceHorizons": {"H0": "execution", "H1": "model/decision",
                               "H2": "independent mature attributable owner value"},
           "operationalDays": 90, "primaryH2Months": 36})
    print(json.dumps({"sources": len(sources), "clauses": len(requirements),
                      "qualifiedGates": 0}))


if __name__ == "__main__":
    main()
