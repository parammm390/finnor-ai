"""Public mathematical data-path inputs, not authenticated S5 records or owners.

Freeze a direct original-envelope Fraction result before the TypeScript reader.
No database, admission, donor inventory, native owner or shared DAG is invoked.
"""
import hashlib
import json
from pathlib import Path
import sys
from fractions import Fraction


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def pgtext(value):
    """jsonb text for these integer/ASCII public values, independently emitted."""
    if isinstance(value, dict):
        keys = sorted(value, key=lambda key: (len(key.encode()), key.encode()))
        return "{" + ", ".join(canonical(key) + ": " + pgtext(value[key]) for key in keys) + "}"
    if isinstance(value, list):
        return "[" + ", ".join(pgtext(item) for item in value) + "]"
    return canonical(value)


def save(path, value):
    with path.open("x") as stream:
        stream.write(canonical(value) + "\n")


def ref(owner, label, prefix, version):
    hashed = sha(label)
    return {"owner": owner, "id": prefix + ":" + hashed, "version": version, "contentDigest": hashed}


def wire_bound(scope):
    """Conservative schema-superset bound, not invented native inventory."""
    hashed, maximum = "f" * 64, 9007199254740991
    blank_ref = {"owner": "", "id": "", "version": "", "contentDigest": hashed}
    count = dict.fromkeys(["resources", "reservations", "originals", "other", "envelopes", "items"], maximum)
    base_scope = dict(scope, transactionId="9" * 20, rightsRevision="9" * 20)
    base = {
        "RESOURCE": {"tag": "RESOURCE", "resourceId": "", "reference": blank_ref,
                     "horizonDigest": hashed, "kind": "", "unit": ""},
        "RESERVATION": {"tag": "RESERVATION", "reservationRef": blank_ref, "certificateRef": blank_ref,
                        "demandRef": None, "originalKey": hashed, "population": "ORIGINAL",
                        "revision": maximum, "envelopeCount": maximum, "status": "PARTIALLY_RECONCILED"},
        "ENVELOPE": {"tag": "ENVELOPE", "reservationId": "", "ordinal": maximum, "resourceId": "",
                     "kind": "", "unit": "", "horizonDigest": hashed, "envelopeDigest": hashed,
                     "quantityCount": maximum, "opaque": False, "valid": False,
                     "quantities": [""] * 65, "minimumQuantities": [""] * 65},
    }
    proof = {}
    for tag, payload in base.items():
        frame = {"kind": "DATA", "fence": hashed, "sequence": maximum,
                 "payloadText": pgtext(payload), "payloadDigest": hashed}
        slots = {"RESOURCE": 6, "RESERVATION": 6, "ENVELOPE": 4}[tag]
        # A UTF-16 code unit takes <=6 bytes in JSON text. Re-encoding
        # payloadText can at most double that; digits never need escaping.
        fixed = len(canonical(frame).encode())
        upper = fixed + slots * 256 * 12 + (130 * 16 if tag == "ENVELOPE" else 0)
        proof[tag] = {"fixedBytes": fixed, "text256Slots": slots, "textBytesPerCodeUnit": 12, "upperBytes": upper}
    manifest = {"kind": "MANIFEST", "schema": "finnor.s5.z1.occupation-stream.v1", "scope": base_scope,
                "fence": hashed, "counts": count, "membersDigest": hashed, "selectedResourceIds": [""] * 16,
                "settlement": "UNKNOWN_UNINSPECTED"}
    proof["MANIFEST"] = {"fixedBytes": len(canonical(manifest).encode()), "text256Slots": 16,
                         "textBytesPerCodeUnit": 6,
                         "upperBytes": len(canonical(manifest).encode()) + 16 * 256 * 6}
    proof["SEAL"] = {"upperBytes": len(canonical({"kind": "SEAL", "fence": hashed, "sequence": maximum,
                                                 "counts": count, "membersDigest": hashed}).encode())}
    assert all(value["upperBytes"] < 32768 for value in proof.values())
    minimum_ref = len(canonical({"owner": "x", "id": "x", "version": "v", "contentDigest": "0" * 64}).encode())
    lower = 65536 * minimum_ref + 4000 * 2 * len(canonical(["0"] * 25).encode())
    assert lower > 8388608
    return {"scope": "CONSERVATIVE_WIRE_SCHEMA_SUPERSET_NOT_AUTHENTICATED_RECORDS", "frames": proof,
            "hardFrameLimit": 65536, "fetchFrames": 64, "hardPageLimit": 8388608,
            "pageUpperUsingHardFrameLimitAnd256ProtocolBytesPerFrame": 2 + 64 * (65536 + 256) + 63,
            "legacyConstructiveLowerBound24Periods": {"minimumEffectRefBytes": minimum_ref,
                "genericEffectRefs": 65536, "nativeEnvelopes": 4000, "lowerBytesIgnoringAllOtherFields": lower,
                "effectQuantumFeasibility": "512 distinct policy/node intents fit 32 policies * 24 periods and each >=1024-unit upper envelope; no budget renewal",
                "legacyTransitionReachability": "NOT_PROVEN_AND_NOT_REQUIRED_FOR_ENCODED_SCHEMA_COUNTEREXAMPLE"},
            "projectionMaximumEnvelopes": 4000 + 256 * 16,
            "projectionMaximumMembers": 16 + 1256 + 4000 + 256 * 16,
            "oldFullBudgetBodyAggregateUpperBytes": 1000 * 8388608,
            "newFullBudgetBodiesRetainedByValidationLoop": 1, "transactionResourceCacheMaximum": 16}


def direct(resources, commitments, selected):
    result = {}
    # Deliberately resource/period-first, not the stream producer's row-first walk.
    for resource in resources:
        rid = resource["resourceId"]
        if rid not in selected:
            continue
        occupation = []
        periods = resource["horizon"]["periods"] + 1
        per_period = [Fraction(resource["existingUse"][period]) for period in range(periods)]
        for original in commitments:
            for envelope in original["envelopes"]:
                if envelope["resourceId"] != rid:
                    continue
                assert envelope["horizon"] == resource["horizon"]
                assert len(envelope["quantities"]) == len(envelope["minimumQuantities"]) == periods
                for period in range(periods):
                    upper = Fraction(envelope["quantities"][period])
                    lower = Fraction(envelope["minimumQuantities"][period])
                    assert 0 <= lower <= upper
                    per_period[period] += upper
        for period in range(periods):
            indices = [period] if resource["kind"] == "OCCUPANCY" else range(period + 1)
            total = sum((per_period[index] for index in indices), Fraction(0))
            assert total.denominator == 1
            occupation.append(str(total.numerator))
        assert all(int(value) + 17 <= 100000000 - 7 for value in occupation)
        result[rid] = {"resourceId": rid, "requested": "17", "occupation": occupation,
                       "semantics": "PER_PERIOD_OCCUPANCY" if resource["kind"] == "OCCUPANCY" else "CUMULATIVE_PREFIX"}
    return result


def generate(destination):
    assert destination.is_absolute()
    destination.mkdir(mode=0o700)
    scope = {"tenantId": "10000000-0000-4000-8000-000000000001",
             "principalId": "20000000-0000-4000-8000-000000000001",
             "transactionId": "101", "rightsRevision": "1"}
    save(destination / "wire-bound.json", wire_bound(scope))
    status = ["RESERVED", "CONSUMPTION_PENDING", "UNKNOWN_OUTCOME", "PARTIALLY_RECONCILED", "SETTLED_RETAINED"]
    cases, byte_examples = [], []
    for periods in [24, 64]:
        resources = []
        for index in range(16):
            role = index % 4
            kind = "OCCUPANCY" if role == 3 else "CUMULATIVE_EXPENDITURE"
            unit = ["z1-logical-tick", "cpu-microseconds", "byte", "byte"][role]
            if index == 12:
                unit, kind = "request", "CUMULATIVE_EXPENDITURE"
            if index == 13:
                unit, kind = "seconds", "CUMULATIVE_EXPENDITURE"
            if index == 14:
                unit, kind = "cpu-microseconds", "CUMULATIVE_EXPENDITURE"
            resources.append({"resourceId": "__proto__" if index == 0 else f"public-resource-{index:02}", "kind": kind, "unit": unit,
                              "resourceClass": "HUMAN_ATTENTION" if index == 13 else "COMPUTE",
                              "ref": ref("S5", f"public-resource:{index}:{periods}", "allocation-resource", "s5-resource-v1"),
                              "horizon": {"startAt": "2026-10-26T00:00:00.000Z", "periodMs": 1000, "periods": periods},
                              "safetyMargin": "7", "existingUse": [str(i % 3) for i in range(periods + 1)],
                              "availability": [{"amount": "100000000", "basis": "REPORTED_AVAILABLE"} for _ in range(periods + 1)]})
        commitments, kinds, original_keys = [], {}, {}

        def envelope(index, amount, institution=False, generic=False):
            resource = resources[index]
            quantities = [str(1024 + (amount + period) % 19) if generic else
                          str(amount) if resource["kind"] == "OCCUPANCY" or period == 0 else "0"
                          for period in range(periods + 1)]
            return {"resourceId": resource["resourceId"], "kind": resource["kind"], "unit": resource["unit"],
                    "horizon": resource["horizon"], "quantities": quantities,
                    "minimumQuantities": list(quantities) if institution else ["0"] * (periods + 1)}

        groups = [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [0, 14, 2, 15]]
        for index in range(1000):
            reservation = ref("S5", f"public-original:{index}:{periods}", "z1-original-budget", "z1-native-owner-v1")
            certificate = ref("S5", f"public-original-certificate:{index}:{periods}", "z1-original-certificate", "z1-native-owner-v1")
            commitments.append({"reservationRef": reservation, "certificateRef": certificate,
                                "envelopes": [envelope(resource, index % 43 + 1) for resource in groups[index % 4]],
                                "status": status[index % len(status)], "policyRefs": [], "effectRefs": []})
            kinds[reservation["id"]] = "ORIGINAL"
            original_keys[reservation["id"]] = sha(scope["tenantId"] + ":public-original-work:" + str(index))
        for index in range(256):
            institution = index >= 128
            reservation = ref("S5", f"public-other:{index}:{periods}", "institution-reservation" if institution else "allocation-reservation", "ordinary-source-fixture-v1")
            item = {"reservationRef": reservation,
                    "envelopes": [envelope(resource, index % 29 + 1, institution, not institution)
                                  for resource in ([12, 13] if institution else range(16))],
                    "status": status[(index + 2) % len(status)], "policyRefs": [], "effectRefs": []}
            if institution:
                item["demandRef"] = ref("S5", f"public-demand:{index}:{periods}", "institution-demand", "ordinary-source-fixture-v1")
            else:
                item["status"] = status[1 + index % (len(status) - 1)]
                item["certificateRef"] = ref("S5", f"public-certificate:{index}:{periods}", "allocation-certificate", "ordinary-source-fixture-v1")
                item["policyRefs"] = [ref("S4", f"public-policy:{index}:{j}", "allocation-policy", "ordinary-source-fixture-v1") for j in range(32)]
                item["effectRefs"] = [ref("S6", f"public-effect:{index}:{j}", "effect", "ordinary-source-fixture-v1") for j in range(512)]
            commitments.append(item)
            kinds[reservation["id"]] = "OTHER"
        snapshot = {"resources": resources, "outstanding": commitments}
        legacy_bytes = len(canonical(snapshot).encode())
        assert legacy_bytes > 8388608, ("LEGACY_COUNTEREXAMPLE_MUST_EXCEED_UNCHANGED_LIMIT", periods, legacy_bytes)
        snapshot_path = destination / f"lower-bound-snapshot-{periods}.json"
        save(snapshot_path, snapshot)
        byte_examples.append({"periods": periods, "compactLegacyBytes": legacy_bytes,
                              "unchangedLimitBytes": 8388608, "originals": 1000, "other": 256,
                              "generic": 128, "institution": 128, "genericEffectReferences": 65536,
                              "scope": "PUBLIC_SCHEMA_LOWER_BOUND_NOT_REAL_AUTHENTICATED_S5_SNAPSHOT"})
        selections = [list(range(16))] if periods == 24 else [list(range(16)), [0, 1, 2, 3]]
        for selection in selections:
            name = f"p{periods}-r{len(selection)}"
            selected = {resources[index]["resourceId"] for index in selection}
            expected = direct(resources, commitments, selected)
            expected_path = destination / f"{name}-expected.json"
            save(expected_path, expected)  # Frozen before the writer and reader.
            members = []
            for resource in resources:
                members.append({"tag": "RESOURCE", "resourceId": resource["resourceId"], "reference": resource["ref"],
                                "horizonDigest": sha(canonical(resource["horizon"])), "kind": resource["kind"], "unit": resource["unit"]})
            opaque_count = 0
            for original in sorted(commitments, key=lambda row: row["reservationRef"]["id"].encode()):
                rid = original["reservationRef"]["id"]
                members.append({"tag": "RESERVATION", "reservationRef": original["reservationRef"],
                                "certificateRef": original.get("certificateRef"), "demandRef": original.get("demandRef"),
                                "population": kinds[rid], "originalKey": original_keys.get(rid), "revision": 1,
                                "envelopeCount": len(original["envelopes"]), "status": original["status"]})
                for ordinal, held in enumerate(original["envelopes"], 1):
                    opaque = held["resourceId"] not in selected
                    opaque_count += int(opaque)
                    members.append({"tag": "ENVELOPE", "reservationId": rid, "ordinal": ordinal,
                                    "resourceId": held["resourceId"], "kind": held["kind"], "unit": held["unit"],
                                    "horizonDigest": sha(canonical(held["horizon"])), "envelopeDigest": sha(pgtext(held)),
                                    "quantityCount": len(held["quantities"]), "opaque": opaque, "valid": True,
                                    "quantities": None if opaque else held["quantities"],
                                    "minimumQuantities": None if opaque else held["minimumQuantities"]})
            count = {"resources": 16, "reservations": 1256, "originals": 1000, "other": 256,
                     "envelopes": sum(len(item["envelopes"]) for item in commitments), "items": len(members)}
            payloads = [pgtext(member) for member in members]
            hashes = [sha(payload) for payload in payloads]
            root = sha("".join(hashes))
            fence = sha(canonical(scope))
            frames = [{"kind": "MANIFEST", "schema": "finnor.s5.z1.occupation-stream.v1", "scope": scope,
                       "fence": fence, "counts": count, "membersDigest": root,
                       "selectedResourceIds": sorted(selected), "settlement": "UNKNOWN_UNINSPECTED"}]
            frames += [{"kind": "DATA", "fence": fence, "sequence": index + 1,
                        "payloadText": payload, "payloadDigest": hashed} for index, (payload, hashed) in enumerate(zip(payloads, hashes))]
            frames += [{"kind": "SEAL", "fence": fence, "sequence": len(members) + 1, "counts": count, "membersDigest": root}]
            frame_path = destination / f"{name}-frames.jsonl"
            with frame_path.open("x") as stream:
                for frame in frames:
                    stream.write(canonical(frame) + "\n")
            settings = {"scope": scope, "resources": [resources[index] for index in selection],
                        "requested": {rid: "17" for rid in selected}, "frames": str(frame_path),
                        "expected": str(expected_path), "counts": count, "expectedOpaqueEnvelopes": opaque_count,
                        "legacySnapshot": str(snapshot_path), "legacyBytes": legacy_bytes,
                        "nativeOwnerFlow": "NOT_RUN", "authUsersCreated": 0, "claimsCreated": 0}
            settings_path = destination / f"{name}-settings.json"
            save(settings_path, settings)
            cases.append({"name": name, "settings": str(settings_path), "framesSha256": hashlib.sha256(frame_path.read_bytes()).hexdigest(),
                          "expectedSha256": hashlib.sha256(expected_path.read_bytes()).hexdigest(),
                          "maximumFrameBytes": max(len(canonical(frame).encode()) for frame in frames), "counts": count})
    report = {"scope": "PUBLIC_DATA_PATH_PROCESS_NOT_NATIVE_OWNER_OR_SQL_EXECUTION",
              "byteCounterexamples": byte_examples, "cases": cases, "authUsersCreated": 0,
              "databaseActions": 0, "nativeClaims": 0, "independentOracle": "PYTHON_FRACTION_ORIGINAL_ENVELOPES_NOT_SHARED_DAG"}
    save(destination / "generation.json", report)
    print(canonical({"status": "FROZEN", "cases": len(cases), "legacyBytes": [row["compactLegacyBytes"] for row in byte_examples]}))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise ValueError("ABSOLUTE_FRESH_PUBLIC_INPUT_DIRECTORY_REQUIRED")
    generate(Path(sys.argv[1]))
