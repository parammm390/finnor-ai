import { describe, expect, it } from "vitest";
import { dedicatedBedrockCredentials } from "@finnor/tools";

describe("dedicated Bedrock credentials", () => {
  it("leaves the host identity in place when neither value is set", () => {
    expect(dedicatedBedrockCredentials({})).toEqual({});
    expect(dedicatedBedrockCredentials({ FINNOR_BEDROCK_ACCESS_KEY_ID: " ", FINNOR_BEDROCK_SECRET_ACCESS_KEY: "" })).toEqual({});
  });

  it("uses the named pair when both values are set", () => {
    expect(dedicatedBedrockCredentials({
      FINNOR_BEDROCK_ACCESS_KEY_ID: " AKIAEXAMPLE ", FINNOR_BEDROCK_SECRET_ACCESS_KEY: "example-secret",
    })).toEqual({ credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "example-secret" } });
  });

  it("fails closed on a half-configured pair instead of falling back to the host identity", () => {
    expect(() => dedicatedBedrockCredentials({ FINNOR_BEDROCK_ACCESS_KEY_ID: "AKIAEXAMPLE" })).toThrow(/must be set together/);
    expect(() => dedicatedBedrockCredentials({ FINNOR_BEDROCK_SECRET_ACCESS_KEY: "example-secret" })).toThrow(/must be set together/);
  });
});
