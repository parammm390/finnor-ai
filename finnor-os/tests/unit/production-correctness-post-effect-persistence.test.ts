import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

describe("production-correctness post-effect persistence", () => {
  it("does not report a customer send as successful when either required history write fails", () => {
    const text = source("../../packages/domain-plugins/customer-comm/index.ts");
    const sendPath = text.slice(text.indexOf("if (draft.actionType === \"send_customer_message\""), text.indexOf("const tenantId = String(draft.payload.tenantId", text.indexOf("return { status: \"success\", output: { sent: true")));

    expect(sendPath).not.toContain(".catch(() => undefined)");
    expect(sendPath).toContain("persistenceFailures");
    expect(sendPath).toContain("output: { sent: true");
    expect(sendPath).toContain('errorKind: "needs_human"');
  });

  it("requires exactly one proposal state update after delivery", () => {
    const text = source("../../packages/domain-plugins/quotation/index.ts");
    const sendPath = text.slice(text.lastIndexOf('if (draft.actionType === "send_proposal")'));

    expect(sendPath).not.toContain(".catch(() => undefined)");
    expect(sendPath).toContain(".returning({ id: proposals.id })");
    expect(sendPath).toContain("updated.length !== 1");
    expect(sendPath).toContain("stateRecorded: false");
    expect(sendPath).toContain('errorKind: "needs_human"');
  });

  it("separates recorded batch sends from delivered-but-unrecorded effects", () => {
    const text = source("../../packages/domain-plugins/proposal-batch/index.ts");
    const executePath = text.slice(text.indexOf("async execute"));

    expect(executePath).not.toContain(".catch(() => undefined)");
    expect(executePath).toContain("deliveredUnrecorded.push");
    expect(executePath.indexOf("recordBusinessEvent")).toBeLessThan(executePath.indexOf("sent.push"));
    expect(executePath).toContain('status: "failure"');
    expect(executePath).toContain('errorKind: "needs_human"');
  });
});
