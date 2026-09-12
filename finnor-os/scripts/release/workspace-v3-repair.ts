import pg from "pg";
import { z } from "zod";
import { pgConnectionConfig } from "@finnor/db";
import {
  DEFAULT_WORKSPACE_CONFIG,
  EXPERIENCE_SCENES,
  WORKSPACE_SURFACES,
  WorkspaceConfigSchema,
  type TenantExperienceManifestV3,
  type WorkspaceSurfaceKey,
} from "../../apps/api/lib/workspace-config";

const LegacyPresentationSchema = z.object({
  voiceEnabled: z.boolean().optional(),
  terminology: z.record(z.unknown()).optional(),
  navigationPriority: z.array(z.unknown()).optional(),
  brand: z.record(z.unknown()).optional(),
  visibility: z.record(z.unknown()).optional(),
  scenes: z.record(z.unknown()).optional(),
}).passthrough();

function stringPreference(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : fallback;
}

function enumPreference<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

/**
 * Release-only data repair for pre-V3 rows. Removed domain fields are never
 * interpreted. Only neutral presentation preferences cross the cutover; every
 * product surface, role, metric, action, projection, vocabulary key/value and
 * extension comes from the canonical Private Equity V3 manifest.
 */
export function convertLegacyWorkspacePresentation(value: unknown): TenantExperienceManifestV3 {
  const current = WorkspaceConfigSchema.safeParse(value);
  if (current.success) return current.data;

  const parsed = LegacyPresentationSchema.safeParse(value);
  if (!parsed.success) return structuredClone(DEFAULT_WORKSPACE_CONFIG);

  const source = parsed.data;
  const defaults = DEFAULT_WORKSPACE_CONFIG;
  const terminology = source.terminology ?? {};
  const brand = source.brand ?? {};
  const visibility = source.visibility ?? {};
  const scenes = source.scenes ?? {};
  const preferredOrder = (source.navigationPriority ?? []).filter(
    (entry): entry is WorkspaceSurfaceKey => typeof entry === "string" && WORKSPACE_SURFACES.includes(entry as WorkspaceSurfaceKey),
  );
  const navigationPriority = [...new Set([...preferredOrder, ...defaults.navigationPriority])] as WorkspaceSurfaceKey[];
  const normalizedScenes = Object.fromEntries(EXPERIENCE_SCENES.map((scene) => {
    const candidate = typeof scenes[scene] === "object" && scenes[scene] !== null
      ? scenes[scene] as Record<string, unknown>
      : {};
    return [scene, {
      detail: enumPreference(candidate.detail, ["compact", "balanced", "detailed"] as const, defaults.scenes[scene].detail),
      emphasis: enumPreference(candidate.emphasis, ["presence", "context", "evidence"] as const, defaults.scenes[scene].emphasis),
    }];
  })) as TenantExperienceManifestV3["scenes"];

  return WorkspaceConfigSchema.parse({
    ...defaults,
    terminology: {
      home: stringPreference(terminology.home, defaults.terminology.home, 24),
      work: stringPreference(terminology.work, defaults.terminology.work, 24),
      deals: stringPreference(terminology.deals, defaults.terminology.deals, 24),
      agents: stringPreference(terminology.agents, defaults.terminology.agents, 24),
    },
    voiceEnabled: source.voiceEnabled ?? defaults.voiceEnabled,
    navigationPriority,
    brand: {
      accent: enumPreference(brand.accent, ["cyan", "teal", "amber", "violet"] as const, defaults.brand.accent),
      surfaceTone: enumPreference(brand.surfaceTone, ["ink", "slate", "sand"] as const, defaults.brand.surfaceTone),
      radius: enumPreference(brand.radius, ["precise", "soft"] as const, defaults.brand.radius),
      density: enumPreference(brand.density, ["compact", "balanced", "spacious"] as const, defaults.brand.density),
      typography: enumPreference(brand.typography, ["system", "editorial", "technical"] as const, defaults.brand.typography),
      motion: enumPreference(brand.motion, ["restrained", "standard", "expressive"] as const, defaults.brand.motion),
      mark: stringPreference(brand.mark, defaults.brand.mark, 3),
      logoAssetKey: "finnor",
    },
    visibility: {
      policy: typeof visibility.policy === "boolean" ? visibility.policy : defaults.visibility.policy,
      authority: typeof visibility.authority === "boolean" ? visibility.authority : defaults.visibility.authority,
    },
    scenes: normalizedScenes,
  });
}

export interface WorkspaceV3RepairReport {
  totalRows: number;
  alreadyV3: number;
  repaired: number;
  verifiedV3: number;
}

export async function repairWorkspaceV3Rows(databaseUrl: string): Promise<WorkspaceV3RepairReport> {
  const client = new pg.Client(pgConnectionConfig(databaseUrl));
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    const rows = await client.query<{ tenant_id: string; workspace_config: unknown }>(
      "SELECT tenant_id, workspace_config FROM finnor_os.tenant_settings ORDER BY tenant_id FOR UPDATE",
    );
    let alreadyV3 = 0;
    let repaired = 0;
    for (const row of rows.rows) {
      if (WorkspaceConfigSchema.safeParse(row.workspace_config).success) {
        alreadyV3 += 1;
        continue;
      }
      const workspace = convertLegacyWorkspacePresentation(row.workspace_config);
      await client.query(
        "UPDATE finnor_os.tenant_settings SET workspace_config=$2::jsonb, updated_at=now() WHERE tenant_id=$1",
        [row.tenant_id, JSON.stringify(workspace)],
      );
      repaired += 1;
    }

    const verified = await client.query<{ workspace_config: unknown }>(
      "SELECT workspace_config FROM finnor_os.tenant_settings ORDER BY tenant_id",
    );
    for (const row of verified.rows) WorkspaceConfigSchema.parse(row.workspace_config);
    if (verified.rowCount !== rows.rowCount) throw new Error("Workspace V3 repair row count changed during its locked transaction");
    await client.query("COMMIT");
    return {
      totalRows: rows.rowCount ?? 0,
      alreadyV3,
      repaired,
      verifiedV3: verified.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
