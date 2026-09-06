// Voice-native confirmation layer: pure functions for parsing spoken decisions and
// building the sentences Vapi speaks. Pure = unit-testable without any Vapi account.

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

const INTEGRATION_NAMES: Record<string, string> = {
  vapi: "Vapi (your phone system)",
  groq: "the AI planning service",
  exa: "the web search service",
  firecrawl: "the source retrieval service",
  redis: "the session memory service",
  email: "your email account",
  gmail: "your Gmail identity",
  resend: "the Finnor notification sender",
};

/**
 * Turn a typed integration failure into the exact sentence to speak to the owner —
 * names WHICH integration failed and asks for the fix (§ spoken failure diagnosis).
 */
export function diagnoseFailure(error: string | undefined, actionType: string): string {
  const readable = actionType.replaceAll("_", " ");
  const match = error?.match(/\[(\w+)\]/);
  const integration = match ? INTEGRATION_NAMES[match[1]!] ?? match[1]! : null;
  if (error && /API_KEY is not set|credential|unauthorized|401|403/i.test(error) && integration) {
    return `Heads up — I couldn't finish "${readable}" because the ${integration} key isn't working. Want to give me a working one and I'll retry?`;
  }
  if (integration) {
    return `Heads up — I couldn't finish "${readable}" because ${integration} isn't responding. I've parked it in your review queue and won't retry until you say so.`;
  }
  return `Heads up — "${readable}" hit a problem: ${error ?? "unknown error"}. It's waiting in your review queue.`;
}

/** The sentence Vapi reads before capturing the spoken yes/no. */
export function buildConfirmationScript(summary: string): string {
  return `${summary} — Say yes to approve, or no to reject.`;
}
