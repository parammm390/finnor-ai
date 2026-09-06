import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function manifestPaths(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return manifestPaths(path);
    return entry.name === "package.json" ? [path] : [];
  });
}

function cycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const found: string[][] = [];
  const visited = new Set<string>();
  const active: string[] = [];
  const visit = (node: string): void => {
    const activeIndex = active.indexOf(node);
    if (activeIndex >= 0) {
      found.push([...active.slice(activeIndex), node]);
      return;
    }
    if (visited.has(node)) return;
    active.push(node);
    for (const dependency of graph.get(node) ?? []) visit(dependency);
    active.pop();
    visited.add(node);
  };
  for (const node of [...graph.keys()].sort()) visit(node);
  return found;
}

describe("P3 import boundary", () => {
  it("keeps epistemic runtime below orchestration with no reverse or transitive package cycle", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    const manifests = manifestPaths(root).map((path) => JSON.parse(readFileSync(path, "utf8")) as Manifest);
    const names = new Set(manifests.flatMap((manifest) => manifest.name ? [manifest.name] : []));
    const graph = new Map<string, string[]>();
    for (const manifest of manifests) {
      if (!manifest.name) continue;
      const declared = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
      graph.set(manifest.name, Object.keys(declared).filter((dependency) => names.has(dependency)).sort());
    }
    expect(graph.get("@finnor/epistemic-runtime")).toEqual(["@finnor/shared-types"]);
    expect(graph.get("@finnor/shared-types") ?? []).not.toContain("@finnor/epistemic-runtime");
    expect(cycles(graph)).toEqual([]);
  });
});
