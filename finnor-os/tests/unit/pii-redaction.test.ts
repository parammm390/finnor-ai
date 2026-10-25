import { describe, expect, it } from "vitest";
import { redactText, redactStructured } from "@finnor/security";

describe("PII text redaction", () => {
  it("redacts real phone and Luhn-valid card values", () => {
    const result = redactText("Call +1 (515) 555-0199 and charge 4111 1111 1111 1111.");
    expect(result.value).toContain("[PHONE_1]");
    expect(result.value).toContain("[CARD_1]");
  });

  it("preserves research year ranges and durable UUID receipt identifiers", () => {
    const uuid = "96717922-4784-4372-8211-657f15c733f2";
    const result = redactText(`Forecast 2025-2032; receipt ${uuid}.`);
    expect(result.value).toBe(`Forecast 2025-2032; receipt ${uuid}.`);
    expect([...result.tokens.keys()]).toEqual([]);
  });

  it("preserves financial terminology while protecting identifiers and unknown numeric strings", () => {
    expect(redactStructured({
      grossNetTreatment: "SOURCE_SIGNED_GROSS_CREDIT_SEPARATE",
      customerSSN: "fixture_identifier", customerSsn: "fixture_identifier", customer_ssn: "fixture_identifier",
      socialSecurityNumber: "fixture_identifier", apiKey: "fixture_credential", accessToken: "fixture_credential",
      nested: { customerEmail: "fixture_identifier", phone: "fixture_identifier", amount: "1000000000" },
    })).toEqual({
      grossNetTreatment: "SOURCE_SIGNED_GROSS_CREDIT_SEPARATE",
      customerSSN: "[REDACTED]", customerSsn: "[REDACTED]", customer_ssn: "[REDACTED]",
      socialSecurityNumber: "[REDACTED]", apiKey: "[REDACTED]", accessToken: "[REDACTED]",
      nested: { customerEmail: "[REDACTED]", phone: "[REDACTED]", amount: "[PHONE_1]" },
    });
  });
});
