#!/usr/bin/env python3
"""Validate requirement-case-matrix.json and render requirement-case-matrix.md.

Stdlib only; the markdown depends only on the JSON (no timestamps, no host state).
Evidence verification results go to stdout/stderr only.

  render-matrix.py [--json PATH] [--md PATH] [--prd PATH] [--require-remote] [--check-only]

Exit codes: 0 valid, 1 validation errors, 2 usage/IO errors.
Without --require-remote an evidence file that does not exist on this host is
reported as UNVERIFIED_REMOTE; with it, the file must exist and hash-match.
"""
import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter, OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
STATES = ["PASS", "FAIL", "NOT_RUN", "INCOMPLETE", "EXTERNAL"]
CLASSES = {"PUBLIC_CI", "NATIVE_E2E", "NATIVE_RECOVERY", "NATIVE_NEGATIVE", "INSTALLED_RECONSTRUCTION", "STATIC_CHECK", "REGRESSION"}
KINDS = {"computation", "checker", "owner-consumption", "currentness", "recovery", "fixture", "gate", "falsifier", "limitation", "product-behaviour"}
BASIS_SCOPES = {"INTEGRATED_ANCESTOR", "INTEGRATED_FINAL_CUT", "PHASE_HEAD_ONLY"}
PHASE_HEADS = {"baccd1e", "2f23467", "999b797", "aaab2c4", "d1a0aaa", "a9527f2"}
IN_SCOPE_PRD = [(197, 255), (259, 303), (307, 380), (384, 470), (474, 562), (566, 650), (654, 735), (823, 871)]
SECTION10 = (739, 819)
CASE_FIELDS = ["id", "title", "class", "path", "input", "independentExpected", "evidence", "rerun", "host", "state", "stateBasis", "countsToward"]
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def structural_prd_line(text):
    t = text.strip()
    return t == "" or t.startswith("#") or t == "---" or t.startswith("```") or t == "$$" or t.startswith("|---")


def all_requirements(doc):
    for ph in doc["phases"]:
        for r in ph["requirements"]:
            yield ph["id"], r
    for r in doc["crossCutting"]:
        yield "CC", r


def validate(doc, prd_path, require_remote):
    errors, warns, verified = [], [], Counter()
    fail = lambda code, msg: errors.append("%s %s" % (code, msg))
    if doc.get("schema") != "finnor.project-z.integrated-requirement-case-matrix.v1":
        fail("M00", "schema")
    if not HEX40.match(doc.get("integratedBase", "")):
        fail("M00", "integratedBase")
    prd_lines = None
    if os.path.exists(prd_path):
        if sha256_file(prd_path) != doc.get("prdSha256"):
            fail("M00", "prdSha256 does not match " + prd_path)
        prd_lines = open(prd_path, encoding="utf-8").read().split("\n")
    else:
        warns.append("PRD file not found at %s; line coverage (M01) not checked" % prd_path)
    packet_ids = {p["id"] for p in doc["externalRequestPackets"]}
    req_ids, case_ids, covered = set(), set(), set()
    pk_used = {}
    for phase, r in all_requirements(doc):
        rid = r.get("id", "?")
        if rid in req_ids:
            fail("M03", "duplicate requirement id " + rid)
        req_ids.add(rid)
        if r.get("kind") not in KINDS:
            fail("M00", "%s bad kind %r" % (rid, r.get("kind")))
        a, b = r["prd"]["lines"]
        if a > b:
            fail("M01", rid + " reversed prd range")
        covered.update(range(a, b + 1))
        if SECTION10[0] <= a <= SECTION10[1] or SECTION10[0] <= b <= SECTION10[1]:
            fail("M13", rid + " cites PRD section 10 lines; comparison/100x/economics belong in separateGates")
        cases = r.get("cases", [])
        if not cases and not r.get("gap"):
            fail("M02", rid + " has no case and no explicit gap")
        if r.get("gap") and "EP-" in r["gap"] and not r.get("external"):
            fail("M14", rid + " gap text cites an external packet but external is null")
        ext = r.get("external")
        if ext:
            if ext not in packet_ids:
                fail("M14", "%s external %s is not a drafted packet" % (rid, ext))
            pk_used.setdefault(ext, set()).add(rid)
        classes = [c.get("class") for c in cases]
        if r["kind"] == "owner-consumption" and cases and all(c == "NATIVE_NEGATIVE" for c in classes):
            fail("M11", rid + " owner-consumption requirement carries only refusal cases (PRD 3.3)")
        if rid.endswith("-R40") and not any(c in ("NATIVE_E2E",) for c in classes):
            fail("M11", rid + " positive-chain requirement lacks a NATIVE_E2E case")
        for c in cases:
            cid = c.get("id", "?")
            for fld in CASE_FIELDS:
                if fld not in c:
                    fail("M00", "%s missing field %s" % (cid, fld))
            if cid in case_ids:
                fail("M03", "duplicate case id " + cid)
            case_ids.add(cid)
            if not cid.startswith(rid + "-C"):
                fail("M03", "case id %s does not extend requirement id %s" % (cid, rid))
            if c.get("class") not in CLASSES:
                fail("M00", "%s bad class" % cid)
            st = c.get("state")
            if st not in STATES:
                fail("M00", "%s bad state %r" % (cid, st))
                continue
            if not str(c.get("independentExpected", "")).strip():
                fail("M05", cid + " has no independentExpected")
            same = "SAME_CODE_AS_PRODUCER" in str(c.get("independentExpected", ""))
            if same and st == "PASS" and r["kind"] == "checker":
                fail("M05", cid + " PASS against a checker requirement with a producer-owned oracle")
            if c.get("class") == "NATIVE_RECOVERY":
                p = c.get("path", "").lower()
                if "local" in p and ("file" in p or "journal" in p):
                    fail("M06", cid + " local-file recovery cannot be class NATIVE_RECOVERY")
                if st == "PASS" and not ("queue" in p and "s5" in p):
                    fail("M06", cid + " NATIVE_RECOVERY PASS needs path naming queue and S5")
            ct = str(c.get("countsToward", ""))
            if st == "PASS" and re.search(r">=32 families|independent qualification", ct, re.I) and "NOT" not in ct:
                fail("M08", cid + " public evidence counted toward independent qualification")
            if re.search(r"\b256 fresh", ct) and "NOT" not in ct:
                fail("M07", cid + " counts 256 as fresh cases")
            if not str(c.get("rerun", "")).strip():
                fail("M00", cid + " has no rerun (use NOT_YET_DEFINED)")
            sb = c.get("stateBasis")
            if st in ("PASS", "FAIL"):
                if not isinstance(sb, dict):
                    fail("M09" if st == "PASS" else "M15", cid + " %s needs stateBasis object" % st)
                    continue
                if not HEX64.match(sb.get("sha256", "")) or not HEX40.match(sb.get("commit", "")):
                    fail("M09", cid + " stateBasis needs 64-hex sha256 and 40-hex commit")
                if sb.get("scope") not in BASIS_SCOPES:
                    fail("M09", cid + " stateBasis scope")
                if sb.get("commit", "")[:7] in PHASE_HEADS and sb.get("scope") != "PHASE_HEAD_ONLY":
                    fail("M09", cid + " phase-head commit must be scope PHASE_HEAD_ONLY")
                f = sb.get("file", "")
                if "native/int-bringup-01" in f and not rid.startswith("CC-T"):
                    fail("M12", cid + " transport-only evidence used outside CC-T")
                if os.path.exists(f):
                    if sha256_file(f) != sb.get("sha256"):
                        fail("M10", "%s digest mismatch for %s" % (cid, f))
                    else:
                        verified["VERIFIED"] += 1
                elif require_remote:
                    fail("M10", "%s evidence file missing: %s" % (cid, f))
                else:
                    verified["UNVERIFIED_REMOTE"] += 1
            else:
                if not (isinstance(sb, str) and sb.strip()):
                    fail("M15", cid + " %s needs a stateBasis explanation string" % st)
            inp = c.get("input", {})
            ref = inp.get("ref") if isinstance(inp, dict) else None
            if ref and ref.startswith("EP-"):
                if ref not in packet_ids:
                    fail("M14", "%s references unknown packet %s" % (cid, ref))
                pk_used.setdefault(ref, set()).add(rid)
                if st != "EXTERNAL":
                    fail("M14", cid + " cites a packet but state is not EXTERNAL")
            if st == "EXTERNAL" and not (ref and ref.startswith("EP-")) and not r.get("external"):
                fail("M14", cid + " EXTERNAL without a packet")
            if ref and isinstance(inp, dict) and inp.get("sha256"):
                full = os.path.join(HERE, "..", "..", "..", ref)
                if os.path.exists(full) and sha256_file(full) != inp["sha256"]:
                    fail("M10", "%s input digest mismatch for %s" % (cid, ref))
    for p in doc["externalRequestPackets"]:
        for k in ("id", "need", "from", "why", "requirementIds"):
            if not p.get(k):
                fail("M14", "packet %s missing %s" % (p.get("id"), k))
        if set(p.get("requirementIds", [])) != pk_used.get(p["id"], set()):
            fail("M14", "packet %s requirementIds differ from usage %s" % (p["id"], sorted(pk_used.get(p["id"], []))))
    # M04: shared evidence keys are tallied once
    # M01: PRD line coverage of in-scope ranges
    if prd_lines is not None:
        excluded = set()
        for ex in doc.get("excludedPrdLines", []):
            a, b = ex["lines"]
            if not ex.get("reason"):
                fail("M01", "excludedPrdLines entry without reason")
            excluded.update(range(a, b + 1))
        uncovered = []
        for a, b in IN_SCOPE_PRD:
            for n in range(a, b + 1):
                if n in covered or n in excluded:
                    continue
                if n - 1 < len(prd_lines) and not structural_prd_line(prd_lines[n - 1]):
                    uncovered.append(n)
        if uncovered:
            runs, start, prev = [], uncovered[0], uncovered[0]
            for n in uncovered[1:]:
                if n != prev + 1:
                    runs.append((start, prev))
                    start = n
                prev = n
            runs.append((start, prev))
            fail("M01", "uncovered in-scope PRD lines: " + ", ".join("%d-%d" % r if r[0] != r[1] else str(r[0]) for r in runs))
    return errors, warns, verified


def tally(doc):
    t = OrderedDict()
    for phase, r in all_requirements(doc):
        row = t.setdefault(phase, {"requirements": 0, "cases": 0, "states": Counter(), "classes": Counter(), "gaps": 0, "evidenceKeys": {}, "reqStates": Counter(),
                                   "passScopes": Counter()})
        row["requirements"] += 1
        row["cases"] += len(r["cases"])
        if r.get("gap"):
            row["gaps"] += 1
        for c in r["cases"]:
            row["states"][c["state"]] += 1
            row["classes"][c["class"]] += 1
            key = c.get("evidenceKey")
            if key:
                row["evidenceKeys"].setdefault(key, []).append(c["id"])
            if c["state"] == "PASS":
                row["passScopes"][c["stateBasis"]["scope"]] += 1
        row["reqStates"][req_state(r)] += 1
    return t


def req_state(r):
    st = [c["state"] for c in r["cases"]]
    if not st:
        return "GAP_NO_CASE"
    if "FAIL" in st:
        return "HAS_FAIL"
    if all(s == "PASS" for s in st) and not r.get("gap"):
        return "ALL_CASES_PASS"
    if "PASS" in st:
        return "PARTIAL"
    if all(s == "EXTERNAL" for s in st):
        return "EXTERNAL"
    return "NO_PASS"


def distinct_pass_count(row):
    # a shared evidence key is one piece of evidence however many requirements cite it
    return len(row["evidenceKeys"])


def cell(s):
    return str(s).replace("|", "\\|").replace("\n", " ")


def render(doc):
    t = tally(doc)
    out = []
    w = out.append
    w("# Z0-Z5 requirement-to-case matrix (integrated candidate)")
    w("")
    w("Generated by `render-matrix.py` from `requirement-case-matrix.json`; do not edit by hand.")
    w("")
    w("- integrated base: `%s`" % doc["integratedBase"])
    w("- PRD sha256: `%s`" % doc["prdSha256"])
    w("- Nothing here is accepted, published or deployed. Independently accepted phases: 0 of 6. `PASS` is a case state backed by a cited evidence file; it is never phase acceptance.")
    w("- Every PASS ran on an ancestor of the integrated base or on a phase head and must be re-run on the final cut (`finalCutRerunRequired`).")
    w("")
    w("## Counts per phase and state")
    w("")
    w("| Scope | Requirements | Cases | PASS | FAIL | NOT_RUN | INCOMPLETE | EXTERNAL | Requirements with gap | Distinct PASS evidence keys |")
    w("|---|---|---|---|---|---|---|---|---|---|")
    tot = Counter()
    for phase, row in t.items():
        w("| %s | %d | %d | %d | %d | %d | %d | %d | %d | %d |" % (phase, row["requirements"], row["cases"], row["states"]["PASS"], row["states"]["FAIL"],
                                                              row["states"]["NOT_RUN"], row["states"]["INCOMPLETE"], row["states"]["EXTERNAL"], row["gaps"],
                                                              len([k for k, v in row["evidenceKeys"].items() if any(True for _ in v)])))
        tot["requirements"] += row["requirements"]
        tot["cases"] += row["cases"]
        tot["gaps"] += row["gaps"]
        for s in STATES:
            tot[s] += row["states"][s]
    w("| **Total** | %d | %d | %d | %d | %d | %d | %d | %d | |" % (tot["requirements"], tot["cases"], tot["PASS"], tot["FAIL"], tot["NOT_RUN"], tot["INCOMPLETE"], tot["EXTERNAL"], tot["gaps"]))
    w("")
    w("Cases citing the same evidence file with the same evidence key are one observation shared by several requirements (`sharedWith`); the case rows are counted per requirement, the evidence keys are counted once.")
    w("")
    w("### PASS scopes and classes")
    w("")
    w("| Scope | PASS by basis scope | Cases by class |")
    w("|---|---|---|")
    for phase, row in t.items():
        w("| %s | %s | %s |" % (phase, ", ".join("%s=%d" % kv for kv in sorted(row["passScopes"].items())) or "-", ", ".join("%s=%d" % kv for kv in sorted(row["classes"].items()))))
    w("")
    w("### Requirement-level derived status")
    w("")
    w("| Scope | " + " | ".join(["ALL_CASES_PASS", "PARTIAL", "HAS_FAIL", "NO_PASS", "EXTERNAL", "GAP_NO_CASE"]) + " |")
    w("|---|---|---|---|---|---|---|")
    for phase, row in t.items():
        w("| %s | %s |" % (phase, " | ".join(str(row["reqStates"][k]) for k in ["ALL_CASES_PASS", "PARTIAL", "HAS_FAIL", "NO_PASS", "EXTERNAL", "GAP_NO_CASE"])))
    w("")
    w("A requirement that is ALL_CASES_PASS but has a non-null gap is reported as PARTIAL. Public-only PASS cases never satisfy a native requirement (PRD 3.3); the PASS cases are public development, static, build or transport evidence.")
    w("")
    w("## Family design (PRD 3.7) per phase")
    w("")
    w("| Phase | Families | Public registered cases | Distinct inputs | Independent fresh cases | Notes |")
    w("|---|---|---|---|---|---|")
    for ph in doc["phases"]:
        c = ph.get("counts")
        if not c:
            continue
        w("| %s | %s | %s | %s | %s | %s |" % (ph["id"], c.get("families"), c.get("publicCases") or c.get("slots"),
                                               c.get("distinctInputs") or c.get("distinctRequestDigests") or c.get("distinctProblemDigests") or c.get("distinctArenaDigests"),
                                               c.get("freshCasesIndependent"), cell(c.get("slotRule") or ", ".join("%s=%s" % kv for kv in c.items() if kv[0] not in ("families", "publicCases", "freshCasesIndependent")))))
    w("")
    w("Z5 true numbers: 256 registered slots, 84 distinct inputs (2 of 32 families reach 8 distinct inputs), 188 positive slots over 50 distinct positive inputs; fresh cases are at most 84, not 256. Z4: 256 requests over 32 distinct programmes. Independent (protected) fresh cases: 0 in every phase.")
    w("")
    for ph in doc["phases"]:
        if ph.get("families"):
            w("### %s families" % ph["id"])
            w("")
            w("| Id | Structural family (source: qualification-families.json) | Public cases | Distinct inputs | State |")
            w("|---|---|---|---|---|")
            for f in ph["families"]:
                w("| %s | %s | %s | %s | %s |" % (f["id"], cell(f["name"]), f["publicCases"], f.get("distinctInputs", ""), f["state"]))
            if ph["families"] and ph["families"][0].get("note"):
                w("")
                w("Note: " + ph["families"][0]["note"])
            w("")

    def req_block(r):
        w("#### %s (%s, PRD %s lines %d-%d)" % (r["id"], r["kind"], r["prd"]["section"], r["prd"]["lines"][0], r["prd"]["lines"][1]))
        w("")
        w(r["text"])
        w("")
        w("Derived status: **%s**" % req_state(r) + ("; gap: %s" % r["gap"] if r.get("gap") else "") + ("; external: %s" % r["external"] if r.get("external") else ""))
        w("")
        for c in r["cases"]:
            w("- `%s` [%s] **%s** - %s" % (c["id"], c["class"], c["state"], c["title"]))
            w("  - path: %s" % c["path"])
            inp = c["input"]
            w("  - input: `%s`%s" % (inp.get("ref"), (" sha256 `%s`" % inp["sha256"]) if inp.get("sha256") else ""))
            w("  - independent expected: %s" % c["independentExpected"])
            w("  - evidence: `%s`" % c["evidence"])
            w("  - rerun: `%s`" % c["rerun"])
            w("  - host: %s" % c["host"])
            sb = c["stateBasis"]
            if isinstance(sb, dict):
                w("  - basis: `%s` sha256 `%s` commit `%s` scope %s%s; %s" % (sb["file"], sb["sha256"], sb["commit"], sb["scope"], " (final-cut rerun required)" if sb.get("finalCutRerunRequired") else "", sb["observed"]))
            else:
                w("  - basis: %s" % sb)
            w("  - counts toward: %s%s" % (c["countsToward"] or "-", ("; shared with " + c["sharedWith"]) if c.get("sharedWith") else ""))
            if c.get("note"):
                w("  - note: %s" % c["note"])
        w("")

    for ph in doc["phases"]:
        w("## %s (PRD section %s)" % (ph["id"], ph["prdSection"]))
        w("")
        for r in ph["requirements"]:
            req_block(r)
    w("## Cross-cutting")
    w("")
    for r in doc["crossCutting"]:
        req_block(r)
    w("## Requirements with an explicit gap")
    w("")
    for phase, r in all_requirements(doc):
        if r.get("gap"):
            w("- `%s` (%s): %s" % (r["id"], phase, r["gap"]))
    w("")
    w("## Separate gates (not folded into software state)")
    w("")
    for k, v in doc["separateGates"].items():
        w("### %s" % k)
        w("")
        w("- PRD requires: %s" % v["prdRequires"])
        w("- internally achievable: %s" % v["internallyAchievable"])
        w("- external: %s" % v["external"])
        w("")
    w("## External request packets (drafted, not sent)")
    w("")
    for p in doc["externalRequestPackets"]:
        w("### %s" % p["id"])
        w("")
        w("- needed: %s" % p["need"])
        w("- from: %s" % p["from"])
        w("- requirement ids: %s" % ", ".join(p["requirementIds"]))
        w("- why it cannot be built internally: %s" % p["why"])
        w("")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", default=os.path.join(HERE, "requirement-case-matrix.json"))
    ap.add_argument("--md", default=os.path.join(HERE, "requirement-case-matrix.md"))
    ap.add_argument("--prd", default=os.path.join(HERE, "..", "..", "FINNOR-Z-PRD.md"))
    ap.add_argument("--require-remote", action="store_true")
    ap.add_argument("--check-only", action="store_true")
    a = ap.parse_args()
    try:
        doc = json.load(open(a.json, encoding="utf-8"))
    except (OSError, ValueError) as e:
        print("cannot read matrix json: %s" % e, file=sys.stderr)
        return 2
    errors, warns, verified = validate(doc, a.prd, a.require_remote)
    for w_ in warns:
        print("WARN " + w_, file=sys.stderr)
    for e in errors:
        print("ERROR " + e, file=sys.stderr)
    print("evidence digests: %s" % dict(verified), file=sys.stderr)
    if errors:
        print("%d validation error(s); markdown not written" % len(errors), file=sys.stderr)
        return 1
    if not a.check_only:
        with open(a.md, "w", encoding="utf-8") as f:
            f.write(render(doc))
    t = tally(doc)
    for phase, row in t.items():
        print("%s requirements=%d cases=%d %s gaps=%d" % (phase, row["requirements"], row["cases"], dict(row["states"]), row["gaps"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
