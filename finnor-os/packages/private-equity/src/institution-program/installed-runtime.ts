import { createRequire } from "node:module";

export type DevelopmentInstallation = {
  root: string; manifestPath: string; manifestDigest: string;
  manifest: { source: { commit: string; tree: string }; runtime: Record<string, string>;
    files: Array<{ path: string; sha256: string }>; checkerPins: string[];
    entrypoints: Record<string, string> };
  entrypoint(name: string): string; checkerPins(): Record<string, string>;
};
// This URL is transformed per original module by the development compiler.
// The custody package itself stays external and resolves its own physical root.
const custody = createRequire(import.meta.url)("../../../source-custody/installation.cjs") as {
  installedRuntime(required?: boolean): DevelopmentInstallation | null;
};
export const installedDevelopmentRuntime = (required = false) => custody.installedRuntime(required);

export function assertInstalledDevelopmentSchema(names: string[], installation = installedDevelopmentRuntime(true)!) {
  const expected = installation.manifest.files.map(p => p.path)
    .filter(p => p.startsWith('finnor-os/packages/db/migrations/') && p.endsWith('.sql'))
    .map(p => p.slice('finnor-os/packages/db/migrations/'.length)).sort();
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expected)) throw Error('X1_INSTALLED_SCHEMA_LINEAGE_MISMATCH');
}
