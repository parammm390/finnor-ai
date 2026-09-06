import { describe, it, expect } from "vitest";
import { parseSpokenDecision, diagnoseFailure, buildConfirmationScript } from "../../packages/orchestration/src/voice";

describe("parseSpokenDecision (voice confirmation parse path)", () => {
  it("clear approvals", () => {
    for (const t of ["yes", "Yeah go ahead", "yep, send it", "approve it", "sounds good, book it", "OK do it"]) {
      expect(parseSpokenDecision(t), t).toBe("approve");
    }
  });
  it("clear rejections", () => {
    for (const t of ["no", "Nope", "don't send that", "cancel it", "hold off for now", "no, not now"]) {
      expect(parseSpokenDecision(t), t).toBe("reject");
    }
  });
  it("the LAST clear signal wins when the caller changes their mind", () => {
    expect(parseSpokenDecision("hmm no wait — yes, go ahead")).toBe("approve");
    expect(parseSpokenDecision("yes... actually no, cancel that")).toBe("reject");
  });
  it("ambiguity fails closed — never approves", () => {
    for (const t of ["hmm let me think", "what was the price again?", "", "maybe later this week"]) {
      expect(parseSpokenDecision(t), t).toBe("unclear");
    }
  });
  it("does not false-match inside other words", () => {
    expect(parseSpokenDecision("I know the address")).toBe("unclear");
  });
});

describe("parseSpokenDecision — per-tenant extra phrases (Phase 14 config seam)", () => {
  it("absent extras: behavior is byte-for-byte identical to no second argument", () => {
    for (const t of ["yes", "no", "hmm let me think", "yeah go ahead", "cancel it"]) {
      expect(parseSpokenDecision(t, {})).toBe(parseSpokenDecision(t));
      expect(parseSpokenDecision(t, { approve: [], reject: [] })).toBe(parseSpokenDecision(t));
    }
  });

  it("a configured approve phrase that isn't in the built-in list now approves", () => {
    // "totally go for it" contains no built-in trigger word — unclear on its own.
    expect(parseSpokenDecision("totally go for it")).toBe("unclear");
    expect(parseSpokenDecision("totally go for it", { approve: ["go for it"] })).toBe("approve");
  });

  it("a configured reject phrase that isn't in the built-in list now rejects", () => {
    // "I'm good thanks" contains no built-in trigger word — unclear on its own.
    expect(parseSpokenDecision("I'm good thanks")).toBe("unclear");
    expect(parseSpokenDecision("I'm good thanks", { reject: ["I'm good"] })).toBe("reject");
  });

  it("extra phrases still respect last-signal-wins against built-in patterns", () => {
    expect(parseSpokenDecision("go for it, actually no", { approve: ["go for it"] })).toBe("reject");
    expect(parseSpokenDecision("no wait, go for it", { approve: ["go for it"] })).toBe("approve");
  });

  it("fail-closed is preserved: ambiguity with extras configured still never approves", () => {
    for (const t of ["hmm let me think", "what was the price again?", ""]) {
      expect(parseSpokenDecision(t, { approve: ["go for it"], reject: ["I'm good"] }), t).toBe("unclear");
    }
  });

  it("extra phrases are escaped, not interpreted as regex — a phrase containing regex metacharacters matches literally", () => {
    // "go+for+it" would be an invalid/wrong-meaning regex if the "+" were live (one-or-more
    // of the preceding char) instead of escaped to a literal plus sign.
    expect(parseSpokenDecision("let's go+for+it right now")).toBe("unclear");
    expect(parseSpokenDecision("let's go+for+it right now", { approve: ["go+for+it"] })).toBe("approve");
    // The metacharacter-laden phrase must not accidentally match unrelated text either.
    expect(parseSpokenDecision("totally unrelated remark here", { approve: ["go+for+it"] })).toBe("unclear");
  });

  it("extra phrase matching is case-insensitive, like the built-in patterns", () => {
    expect(parseSpokenDecision("GO FOR IT", { approve: ["go for it"] })).toBe("approve");
  });

  it("matches a phrase ending in a non-word character positioned at the end of the transcript (lookaround boundary, not \\b)", () => {
    // \b only fires at a word/non-word transition — it fails when BOTH sides of a
    // boundary are non-word, which happens here: the phrase's last char ")" is
    // non-word, and it sits right before the function's own trailing padding space
    // (also non-word), so \b would never fire at that position. Neither "ship it)"
    // nor "totally" is a built-in trigger, isolating the extra phrase's own effect.
    expect(parseSpokenDecision("totally ship it)")).toBe("unclear");
    expect(parseSpokenDecision("totally ship it)", { approve: ["ship it)"] })).toBe("approve");
  });
});

describe("diagnoseFailure (spoken failure diagnosis)", () => {
  it("names the failing integration and asks for the fix on credential errors", () => {
    const s = diagnoseFailure("Could not reach voice transport: [vapi] VAPI_API_KEY is not set", "place_call");
    expect(s).toContain("Vapi");
    expect(s.toLowerCase()).toContain("key");
    expect(s).toContain("place call");
  });
  it("names the integration on outage errors without asking for a key", () => {
    const s = diagnoseFailure("[resend] timed out after 15000ms", "send_message");
    expect(s).toContain("notification sender");
    expect(s.toLowerCase()).toContain("review queue");
  });
  it("degrades gracefully with no integration tag", () => {
    const s = diagnoseFailure(undefined, "record_finding");
    expect(s).toContain("record finding");
  });
});

describe("buildConfirmationScript", () => {
  it("appends the yes/no ask", () => {
    expect(buildConfirmationScript("Send 3 proposals.")).toMatch(/yes to approve.*no to reject/i);
  });
});
