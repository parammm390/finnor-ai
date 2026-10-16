import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoalitionProblem } from "../../packages/shared-types/src/coalition-programme";
import { loadR2Runtime, R2NativeSession } from "../../packages/private-equity/src/capital-program/r2-native";
import { inM3Episode } from "../../packages/private-equity/src/capital-program/v2-budget";
import { runCoalitionNativeSearch, coalitionNativeCandidate,packagedCoalitionProgramme } from "../../packages/private-equity/src/capital-program/r5-search";
import {epistemicHash} from "../../packages/epistemic-runtime/src/source-precedence";
import { encodeCoalitionMaster } from "../../packages/epistemic-runtime/src/coalition-programme-search/encoding";
import {canonicalFixture,resealCanonicalFixture} from "./canonical-fixture.mts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = process.argv[2];
if (!output || !isAbsolute(output)) throw Error("Fresh absolute private evidence directory required");
await mkdir(output, { mode: 0o700 });
const runtime = await loadR2Runtime(), started = performance.now(), results: unknown[] = [];
const corpus = spawnSync(runtime.python, [join(root, "finnor-os/scripts/r5/corpus.py")],
  { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", TZ: "UTC" } });
assert.equal(corpus.status, 0, corpus.stderr);
const cases = JSON.parse(corpus.stdout) as Array<{ id: string; original: CoalitionProblem; expected: {
  optimum?: string; infeasible?: boolean; partitions?: number; iterations?: number;
} }>;
const basis = cases.find(item => item.id === "small-two")!;
const correlated = structuredClone(basis);
correlated.id = "joint-correlated-worlds";
for (const equation of correlated.original.grammar.operators[1]!.equations)
  equation.terms[0]!.coefficientId = "return-" + equation.ownerPartyId;
correlated.original.worlds.forEach((world, index) => Object.assign(world.coefficients,
  { "return-party-0": ["1", "9"][index], "return-party-1": ["9", "1"][index] }));
cases.push(correlated);
const adverse = structuredClone(basis);
adverse.id = "adverse-world-added"; adverse.expected = { optimum: "1", iterations: 2 };
adverse.original.worlds[1]!.coefficients.return = "1";
cases.push(adverse);
const thirds = structuredClone(basis);
thirds.id = "continuous-thirds-not-a-grid";
thirds.original.transfers[0]!.bounds = { "party-0": ["1/3", "1/3"], "party-1": ["-1/3", "-1/3"] };
cases.push(thirds);
const pairs = structuredClone(cases.find(item => item.id === "small-three")!);
pairs.id = "positive-joint-multiple-coalitions";
const four = spawnSync(runtime.python, ["-c", "import sys,json;sys.path.insert(0,sys.argv[1]);from corpus import joint;print(json.dumps(joint(4)))",
  join(root, "finnor-os/scripts/r5")], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C", TZ: "UTC" } });
assert.equal(four.status, 0, four.stderr);
pairs.original = JSON.parse(four.stdout);
const pairA = pairs.original.grammar.operators[1]!;
pairA.id = "joint-pair-a"; pairA.eligibleParties = ["party-0", "party-1"]; pairA.requiredParties = [...pairA.eligibleParties];
const pairB = structuredClone(pairA);
pairB.id = "joint-pair-b"; pairB.eligibleParties = ["party-2", "party-3"]; pairB.requiredParties = [...pairB.eligibleParties];
pairs.original.grammar.operators.push(pairB);
pairs.expected = { optimum: "18", partitions: 15 };
cases.push(pairs);
const constrained = structuredClone(pairs);
constrained.id = "joint-resource-alternative-not-local-winners";
constrained.original.resources[0]!.available = { downside: ["1", "1"], upside: ["1", "1"] };
constrained.expected = { optimum: "9", partitions: 15 };
cases.push(constrained);
const canonicalEight={...structuredClone(cases.find(item=>item.id==="eight-complete")!),id:"eight-canonical-complete"};
canonicalEight.original=canonicalFixture(canonicalEight.original);cases.push(canonicalEight);
const canonicalAlternative={...structuredClone(pairs),id:"canonical-human-coupling-alternative",expected:{optimum:"9",partitions:15}};
canonicalAlternative.original=canonicalFixture(canonicalAlternative.original);
const originalCanonical=canonicalAlternative.original;
originalCanonical.controlDemand!.dimensions[0]!.occupancyResourceId="compute";
for(const operator of originalCanonical.grammar.operators)
 originalCanonical.controlDemand!.humanSecondsByOperator[operator.id]=operator.kind==="INTERVENE"?"1":"0";
originalCanonical.canonicalAllocation!.mandate.search.maxHumanSeconds=1;
originalCanonical.canonicalAllocation!.mandate.resources.couplings=[{id:"all-coalition-coupling",weights:{compute:1},maxPerPeriod:1}];
resealCanonicalFixture(originalCanonical);cases.push(canonicalAlternative);
const negativeCovenant={...structuredClone(basis),id:"canonical-negative-covenant-no-phantom-payer",expected:{optimum:"0",partitions:2}};
negativeCovenant.original=canonicalFixture(negativeCovenant.original);
negativeCovenant.original.canonicalAllocation!.resources[0]!.covenants=[{id:"original-signed-funding-covenant",
 sourceRef:negativeCovenant.original.obligationsRef,rightsRef:"owner",unit:"USD",
 terms:[{resourceId:"compute",coefficient:"10",coefficientUnit:"USD/native-attempt"},
  {resourceId:"cash-party-0",coefficient:"-1",coefficientUnit:"USD/USD"}],periods:[1],maximum:"0",safetyMargin:"0",basis:"CANONICAL_RESOURCE_USAGE"}];
resealCanonicalFixture(negativeCovenant.original);cases.push(negativeCovenant);
const canonicalThirds={...structuredClone(thirds),id:"canonical-thirds-exact-signed-division",expected:{optimum:"9",partitions:2}};
canonicalThirds.original=canonicalFixture(canonicalThirds.original);
canonicalThirds.original.transfers[0]!.bounds={"party-0":["1/3","1/3"],"party-1":["-1/3","-1/3"]};
cases.push(canonicalThirds);

const sourcePaths = [
  "finnor-os/scripts/r5/reference.py", "finnor-os/scripts/r5/canonical_allocation.py","finnor-os/scripts/r5/canonical-fixture.mts",
  "finnor-os/scripts/r5/corpus.py", "finnor-os/scripts/r5/run-native.mts",
  "finnor-os/scripts/r2/fixtures.mts",
  ...["allocation-resource-check.ts","allocation-contracts.ts","control-contracts.ts"].map(name=>"finnor-os/packages/epistemic-runtime/src/"+name),
  "finnor-os/packages/private-equity/src/capital-program/r5-search.ts",
  "finnor-os/packages/private-equity/src/capital-program/r5-tie.ts",
  "finnor-os/packages/private-equity/src/capital-program/r2-native.ts",
  "finnor-os/packages/epistemic-runtime/src/r2-encoding.ts",
  "finnor-os/packages/epistemic-runtime/src/r2-world-separation.ts",
  ...["domain.ts", "guards.ts", "programmes.ts", "encoding.ts","canonical-allocation.ts","tie.ts", "programme-child.ts","selected-programme.ts","programme.mjs", "programme-manifest.json"].map(name =>
    "finnor-os/packages/epistemic-runtime/src/coalition-programme-search/" + name),
  ...["r2_check.py", "r2_supervise.py", "r2_complete.py"].map(name => "finnor-os/packages/epistemic-runtime/python/" + name),
];
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const sourceDigests = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await readFile(join(root, path)))])));
await writeFile(join(output, "freeze.json"), JSON.stringify({
  schema: "finnor.r5.native-campaign-freeze.v1", sourceDigests, runtimeRef: runtime.ref,
  node: process.version, originalCampaignWallSeconds: 1200, perOriginalEpisodeWallMs: 30000,
  evidenceClass: "ACTUAL_P1_R2_SCIP_VIPR_INDEPENDENT_ORIGINAL_COMPONENT",
  canonicalOwners: "NOT_RUN", mounted: "NOT_RUN", installed: "NOT_RUN", protectedGain: "NOT_RUN",
  reproduce: "FINNOR_R2_RUNTIME=<pinned-runtime> FINNOR_R2_PYTHON=<verified-python> node --import ./finnor-os/node_modules/tsx/dist/loader.mjs finnor-os/scripts/r5/run-native.mts <fresh-absolute-output>",
}, null, 2) + "\n");
let failed = false;
for (const item of cases) {
  const began = performance.now(), directory = join(output, item.id);
  await mkdir(directory, { mode: 0o700 });
  const p = item.original;
  p.owner.originalEpisodeId = "authored-native-episode-" + item.id;
  p.owner.originalBudgetGrantRef.id = "authored-native-grant-" + item.id;
  p.owner.originalBudgetGrantRef.contentDigest = hash(Buffer.from(p.owner.originalBudgetGrantRef.id));
  await writeFile(join(directory, "input.json"), JSON.stringify(p, null, 2) + "\n");
  const deadline = Math.min(Date.now() + 30000, Date.parse(p.owner.originalDeadline));
  const events: unknown[] = [];
  const checkpoint = async () => {
    if (Date.now() >= deadline || performance.now() - started >= 1200000) throw Error("Original campaign/episode deadline exhausted");
  };
  const session = new R2NativeSession(runtime, directory, deadline, p.limits.native, checkpoint,
    async event => { events.push(event); }, checkpoint);
  try {
    await inM3Episode(30000, async () => {
      const result = await runCoalitionNativeSearch(p, session);
      await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2) + "\n");
      if (item.expected.infeasible) assert.equal(result.status, "INFEASIBLE");
      else {
        assert.equal(result.status, "COMPLETE", JSON.stringify(result.unresolved));
        assert.equal(result.lower, item.expected.optimum); assert.equal(result.upper, item.expected.optimum);
        assert.equal(result.gap, "0"); assert.ok(result.candidate); assert.ok(result.proofs.length);
        assert.equal(result.tie?.qualified,true);
        await session.checkCoalition(p, "candidate", { candidate: result.candidate });
        const exposed = coalitionNativeCandidate(result, session)!;
        const bound = await session.checkCoalition(p, "candidate", { candidate: exposed });
        assert.equal(bound.result.candidateDigest, hash(Buffer.from(JSON.stringify(exposed, function(_key,value){
          if(value&&typeof value==="object"&&!Array.isArray(value))return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0));
          return value;
        }))));
        // Scientific corpus fixture only, not an actual S4 owner receipt.
        const selectionRef={owner:"S4",version:p.version,id:"corpus-s4:"+epistemicHash(exposed),contentDigest:epistemicHash(exposed)};
        const packaged=await packagedCoalitionProgramme();
        const compiled=await session.executeProgramme(packaged.javascript,[{original:p,candidate:exposed,selectionRef,deadlineAt:session.deadlineAt}],1048576);
        const programmeCheck=await session.checkCoalition(p,"programme",{candidate:exposed,selectionRef,module:compiled.outputs});
        assert.equal(programmeCheck.result.programmeQualified,true);
        assert.equal(programmeCheck.result.programmeDigest,epistemicHash(compiled.outputs));
        await writeFile(join(directory,"selected-p1-programme.json"),JSON.stringify({compiled,programmeCheck,
          actualS4Receipt:false,qualification:"CORPUS_SELECTED_PREIMAGE_ONLY"},null,2)+"\n");
        if(item.id==="small-two"){
          const changed=structuredClone(compiled.outputs) as {executionAuthorityGranted:boolean};
          changed.executionAuthorityGranted=true;
          await assert.rejects(()=>session.checkCoalition(p,"programme",{candidate:exposed,selectionRef,module:changed}),
            /programme:selected-original-owner-handoff/);
        }
      }
      if (item.expected.iterations) assert.equal(result.iterations.length, item.expected.iterations);
      assert.ok(result.p1.physicalRef);
      assert.equal(result.family.partitions.length, item.expected.partitions ?? 2);
      if (item.id === "eight-complete")
        assert.equal(result.family.partitions.reduce((sum, partition) => sum + BigInt(partition.programmeCombinations), 0n), 681870n);
      if (item.id === "positive-joint-multiple-coalitions") assert.equal(result.candidate!.selected.length, 2);
      assert.equal(result.p1.authority, "NONE_OUTPUT_UNTRUSTED");
      assert.ok(session.receipts.every(receipt => receipt.physicalExitObserved));
      if (item.id === "continuous-thirds-not-a-grid")
        assert.deepEqual(result.candidate!.division[0]!.amounts, { "party-0": "1/3", "party-1": "-1/3" });
      if (item.id === "small-two") {
        const encoding = encodeCoalitionMaster(p, result.family, p.worlds.map(world => world.id));
        const shortlist = structuredClone(result.family); shortlist.options.pop();
        await assert.rejects(() => session.checkCoalition(p, "encoding", { family: shortlist, encoding }),
          /coverage:complete-original-programmes/);
        const changed = structuredClone(encoding); changed.rows[0]!.rhs = "2";
        await assert.rejects(() => session.checkCoalition(p, "encoding", { family: result.family, encoding: changed }),
          /encoding:original-row/);
        const renamedBound = structuredClone(encoding);
        renamedBound.variables.find(variable => variable.id === "t0_0")!.lower = "0";
        await assert.rejects(() => session.checkCoalition(p, "encoding", { family: result.family, encoding: renamedBound }),
          /encoding:original-variable-bounds/);
      }
      if(item.id==="canonical-negative-covenant-no-phantom-payer"){
        const encoding=encodeCoalitionMaster(p,result.family,p.worlds.map(world=>world.id));
        assert(encoding.variables.some(variable=>variable.id==="sign_t0_0"&&variable.kind==="BINARY"));
        const changed=structuredClone(encoding);changed.variables.find(variable=>variable.id==="sign_t0_0")!.upper="0";
        await assert.rejects(()=>session.checkCoalition(p,"encoding",{family:result.family,encoding:changed}),
          /encoding:original-variable-bounds/);
        const missing=structuredClone(encoding);missing.rows.pop();
        await assert.rejects(()=>session.checkCoalition(p,"encoding",{family:result.family,encoding:missing}),
          /encoding:original-row-count/);
      }
      if(item.id==="canonical-thirds-exact-signed-division"){
        assert.deepEqual(result.candidate!.division[0]!.amounts,{"party-0":"1/3","party-1":"-1/3"});
        const encoding=encodeCoalitionMaster(p,result.family,p.worlds.map(world=>world.id));
        const transfer=encoding.variables.find(variable=>variable.id==="t0_0")!;
        assert.equal(transfer.lower,"1/3");assert.equal(transfer.upper,"1/3");
        const rounded=structuredClone(encoding);
        rounded.variables.find(variable=>variable.id==="t0_0")!.lower="0.3333333333333333";
        await assert.rejects(()=>session.checkCoalition(p,"encoding",{family:result.family,encoding:rounded}),
          /encoding:original-variable-bounds/);
      }
      results.push({ id: item.id, status: "PASS", expected: item.expected,
        observed: { status: result.status, lower: result.lower, upper: result.upper, programmeOptions: result.family.options.length,
          iterations: result.iterations.length, physicalChildren: session.receipts.length,
          cpuMs: session.chargedCpuMs, sampledAggregatePeakBytes: session.aggregatePeakMemoryBytes },
        elapsedMs: performance.now() - began });
    });
  } catch (error) {
    failed = true;
    results.push({ id: item.id, status: "FAIL", message: error instanceof Error ? error.stack : String(error),
      elapsedMs: performance.now() - began });
  } finally {
    await session.cancel();
    await writeFile(join(directory, "physical-events.json"), JSON.stringify({ events, receipts: session.receipts }, null, 2) + "\n");
    await writeFile(join(output, "results.json"), JSON.stringify({ schema: "finnor.r5.native-campaign.v1",
      results, elapsedMs: performance.now() - started, canonicalOwners: "NOT_RUN", mounted: "NOT_RUN", installed: "NOT_RUN" }, null, 2) + "\n");
    console.log(JSON.stringify(results.at(-1)));
  }
}
for (const [path, digest] of Object.entries(sourceDigests))
  assert.equal(hash(await readFile(join(root, path))), digest, "Source changed during campaign: " + path);
process.exitCode = failed ? 1 : 0;
