export function requireCoalition(condition: unknown, boundary: string): asserts condition {
  if (!condition) throw Error("R5_" + boundary);
}
