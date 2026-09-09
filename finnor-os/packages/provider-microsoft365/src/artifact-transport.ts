import { MicrosoftGraphClient } from "./client";
import { MicrosoftGraphError } from "./errors";

const ARTIFACT_MAX_BYTES = 10_485_760;
const UPLOAD_CHUNK_BYTES = 3_276_800; // 10 * Graph's required 320 KiB fragment multiple.
const MAX_VERSION_PAGES = 20;

const encoded = (value: string): string => encodeURIComponent(value);
const itemPath = (driveId: string, itemId: string): string => `/drives/${encoded(driveId)}/items/${encoded(itemId)}`;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new MicrosoftGraphError("invalid_response", `Microsoft ${label} was missing`, null, false);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export interface MicrosoftDriveItemIdentity { driveId: string; itemId: string }

export interface MicrosoftDriveItemMetadata extends MicrosoftDriveItemIdentity {
  id: string;
  name: string;
  size: number;
  eTag: string;
  cTag: string | null;
  mimeType: string | null;
  providerVersionId: string | null;
  lastModifiedDateTime: string | null;
  webUrl: string | null;
  sensitivityLabelPresent: boolean;
  raw: Record<string, unknown>;
}

export interface MicrosoftDriveItemVersion {
  id: string;
  size: number | null;
  lastModifiedDateTime: string | null;
  publication: Record<string, unknown>;
}

export interface MicrosoftDriveCreateInput {
  driveId: string;
  parentItemId: string;
  name: string;
  bytes: Buffer;
  conflictBehavior: "fail";
}

function driveItemMetadata(
  identity: MicrosoftDriveItemIdentity,
  value: Record<string, unknown>,
  status: number | null,
): MicrosoftDriveItemMetadata {
  const size = Number(value.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new MicrosoftGraphError("invalid_response", "Microsoft DriveItem size was invalid", status, false);
  const file = object(value.file);
  const eTag = requiredString(value.eTag ?? value["@odata.etag"], "DriveItem eTag");
  return {
    ...identity,
    id: requiredString(value.id, "DriveItem ID"),
    name: requiredString(value.name, "DriveItem name"),
    size,
    eTag,
    cTag: optionalString(value.cTag),
    mimeType: optionalString(file.mimeType),
    providerVersionId: optionalString(value["@odata.etag"] ?? value.eTag),
    lastModifiedDateTime: optionalString(value.lastModifiedDateTime),
    webUrl: optionalString(value.webUrl),
    sensitivityLabelPresent: Object.keys(object(value.sensitivityLabel)).length > 0,
    raw: value,
  };
}

export class MicrosoftDriveArtifactTransport {
  constructor(
    readonly client: MicrosoftGraphClient,
    readonly authMode: "app_only" | "delegated",
  ) {}

  async metadata(identity: MicrosoftDriveItemIdentity): Promise<MicrosoftDriveItemMetadata> {
    const response = await this.client.requestJson<Record<string, unknown>>({
      operation: "artifact_driveitem_metadata",
      pathOrUrl: `${itemPath(identity.driveId, identity.itemId)}?$select=id,name,size,eTag,cTag,file,lastModifiedDateTime,webUrl,sensitivityLabel`,
      maxResponseBytes: 256 * 1024,
    });
    return driveItemMetadata(identity, response.value, response.status);
  }

  /** Resolves one explicit child path without listing or fuzzy matching. It is used
   * only to recover an ambiguous create delivery; callers still compare read-back
   * bytes/semantics before accepting the provider object. */
  async metadataByPath(input: { driveId: string; parentItemId: string; name: string }): Promise<MicrosoftDriveItemMetadata> {
    if (!input.parentItemId.trim() || !input.name.trim() || input.name.length > 255 || /[\\/\u0000-\u001f]/.test(input.name)) {
      throw new MicrosoftGraphError("blocked_config", "Microsoft artifact target folder or file name is invalid", null, false);
    }
    const response = await this.client.requestJson<Record<string, unknown>>({
      operation: "artifact_driveitem_path_metadata",
      pathOrUrl: `/drives/${encoded(input.driveId)}/items/${encoded(input.parentItemId)}:/${encoded(input.name)}?$select=id,name,size,eTag,cTag,file,lastModifiedDateTime,webUrl,sensitivityLabel`,
      maxResponseBytes: 256 * 1024,
    });
    const itemId = requiredString(response.value.id, "DriveItem ID");
    return driveItemMetadata({ driveId: input.driveId, itemId }, response.value, response.status);
  }

  async download(identity: MicrosoftDriveItemIdentity): Promise<{ metadata: MicrosoftDriveItemMetadata; bytes: Buffer }> {
    const metadata = await this.metadata(identity);
    if (metadata.size > ARTIFACT_MAX_BYTES) throw new MicrosoftGraphError("invalid_response", "Microsoft artifact exceeds FINNOR's enforced byte bound", null, false);
    const response = await this.client.requestBytes({
      operation: "artifact_driveitem_download",
      pathOrUrl: `${itemPath(identity.driveId, identity.itemId)}/content`,
      maxResponseBytes: ARTIFACT_MAX_BYTES,
    });
    const bytes = Buffer.from(response.value);
    if (bytes.length !== metadata.size) {
      // A concurrent provider save between metadata and content is a fetch race,
      // never a trustworthy version. Callers retry from fresh metadata.
      throw new MicrosoftGraphError("conflict", "Microsoft file changed during download", 412, false, undefined, "providerFetchRace");
    }
    const after = await this.metadata(identity);
    if (after.eTag !== metadata.eTag) throw new MicrosoftGraphError("conflict", "Microsoft file changed during download", 412, false, undefined, "providerFetchRace");
    return { metadata: after, bytes };
  }

  async listVersions(identity: MicrosoftDriveItemIdentity, limit = 200): Promise<MicrosoftDriveItemVersion[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 1_000);
    const output: MicrosoftDriveItemVersion[] = [];
    let path: string | null = `${itemPath(identity.driveId, identity.itemId)}/versions?$top=${Math.min(boundedLimit, 200)}`;
    for (let page = 0; path && page < MAX_VERSION_PAGES && output.length < boundedLimit; page += 1) {
      const response = await this.client.requestJson<Record<string, unknown>>({ operation: "artifact_driveitem_versions", pathOrUrl: path, maxResponseBytes: 1_048_576 });
      const values = Array.isArray(response.value.value) ? response.value.value : [];
      for (const entry of values) {
        const row = object(entry);
        const id = requiredString(row.id, "DriveItem version ID");
        const size = row.size === undefined || row.size === null ? null : Number(row.size);
        if (size !== null && (!Number.isSafeInteger(size) || size < 0)) throw new MicrosoftGraphError("invalid_response", "Microsoft DriveItem version size was invalid", response.status, false);
        output.push({ id, size, lastModifiedDateTime: optionalString(row.lastModifiedDateTime), publication: object(row.publication) });
        if (output.length >= boundedLimit) break;
      }
      path = optionalString(response.value["@odata.nextLink"]);
    }
    if (path) throw new MicrosoftGraphError("invalid_response", "Microsoft DriveItem version pagination exceeded the configured bound", null, false);
    return output;
  }

  async downloadVersion(identity: MicrosoftDriveItemIdentity, versionId: string): Promise<Buffer> {
    const response = await this.client.requestBytes({
      operation: "artifact_driveitem_version_download",
      pathOrUrl: `${itemPath(identity.driveId, identity.itemId)}/versions/${encoded(versionId)}/content`,
      maxResponseBytes: ARTIFACT_MAX_BYTES,
    });
    return Buffer.from(response.value);
  }

  private async uploadChunks(uploadUrl: string, bytes: Buffer): Promise<Record<string, unknown>> {
    let final: Record<string, unknown> = {};
    for (let start = 0; start < bytes.length; start += UPLOAD_CHUNK_BYTES) {
      const end = Math.min(start + UPLOAD_CHUNK_BYTES, bytes.length);
      const response = await this.client.putUploadChunk({
        operation: "artifact_driveitem_upload_chunk",
        uploadUrl,
        bytes: bytes.subarray(start, end),
        start,
        total: bytes.length,
      });
      final = response.value;
      if (end < bytes.length && response.status !== 202) throw new MicrosoftGraphError("invalid_response", "Microsoft upload completed before all chunks were sent", response.status, false);
      if (end === bytes.length && response.status !== 200 && response.status !== 201) throw new MicrosoftGraphError("invalid_response", "Microsoft upload did not return final DriveItem metadata", response.status, false);
    }
    return final;
  }

  /** Creates a new provider file at an explicit Drive/folder/name. The only
   * certified conflict policy is FAIL, so this path never silently renames or
   * replaces a collaborator's file. */
  async createFile(input: MicrosoftDriveCreateInput): Promise<MicrosoftDriveItemMetadata> {
    if (input.conflictBehavior !== "fail") throw new MicrosoftGraphError("blocked_config", "Microsoft artifact creation requires conflictBehavior=fail", null, false);
    if (!input.parentItemId.trim() || !input.name.trim() || input.name.length > 255 || /[\\/\u0000-\u001f]/.test(input.name)) {
      throw new MicrosoftGraphError("blocked_config", "Microsoft artifact target folder or file name is invalid", null, false);
    }
    if (input.bytes.length === 0 || input.bytes.length > ARTIFACT_MAX_BYTES) throw new MicrosoftGraphError("blocked_config", "Artifact bytes are outside the publication bound", null, false);
    const session = await this.client.requestJson<Record<string, unknown>>({
      operation: "artifact_driveitem_create_upload_session",
      pathOrUrl: `/drives/${encoded(input.driveId)}/items/${encoded(input.parentItemId)}:/${encoded(input.name)}:/createUploadSession`,
      method: "POST",
      body: { item: { "@microsoft.graph.conflictBehavior": "fail", name: input.name } },
      maxResponseBytes: 256 * 1024,
    });
    const final = await this.uploadChunks(requiredString(session.value.uploadUrl, "upload session URL"), input.bytes);
    const itemId = requiredString(final.id, "created DriveItem ID");
    return this.metadata({ driveId: input.driveId, itemId });
  }

  /** Conditional replacement always creates an upload session because v1.0
   * explicitly defines If-Match/412 at session creation. It avoids relying on an
   * undocumented precondition for the small-file PUT endpoint. */
  async replaceConditional(input: MicrosoftDriveItemIdentity & { bytes: Buffer; expectedETag: string }): Promise<MicrosoftDriveItemMetadata> {
    if (!input.expectedETag) throw new MicrosoftGraphError("blocked_config", "A provider eTag is required for publication", null, false);
    if (input.bytes.length === 0 || input.bytes.length > ARTIFACT_MAX_BYTES) throw new MicrosoftGraphError("blocked_config", "Artifact bytes are outside the publication bound", null, false);
    const before = await this.metadata(input);
    if (before.eTag !== input.expectedETag) throw new MicrosoftGraphError("conflict", "Microsoft provider head changed before publication", 412, false);
    if (this.authMode === "app_only" && before.sensitivityLabelPresent) {
      throw new MicrosoftGraphError("permission", "Sensitivity-labeled files require a delegated Microsoft user context", 403, false, undefined, "sensitivityLabelRequiresDelegated");
    }
    const session = await this.client.requestJson<Record<string, unknown>>({
      operation: "artifact_driveitem_create_upload_session",
      pathOrUrl: `${itemPath(input.driveId, input.itemId)}/createUploadSession`,
      method: "POST",
      headers: { "if-match": input.expectedETag },
      body: { item: { "@microsoft.graph.conflictBehavior": "replace" } },
      maxResponseBytes: 256 * 1024,
    });
    const uploadUrl = requiredString(session.value.uploadUrl, "upload session URL");
    const final = await this.uploadChunks(uploadUrl, input.bytes);
    const after = await this.metadata(input);
    const returnedId = optionalString(final.id);
    if (returnedId && returnedId !== input.itemId) throw new MicrosoftGraphError("invalid_response", "Microsoft upload acknowledged a different DriveItem", null, false);
    return after;
  }
}

function workbookItemPath(driveId: string, itemId: string): string {
  return `/drives/${encoded(driveId)}/items/${encoded(itemId)}/workbook`;
}

function workbookRangePath(driveId: string, itemId: string, worksheetId: string, address: string): string {
  const escapedAddress = address.replaceAll("'", "''");
  return `${workbookItemPath(driveId, itemId)}/worksheets/${encoded(worksheetId)}/range(address='${encodeURIComponent(escapedAddress)}')`;
}

/** Delegated-only Excel recalculation/read-back. The session header is explicit on
 * every call and this surface cannot be constructed from P2 app-only auth. */
export class MicrosoftDelegatedExcelTransport {
  constructor(readonly client: MicrosoftGraphClient) {}

  async createSession(driveId: string, itemId: string, persistChanges = true): Promise<string> {
    let response = await this.client.requestJson<Record<string, unknown>>({
      operation: "excel_create_session",
      pathOrUrl: `${workbookItemPath(driveId, itemId)}/createSession`,
      method: "POST",
      headers: { prefer: "respond-async" },
      body: { persistChanges },
      maxResponseBytes: 256 * 1024,
    });
    if (response.status === 202) {
      const location = response.headers.get("location");
      if (!location) throw new MicrosoftGraphError("invalid_response", "Asynchronous Excel session omitted Location", 202, false);
      for (let attempt = 0; attempt < 20 && response.status === 202; attempt += 1) {
        const retryAfter = Math.min(Math.max(Number(response.headers.get("retry-after") ?? 1), 0.25), 5) * 1_000;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, retryAfter));
        response = await this.client.requestJson<Record<string, unknown>>({
          operation: "excel_create_session_poll",
          pathOrUrl: location,
          maxResponseBytes: 256 * 1024,
        });
      }
      if (response.status === 202) throw new MicrosoftGraphError("provider_down", "Asynchronous Excel session did not complete within the bounded poll window", 202, true, 2_000);
    }
    return requiredString(response.value.id, "workbook session ID");
  }

  async readRange(driveId: string, itemId: string, worksheetId: string, address: string, sessionId: string): Promise<Record<string, unknown>> {
    const response = await this.client.requestJson<Record<string, unknown>>({
      operation: "excel_read_range",
      pathOrUrl: workbookRangePath(driveId, itemId, worksheetId, address),
      headers: { "workbook-session-id": sessionId },
      maxResponseBytes: 1_048_576,
    });
    return response.value;
  }

  async writeRange(input: { driveId: string; itemId: string; worksheetId: string; address: string; sessionId: string; values?: unknown[][]; formulas?: string[][] }): Promise<Record<string, unknown>> {
    if (!input.values && !input.formulas) throw new MicrosoftGraphError("blocked_config", "Excel range write requires values or formulas", null, false);
    const response = await this.client.requestJson<Record<string, unknown>>({
      operation: "excel_write_range",
      pathOrUrl: workbookRangePath(input.driveId, input.itemId, input.worksheetId, input.address),
      method: "PATCH",
      headers: { "workbook-session-id": input.sessionId },
      body: { ...(input.values ? { values: input.values } : {}), ...(input.formulas ? { formulas: input.formulas } : {}) },
      maxResponseBytes: 1_048_576,
    });
    return response.value;
  }

  async calculate(driveId: string, itemId: string, sessionId: string, calculationType: "Recalculate" | "Full" | "FullRebuild" = "FullRebuild"): Promise<void> {
    await this.client.requestJson<Record<string, unknown>>({
      operation: "excel_calculate",
      pathOrUrl: `${workbookItemPath(driveId, itemId)}/application/calculate`,
      method: "POST",
      headers: { "workbook-session-id": sessionId },
      body: { calculationType },
      maxResponseBytes: 64 * 1024,
    });
  }

  async closeSession(driveId: string, itemId: string, sessionId: string): Promise<void> {
    await this.client.requestJson<Record<string, unknown>>({
      operation: "excel_close_session",
      pathOrUrl: `${workbookItemPath(driveId, itemId)}/closeSession`,
      method: "POST",
      headers: { "workbook-session-id": sessionId },
      body: {},
      maxResponseBytes: 64 * 1024,
    });
  }
}
