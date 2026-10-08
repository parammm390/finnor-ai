export type VercelReleaseComponent = "frontend" | "api" | "supplierCanaryApp" | "supplierCanaryAuth";
export function vercelProtectionEnvName(component: VercelReleaseComponent): string;
export function vercelProtectionHeaders(component: VercelReleaseComponent): {
  accept: string;
  "cache-control": string;
  "x-vercel-protection-bypass": string;
};
