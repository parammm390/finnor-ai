"""Validate actual case/source-bound engineering observations, not PASS labels."""
import hashlib
import json
from pathlib import Path

ASSETS = "finnor-os/packages/private-equity/src/confidential-computation/"
GATES = {"installed-lifecycle", "canonical-recovery-and-fresh-authorization",
         "unrelated-effect-preservation", "finite-numerical-binding-release",
         "adverse-and-custody", "offline-reconstruction", "independent-review", "types-and-boundary"}
PYTHON = ("compiler.py", "correspondence.py", "secure_runtime.py", "backend.py",
          "public_driver.py", "participant.py", "profile.json", "backend-identity.json")
PRODUCT_DRIVERS = {"product-episode.mts", "product-lifecycle.mts", "product-transport.mts",
                   "environment.mts", "installation.mts", "browser-episode.mts", "owner-episode.mts",
                   "s8-episode.mts", "recovery-episode.mts", "effect-episode.mts",
                   "owner-adversarial-episode.mts", "browser-e2e.ts", "product-e2e.ts"}
COMMON_STAGES = {"migration-upgrade-replay", "ordinary-role-durable-guards", "original-owner-preparation",
                 "opaque-source-authority", "ordinary-read-only-workforce", "original-intake-selected-plan",
                 "durable-queue-independent-compilation", "participant-local-consent-and-commitments"}
LIFECYCLE_STAGES = COMMON_STAGES | {"mounted-world-original-state", "installed-native-mpc", "recipient-release",
    "actual-upstream-owner-context", "actual-recipient-s4-s5-s6-continuation",
    "recipient-release-and-native-consumer", "canonical-work-completion", "mounted-recipient-scope-and-reload",
    "actual-typed-s8-construction-review", "revocation-and-recipient-derivative-fence",
    "native-owner-and-s8-revocation-fences", "mounted-revocation-fence"}
GATE_REFUSAL_CASES = {
    "wrong-product-case": "EXACT_EXECUTED_PRODUCT_CASE_REQUIRED",
    "stale-product-driver": "EXECUTED_PRODUCT_DRIVER_CUT_CHANGED",
    "incomplete-product-stages": "COMPLETE_PRODUCT_STAGES_REQUIRED",
    "missing-protocol-fault": "ALL_ACTUAL_FAULT_BOUNDARIES_REQUIRED",
    "duplicate-gate": "ALL_DISTINCT_CURRENT_ENGINEERING_GATES_REQUIRED",
    "duplicate-observation-role": "DISTINCT_PINNED_OBSERVATIONS_REQUIRED",
    "open-individual-review": "ACTUAL_REVIEWER_UNRESOLVED_FINDINGS_REFUSE_COMPLETION",
    "nonpassing-individual-review": "ACTUAL_REVIEWER_UNRESOLVED_FINDINGS_REFUSE_COMPLETION",
    "stale-reconstructed-source": "ACTUAL_CURRENT_OFFLINE_RECONSTRUCTION_REQUIRED",
}


def sha(body):
    return hashlib.sha256(body).hexdigest()


def require(condition, predicate):
    if not condition:
        raise ValueError(predicate)


def code_sources(sources):
    return {name: sha(body) for name, body in sources.items()
            if not name.startswith("scope-postx/") and Path(name).suffix != ".md"}


def validate_engineering_gates(index, evidence, sources, review, review_sha, installed, installation_sha):
    actual = {g["id"]: g for g in index.get("gates", [])}
    require(index.get("status") == "PASS" and len(actual) == len(index.get("gates", []))
            and set(actual) == GATES and index.get("sourceReviewManifestSha256") == review_sha,
            "ALL_DISTINCT_CURRENT_ENGINEERING_GATES_REQUIRED")
    current = code_sources(sources)
    runtime = {name: digest for name, digest in current.items()
               if name.startswith(("finnor-os/packages/", "finnor-os/apps/", "src/"))
               or name == "finnor-os/scripts/s5/owner-fixture.mts"}
    installed_sources = {f["path"].removeprefix("runtime/"): f["sha256"] for f in installed["files"]
                         if f["kind"] == "source"}
    require(all(installed_sources.get(name) == digest for name, digest in runtime.items()),
            "CURRENT_REVIEWED_RUNTIME_NOT_INSTALLED")
    python = {name: current[ASSETS+name] for name in PYTHON}
    entrypoints = {f["path"]: f["sha256"] for f in installed["files"] if f["path"].startswith("runtime/y4-runtime/")}
    require(bool(entrypoints), "ACTUAL_INSTALLED_ENTRYPOINTS_REQUIRED")

    def product(value, case, stages, expected_installation=installation_sha):
        require(value.get("schema") == "finnor.y4.product-e2e.v1" and value.get("case") == case
                and value.get("status") == "PASS", "EXACT_EXECUTED_PRODUCT_CASE_REQUIRED")
        rows = {r["id"]: r for r in value.get("results", [])}
        require(len(rows) == len(value.get("results", [])) and (stages | COMMON_STAGES).issubset(rows)
                and all(r["status"] == "PASS" for r in rows.values()), "COMPLETE_PRODUCT_STAGES_REQUIRED")
        require(rows["original-owner-preparation"]["observed"]["installationDigest"] == expected_installation,
                "EXECUTED_PRODUCT_INSTALLATION_CHANGED")
        drivers = {f["path"]: f["sha256"] for f in value.get("driverInputs", [])}
        require(set(drivers) == {"finnor-os/scripts/y4/"+n for n in PRODUCT_DRIVERS}
                and all(current.get(n) == h for n, h in drivers.items()),
                "EXECUTED_PRODUCT_DRIVER_CUT_CHANGED")
        return rows

    def browser(value, rows):
        require(value.get("schema") == "finnor.y4.mounted-browser.v1" and value.get("status") == "PASS"
                and value.get("authBypass") is False and value.get("mockedApiBodies") is False
                and value.get("revocationCleared") is True and value.get("offlineCleared") is True
                and value.get("nonrecipientHidden") is True and value.get("principalABAFreshRead") is True
                and value.get("delayedPriorPrincipalResponseDiscarded") is True
                and value["screenshot"] == rows["mounted-revocation-fence"]["observed"]["screenshot"],
                "ACTUAL_CURRENT_BROWSER_REQUIRED")
        cut = {item["path"]: item.get("sha256") for item in value.get("sourceCut", [])}
        frontend = {n: h for n, h in current.items() if n.startswith("src/")}
        require(frontend and all(cut.get(n) == h for n, h in frontend.items()),
                "ACTUAL_BROWSER_SOURCE_CUT_CHANGED")

    def finite(value, case):
        require(value.get("case") == case and value.get("status") == "PASS"
                and value.get("identity") == python
                and value.get("driverSha256") == current["finnor-os/scripts/y4/engineering.py"]
                and value.get("protectedSubmission") is False, "CURRENT_FINITE_CASE_REQUIRED")
        helpers = value.get("additionalDriverInputs", {})
        required = {"reference_oracle.py"}
        if case in ("adverse", "participant-disposal"):
            required.add("fault_observer.py")
        elif case == "release":
            required.add("release_episode.py")
        require(set(helpers) == required
                and all(current.get("finnor-os/scripts/y4/"+name) == h for name, h in helpers.items()),
                "CURRENT_FINITE_HELPER_CUT_REQUIRED")

    for gate_id, gate in actual.items():
        name = gate["publicEvidenceName"]
        require(gate.get("status") == "PASS" and name in evidence and sha(evidence[name]) == gate["sha256"],
                "PASSED_PINNED_GATE_PROOF_REQUIRED")
        proof = json.loads(evidence[name])
        require(proof.get("schema") == "finnor.y4.engineering-gate-proof.v1"
                and proof.get("gateId") == gate_id and proof.get("status") == "PASS",
                "EXACT_ENGINEERING_GATE_PROOF_REQUIRED")
        observations = {}
        for item in proof.get("observations", []):
            require(item["role"] not in observations and item["name"] in evidence
                    and sha(evidence[item["name"]]) == item["sha256"], "DISTINCT_PINNED_OBSERVATIONS_REQUIRED")
            observations[item["role"]] = json.loads(evidence[item["name"]])
        o = observations
        if gate_id == "installed-lifecycle":
            rows = product(o["product"], "lifecycle", LIFECYCLE_STAGES)
            require(rows["installed-native-mpc"]["observed"]["independentNativeRebuilds"] == 3,
                    "ALL_LOCAL_NATIVE_RECONSTRUCTIONS_REQUIRED")
            owner = rows["actual-recipient-s4-s5-s6-continuation"]["observed"]
            require(owner["hiddenEffectNotTreatedAsZeroByActualS4"] is True
                    and owner["executionAuthorityGranted"] is False and owner["dispatchGranted"] is False,
                    "ACTUAL_PRIVATE_OWNER_CONTINUATION_REQUIRED")
            race_rows = product(o["ownerRace"], "owner-commit-race", {"installed-native-mpc", "recipient-release",
                "actual-upstream-owner-context", "actual-recipient-s4-s5-s6-continuation",
                "actual-native-s6-revocation-commit-race"})
            race = race_rows["actual-native-s6-revocation-commit-race"]["observed"]
            require(all(race[key] is True for key in ("actualFinalS6CommitObserved", "nativePortfolioMutexHeld",
                    "ordinaryOwnerRowBarrier", "consentRevocationCommittedFirst", "finalCommitRefused",
                    "revocationSourceMutexObserved", "revocationWaitedForOrdinaryBarrier",
                    "existingReservationsConsumptionsEffectsAndHistoryUnchanged"))
                    and race["computationId"] == race_rows["durable-queue-independent-compilation"]
                    ["observed"]["computationId"] and race["executionAuthorityGranted"] is False,
                    "ACTUAL_S6_REVOCATION_COMMIT_RACE_REQUIRED")
            browser(o["browser"], rows)
        elif gate_id == "canonical-recovery-and-fresh-authorization":
            rows = product(o["product"], "recovery", {"canonical-worker-crash-and-read-only-reconciliation",
                "fresh-installed-native-mpc", "fresh-canonical-work-completion",
                "fresh-recipient-release", "fresh-recipient-release-and-native-consumer",
                "fresh-separately-authorized-native-calculation"} |
                {"fresh-"+s for s in COMMON_STAGES - {"migration-upgrade-replay", "ordinary-role-durable-guards"}})
            require(o["canonical"]["schema"] == "finnor.y4.canonical-recovery-e2e.v1"
                    and o["canonical"]["summary"]["originalParticipantBytesUnchangedByReconciliation"] is True
                    and o["canonical"]["summary"]["physicallyStoppedNativeParties"] == 3
                    and o["fresh"]["schema"] == "finnor.y4.fresh-authorized-recovery-e2e.v1"
                    and o["fresh"]["summary"]["crashedComputationAndOriginalFailedCostsUnchanged"] is True
                    and o["canonical"]["computationId"] == rows["durable-queue-independent-compilation"]["observed"]["computationId"]
                    and o["canonical"]["summary"] == rows["canonical-worker-crash-and-read-only-reconciliation"]["observed"]
                    and o["fresh"]["summary"] == rows["fresh-separately-authorized-native-calculation"]["observed"],
                    "ORIGINAL_AND_FRESH_RESPONSIBILITY_PROOFS_REQUIRED")
        elif gate_id == "unrelated-effect-preservation":
            rows = product(o["product"], "effect-preservation", {"actual-unrelated-effect-preservation"})
            require(o["effect"]["schema"] == "finnor.y4.effect-preservation-e2e.v1"
                    and o["effect"]["summary"]["nativeEffectActionReservationConsumptionChargeHistoryUnchangedByY4"] is True
                    and o["effect"]["summary"]["actualColdS6ProtectedRecovery"] is True
                    and o["effect"]["summary"]["acceptedProviderMutationCount"] == 1
                    and o["effect"]["summary"]["duplicateMutationCount"] == 0
                    and o["effect"]["summary"] == rows["actual-unrelated-effect-preservation"]["observed"],
                    "ACTUAL_UNRELATED_EFFECT_PROOF_REQUIRED")
        elif gate_id == "finite-numerical-binding-release":
            for case in ("correspondence", "hash-conformance", "numerical", "numerical-reject", "binding", "release"):
                finite(o[case], case)
            release = o["release"]
            require(release["originalResultSha256"] == sha(next(evidence[i["name"]] for i in proof["observations"]
                    if i["role"] == "numerical")) and release["priorPrivateStateBytesUnchanged"] is True
                    and release["originalDeadlineNotRenewed"] is True and len(release["adaptivePrepareDenials"]) == 18
                    and all(d["status"] == "PASS" for d in release["adaptivePrepareDenials"]),
                    "CURRENT_CUMULATIVE_RELEASE_PROOF_REQUIRED")
        elif gate_id == "adverse-and-custody":
            finite(o["adverse"], "adverse");finite(o["disposal"], "participant-disposal")
            rows = product(o["cancellation"], "cancellation-disposal", {"bounded-all-owner-cancellation-disposal"})
            cancelled = rows["bounded-all-owner-cancellation-disposal"]["observed"]
            require(cancelled["laterOwnersAbortedBeforeFirstOwnerLockReleased"] is True
                    and cancelled["allOwnersTerminalAndSecretsAndNoncesBurned"] is True
                    and cancelled["noNativeInputDelivery"] is True
                    and cancelled["originalSessionDeadlineAndChargesRetained"] is True,
                    "ACTUAL_BOUNDED_ALL_OWNER_CANCELLATION_REQUIRED")
            require(o["adverse"]["allRegisteredFaultsCovered"] is True
                    and set(o["adverse"]["requestedFaults"]) == {"dropout", "tls", "message", "cancel"}
                    and o["disposal"]["allDisposalFaultsCovered"] is True
                    and set(o["disposal"]["requestedFaults"]) == {"verification", "setup", "budget", "output"},
                    "ALL_ACTUAL_FAULT_BOUNDARIES_REQUIRED")
            for name in ("adverse", "disposal"):
                faults = o[name]["faults"]
                require(len(faults) == 4 and {f["fault"] for f in faults} == set(o[name]["requestedFaults"])
                        and all(f["status"] == "PASS" and f["states"] == ["ABORTED"] * 3
                                and f["acceptedReleases"] == 0 for f in faults), "ALL_OBSERVED_FAULT_CASES_REQUIRED")
            require(o["custody"]["status"] == "PASS" and o["custody"]["privateStateRetainedPrivately"] is True
                    and o["custody"]["retainedBytesAndLinkTargetsMatch"] is True
                    and o["custody"]["originalCampaignSha256"] == sha(next(evidence[i["name"]]
                        for i in proof["observations"] if i["role"] == "adverse")), "ACTUAL_PRIVATE_CUSTODY_REQUIRED")
        elif gate_id == "offline-reconstruction":
            r = o["reconstruction"]
            require(r.get("status") == "PASS" and r.get("driverSha256") == current["finnor-os/scripts/y4/reconstruct.py"]
                    and r.get("fullProductCleanInstall") is True and r.get("donorWorktreeOrDependencyReads") is False
                    and all(r.get("reconstructedSourceFiles", {}).get(n) == h for n, h in runtime.items())
                    and r.get("installedEntrypointDigests") == entrypoints, "ACTUAL_CURRENT_OFFLINE_RECONSTRUCTION_REQUIRED")
            require(r.get("productResultSha256") == sha(next(evidence[i["name"]] for i in proof["observations"]
                    if i["role"] == "product")), "ACTUAL_RECONSTRUCTED_PRODUCT_RECEIPT_REQUIRED")
            rows = product(o["product"], "lifecycle", LIFECYCLE_STAGES, r["installationManifestSha256"])
            browser(o["browser"], rows)
        elif gate_id == "independent-review":
            require(o["review"]["schema"] == "finnor.y4.completed-independent-review.v1"
                    and o["review"]["status"] == "PASS" and o["review"]["codeSources"] == current
                    and set(o["review"]["roles"]) == {"reuse", "correctness", "efficiency"}
                    and o["review"]["unresolvedEngineeringFindings"] == []
                    and o["review"]["sourceReviewManifestSha256"] == review_sha,
                    "CURRENT_COMPLETE_INDEPENDENT_REVIEW_REQUIRED")
            declaration_ids = {str(d["id"]) for d in review["inventory"]["newDeclarations"]}
            compatibility_ids = {d.get("id", d["path"]+":"+str(d["line"]))
                                 for d in review["inventory"]["compatibilityCandidates"]}
            for role in ("reuse", "correctness", "efficiency"):
                report = o[role]
                require(report.get("schema") == "finnor.y4.review-dispositions.v1"
                        and report.get("role") == role and report.get("sourceManifestSha256") == review_sha,
                        "ACTUAL_CURRENT_INDEPENDENT_REVIEWER_REPORT_REQUIRED")
                require(report.get("status") == "PASS" and report.get("findings") == []
                        and report.get("result", {}).get("openFindingIds", []) == []
                        and report.get("result", {}).get("qualityFindings", 0) == 0,
                        "ACTUAL_REVIEWER_UNRESOLVED_FINDINGS_REFUSE_COMPLETION")
                require({d["path"] for d in report["fileDispositions"]} == set(sources)
                        and {str(d["id"]) for d in report["declarationDispositions"]} == declaration_ids
                        and {d["id"] for d in report["compatibilityDispositions"]} == compatibility_ids,
                        "EVERY_REVIEWED_FILE_DECLARATION_AND_COMPATIBILITY_DISPOSITION_REQUIRED")
        elif gate_id == "types-and-boundary":
            refused = o["refusals"]
            require(refused.get("schema") == "finnor.y4.gate-refusal-e2e.v1"
                    and refused.get("status") == "PASS" and refused.get("actualSealerInvocations") is True
                    and refused.get("originalEvidenceBytesUnchanged") is True
                    and refused.get("sourceReviewManifestSha256") == review_sha
                    and refused.get("driverSha256") == current["finnor-os/scripts/y4/gate-refusal-episode.py"]
                    and refused.get("sealerSha256") == current["finnor-os/scripts/y4/seal-handoff.py"]
                    and refused.get("gateValidatorSha256") == current["finnor-os/scripts/y4/engineering_gates.py"],
                    "CURRENT_ACTUAL_SEALER_REFUSAL_EPISODE_REQUIRED")
            cases = {r["id"]: r for r in refused.get("results", [])}
            require(len(cases) == len(refused.get("results", [])) and set(cases) == set(GATE_REFUSAL_CASES)
                    and all(r["status"] == "PASS" and r["exitCode"] != 0 and r["outputCreated"] is False
                            and r["observedPredicate"] == GATE_REFUSAL_CASES[name] for name, r in cases.items()),
                    "ALL_REGISTERED_ACTUAL_SEALER_REFUSALS_REQUIRED")
            v = o["validation"]
            require(v.get("schema") == "finnor.y4.validation.v1" and v.get("status") == "PASS"
                    and v.get("codeSources") == current, "CURRENT_VALIDATION_DEPENDENCY_CUT_REQUIRED")
            checks = {c["id"]: c for c in v.get("checks", [])}
            require({"backend", "episode", "browser", "domain-boundary", "python-parse", "generated-contracts"}.issubset(checks)
                    and len(checks) == len(v["checks"])
                    and all(c.get("exitCode") == 0 and c.get("publicEvidenceName") in evidence
                            and sha(evidence[c["publicEvidenceName"]]) == c["sha256"] for c in checks.values()),
                    "ALL_CURRENT_TYPES_AND_BOUNDARIES_REQUIRED")
    return {"status": "PASS", "gates": sorted(actual), "caseAndExecutedSourceBinding": True}
