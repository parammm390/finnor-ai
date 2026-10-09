export interface ProductionDatabaseTarget {
  host: string;
  supabaseUrl: string;
  schema: string;
}
export function assertProductionDatabaseTarget(connectionString: string, database: ProductionDatabaseTarget, kind: "owner" | "application" | "worker"): {
  host: string; projectRef: string; database: string; port: number; role: string;
};
export function verifyRestrictedApplicationRole(client: {
  query(sql: string, parameters?: string[]): Promise<{ rows: any[] }>;
}, database: ProductionDatabaseTarget, kind?: "application" | "worker"): Promise<{
  role: string; superuser: boolean; bypassRls: boolean; privilegedMembership: boolean;
  tenantTables: number; forcedTables: number; tenantTableOwnership: boolean;
}>;
