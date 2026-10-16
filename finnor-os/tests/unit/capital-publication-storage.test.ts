import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { capitalDigest, canonicalCapital } from "../../packages/private-equity/src/capital-formation/contracts";
import {
  decodeCapitalPublication, encodeCapitalPublication,
} from "../../packages/private-equity/src/capital-formation/publication-storage";

const small = { schema: "finnor.v4.capital-publication.v1", package: { receivedMinor: "0" } };
const wide = { ...small, conditions: Array.from({ length: 1088 }, (_, id) => ({
  id, statement: "条件 and exact declared responsibility ".repeat(12),
})) };
const storedWide = () => encodeCapitalPublication(wide);
const decode = (value: unknown, digest = capitalDigest(wide)) =>
  decodeCapitalPublication(canonicalCapital(value), digest);

describe("bounded V4 publication storage, failure model registered before implementation", () => {
  it("keeps historical inline bytes and logical identity", () => {
    expect(encodeCapitalPublication(small)).toBe(small);
    expect(decode(small, capitalDigest(small))).toEqual(small);
  });
  it("losslessly retains wide Unicode publications within the unchanged Core bound", () => {
    const stored = storedWide();
    expect(Buffer.byteLength(canonicalCapital(wide))).toBeGreaterThan(262144);
    expect(Buffer.byteLength(canonicalCapital(stored))).toBeLessThanOrEqual(262144);
    expect(decode(stored)).toEqual(wide);
    expect(capitalDigest(decode(stored))).toBe(capitalDigest(wide));
  });
  it("rejects a different logical digest for inline and compressed records", () => {
    expect(() => decode(small, "0".repeat(64))).toThrow("CAPITAL_PUBLICATION_BYTES_CHANGED");
    expect(() => decode(storedWide(), "0".repeat(64))).toThrow("CAPITAL_PUBLICATION_BYTES_CHANGED");
  });
  it("rejects unexpected storage fields and unsupported encodings", () => {
    expect(() => decode({ ...storedWide(), extra: true })).toThrow("CAPITAL_PUBLICATION_STORAGE_INVALID");
    expect(() => decode({ ...storedWide(), encoding: "unsupported" })).toThrow("CAPITAL_PUBLICATION_STORAGE_INVALID");
  });
  it("rejects noncanonical base64 and corrupt compressed bytes", () => {
    const stored = storedWide();
    expect(() => decode({ ...stored, data: String(stored.data) + "=" })).toThrow("CAPITAL_PUBLICATION_STORAGE_INVALID");
    expect(() => decode({ ...stored, data: Buffer.from("not a gzip stream").toString("base64") }))
      .toThrow("CAPITAL_PUBLICATION_STORAGE_INVALID");
  });
  it("rejects false decoded lengths", () => {
    const stored = storedWide();
    expect(() => decode({ ...stored, decodedBytes: Number(stored.decodedBytes) - 1 }))
      .toThrow("CAPITAL_PUBLICATION_STORAGE_INVALID");
  });
  it("bounds decompression even when an envelope lies about output length", () => {
    const stored = storedWide();
    expect(() => decode({ ...stored, decodedBytes: 8388608,
      data: gzipSync(Buffer.alloc(8388609, 65)).toString("base64") }))
      .toThrow("CAPITAL_PUBLICATION_STORAGE_INVALID");
  });
  it("refuses logical or encoded data above the finite bounds without truncation", () => {
    expect(() => encodeCapitalPublication({ value: "x".repeat(8388609) }))
      .toThrow("CAPITAL_PUBLICATION_STORAGE_BOUND_EXCEEDED");
    expect(() => encodeCapitalPublication({ value: randomBytes(350000).toString("hex") }))
      .toThrow("CAPITAL_PUBLICATION_STORAGE_BOUND_EXCEEDED");
  });
  it("rejects noncanonical JSON and oversized stored content", () => {
    expect(() => decodeCapitalPublication(JSON.stringify(small, null, 2), capitalDigest(small)))
      .toThrow("CAPITAL_PUBLICATION_STORAGE_INVALID");
    expect(() => decodeCapitalPublication(" ".repeat(262145), capitalDigest(small)))
      .toThrow("CAPITAL_PUBLICATION_STORAGE_INVALID");
  });
});
