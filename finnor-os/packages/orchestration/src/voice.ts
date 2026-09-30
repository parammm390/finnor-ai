// Spoken decision parser used by orchestration learning. Ambiguous input never approves.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lastMatchIndex(text: string, pattern: RegExp): number {
  let last = -1;
  for (const m of text.matchAll(pattern)) last = m.index ?? -1;
  return last;
}

/**
 * Parse a spoken yes/no from a call transcript. The LAST clear signal wins, because
 * people change their mind mid-sentence ("hmm, no wait — yes, go ahead").
 * Anything ambiguous is "unclear" — an unclear answer NEVER approves (fail-closed).
 *
 * `extra` is a per-tenant config seam (domain_policies for the `voice_confirmation`
 * action type, `policy.approvePhrases`/`policy.rejectPhrases`) — tenants can teach the
 * parser their teams' phrasing without a code change. Phrases are escaped
 * before becoming regex (never interpolated as user-supplied regex) and matched with
 * the exact same word-boundary, last-signal-wins logic as the built-in patterns.
 * Absent `extra`, behavior is byte-for-byte identical to before this parameter existed.
 */
export function parseSpokenDecision(
  transcript: string,
  extra?: { approve?: string[]; reject?: string[] },
): "approve" | "reject" | "unclear" {
  const t = ` ${transcript.toLowerCase()} `;
  const approvePatterns =
    /\b(yes|yeah|yep|yup|approve|approved|confirm|confirmed|go ahead|do it|send it|book it|sounds good|that works|absolutely|sure|correct|okay|ok)\b/g;
  const rejectPatterns =
    /\b(no|nope|nah|don't|do not|cancel|reject|rejected|stop|hold off|not now|never mind|nevermind|wait|skip it)\b/g;

  let lastApprove = lastMatchIndex(t, approvePatterns);
  let lastReject = lastMatchIndex(t, rejectPatterns);

  // Lookaround boundaries, not \b: tenant-configured phrases may start or end with a
  // non-word character (e.g. an apostrophe or punctuation), and \b only fires at a
  // word/non-word transition — it silently fails to match at a boundary where both
  // sides are non-word. (?<!\w)...(?!\w) has no such blind spot.
  if (extra?.approve && extra.approve.length > 0) {
    const extraApprove = new RegExp(`(?<!\\w)(${extra.approve.map(escapeRegExp).join("|")})(?!\\w)`, "gi");
    lastApprove = Math.max(lastApprove, lastMatchIndex(t, extraApprove));
  }
  if (extra?.reject && extra.reject.length > 0) {
    const extraReject = new RegExp(`(?<!\\w)(${extra.reject.map(escapeRegExp).join("|")})(?!\\w)`, "gi");
    lastReject = Math.max(lastReject, lastMatchIndex(t, extraReject));
  }

  if (lastApprove === -1 && lastReject === -1) return "unclear";
  if (lastApprove > lastReject) return "approve";
  if (lastReject > lastApprove) return "reject";
  return "unclear";
}
