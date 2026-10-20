import { createHash } from "node:crypto";
import { withTenantTransaction } from "@finnor/db";
import { appendDocumentVersion, ensureProviderDocumentTx, loadDocumentVersion } from "@finnor/data-platform";
import { resolveMicrosoftProviderAuthContext } from "@finnor/security";
import { MicrosoftGraphClient } from "@finnor/provider-microsoft365";
import type { PeMutationContext } from "../types";
import type { DigitalInstitutionProfile } from "./contracts";
import { lockInstitutionSourceAuthority } from "./source-locks";

export interface InstalledMailGrant {
  id: string; integration_id: string; adapter_scope: string; external_id: string;
  source_id: string; source_class: string; external_object_type: string; protocol: string;
  provider: string; revision: string; original_sha256: string;
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** One exact installed source, not a generic caller-supplied URL or authority. */
export async function acquireInstalledMailOriginal(
  ctx: PeMutationContext, workId: string, grant: InstalledMailGrant, profile: DigitalInstitutionProfile,
): Promise<{ documentId: string; versionId: string; bytes: Buffer; retainedAt: string;
  providerOriginal:{sourceScopeId:string;externalId:string;retrievedAt:string} }> {
  if (grant.provider !== "microsoft_graph" || grant.source_class !== "email"
      || grant.external_object_type !== "message" || !['rfc822','installed_source_adapter'].includes(grant.protocol)
      || !grant.integration_id || !grant.adapter_scope || !grant.external_id
      || profile.bounds.authorizedAcquisitionCalls < 3) {
    throw new Error("X1_INSTALLED_ADAPTER_UNSUPPORTED_OR_ACQUISITION_BOUND");
  }
  const scope = await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true },
    async (_db, client) => client.query<{
      id: string; enabled: boolean; source_kind: string; configuration: { mailboxId?: string; folderId?: string };
      required_permissions: string[]; effective_permissions: string[];
    }>(
      `SELECT id::text,enabled,source_kind,configuration,required_permissions,effective_permissions
         FROM finnor_os.integration_source_scopes
        WHERE tenant_id=$1 AND integration_id=$2 AND provider=$3
          AND scope_key=$4 AND disabled_at IS NULL LIMIT 1`,
      [ctx.auth.tenantId, grant.integration_id, grant.provider, grant.adapter_scope],
    ));
  const installed = scope.rows[0];
  const mailboxId = installed?.configuration?.mailboxId;
  const folderId = installed?.configuration?.folderId;
  if (!installed?.enabled || installed.source_kind !== "outlook_mail_folder"
      || !mailboxId || !folderId || mailboxId.length > 512 || folderId.length > 512) {
    throw new Error("X1_INSTALLED_SOURCE_SCOPE_NOT_CURRENT");
  }
  const auth = await resolveMicrosoftProviderAuthContext({
    tenantId: ctx.auth.tenantId, integrationId: grant.integration_id,
  });
  if (installed.required_permissions.some((permission) =>
    !auth.consentedPermissions.includes(permission) || !installed.effective_permissions.includes(permission))) {
    throw new Error("X1_INSTALLED_SOURCE_PERMISSION_NOT_CURRENT");
  }
  const client = new MicrosoftGraphClient(auth);
  const path = `/users/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(grant.external_id)}`;
  const headers = { Prefer: 'IdType="ImmutableId"' };
  const metadata = async () => {
    const response = await client.requestJson<Record<string, unknown>>({
      operation: "x1.mail.original.metadata.read", pathOrUrl: `${path}?$select=id,parentFolderId,changeKey`,
      headers, maxResponseBytes: 128 * 1024,
    });
    if (response.value.id !== grant.external_id || response.value.parentFolderId !== folderId
        || response.value.changeKey !== grant.revision) {
      throw new Error("X1_INSTALLED_SOURCE_VERSION_OR_FOLDER_CHANGED");
    }
  };
  await metadata();
  const prior = await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true },
    async (_db, sql) => sql.query<{ document_id: string; document_version_id: string; byte_sha256: string; acquired_at:Date }>(
      `SELECT document_id::text,document_version_id::text,byte_sha256,acquired_at
         FROM finnor_os.x1_source_acquisitions WHERE tenant_id=$1 AND grant_id=$2`,
      [ctx.auth.tenantId, grant.id],
    ));
  if (prior.rows[0]) {
    const known = await withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, readOnly: true },
      async (db) => loadDocumentVersion(db, ctx.auth.tenantId,
        prior.rows[0]!.document_id, prior.rows[0]!.document_version_id));
    if (!known || known.bytes.length === 0 || known.bytes.length > profile.bounds.objectBytes
        || digest(known.bytes) !== grant.original_sha256
        || digest(known.bytes) !== prior.rows[0].byte_sha256) {
      throw new Error("X1_INSTALLED_ORIGINAL_RECEIPT_CHANGED");
    }
    return { documentId: prior.rows[0].document_id, versionId: prior.rows[0].document_version_id,
      bytes: known.bytes, retainedAt: new Date(prior.rows[0].acquired_at).toISOString(),
      providerOriginal:{sourceScopeId:installed.id,externalId:grant.external_id,retrievedAt:new Date(prior.rows[0].acquired_at).toISOString()} };
  }
  const response = await client.requestBytes({
    operation: "x1.mail.original.mime.read", pathOrUrl: `${path}/$value`, headers,
    maxResponseBytes: Math.min(profile.bounds.objectBytes, 10_485_760),
    acceptedContentTypes: ["message/rfc822", "text/plain", "application/octet-stream"],
  });
  const bytes = Buffer.from(response.value);
  if (!bytes.length || bytes.length > profile.bounds.objectBytes
      || digest(bytes) !== grant.original_sha256) throw new Error("X1_INSTALLED_ORIGINAL_DIGEST_OR_BOUND");
  await metadata();
  return withTenantTransaction(ctx.auth.tenantId, { userId: ctx.auth.userId, isolation: "serializable" },
    async (db, sql) => {
      await lockInstitutionSourceAuthority(ctx,sql,workId,[grant.id]);
      const locked = await sql.query(
        `SELECT 1 FROM finnor_os.x1_source_grants
          WHERE tenant_id=$1 AND id=$2 AND work_id=$3 AND principal_id=$4
            AND revoked_at IS NULL AND expires_at>clock_timestamp() AND revision=$5
            AND original_sha256=$6`,
        [ctx.auth.tenantId, grant.id, workId, ctx.auth.userId, grant.revision, grant.original_sha256],
      );
      const currentScope = await sql.query(
        `SELECT 1 FROM finnor_os.integration_source_scopes
          WHERE tenant_id=$1 AND id=$2 AND enabled AND disabled_at IS NULL
            AND source_kind='outlook_mail_folder' AND configuration->>'mailboxId'=$3
            AND configuration->>'folderId'=$4 FOR SHARE`,
        [ctx.auth.tenantId, installed.id, mailboxId, folderId],
      );
      if (!locked.rows[0] || !currentScope.rows[0]) throw new Error("X1_INSTALLED_AUTHORITY_CHANGED_DURING_RETENTION");
      const document = await ensureProviderDocumentTx(db, {
        tenantId: ctx.auth.tenantId, provider: "microsoft_graph",
        externalId: `x1:${grant.id}:${grant.external_id}`, kind: "x1_original_mail",
        title: `Original institutional mail ${grant.source_id}`, createdBy: ctx.auth.userId,
      });
      const version = await appendDocumentVersion(db, {
        tenantId: ctx.auth.tenantId, documentId: document.documentId, bytes,
        mediaType: "message/rfc822", format: "unknown", origin: "provider_observation",
        actor: ctx.auth.userId, sourceSystem: "microsoft_graph", sourceRef: grant.id,
        providerVersionId: grant.revision,
      });
      // Raw INSERT is revoked from finnor_app; the SECURITY DEFINER owner
      // function re-derives tenant/principal from the request GUCs and
      // cross-checks the referenced grant and document version digests.
      const inserted = await sql.query<{ document_id: string; document_version_id: string; byte_sha256: string; acquired_at:Date }>(
        `SELECT document_id::text,document_version_id::text,byte_sha256,acquired_at
           FROM finnor_os.x1_record_source_acquisition($1,$2,$3,$4,$5)`,
        [grant.id, document.documentId, version.id, digest(bytes), grant.revision],
      );
      if (!inserted.rows[0]) throw new Error("X1_CONCURRENT_SOURCE_ACQUISITION_RETRY");
      return { documentId: document.documentId, versionId: version.id, bytes,
        retainedAt: new Date(inserted.rows[0].acquired_at).toISOString(),
        providerOriginal:{sourceScopeId:installed.id,externalId:grant.external_id,retrievedAt:new Date(inserted.rows[0].acquired_at).toISOString()} };
    });
}
