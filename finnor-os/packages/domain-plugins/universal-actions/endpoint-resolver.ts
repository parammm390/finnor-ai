import { withTenant } from "@finnor/db";
import { resolveParty } from "@finnor/read-models";
import type { UniversalCommunicationChannel, PartyRef } from "@finnor/shared-types";
import { sql } from "drizzle-orm";

export interface ResolvedCommunicationTarget {
  recipient: PartyRef;
  endpoint: string;
  displayName: string;
}

interface EndpointRow extends Record<string, unknown> {
  party_type: PartyRef["partyType"];
  party_id: string;
  display_name: string;
  endpoint: string | null;
}

function endpointSql(tenantId: string, ref: PartyRef, channel: Exclude<UniversalCommunicationChannel, "internal">) {
  const methodType = channel === "voice" ? "phone" : channel;
  return sql`
    SELECT * FROM (
      SELECT 'employee'::text party_type,u.id party_id,
             coalesce(nullif(btrim(u.display_name),''),'Employee') display_name,
             CASE WHEN ${channel}='email' THEN u.email ELSE u.phone_number END endpoint
      FROM finnor_os.users u
      WHERE u.tenant_id=${tenantId}::uuid AND u.status='active'
      UNION ALL
      SELECT 'external_organization',o.id,o.name,
             CASE WHEN ${channel}='email' THEN o.business_email ELSE o.business_phone END
      FROM finnor_os.external_organizations o WHERE o.tenant_id=${tenantId}::uuid AND o.active=true
      UNION ALL
      SELECT 'external_contact',c.id,c.name,
             CASE WHEN ${channel}='email' THEN c.business_email ELSE c.business_phone END
      FROM finnor_os.external_contacts c WHERE c.tenant_id=${tenantId}::uuid AND c.active=true
    ) endpoints
    WHERE party_type=${ref.partyType} AND party_id=${ref.partyId}::uuid
      AND endpoint IS NOT NULL AND btrim(endpoint)<>''
    ORDER BY party_type,party_id
  `;
}

/** Execution-only endpoint resolution. The return value is passed directly into the
 * scoped provider tool and must never be included in planner context or action output. */
export async function resolveCommunicationTargets(
  tenantId: string,
  ref: PartyRef,
  channel: Exclude<UniversalCommunicationChannel, "internal">,
  requesterEmployeeId?: string,
): Promise<ResolvedCommunicationTarget[]> {
  const resolved = await resolveParty(tenantId, { ref }, { requesterEmployeeId });
  if (resolved.status !== "resolved" || !resolved.party) {
    throw new Error(`PartyRef could not be resolved for execution (${resolved.status})`);
  }

  if (ref.partyType === "team" || ref.partyType === "location") {
    const result = await withTenant(tenantId, (db) => db.execute<EndpointRow>(sql`
      WITH members AS (
        SELECT DISTINCT u.id
        FROM finnor_os.users u
        LEFT JOIN finnor_os.org_unit_memberships m
          ON m.tenant_id=u.tenant_id AND m.employee_id=u.id AND m.active=true
        LEFT JOIN finnor_os.org_units o
          ON o.tenant_id=m.tenant_id AND o.id=m.org_unit_id AND o.active=true
        WHERE u.tenant_id=${tenantId}::uuid AND u.status='active'
          AND CASE WHEN ${ref.partyType}='team' THEN o.id=${ref.partyId}::uuid
                   ELSE u.primary_location_id=${ref.partyId}::uuid OR o.location_id=${ref.partyId}::uuid END
      )
      SELECT 'employee'::text party_type,u.id party_id,
             coalesce(nullif(btrim(u.display_name),''),'Employee') display_name,
             CASE WHEN ${channel}='email' THEN u.email ELSE u.phone_number END endpoint
      FROM members JOIN finnor_os.users u ON u.id=members.id AND u.tenant_id=${tenantId}::uuid
      WHERE CASE WHEN ${channel}='email' THEN u.email IS NOT NULL ELSE u.phone_number IS NOT NULL END
      ORDER BY u.id
    `));
    return result.rows
      .filter((row) => row.endpoint)
      .map((row) => ({ recipient: { partyType: "employee", partyId: row.party_id }, endpoint: row.endpoint!, displayName: row.display_name }));
  }

  const result = await withTenant(tenantId, (db) => db.execute<EndpointRow>(endpointSql(tenantId, ref, channel)));
  return result.rows.map((row) => ({ recipient: ref, endpoint: row.endpoint!, displayName: row.display_name }));
}

export async function expandInternalRecipients(tenantId: string, ref: PartyRef): Promise<PartyRef[]> {
  const resolved = await resolveParty(tenantId, { ref });
  if (resolved.status !== "resolved") throw new Error(`PartyRef could not be resolved for execution (${resolved.status})`);
  if (ref.partyType !== "team" && ref.partyType !== "location") return [ref];
  const result = await withTenant(tenantId, (db) => db.execute<{ party_id: string }>(sql`
    SELECT DISTINCT u.id party_id
    FROM finnor_os.users u
    LEFT JOIN finnor_os.org_unit_memberships m
      ON m.tenant_id=u.tenant_id AND m.employee_id=u.id AND m.active=true
    LEFT JOIN finnor_os.org_units o
      ON o.tenant_id=m.tenant_id AND o.id=m.org_unit_id AND o.active=true
    WHERE u.tenant_id=${tenantId}::uuid AND u.status='active'
      AND CASE WHEN ${ref.partyType}='team' THEN o.id=${ref.partyId}::uuid
               ELSE u.primary_location_id=${ref.partyId}::uuid OR o.location_id=${ref.partyId}::uuid END
    ORDER BY u.id
  `));
  return result.rows.map((row) => ({ partyType: "employee", partyId: row.party_id }));
}
