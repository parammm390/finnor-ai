"""Repeatable offline archive E2E, not authenticated owner qualification."""
import argparse
from contextlib import ExitStack
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import runpy
import shutil
import sys
import tarfile

parser = argparse.ArgumentParser()
for name in ("repository", "target", "delivery", "evidence"):
    parser.add_argument("--" + name, type=Path, required=True)
a = parser.parse_args()
assert all(p.is_absolute() for p in vars(a).values())
assert a.evidence.is_relative_to(a.repository / "scope-z/phase-evidence/z4")
os.umask(0o077)
E = runpy.run_path(str(a.repository / "finnor-os/scripts/project-z/z4/engineering.py"))
run = E["Run"](a, "finnor.z4.actual-archive-relocation.v1")
temporary = a.evidence / "temporary-extracted"
harness = a.evidence / "temporary-entry.mts"
good, failure = False, None
run.report.update(authenticatedSourceOwner="NOT_RUN", authenticatedInstalledOwner="NOT_RUN",
                  protectedAdmission="NOT_RUN", financialQualification="NOT_RUN",
                  extractionScope="FULL_DECLARED_INSTALLED_ARCHIVE_NOT_AUTHENTICATED_API_BROWSER",
                  nodeMaxOldSpaceMiB=1024, networkActionsRequested=0)


def command(name, argv, cwd, env, timeout=300, expected=0):
    run.command(name, argv, cwd, env, timeout)
    assert run.report["steps"][-1]["exit"] == expected, name
    return (a.evidence / (name + ".log")).read_text()


try:
    with E["LOCK"].open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        delivery = json.loads((a.delivery / "report.json").read_text())
        assert delivery["status"] == "PACKAGED_ENGINEERING_ONLY_AWAITING_COORDINATOR"
        archive = a.delivery / delivery["installedArchive"]["path"]
        assert E["sha"](archive) == delivery["installedArchive"]["sha256"]
        entries = json.loads((a.delivery / "installed-manifest.json").read_text())
        declared = {entry["path"]: entry for entry in entries}
        assert len(declared) == len(entries)
        env = E["environment"](a.target)
        env["NODE_OPTIONS"] = "--max-old-space-size=1024 --import=" + str(
            a.target / "finnor-os/scripts/project-z/z4/isolation-loader.mjs")
        node = a.target / ".z4-toolchains/node/bin/node"
        identity_module = a.target / "finnor-os/packages/private-equity/src/project-z/z4-execution-proof/identity.ts"
        selector = "import {sourceIdentity} from " + json.dumps(str(identity_module)) + \
                   ";console.log(JSON.stringify(await sourceIdentity()));"
        identity = json.loads(command("installed-source-selection", [
            node, "--import", "tsx", "--input-type=module", "--eval", selector],
            a.target / "finnor-os", env))
        required = {entry["path"] for entry in E["R"]["owned_inventory"](a.target)}
        required |= {entry["path"] for entry in identity["files"]}
        required |= {E["NATIVE"] + "/bin/z4-proof", E["NATIVE"] + "/bin/z4-field-falsifier",
                     ".z4-toolchains/node/bin/node", "z4-reconstruction-source.json",
                     "scope-z/phase-evidence/z4/installed-provenance.json"}
        selected = set(declared)
        assert required <= selected
        logical_bytes = sum(entry.get("bytes", 0) for entry in entries)
        free_bytes, reserve = shutil.disk_usage(a.evidence).free, 512 * 1024**2
        run.report.update(extractionRequiredBytes=logical_bytes, extractionReserveBytes=reserve,
                          extractionFreeBytesBefore=free_bytes)
        assert free_bytes >= logical_bytes + reserve, "Z4_FULL_ARCHIVE_EXTRACTION_DISK_GUARD"
        with tarfile.open(archive, "r:gz") as tar:
            headers = tar.getmembers()
        header = {item.name: item for item in headers}
        order = {item.name: i for i, item in enumerate(headers)}
        assert len(header) == len(headers) == len(declared) and set(header) == set(declared)
        for name, item in header.items():
            entry = declared[name]
            assert not name.startswith("/") and ".." not in PurePosixPath(name).parts
            assert (item.uid, item.gid, item.mtime, item.uname, item.gname) == (0, 0, 0, "", "")
            expected_mode = 0o700 if entry["kind"] == "symlink" else 0o500 if entry["executable"] else 0o400
            assert item.mode == expected_mode
            if entry["kind"] == "symlink":
                assert item.issym() and item.linkname == entry["target"]
            else:
                assert item.isfile() or item.islnk()
                if item.isfile():
                    assert item.size == entry["bytes"]
        destinations = {}
        for name in sorted(selected):
            if declared[name]["kind"] == "symlink":
                continue
            root, seen = name, set()
            while header[root].islnk():
                assert root not in seen
                seen.add(root)
                previous = header[root].linkname
                assert previous in header and order[previous] < order[root]
                assert declared[previous]["kind"] == "file"
                assert all(declared[previous][key] == declared[name][key]
                           for key in ("sha256", "bytes", "executable"))
                root = previous
            assert header[root].isfile()
            destinations.setdefault(root, []).append(name)
        temporary.mkdir(mode=0o700)
        extracted = set()
        with tarfile.open(archive, "r|gz") as tar:
            for item in tar:
                if item.name not in destinations:
                    continue
                names = destinations[item.name]
                with ExitStack() as stack:
                    outputs = []
                    for name in names:
                        path = temporary / name
                        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                        outputs.append(stack.enter_context(path.open("xb")))
                    source = stack.enter_context(tar.extractfile(item))
                    while chunk := source.read(1024 * 1024):
                        for output in outputs:
                            output.write(chunk)
                for name in names:
                    path, entry = temporary / name, declared[name]
                    assert path.stat().st_size == entry["bytes"] and E["sha"](path) == entry["sha256"]
                    os.chmod(path, 0o500 if entry["executable"] else 0o400)
                    extracted.add(name)
        for name in sorted(selected):
            entry = declared[name]
            if entry["kind"] == "symlink":
                path = temporary / name
                path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                path.symlink_to(entry["target"])
                assert path.resolve().is_relative_to(temporary)
                extracted.add(name)
        assert extracted == selected
        E["save"](a.evidence / "selected-archive-members.json", [declared[name] for name in sorted(selected)])
        inputs_file = a.repository / "scope-z/phase-evidence/z4/archive-relocation-inputs-02.json"
        inputs = json.loads(inputs_file.read_text())
        run.report.update(publicInputsSha256=E["sha"](inputs_file), checkerContract="NO_ORIGINAL_EXECUTION_REPLAY_V2")
        inputs.update(sourceDigest=identity["digest"], sourceCommit=delivery["sourceCommit"],
                      sourceTree=delivery["sourceTree"], nativeBinarySha256=identity["native"]["binarySha256"])
        runtime = temporary / "finnor-os/.z4-relocation"
        runtime.mkdir(mode=0o700)
        E["save"](runtime / "inputs.json", inputs)
        core = a.target / "finnor-os/packages/epistemic-runtime/src/project-z/z4-execution-proof"
        body = """
import {readFile} from 'node:fs/promises';
import {canonical,sha,validateRequest} from CORE_CONTRACTS;
import {produceExecutionProof,checkExecutionProof} from CORE_ENGINE;
import {runNative} from CORE_NATIVE;
import {codeIdentity} from PURE_IDENTITY;
const root=globalThis[Symbol.for('finnor.z4.declared-runtime-root')];
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
const identity=await codeIdentity();
if(identity.digest!==input.sourceDigest||identity.sourceCommit!==input.sourceCommit||
 identity.sourceTree!==input.sourceTree||identity.native.binarySha256!==input.nativeBinarySha256||
 identity.basis!=='DECLARED_ARCHIVE_IDENTITY_WITH_CURRENT_SOURCE_VERIFICATION_NOT_GIT_OBSERVATION')
 throw Error('Z4_RELOCATED_IDENTITY_MISMATCH');
const frozenBody=await readFile(root+'/scope-z/phase-evidence/z4/public-cases.pre-code.json');
if(sha(frozenBody)!==input.registeredFixtureSha256)throw Error('Z4_RELOCATED_FIXTURE_MISMATCH');
const frozen=JSON.parse(frozenBody.toString()).cases.find(c=>c.id===input.registeredCaseId);
const limits=()=>({deadlineAt:new Date(Date.now()+300000).toISOString(),maxMemoryBytes:2*1024**3,cpuSeconds:180});
const rows=[];
let fresh;
for(const [name,request,expected] of [
 ['registered-public',{...frozen.request,binding:'0'.repeat(64)},frozen.expectedFinal],
 ['new-public-runtime-definition',input.freshRuntimeDefinition,input.freshExpectedFinal]]){
 const r=validateRequest(request),produced=await produceExecutionProof(r,limits());
 const candidate={statement:produced.statement,artifact:produced.artifact};
 const audit=await checkExecutionProof(r,candidate,limits());
 if(canonical(audit.statement.finalState)!==canonical(expected)||audit.originalExecutionReplayed!==false||
  audit.verifier.data.status!=='VERIFIED_COMPUTATION_ONLY'||audit.executionAuthorityGranted!==false)
  throw Error('Z4_RELOCATED_EXPECTED_VALUE_FAILED');
 rows.push({name,expected,request:r,candidate,verifier:audit.verifier.data,
  processes:[...produced.processes,...audit.processes].map(({data,...receipt})=>receipt)});
 if(name==='new-public-runtime-definition')fresh={request:r,candidate};
}
const negatives=[];
for(const [name,predicate,action] of [
 ['wrong-initial','Z4_CRYPTOGRAPHIC_VERIFIER_REJECTED',async()=>{
   const c=structuredClone(fresh.candidate);c.statement.initial[0]='6';await runNative('verify',c,limits());}],
 ['wrong-output','Z4_PUBLIC_OUTPUT_OR_COMMITMENT_MISMATCH',async()=>{
   const c=structuredClone(fresh.candidate);c.statement.finalState[0]='619';await checkExecutionProof(fresh.request,c,limits());}]]){
 let observed;
 try{await action();}catch(e){observed=e.message;}
 if(observed!==predicate)throw Error('Z4_RELOCATED_WRONG_NEGATIVE:'+name+':'+observed);
 negatives.push({name,predicate,observed});
}
console.log(JSON.stringify({schema:'finnor.z4.relocated-mechanism.v1',status:'PASSED_OFFLINE_ARCHIVE_MECHANISM_ONLY',
 identity,rows,negatives,authenticatedNativeOwner:'NOT_RUN',protectedAdmission:'NOT_RUN',eligibleReuseN:0}));
"""
        for placeholder, path in [("CORE_CONTRACTS", core / "contracts.ts"), ("CORE_ENGINE", core / "engine.ts"),
                                  ("CORE_NATIVE", core / "native.ts"), ("PURE_IDENTITY", identity_module)]:
            body = body.replace(placeholder, json.dumps(str(path)))
        harness.write_text(body)
        run.report.update(harnessSource=body, harnessSha256=E["sha"](harness))
        bundle = runtime / "entry.mjs"
        command("bundle-installed-kernel", [
            node, a.target / "finnor-os/node_modules/esbuild/bin/esbuild", harness,
            "--bundle", "--format=esm", "--platform=node", "--packages=external",
            "--outfile=" + str(bundle), "--metafile=" + str(a.evidence / "bundle-metafile.json")],
            a.target / "finnor-os", env)
        meta = json.loads((a.evidence / "bundle-metafile.json").read_text())
        for name in meta["inputs"]:
            path = (a.target / "finnor-os" / name).resolve()
            if path == harness:
                continue
            assert path.is_relative_to(a.target)
            assert E["sha"](path) == declared[str(path.relative_to(a.target))]["sha256"]
        home = temporary / ".z4-offline-home"
        (home / "tmp").mkdir(mode=0o700, parents=True)
        relocated_env = {key: value for key, value in env.items()
                         if key not in ("PATH", "HOME", "TMPDIR", "NODE_OPTIONS")
                         and not key.startswith("npm_config_")}
        relocated_env.update(PATH=str(temporary / ".z4-toolchains/node/bin") + ":/usr/bin:/bin",
                             HOME=str(home), TMPDIR=str(home / "tmp"),
                             NODE_OPTIONS="--max-old-space-size=1024 --import=" + str(
                                 temporary / "finnor-os/scripts/project-z/z4/isolation-loader.mjs"))
        relocated_node = temporary / ".z4-toolchains/node/bin/node"
        observed = json.loads(command("relocated-real-proofs", [
            relocated_node, bundle, runtime / "inputs.json"], temporary / "finnor-os", relocated_env))
        assert observed["status"] == "PASSED_OFFLINE_ARCHIVE_MECHANISM_ONLY"
        probe = ("try{await import(" + json.dumps(str(core / "engine.ts")) +
                 ");throw Error('Z4_FALLBACK_ACCEPTED');}catch(e){if(e.message!=="
                 "'Z4_EXTERNAL_MODULE_FALLBACK_REFUSED')throw e;console.log(e.message);}")
        assert command("original-checkout-import-denied", [
            relocated_node, "--input-type=module", "--eval", probe],
            temporary / "finnor-os", relocated_env).strip() == "Z4_EXTERNAL_MODULE_FALLBACK_REFUSED"
        command("extracted-missing-authority", [
            relocated_node, "--import", "tsx", "scripts/project-z/z4/native-e2e.mts",
            "--repository", temporary, "--evidence", a.evidence / "missing-authority"],
            temporary / "finnor-os", relocated_env, expected=78)
        guard = json.loads((a.evidence / "missing-authority/replay-guard.json").read_text())
        assert guard["code"] == "Z4_REPLAY_AUTHORITY_MANIFEST_REQUIRED"
        assert all(guard[key] == 0 for key in ("authCallsAttempted", "databaseCallsAttempted", "networkCallsAttempted"))
        assert guard["guardsPassedMarkerWritten"] is False
        no_replay_input = a.repository / "scope-z/phase-evidence/z4/no-replay-inputs-01.json"
        command("extracted-no-replay-proof-checker", [
            relocated_node, "--import", "tsx", "--import",
            temporary / "finnor-os/scripts/project-z/z4/no-replay-fault-loader.mjs",
            temporary / "finnor-os/scripts/project-z/z4/no-replay-e2e.mts",
            "--input", no_replay_input, "--evidence", a.evidence / "no-replay"],
            temporary / "finnor-os", relocated_env)
        no_replay = json.loads((a.evidence / "no-replay/report.json").read_text())
        assert no_replay["status"] == "PASSED_NO_REPLAY_NATIVE_PROOF_E2E_ONLY"
        assert no_replay["originalVmCallsDuringVerification"] == 0
        assert len(no_replay["rows"]) == 8
        command("extracted-critical-falsifiers", [
            relocated_node, "--import", "tsx", "scripts/project-z/z4/critical-falsifiers.mts",
            "--evidence", a.evidence / "critical-falsifiers"],
            temporary / "finnor-os", relocated_env, timeout=600)
        critical = json.loads((a.evidence / "critical-falsifiers/report.json").read_text())
        assert critical["status"] == "PASSED_OFFLINE_CRITICAL_FALSIFIERS_ONLY"
        assert len(critical["rows"]) == 48 and all(row["status"].startswith("PASSED") for row in critical["rows"])
        command("extracted-physical-process-control", [
            relocated_node, "--import", "tsx", "scripts/project-z/z4/process-control.mts",
            "--repository", temporary, "--evidence", a.evidence / "process-control"],
            temporary / "finnor-os", relocated_env)
        for name in selected:
            path, entry = temporary / name, declared[name]
            if entry["kind"] == "symlink":
                assert path.is_symlink() and os.readlink(path) == entry["target"]
            else:
                assert not path.is_symlink() and E["sha"](path) == entry["sha256"]
        run.report.update(installedArchiveSha256=E["sha"](archive),
                          normalizedDeclaredHeaders=len(headers), extractedMembers=len(selected),
                          extractedBytes=sum(declared[name].get("bytes", 0) for name in selected),
                          sourceDigest=identity["digest"], sourceCommit=delivery["sourceCommit"],
                          sourceTree=delivery["sourceTree"], compiledEntrySha256=E["sha"](bundle),
                          harnessSource=body, harnessSha256=E["sha"](harness),
                          positiveCases=2, negativeCases=2, originalCheckoutImport="REFUSED",
                          missingAuthorityExit=78, missingAuthorityGuard=guard,
                          noReplayInputSha256=E["sha"](no_replay_input), noReplayCases=8,
                          originalVmCallsDuringVerification=0,
                          repeatedCriticalCases=48, fullDeclaredBytesUnchangedAfterReplay=True,
                          offlinePhysicalProcessControl="EXIT_0_NOT_DURABLE_OWNER_RECOVERY")
        good = True
except Exception as error:
    failure = str(error)
    run.report["failure"] = failure
finally:
    cleanup = []
    if temporary.is_dir():
        for path in sorted(temporary.rglob("*")):
            if path.is_symlink():
                cleanup.append({"path": str(path.relative_to(temporary)), "symlink": os.readlink(path)})
            elif path.is_file():
                cleanup.append({"path": str(path.relative_to(temporary)), "sha256": E["sha"](path),
                                "bytes": path.stat().st_size})
        E["save"](a.evidence / "temporary-extraction-cleanup.json", cleanup)
        for entry in cleanup:
            path = temporary / entry["path"]
            if "symlink" in entry:
                assert path.is_symlink() and os.readlink(path) == entry["symlink"]
            else:
                assert not path.is_symlink() and E["sha"](path) == entry["sha256"]
            path.unlink()
        for path in sorted(temporary.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            assert path.is_dir() and not path.is_symlink()
            path.rmdir()
        temporary.rmdir()
    if harness.is_file():
        run.report["removedTemporaryHarnessSha256"] = E["sha"](harness)
        harness.unlink()
    run.report["temporaryFilesRemoved"] = not temporary.exists() and not harness.exists()
sys.exit(run.finish("PASSED_ACTUAL_FULL_ARCHIVE_OFFLINE_RELOCATION_ONLY" if good else "FAILED_ARCHIVE_RELOCATION"))
