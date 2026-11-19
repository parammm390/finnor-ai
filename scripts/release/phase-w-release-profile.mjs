/** Absence is an adapter-verified fact, not a parse-error fallback. */
export function parsePhaseWReleaseCandidate(text) {
  if (text === undefined) return "LEGACY_VERIFIED_MARKER_ABSENT";
  const invalid = () => { throw Object.assign(Error("PHASE_W_RELEASE_MARKER_INVALID"), { code: "PHASE_W_RELEASE_MARKER_INVALID" }); };
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 4096) invalid();
  let marker;
  try { marker = JSON.parse(text); } catch { invalid(); }
  if (!marker || typeof marker !== "object" || Array.isArray(marker)
    || Object.keys(marker).sort().join(",") !== "releaseProfile,schema"
    || marker.schema !== "finnor.w.release-candidate.v1"
    || marker.releaseProfile !== "PHASE_W_FULL_PRD") invalid();
  // The only two supported values contain no embedded JSON keys. Counting
  // decoded key tokens also refuses duplicates and escaped duplicate spellings.
  const keys = [...text.matchAll(/("(?:[^"\\]|\\.)*")\s*:/g)].map(match => JSON.parse(match[1]));
  if (keys.length !== 2 || new Set(keys).size !== 2) invalid();
  return "PHASE_W_FULL_PRD";
}
