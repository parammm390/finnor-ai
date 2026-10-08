"""Preserve the normative fields, algorithms and challenge denominators."""
import hashlib
import json
import pathlib
import re

here = pathlib.Path(__file__).resolve().parent
control = pathlib.Path("/Users/paramdave/.codex/visualizations/2026/10/04/01a10828-82e3-7572-8d13-530b28a346bf/finnor-pm-control")
extract = control / "completion-prompts-2026-10-07/original-ten-phase-contracts.md"
text = extract.read_text()
missions = {
    "P3": control / "prompts/phase-03-p3-branch-fabric-factory-parallel.md",
    "M3": control / "prompts/phase-05-m3-capital-program-factory.md",
    "M4": control / "prompts/phase-06-m4-counterexample-search-factory.md",
}
fields = {
    "P3": "kind program baselineState scenario environment observations postconditions checkpoints result evidenceClass".split(),
    "M3": "mandate programModule ownerBoundGraph evidenceSlice mechanisms inquiries allocationRequest effectProposals challengeEvidence incumbentAndSearchGap".split(),
    "M4": "candidate claims searchedDomain independentWitnesses unresolved repairDependencies result".split(),
}
envelopes = {
    "P3": "tenant mandate work parents rights inputs producer runtime domain dependencies costs status".split(),
    "M3": "id tenant mandateOrChange work parents inputs rights owners producer runtime domain invalidation computeGrant costs state".split(),
    "M4": "id tenant mandateOrChange work parents inputs rights owners producer runtime domain invalidation computeGrant costs state".split(),
}
rows = []


def add(phase, kind, key, requirement, source, line=None):
    rows.append({
        "id": f"{phase}.{kind}.{key}", "phase": phase, "category": kind,
        "requirement": requirement, "source": {"path": str(source), "line": line},
        "implementation": {"state": "UNRECONCILED", "paths": []},
        "executionProof": {"state": "NOT_RUN", "evidence": []},
        "integrationAtFinalCut": {"state": "NOT_RUN", "generation": None},
        "independentQualification": {"state": "UNQUALIFIED", "evidence": []},
        "productionFieldAdmission": {"state": "UNADMITTED", "evidence": []},
        "primaryTestOwner": "B", "sourceCut": None, "integrationDependencies": [],
        "closureState": "OPEN",
    })


denominators = {}
for phase, path in missions.items():
    lines = path.read_text().splitlines()
    section = text.split(f"## {phase}\n", 1)[1].split("\n## ", 1)[0]
    marker = {"P3": "Branch execution algorithm", "M3": "Representation and search", "M4": "Search algorithm"}[phase]
    algorithm = section.split(marker + "\n", 1)[1]
    steps = []
    for line in algorithm.splitlines():
        if not re.match(r"^\d+\. ", line):
            break
        steps.append(line)
    if len(steps) != {"P3": 7, "M3": 8, "M4": 6}[phase]:
        raise RuntimeError(f"{phase}: original algorithm denominator changed")
    for index, step in enumerate(steps, 1):
        add(phase, "ALGORITHM", str(index).zfill(2), step, extract,
            text[:text.index(step)].count("\n") + 1)
    for field in fields[phase]:
        add(phase, "OUTPUT", field, f"Original single output field: {field}. Preserve required/optional meaning and resolve real owner bytes.", extract)
    for field in envelopes[phase]:
        add(phase, "ENVELOPE", field, f"Original common envelope binding: {field}. Missing authority remains unresolved, never caller-trusted.", extract)
    if phase == "P3":
        families = [(str(index + 1).zfill(2), i + 1, line) for index, (i, line) in enumerate(
            (i, line) for i, line in enumerate(lines) if re.match(r"^[A-T]\. ", line))]
    else:
        families = [(match.group(1).zfill(2), i + 1, line)
                    for i, line in enumerate(lines)
                    if (match := re.match(r"^(\d+)\. \*\*", line))]
        # Milestones are outside the mandatory challenge block.
        families = [item for item in families if
                    (210 <= item[1] <= 278 if phase == "M3" else 162 <= item[1] <= 228)]
    for key, line, requirement in families:
        add(phase, "CHALLENGE", key, requirement, path, line)
    expected = 20 if phase == "P3" else 34
    if len(families) != expected:
        raise RuntimeError(f"{phase}: original challenge denominator changed")
    denominators[phase] = {"algorithmSteps": len(steps), "outputFields": len(fields[phase]),
                           "envelopeFields": len(envelopes[phase]), "challengeFamilies": expected}
    challenge_lines = {item[1] for item in families}
    for line_number, line in enumerate(lines, 1):
        if line_number in challenge_lines or not line.strip() or line.startswith(("#", "```", "/goal ")):
            continue
        if line.startswith(("- ", "* ")) or re.match(r"^\d+\. ", line) or re.match(r"^(Must |Never |Require |Reject |Preserve |Gate)", line):
            add(phase, "CONSUMER_DURABILITY_RULE", str(line_number).zfill(3), line, path, line_number)
    gate = next(line for line in section.splitlines() if line.startswith(("Gate P3:", "Gate M3", "Gate M4")))
    if gate in ("Gate M3", "Gate M4"):
        gate = section.split(gate, 1)[1].strip().split("\n", 1)[0]
    add(phase, "GATE", "ORIGINAL", gate, extract)
    for predicate, requirement in {
        "PREREGISTRATION": "Independent frozen numeric criteria, domain, comparator, cluster, information, resources, stopping and multiplicity before scoring.",
        "MATCHED_COST": "All preparation/search/rejected/failed/cleanup/provider/human costs, qualified positive comparator and simultaneous intervals.",
        "QUALITY_RISK": "Correctness >=95%, reference shortfall <=0.05, calibration <=0.02, interval width <=0.5, deterministic constraints and zero observed authority/tenant/false verification violations.",
        "RESOURCE_ENVELOPE": "900 human seconds, USD100, 16GiB, 30-second response, 3600-second wall; 80 hours/USD10000 preparation; genuine shared S5 grant.",
        "ADMISSION": "Actual independent S8/environment/owner admission; local signer cannot supply it.",
        "H2": "Original 90-day closed loop, reach and 36-month S7 mature net owner wealth; 100x and named 10x are separate original tests.",
    }.items():
        add(phase, "GATE", predicate, requirement, path)
ledger = {
    "schema": "completion-requirement-ledger.v1", "phases": ["P3", "M3", "M4"],
    "derivedCompletionRule": "All mandatory columns must qualify; no green software column overrides an unpassed gate.",
    "originalDenominators": denominators,
    "sourceDigests": [{"path": str(p), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                      for p in [extract, *missions.values()]],
    "requirements": rows,
}
(here / "requirements.json").write_text(json.dumps(ledger, indent=2) + "\n")
print(json.dumps({"registeredRequirements": len(rows), "originalDenominators": denominators}))
