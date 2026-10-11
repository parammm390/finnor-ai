import { r2Quantity as q } from "./r2-rational";

/** Common original-joint-world separation, not a sum of local worst cases. */
export function separateR2Worlds(
  worlds: string[], values: Array<{ worldId: string; value: string }>, violations: Array<{ worldId: string }>,
) {
  const worst = values.length ? values.reduce((a, b) => q(a.value).compare(q(b.value)) <= 0 ? a : b) : null;
  const adverse = violations.find(v => !worlds.includes(v.worldId))?.worldId ??
    (worst && !worlds.includes(worst.worldId) ? worst.worldId : null);
  return { worst, adverse, duplicateWitnesses: [...new Set(violations.filter(v => worlds.includes(v.worldId)).map(v => v.worldId))] };
}
