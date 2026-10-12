import { createHash } from "node:crypto";

/** JSON object order is not semantic. Arrays retain their declared order. */
export function canonicalInstitutionJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalInstitutionJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalInstitutionJson(item)}`).join(",")}}`;
}
export const institutionDigest = (value: unknown) => createHash("sha256")
  .update(canonicalInstitutionJson(value)).digest("hex");
export const institutionOwnerCutDigest = (entities: Array<{ref:string;registrationId:string;sourceId?:string}>) =>
  institutionDigest(entities.map(entity=>{
    const binding=entity as typeof entity & {ownerWitness?:Record<string,unknown>};
    // Native @v facts keep their own mutation version. S1 history ordinals also
    // advance for graph maintenance; retain that provenance without pretending
    // it changes the canonical fact. @s owner witnesses remain fully bound.
    if(!/@v[1-9][0-9]*$/.test(binding.ref)||!binding.ownerWitness)return binding;
    const {historyVersion:_historyVersion,historySnapshotHash:_historySnapshotHash,...witness}=binding.ownerWitness;
    return {...binding,ownerWitness:witness};
  }).sort((a,b)=>JSON.stringify([a.ref,a.registrationId,a.sourceId??""])
    .localeCompare(JSON.stringify([b.ref,b.registrationId,b.sourceId??""]))));
