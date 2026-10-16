"""Independent development oracle over original enrolled/signed source bytes.
No product classifications, normalizers, generated expectations or floats are imported.
This is not an S8 blind trial or a field economic estimate.
"""
import base64
import hashlib
import json
import sys
from datetime import datetime
from fractions import Fraction
from cryptography.hazmat.primitives.serialization import load_pem_public_key


def canonical(x):
    return json.dumps(x, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def digest(x):
    return hashlib.sha256(canonical(x)).hexdigest()


def timestamp(x):
    return datetime.fromisoformat(x.replace("Z", "+00:00"))


def quantity(x):
    if not isinstance(x, str) or not x.isdecimal() or str(int(x)) != x:
        raise ValueError("Noncanonical original quantity")
    return int(x)


def reconstruct(x):
    m, issuers, profiles = x["mandate"], {i["id"]: i for i in x["issuers"]}, x["profiles"]
    now = timestamp(x["knowledgeAt"])
    groups, authenticated = {}, []
    roles = {"IDENTITY_CONFIRMED": "IDENTITY", "PROFESSIONAL_DETERMINATION": "PROFESSIONAL",
             "CONDITION_OBSERVED": "CONDITION", "FUNDING_OBSERVATION": "SETTLEMENT"}
    for event in x["events"]:
        b = event["body"]
        i = issuers[b["issuerId"]]
        load_pem_public_key(i["publicKey"].encode()).verify(base64.b64decode(event["signature"], validate=True), canonical(b))
        if i["revoked"] or b["issuerRevision"] != i["revision"] or roles.get(b["kind"], "PROVIDER") not in i["purposes"]:
            continue
        if b["tenantId"] != m["tenantId"] or b["programmeId"] != m["programmeId"]:
            raise ValueError("Original event scope differs")
        if timestamp(b["observedAt"]) > now:
            raise ValueError("Future evidence")
        authenticated.append(b["eventId"])
        groups.setdefault((b["providerEntityId"], b["instrument"], b["commitmentIdentity"]), []).append(b)
    states = []
    for key, history in groups.items():
        history.sort(key=lambda b: (timestamp(b["observedAt"]), b["sequence"], b["eventId"]))
        originals = [b for b in history if b.get("terms")]
        if not originals:
            continue
        last, t = originals[-1], originals[-1]["terms"]
        td = digest(t)
        if last["termsDigest"] != td or t["amount"]["legalEntityId"] != m["legalEntityId"]:
            raise ValueError("Original exact terms differ")
        face = quantity(t["amount"]["amountMinor"])
        profile = next(p for p in profiles if p["instrument"] == key[1])
        identities = [b for b in history if b["kind"] == "IDENTITY_CONFIRMED" and b["issuerId"] in profile["identityIssuerIds"]]
        executed = [b for b in history if b["kind"] == "COMMITMENT_EXECUTED" and b["termsDigest"] == td]
        determined = [b for b in history if b["kind"] == "PROFESSIONAL_DETERMINATION" and b["termsDigest"] == td
                      and b["issuerId"] in profile["professionalIssuerIds"]]
        withdrawn = any(b["kind"] in ("WITHDRAWAL", "REFUSAL") for b in history)
        state = "INDICATIVE" if last["kind"] == "INDICATION" else "APPROVAL_PENDING"
        conditions = []
        if withdrawn:
            state = "WITHDRAWN"
        elif timestamp(t["expiresAt"]) <= now:
            state = "EXPIRED"
        elif executed and determined and identities and identities[-1]["identity"]["providerEligible"]:
            pd = determined[-1]["determination"]
            material = sorted(c["id"] for c in t["conditions"] if c["material"])
            if material != sorted(pd["materialConditionIds"]):
                raise ValueError("Incomplete professional inventory")
            for c in t["conditions"]:
                observations = [b for b in history if b["kind"] == "CONDITION_OBSERVED" and b["condition"]["id"] == c["id"]
                                and b["issuerId"] in c["requiredIssuerIds"] and b["termsDigest"] == td]
                if c["id"] in pd["unsatisfiedConditionIds"] or c["kind"] == "DISCRETIONARY" or (
                        c["kind"] != "PROFESSIONAL" and not any(b["condition"]["satisfied"] for b in observations)):
                    conditions.append(c["id"])
            if all(pd.get(k) for k in ("executionEstablished", "issuerAuthorityEstablished", "offeringActivityEstablished", "liabilitiesComplete")):
                if pd["operativeStatus"] in ("BINDING_CONDITIONAL", "EFFECTIVE"):
                    state = "VERIFIED_CONDITIONAL" if conditions or pd["operativeStatus"] == "BINDING_CONDITIONAL" else "VERIFIED_EFFECTIVE_UNDRAWN"
        states.append({"commitmentId": ":".join(key), "state": state, "face": face, "conditions": conditions,
                       "instrument": t["instrument"], "terms": t})
    conditional = sum(s["face"] for s in states if s["state"] == "VERIFIED_CONDITIONAL")
    indicative = sum(s["face"] for s in states if s["state"] == "INDICATIVE" and s["instrument"] != "CORPORATE_DEBT")
    # Receiving evidence requires an actual exact owner origin, not a supplied
    # record write or a provider assertion. The local baseline has no such origin.
    received = 0
    for b in (e["body"] for e in x["events"]):
        if b["kind"] == "FUNDING_OBSERVATION" and not any(d["effectId"] == b["funding"]["originalDrawEffectId"] and d["exactOwnerBinding"] for d in x["draws"]):
            raise ValueError("Unbound alleged funding")
    # Independently reconstruct the whole authenticated dependency graph. The
    # Python oracle imports no producer/checker graph or classification result.
    graph = {s["commitmentId"]: set(d for c in s["terms"]["conditions"] for d in c["dependencyCommitmentIds"])
             for s in states}
    visited, active = set(), set()

    def has_cycle(node):
        if node in active:
            return True
        if node in visited:
            return False
        active.add(node)
        cyclic = any(has_cycle(child) for child in graph[node] if child in graph)
        active.remove(node)
        visited.add(node)
        return cyclic

    circular = any(has_cycle(node) for node in graph)
    return {"conditionalCommittedMinor": str(conditional), "indicativeEquityMinor": str(indicative),
            "fundingReceivedMinor": str(received), "requirementMinor": m["requirement"]["amountMinor"],
            "readiness": "INCOMPLETE", "authenticatedEventIds": authenticated, "states": states,
            "qualification": "DEVELOPMENT_ORIGINAL_SOURCE_ORACLE_NOT_BLIND_ADMISSION",
            "circularFinancingDetected": circular,
            "ownerShare": str(Fraction(int(m["requirement"]["ownerShare"]["numerator"]), int(m["requirement"]["ownerShare"]["denominator"])))}


print(json.dumps(reconstruct(json.load(sys.stdin)), sort_keys=True))
