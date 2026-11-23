import { createHash } from "node:crypto";
import { join } from "node:path";
import type { CoalitionProblem, CoalitionCandidate } from "../../../shared-types/src/coalition-programme";
import { canonicalJson, epistemicHash } from "../../../epistemic-runtime/src/source-precedence";
import { r2Quantity as q, r2String as text } from "../../../epistemic-runtime/src/r2-rational";
import { separateR2Worlds } from "../../../epistemic-runtime/src/r2-world-separation";
import { parseCoalitionProblem, requireCoalition } from "../../../epistemic-runtime/src/coalition-programme-search/domain";
import { encodeCoalitionMaster, decodeCoalitionPrimal } from "../../../epistemic-runtime/src/coalition-programme-search/encoding";
import type { CoalitionFamily } from "../../../epistemic-runtime/src/coalition-programme-search/programmes";
import { R2NativeSession, readR2Artifact, r2Repository, coalitionCheckerIdentity } from "./r2-native";
import {selectCoalitionNativeTie} from "./r5-tie";

type Candidate = ReturnType<typeof decodeCoalitionPrimal>;
type Checked = Awaited<ReturnType<R2NativeSession["checkCoalition"]>>;
type Solved = Awaited<ReturnType<R2NativeSession["solve"]>>;
interface FullWorldCheck {
  feasible: boolean; lower: string | null;
  worldValues: Array<{ worldId: string; value: string }>;
  violations: Array<{ worldId: string; witness: unknown }>;
}

export async function packagedCoalitionProgramme() {
  const base = join(r2Repository, "finnor-os/packages/epistemic-runtime/src/coalition-programme-search");
  const manifest = JSON.parse(await readR2Artifact(join(base, "programme-manifest.json"), 262144)) as {
    schema: string; moduleSha256: string; sources: Array<{ path: string; sha256: string }>;
  };
  requireCoalition(manifest.schema === "finnor.r5.packaged-programme.v1", "PACKAGED_PROGRAMME_IDENTITY");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  for (const source of manifest.sources) {
    requireCoalition(source.path.startsWith("finnor-os/packages/epistemic-runtime/src/") &&
      !source.path.split("/").includes(".."), "PACKAGED_SOURCE_CUSTODY");
    requireCoalition(hash(await readR2Artifact(join(r2Repository, source.path))) === source.sha256, "PACKAGED_SOURCE_CHANGED");
  }
  const javascript = await readR2Artifact(join(base, "programme.mjs"), 1048576);
  requireCoalition(hash(javascript) === manifest.moduleSha256, "PACKAGED_MODULE_CHANGED");
  return { javascript, manifest };
}

/** Owned full-family adapter, sharing R2's original native session, world
 * separation, rational LP writer, proof completion and physical accounting.
 * It grants no S4/S5/S6 authority and is not a complete owner qualification. */
export async function runCoalitionNativeSearch(value: unknown, session: R2NativeSession) {
  const p: CoalitionProblem = parseCoalitionProblem(value);
  session.bindCoalitionChecker(await coalitionCheckerIdentity());
  requireCoalition(canonicalJson(p.limits.native) === canonicalJson(session.caps), "ORIGINAL_NATIVE_GRANT_BINDING");
  requireCoalition(session.deadlineAt <= Date.parse(p.owner.originalDeadline), "ORIGINAL_DEADLINE_BINDING");
  const packaged = await packagedCoalitionProgramme();
  await session.checkpoint();
  const p1 = await session.executeProgramme(packaged.javascript,
    [{ original: p, deadlineAt: session.deadlineAt }], Math.min(1048576, p.limits.maxEncodingBytes));
  const family = p1.outputs as CoalitionFamily;
  requireCoalition(Array.isArray(family.options) && typeof family.complete === "boolean", "UNTRUSTED_P1_OUTPUT_SHAPE");
  const checks: Checked[] = [], proofs: Array<Solved & { encodingDigest: string }> = [], iterations: Array<{
    index: number; worlds: string[]; lower: string | null; upper: string | null; addedWorld: string | null;
    duplicateWitnesses: string[];
  }> = [];
  const unresolved = [...family.unresolved];
  let lower: string | null = null, upper: string | null = null, candidate: Candidate | null = null;
  let status: "COMPLETE" | "INCOMPLETE" | "INFEASIBLE" = "INCOMPLETE";
  const worlds = [p.worlds[0]!.id];
  if (!family.complete) unresolved.push("COMPLETE_ORIGINAL_PROGRAMME_FAMILY_UNKNOWN");
  else for (let index = 0; index <= p.worlds.length; index++) {
    await session.checkpoint();
    const encoding = encodeCoalitionMaster(p, family, worlds);
    checks.push(await session.checkCoalition(p, "encoding", { family, encoding }));
    const solved = await session.solve(encoding, index);
    let proof: Record<string, unknown> | null = null;
    if (solved.viprRef && solved.proofRef && !solved.proofError) {
      const checked = await session.checkCoalition(p, "proof", { family, encoding, proofPath: solved.proofPath });
      checks.push(checked); proofs.push({ ...solved, encodingDigest: epistemicHash(encoding) }); proof = checked.result;
      if (typeof proof.upper === "string")
        upper = upper === null || q(proof.upper).compare(q(upper)) < 0 ? proof.upper : upper;
      if (proof.infeasibleProof === true) { status = "INFEASIBLE"; break; }
    } else unresolved.push(solved.proofError ?? "COMPLETE_NATIVE_VIPR_PROOF_UNKNOWN");
    if (!solved.solution) { unresolved.push("INDEPENDENTLY_REPLAYABLE_PRIMAL_UNKNOWN"); break; }
    const proposed = decodeCoalitionPrimal(p, family, encoding, solved.solution);
    const checked = await session.checkCoalition(p, "separate", { candidate: proposed });
    checks.push(checked);
    const full = checked.result as unknown as FullWorldCheck;
    if (full.feasible && full.lower !== null && (lower === null || q(full.lower).compare(q(lower)) > 0)) {
      lower = full.lower; candidate = { ...proposed, objective: full.lower };
    }
    requireCoalition(lower === null || upper === null || q(lower).compare(q(upper)) <= 0, "CROSSED_INDEPENDENT_BOUNDS");
    const separated = separateR2Worlds(worlds, full.worldValues, full.violations);
    iterations.push({ index, worlds: [...worlds], lower, upper, addedWorld: separated.adverse,
      duplicateWitnesses: separated.duplicateWitnesses });
    if (lower !== null && upper !== null && q(lower).compare(q(upper)) === 0) {
      status = "COMPLETE"; break;
    }
    if (separated.adverse) { worlds.push(separated.adverse); continue; }
    unresolved.push("NO_NEW_WORLD_AND_EXACT_STOP_GATE_UNPASSED"); break;
  }
  let tie:Awaited<ReturnType<typeof selectCoalitionNativeTie>>|null=null;
  if(status==="COMPLETE"&&lower!==null){
    try{
      tie=await selectCoalitionNativeTie(p,family,lower,session);
      candidate=tie.candidate;checks.push(tie.checked);
    }catch(error){
      status="INCOMPLETE";unresolved.push("FROZEN_TIE_UNQUALIFIED:"+(error instanceof Error?error.message:"UNKNOWN"));
    }
  }
  await session.checkpoint();
  return {
    schema: "finnor.r5.native-search-component.v1" as const, status,
    originalDigest: epistemicHash(p), original: p, family, candidate, lower, upper,
    gap: lower === null || upper === null ? null : text(q(upper).sub(q(lower))),
    checks, proofs, iterations, tie, p1: { ...p1, moduleManifest: packaged.manifest },
    partitionBounds: family.partitions.map(partition => ({
      partitionId: partition.id, disposition: partition.disposition,
      upper: partition.disposition === "NO_ADMITTED_LOCAL_PROGRAMME" ? null : upper,
      basis: upper === null ? "UNKNOWN" : "ACCEPTED_COMPLETE_JOINT_MASTER_RELAXATION_INCLUDES_THIS_PARTITION",
    })),
    unresolved, costs: { physicalRefs: session.receipts.map(receipt => receipt.ref),
      cpuMs: session.chargedCpuMs, aggregateSampledPeakBytes: session.aggregatePeakMemoryBytes, money: null },
    qualification: "MATHEMATICAL_NATIVE_COMPONENT_ONLY_CANONICAL_OWNERS_UNQUALIFIED" as const,
    executionAuthorityGranted: false as const,
  };
}

export function coalitionNativeCandidate(
  native: Awaited<ReturnType<typeof runCoalitionNativeSearch>>, session: R2NativeSession,
): CoalitionCandidate | null {
  if (!native.candidate) return null;
  const lastProof = native.proofs.at(-1);
  return {
    schema: "finnor.r5.candidate.v1", originalDigest: native.originalDigest,
    programmeOptions: native.family.options, selectedOptionIds: native.candidate.selected.map(option => option.id),
    division: native.candidate.division, objective: native.candidate.objective,
    family: { complete: native.family.complete, generatedOptions: native.family.options.length, unresolved: native.family.unresolved },
    nativeBasis: { runtimeRef: session.runtime.ref, originalEncodingDigest: lastProof?.encodingDigest ?? "",
      modelSha256: lastProof?.modelSha256 ?? "", proofSha256: lastProof?.proofSha256 ?? null,
      viprRef: lastProof?.viprRef ?? null, physicalRefs: session.receipts.map(receipt => receipt.ref) },
  };
}
