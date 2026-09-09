import { describe, expect, it, vi } from "vitest";
import {
  MicrosoftDelegatedExcelTransport,
  MicrosoftDriveArtifactTransport,
  MicrosoftGraphError,
} from "@finnor/provider-microsoft365";

const response = <T>(value: T, status = 200, headers = new Headers()) => ({
  value,
  status,
  headers,
  clientRequestId: "test-request",
});

function rawMetadata(input: { id?: string; name?: string; size: number; eTag?: string; sensitivity?: boolean }) {
  return {
    id: input.id ?? "item-1",
    name: input.name ?? "model.xlsx",
    size: input.size,
    eTag: input.eTag ?? '"etag-1"',
    cTag: '"ctag-1"',
    file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    lastModifiedDateTime: "2026-09-09T00:00:00.000Z",
    webUrl: "https://example.invalid/model.xlsx",
    ...(input.sensitivity ? { sensitivityLabel: { id: "label-1" } } : {}),
  };
}

describe("P3 Microsoft artifact transports", () => {
  it("downloads exact bytes around a stable eTag and exposes bounded provider versions", async () => {
    const bytes = Buffer.from("provider bytes");
    const requestJson = vi.fn(async (request: { operation: string; pathOrUrl: string }) => {
      if (request.operation === "artifact_driveitem_versions") {
        return response({ value: [{ id: "v2", size: bytes.length }, { id: "v1", size: bytes.length }] });
      }
      return response(rawMetadata({ size: bytes.length }));
    });
    const requestBytes = vi.fn(async (request: { operation: string }) => response(
      request.operation === "artifact_driveitem_version_download" ? Uint8Array.from([1, 2, 3]) : new Uint8Array(bytes),
    ));
    const transport = new MicrosoftDriveArtifactTransport({ requestJson, requestBytes } as never, "app_only");
    const downloaded = await transport.download({ driveId: "drive A", itemId: "item/1" });
    expect(downloaded.bytes.equals(bytes)).toBe(true);
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(requestBytes).toHaveBeenCalledWith(expect.objectContaining({
      pathOrUrl: "/drives/drive%20A/items/item%2F1/content",
      maxResponseBytes: 10_485_760,
    }));
    expect(await transport.listVersions({ driveId: "drive A", itemId: "item/1" })).toEqual([
      expect.objectContaining({ id: "v2", size: bytes.length }),
      expect.objectContaining({ id: "v1", size: bytes.length }),
    ]);
    expect(Buffer.from(await transport.downloadVersion({ driveId: "drive A", itemId: "item/1" }, "v/1"))).toEqual(Buffer.from([1, 2, 3]));
    expect(requestBytes).toHaveBeenLastCalledWith(expect.objectContaining({ pathOrUrl: expect.stringContaining("/versions/v%2F1/content") }));
  });

  it("creates a large file through bounded upload chunks with fail-on-conflict identity", async () => {
    const bytes = Buffer.alloc(4_000_000, 7);
    const requestJson = vi.fn(async (request: { operation: string; pathOrUrl: string; body?: Record<string, unknown> }) => {
      if (request.operation === "artifact_driveitem_create_upload_session") {
        expect(request.pathOrUrl).toBe("/drives/drive/items/folder:/IC%20Deck.pptx:/createUploadSession");
        expect(request.body).toEqual({ item: { "@microsoft.graph.conflictBehavior": "fail", name: "IC Deck.pptx" } });
        return response({ uploadUrl: "https://upload.invalid/session" }, 200);
      }
      return response(rawMetadata({ id: "created", name: "IC Deck.pptx", size: bytes.length, eTag: '"new"' }));
    });
    const putUploadChunk = vi.fn(async (input: { start: number; total: number; bytes: Uint8Array }) => {
      expect(input.total).toBe(bytes.length);
      return input.start === 0
        ? response({}, 202)
        : response({ id: "created" }, 201);
    });
    const transport = new MicrosoftDriveArtifactTransport({ requestJson, putUploadChunk } as never, "app_only");
    const created = await transport.createFile({ driveId: "drive", parentItemId: "folder", name: "IC Deck.pptx", bytes, conflictBehavior: "fail" });
    expect(created).toMatchObject({ id: "created", eTag: '"new"', size: bytes.length });
    expect(putUploadChunk).toHaveBeenCalledTimes(2);
    expect((putUploadChunk.mock.calls[0]?.[0] as { bytes: Uint8Array }).bytes.length % (320 * 1024)).toBe(0);
  });

  it("enforces the exact eTag, sends If-Match, and blocks labeled app-only replacement", async () => {
    const bytes = Buffer.from("replacement");
    const requestJson = vi.fn()
      .mockResolvedValueOnce(response(rawMetadata({ size: bytes.length, eTag: '"base"' })))
      .mockResolvedValueOnce(response({ uploadUrl: "https://upload.invalid/replace" }))
      .mockResolvedValueOnce(response(rawMetadata({ size: bytes.length, eTag: '"next"' })));
    const putUploadChunk = vi.fn(async () => response({ id: "item-1" }, 201));
    const transport = new MicrosoftDriveArtifactTransport({ requestJson, putUploadChunk } as never, "app_only");
    expect(await transport.replaceConditional({ driveId: "drive", itemId: "item-1", bytes, expectedETag: '"base"' }))
      .toMatchObject({ eTag: '"next"' });
    expect(requestJson.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      method: "POST",
      headers: { "if-match": '"base"' },
      body: { item: { "@microsoft.graph.conflictBehavior": "replace" } },
    }));

    const stale = new MicrosoftDriveArtifactTransport({
      requestJson: async () => response(rawMetadata({ size: bytes.length, eTag: '"remote"' })),
    } as never, "app_only");
    await expect(stale.replaceConditional({ driveId: "drive", itemId: "item-1", bytes, expectedETag: '"base"' }))
      .rejects.toEqual(expect.objectContaining({ kind: "conflict", status: 412 }));

    const labeled = new MicrosoftDriveArtifactTransport({
      requestJson: async () => response(rawMetadata({ size: bytes.length, eTag: '"base"', sensitivity: true })),
    } as never, "app_only");
    await expect(labeled.replaceConditional({ driveId: "drive", itemId: "item-1", bytes, expectedETag: '"base"' }))
      .rejects.toEqual(expect.objectContaining({ kind: "permission", status: 403, providerCode: "sensitivityLabelRequiresDelegated" }));

    const delegatedRequests = vi.fn()
      .mockResolvedValueOnce(response(rawMetadata({ size: bytes.length, eTag: '"base"', sensitivity: true })))
      .mockResolvedValueOnce(response({ uploadUrl: "https://upload.invalid/delegated" }))
      .mockResolvedValueOnce(response(rawMetadata({ size: bytes.length, eTag: '"next"', sensitivity: true })));
    const delegated = new MicrosoftDriveArtifactTransport({ requestJson: delegatedRequests, putUploadChunk } as never, "delegated");
    await expect(delegated.replaceConditional({ driveId: "drive", itemId: "item-1", bytes, expectedETag: '"base"' })).resolves.toMatchObject({ eTag: '"next"' });
  });

  it("uses the delegated workbook session header for range read/write, calculation, and close", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const client = {
      requestJson: async (request: Record<string, unknown>) => {
        requests.push(request);
        if (request.operation === "excel_create_session") return response({ id: "session-1" }, 201);
        return response({ address: "A1:B2", values: [[1, 2], [3, 4]] });
      },
    };
    const excel = new MicrosoftDelegatedExcelTransport(client as never);
    const session = await excel.createSession("drive", "item", true);
    await excel.readRange("drive", "item", "Model", "A1:B2", session);
    await excel.writeRange({ driveId: "drive", itemId: "item", worksheetId: "Model", address: "A1:B2", sessionId: session, formulas: [["=1", "=2"], ["=3", "=4"]] });
    await excel.calculate("drive", "item", session, "FullRebuild");
    await excel.closeSession("drive", "item", session);
    expect(requests.map((request) => request.operation)).toEqual([
      "excel_create_session", "excel_read_range", "excel_write_range", "excel_calculate", "excel_close_session",
    ]);
    expect(requests.slice(1).every((request) => (request.headers as Record<string, string>)["workbook-session-id"] === session)).toBe(true);
    expect(requests[2]).toEqual(expect.objectContaining({ method: "PATCH", body: { formulas: [["=1", "=2"], ["=3", "=4"]] } }));
  });

  it("rejects malformed metadata and invalid create policies instead of inventing provider identity", async () => {
    const transport = new MicrosoftDriveArtifactTransport({ requestJson: async () => response({ id: "missing-fields" }) } as never, "app_only");
    await expect(transport.metadata({ driveId: "drive", itemId: "item" })).rejects.toBeInstanceOf(MicrosoftGraphError);
    await expect(transport.createFile({ driveId: "drive", parentItemId: "folder", name: "bad/name.xlsx", bytes: Buffer.from("x"), conflictBehavior: "fail" }))
      .rejects.toEqual(expect.objectContaining({ kind: "blocked_config" }));
  });
});
