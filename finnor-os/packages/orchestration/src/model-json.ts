/** Bedrock Converse can return a fenced object even when the caller asks for JSON.
 * Accept one object only; the downstream domain schema remains authoritative. */
export function parseModelJson(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (originalError) {
    const start = cleaned.indexOf("{");
    if (start < 0) throw originalError;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < cleaned.length; index += 1) {
      const character = cleaned[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) { end = index; break; }
      }
    }
    if (end < 0) throw originalError;
    const suffix = cleaned.slice(end + 1).replace(/^\s*```/, "").trim();
    if (/^[{[]/.test(suffix)) throw new Error("Model returned more than one JSON value");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}
