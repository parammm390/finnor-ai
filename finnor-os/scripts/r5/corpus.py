"""Authored bounded original inputs, not owner/admission/consent receipts."""
import copy
import hashlib
import json


def ref(owner, name):
    return dict(owner=owner, id="authored-" + name, version="authored-model-v1",
                contentDigest=hashlib.sha256(name.encode()).hexdigest())


def joint(parties=8):
    ids = ["party-" + str(i) for i in range(parties)]
    worlds = ["downside", "upside"]
    zero, one = {"compute": ["0", "0"]}, {"compute": ["1", "0"]}
    operator = dict(id="joint-investment", operationRef=ref("P1", "joint-investment"),
                    modelRef=ref("S3", "finite-joint-response"), kind="INTERVENE",
                    eligibleParties=ids, requiredParties=[], minMembers=1,
                    maxMembers=8, termChoices=[{}], grantChoices=[zero, one],
                    equations=[], costs=[], requiresAfter=[], exclusiveItems=[],
                    consentRequired=ids)
    for party in ids:
        member = dict(kind="MEMBER", partyId=party)
        grant = dict(kind="GRANT", resourceId="compute", date=0)
        terms = [dict(coefficientId="return", feature=dict(kind="PRODUCT", left=member, right=grant))]
        for other in ids:
            if other != party:
                terms.append(dict(coefficientId="pair-share",
                                  feature=dict(kind="PRODUCT",
                                               left=dict(kind="MEMBER_PAIR", parties=[party, other]),
                                               right=grant)))
        operator["equations"].append(dict(itemId="owner-cash-" + party,
                                          ownerPartyId=party, kind="CASH",
                                          unit="USD", currency="USD", date=1, terms=terms))
        operator["costs"].append(dict(itemId="coordination-cost-" + party,
                                     ownerPartyId=party, kind="CASH", unit="USD",
                                     currency="USD", date=0,
                                     terms=[dict(coefficientId="complete-cost", feature=member)]))
    wait = dict(id="independent-wait", operationRef=ref("P1", "independent-wait"),
                modelRef=ref("S3", "finite-joint-response"), kind="WAIT",
                eligibleParties=ids, requiredParties=[], minMembers=1, maxMembers=8,
                termChoices=[{}], grantChoices=[zero], equations=[], costs=[],
                requiresAfter=[], exclusiveItems=[], consentRequired=[])
    return dict(schema="finnor.r5.original.v1", version="r5-joint-coalition-rational-v1",
                profile="EIGHT_PARTIES_FINITE_JOINT_GRAMMAR_OBSERVABLE_DIVISION",
                parties=[dict(id=party, partyRef=ref("S1", party),
                              rightsRef=ref("S1", party + "-rights"),
                              outsideOptionRef=ref("S3", party + "-outside"),
                              fundingRef=ref("S5", party + "-cash"),
                              requiredConsentRef=ref("S6", party + "-consent"),
                              outsideOptions={world: "0" for world in worlds},
                              settledCash={world: ["100", "100"] for world in worlds},
                              ownerObjectiveWeight="1") for party in ids],
                worlds=[dict(id=world,
                             coefficients={"return": value, "pair-share": "1/2",
                                           "complete-cost": "1"},
                             eventTokens={"settlement": "observed"})
                        for world, value in zip(worlds, ["5", "15"])],
                dates=["2030-01-01T00:00:00.000Z", "2030-01-02T00:00:00.000Z"],
                unit="USD", currency="USD", valuationDate="2030-01-01T00:00:00.000Z",
                discountFactors=["1", "1"],
                events=[dict(id="settlement", eventRef=ref("S6", "observable-settlement"),
                             availableDate=1, tokens=["observed"])],
                transfers=[dict(eventId="settlement", token="observed", date=1,
                                operationRef=ref("S6", "proposed-observable-transfer"),
                                bounds={party: ["-100", "100"] for party in ids})],
                grammar=dict(ref=ref("P1", "complete-finite-grammar"),
                             operators=[wait, operator], maxSteps=1,
                             admittedCoalitions="ALL_ELIGIBLE_NONEMPTY_SUBSETS"),
                model=dict(ref=ref("S3", "finite-joint-response"),
                           qualification="SUPPLIED_FINITE_MODEL_UNADMITTED",
                           noStrategicSpillover="SUPPLIED_NO_CROSS_COALITION_SPILLOVER",
                           omittedMechanisms=[]),
                objective=dict(kind="ROBUST", mandateRef=ref("S4", "original-joint-objective")),
                resources=[dict(id="compute", sourceRef=ref("S5", "original-compute"),
                                unit="native-attempt",
                                available={world: ["4", "4"] for world in worlds},
                                kind="CUMULATIVE_EXPENDITURE")],
                obligationsRef=ref("S6", "original-known-obligations"),
                owner=dict(tenantId="authored-private-tenant", principalId="authored-principal",
                           workId="authored-existing-work", workRevision="authored-input-v1",
                           originalEpisodeId="authored-original-episode",
                           originalBudgetGrantRef=ref("S5", "original-search-grant"),
                           originalDeadline="2030-01-01T01:00:00.000Z", dependencies=[]),
                limits=dict(maxProgrammeOptions=10000, maxEncodingBytes=8388608,
                            native=dict(maxPaths=50000, maxHistories=50000,
                                        maxVariables=100000, maxRows=300000,
                                        maxProofBytes=8388608, cpuMs=30000,
                                        memoryMiB=2048, maxNativeCalls=128)))


def cases():
    yield "eight-complete", joint(), {"partitions": 4140, "optimum": "60"}
    yield "small-two", joint(2), {"partitions": 2, "optimum": "9"}
    yield "small-three", joint(3), {"partitions": 5, "optimum": "15"}
    outside = joint(3)
    outside["parties"][-1]["outsideOptions"] = {"downside": "10", "upside": "10"}
    yield "nonzero-outside", outside, {"partitions": 5, "optimum": "15"}
    unwilling = joint(3)
    unwilling["parties"][-1]["outsideOptions"] = {"downside": "1000", "upside": "1000"}
    yield "unwilling", unwilling, {"partitions": 5, "infeasible": True}
    costs = joint(3)
    for world in costs["worlds"]:
        world["coefficients"]["complete-cost"] = "100"
    yield "negative-after-cost", costs, {"partitions": 5, "optimum": "0"}


if __name__ == "__main__":
    print(json.dumps([dict(id=name, original=p, expected=expected)
                      for name, p, expected in cases()], sort_keys=True))
