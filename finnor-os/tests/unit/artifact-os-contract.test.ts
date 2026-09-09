import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string): string => readFileSync(resolve(ROOT, path), "utf8");

function sourceTree(path: string): string {
  const root = resolve(ROOT, path);
  const files: string[] = [];
  const visit = (entry: string) => {
    if (statSync(entry).isDirectory()) {
      for (const child of readdirSync(entry)) visit(join(entry, child));
    } else if (/\.(?:ts|tsx|json)$/.test(entry)) {
      files.push(entry);
    }
  };
  visit(root);
  return files.sort().map((file) => readFileSync(file, "utf8")).join("\n");
}

describe("P3 Artifact OS architecture and workspace contract", () => {
  it("keeps package dependency direction within the certified architecture", () => {
    const ooxml = sourceTree("packages/ooxml");
    for (const forbidden of ["@finnor/private-equity", "@finnor/orchestration", "@finnor/authority", "@finnor/provider-microsoft365"]) {
      expect(ooxml, forbidden).not.toContain(forbidden);
    }

    for (const packagePath of ["packages/spreadsheet-ir", "packages/document-ir", "packages/presentation-ir"]) {
      const ir = sourceTree(packagePath);
      for (const forbidden of ["@finnor/db", "@finnor/private-equity", "@finnor/provider-microsoft365", "@finnor/orchestration", "@finnor/authority"]) {
        expect(ir, `${packagePath} -> ${forbidden}`).not.toContain(forbidden);
      }
    }

    const provider = sourceTree("packages/provider-microsoft365");
    for (const forbidden of ["@finnor/spreadsheet-ir", "@finnor/document-ir", "@finnor/presentation-ir", "@finnor/private-equity"]) {
      expect(provider, forbidden).not.toContain(forbidden);
    }
    expect(sourceTree("packages/spreadsheet-ir")).not.toMatch(/@finnor\/(?:underwriting|phase4|p4)/i);
  });

  it("keeps Core Document as the only logical artifact owner", () => {
    const migrations = sourceTree("packages/db/migrations");
    expect(migrations).not.toMatch(/CREATE\s+TABLE\s+finnor_os\.(?:artifacts|pe_artifacts)\b/i);
    const peTypes = read("packages/private-equity/src/types.ts");
    expect(peTypes).not.toMatch(/["']pe_artifact["']/);
    expect(read("packages/db/migrations/0119_document_artifact_versions.sql")).toContain("FOREIGN KEY(tenant_id,document_id) REFERENCES finnor_os.documents");
  });

  it("exposes a functional authenticated Artifact Workspace without pretending to render Office", () => {
    const page = read("apps/console/app/artifacts/[id]/page.tsx");
    const summaryRoute = read("apps/api/app/api/documents/[id]/artifact/route.ts");
    const actionRoute = read("apps/api/app/api/documents/[id]/artifact/[...action]/route.ts");

    expect(summaryRoute).toContain("requireContext(req)");
    expect(actionRoute).toContain("requireContext(req)");
    expect(page).toContain('aria-label="Version timeline"');
    expect(page).toContain("summary.versions.map");
    expect(page).toContain('head.kind === "provider"');
    expect(page).toContain('head.kind === "draft"');
    expect(page).toContain("selectedNode.data.formula");
    expect(page).toContain("selectedNode.data.cached");
    expect(page).toContain("selectedNode.data.calculation");
    expect(page).toContain("selectedNode.data.dependencies");
    expect(page).toContain("selectedNode.data.dependents");
    expect(page).toContain("/artifact/diff?left=");
    expect(page).toContain("/artifact/patches");
    expect(page).toContain("Create immutable draft version");
    expect(page).toContain("/artifact/publish");
    expect(page).toContain("latestExternalOperation.status");
    expect(page).toMatch(/conflict\|failed\|stale\|unverified/);
    expect(page).toContain("selectedCollaboration?.bindings");
    expect(page).toContain("does not imitate Office rendering");
    expect(page).toContain("Provider and local draft heads stay separate");
  });

  it("documents every Artifact Workspace route and every bounded inspector query", () => {
    const generator = read("scripts/generate-openapi.ts");
    for (const path of [
      "/api/artifacts",
      "/api/documents/{id}/artifact",
      "/api/documents/{id}/artifact/ir/{versionId}",
      "/api/documents/{id}/artifact/context",
      "/api/documents/{id}/artifact/drafts",
      "/api/documents/{id}/artifact/patches",
      "/api/documents/{id}/artifact/publish",
      "/api/documents/{id}/artifact/publish-new",
      "/api/documents/{id}/artifact/recalculate",
    ]) expect(generator, path).toContain(`"${path}"`);
    for (const parameter of ["sheetId", "address", "range", "dependencyOf", "dependentOf", "offset", "limit"]) {
      expect(generator, parameter).toContain(`name: "${parameter}"`);
    }
  });

  it("materializes provider bytes only for a live Core Document and preserves replay boundaries", () => {
    const handler = read("apps/worker/src/handlers/materialize-artifact-version.ts");
    const worker = read("apps/worker/src/index.ts");
    const sourceSync = read("apps/worker/src/handlers/sync-source.ts");

    expect(worker).toContain('queue.register("materialize_artifact_version", materializeArtifactVersion)');
    expect(sourceSync).toContain('"materialize_artifact_version",');
    expect(sourceSync).toContain("artifact-materialize:");
    expect(handler).toContain("d.archived_at IS NULL");
    expect(handler).toContain("expectedETag");
    expect(handler).toContain("provider_fetch_race");
    expect(handler).toContain("byte_sha256");
    expect(handler).toContain("provider_head");
    expect(handler).toContain("current_head");
  });
});
