#!/usr/bin/env node
// Z0-R12 access-gap measurement (PRD 4.4: "a second eligible scientific family ... chosen from a measured
// access gap rather than ceremonial registration"). Static, deterministic, read-only: it reads the committed
// tree and writes only the two evidence files named below. Nothing is hand-listed; every family, job type,
// operation and reader comes from the canonical sources named in `inputs`.
//
// Preregistered rule (written before the first run; the run output may not change it):
//   Universe U   : production job types that are registered in apps/worker/src/index.ts createWorker() and
//                  whose handler import resolves under packages/private-equity/src/<family>/.
//   Layers       : W worker job registered; K independent checker/verifier file in the family;
//                  O owner consumption (an exported *consum* function or a *consume* HTTP operation);
//                  F an existing end-to-end fixture under finnor-os/scripts that imports the family;
//                  Q a typed Work-level operational-query reader (operational-query-runtime.ts imports it);
//                  P an objective-loop/objective-success import of the family.
//   Eligible     : W && K && O && F, not a Project Z family (Z0 earns no new scientific credit) and not a
//                  family Z0's own X1 to X2 bridge already imports (the first family; "second" excludes it).
//   Attribution  : an HTTP operation counts for a family only if the route is owned by @finnor/private-equity and
//                  imports exactly one family, or (company-brain) its operation literal sits in that family's
//                  own api/handler/service files. Cross-cutting owner routes belong to no family.
//   Access gap   : eligible && !Q && !P  (the family computes and is consumed, but ordinary Work cannot
//                  request/observe it through its typed query plane).
//   gapSize      : number of the family's HTTP operations that the canonical coverage audit classifies as
//                  BACKEND_API_NO_MOUNTED_FRONTEND (observed access deficiency).
//   Selection    : maximum gapSize; ties -> fewer source lines (less change surface); then family name.
//
// usage: node scripts/project-z/z0/measure-access-gap.mjs [--root=<repo root>] [--out=<dir>]
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, relative, basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? "").slice(name.length + 3) || fallback;
const root = resolve(arg("root", join(import.meta.dirname, "..", "..", "..", "..")));
const os = join(root, "finnor-os");
const outDir = resolve(arg("out", join(root, "scope-z", "phase-evidence", "z0")));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const read = (p) => readFileSync(p, "utf8");
const inputs = {};
const input = (p) => { const text = read(join(root, p)); inputs[p] = sha(text); return text; };

const walk = (dir, accept, out = []) => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, accept, out); else if (accept(p)) out.push(p);
  }
  return out;
};
const isSource = (p) => /\.(ts|mts|mjs|tsx)$/.test(p) && !/\.(test|spec)\.|\.d\.ts$/.test(p) && !p.endsWith("migrations-bundle.ts");

const contract = await import(pathToFileURL(join(os, "packages/db/compute-contract.ts")).href);
inputs["finnor-os/packages/db/compute-contract.ts"] = sha(read(join(os, "packages/db/compute-contract.ts")));
const jobTypes = Object.keys(contract.PRODUCTION_JOB_CONTRACTS).sort();

// --- worker registration: job -> handler identifier -> import path -> family -----------------------------
const workerText = input("finnor-os/apps/worker/src/index.ts");
const importOf = new Map();
for (const m of workerText.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g))
  for (const part of m[1].split(",")) { const id = part.trim().split(/\s+as\s+/).pop(); if (id) importOf.set(id, m[2]); }
const familyOfPath = (p) => {
  const m = /private-equity\/src\/(project-z\/[a-z0-9-]+|[a-z0-9-]+)/.exec(p);
  return m ? m[1] : null;
};
const registrations = new Map();
for (const m of workerText.matchAll(/queue\.register\(\s*['"]([a-z0-9_]+)['"]\s*,([^\n]*?),\s*PRODUCTION_JOB_CONTRACTS\./g)) {
  const [, job, expr] = m;
  const ids = [...expr.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((x) => x[0]).filter((id) => importOf.has(id));
  const family = ids.map((id) => familyOfPath(importOf.get(id))).find(Boolean) ?? null;
  registrations.set(job, { handlerImports: ids.map((id) => importOf.get(id)), family });
}

// --- family source inventory ---------------------------------------------------------------------------
const peSrc = join(os, "packages/private-equity/src");
const familyDirs = [];
for (const name of readdirSync(peSrc)) {
  const p = join(peSrc, name);
  if (!statSync(p).isDirectory()) continue;
  if (name === "project-z") for (const z of readdirSync(p)) { if (statSync(join(p, z)).isDirectory()) familyDirs.push(`project-z/${z}`); }
  else familyDirs.push(name);
}
const filesOf = new Map(familyDirs.map((f) => [f, walk(join(peSrc, f), isSource)]));
const linesOf = (f) => filesOf.get(f).reduce((n, p) => n + read(p).split("\n").length, 0);

// --- HTTP surface from the canonical coverage audit ----------------------------------------------------
const coverageText = input("docs/centropy/capability-coverage.json");
const coverage = JSON.parse(coverageText);
const gapIds = new Set(coverage.backendApiWithoutMountedFrontend.map((g) => (typeof g === "string" ? g : g.capabilityId)));
const opHits = (op) => {
  const needle = [`'${op}'`, `"${op}"`, `\`${op}\``];
  const hits = new Map();
  for (const f of familyDirs) for (const p of filesOf.get(f)) { const t = read(p); if (needle.some((n) => t.includes(n))) hits.set(f, [...(hits.get(f) ?? []), basename(p)]); }
  return hits;
};
const httpByFamily = new Map(familyDirs.map((f) => [f, { operations: [], gapOperations: [] }]));
const ambiguous = [], unresolved = [], notAttributed = [];
for (const cap of coverage.capabilities) {
  if (cap.transport !== "http") continue;
  let fams = [];
  const op = /^POST \/api\/company-brain\/([a-z0-9-]+)$/.exec(cap.actualRouteOrTool ?? "")?.[1];
  if (op) {
    const hits = opHits(op);
    fams = [...hits.keys()];
    if (fams.length > 1) {
      const api = fams.filter((f) => hits.get(f).some((b) => /^(api|handler|service|operations|v2-api)\.ts$/.test(b)));
      if (api.length === 1) fams = api; else { ambiguous.push({ capabilityId: cap.capabilityId, families: fams }); fams = []; }
    } else if (fams.length === 0) unresolved.push(cap.capabilityId);
  } else {
    // Failure model M2: a route is credited to a family only when the persistence package owns the route and it imports
    // exactly one family. Cross-cutting owner routes (S5 allocations, S6 obligations, ...) import helpers and belong to no family.
    const routeText = existsSync(join(root, cap.source)) ? read(join(root, cap.source)) : "";
    const imported = [...new Set([...routeText.matchAll(/private-equity\/src\/(project-z\/[a-z0-9-]+|[a-z0-9-]+)/g)].map((m) => m[1]))].filter((f) => httpByFamily.has(f));
    if (cap.owner === "@finnor/private-equity" && imported.length === 1) fams = imported;
    else if (imported.length) notAttributed.push({ capabilityId: cap.capabilityId, owner: cap.owner, importedFamilies: imported, unmountedGap: gapIds.has(cap.capabilityId) });
  }
  for (const f of fams) {
    const row = httpByFamily.get(f);
    row.operations.push(cap.capabilityId);
    if (gapIds.has(cap.capabilityId)) row.gapOperations.push(cap.capabilityId);
  }
}

// --- Work-level reachability ---------------------------------------------------------------------------
const importedFamilies = (text) => new Set([...text.matchAll(/from\s*['"][^'"]*private-equity\/src\/(project-z\/[a-z0-9-]+|[a-z0-9-]+)/g)].map((m) => m[1]));
// The first family is whatever Z0's own X1 to X2 bridge already delivers; "second" excludes it (failure model M3).
const firstFamilies = new Set(walk(join(os, "packages/orchestration/src/project-z/z0-convergence"), isSource).flatMap((p) => [...importedFamilies(read(p))]));
const queryRuntime = input("finnor-os/packages/orchestration/src/operational-query-runtime.ts");
const objectiveLoop = input("finnor-os/packages/orchestration/src/objective-loop.ts");
const objectiveSuccess = input("finnor-os/packages/orchestration/src/objective-success.ts");
input("finnor-os/packages/shared-types/src/operational-queries.ts");
input("finnor-os/apps/api/app/api/company-brain/[operation]/route.ts");
const queryFamilies = importedFamilies(queryRuntime);
const objectiveFamilies = new Set([...importedFamilies(objectiveLoop), ...importedFamilies(objectiveSuccess)]);

const scriptFiles = walk(join(os, "scripts"), (p) => /\.(ts|mts|mjs|cjs)$/.test(p) && !p.includes("/scripts/project-z/"));
const scriptText = scriptFiles.map((p) => [relative(os, p), read(p)]);

const rows = [];
for (const family of familyDirs) {
  const jobs = [...registrations].filter(([, r]) => r.family === family).map(([job]) => job).sort();
  const files = filesOf.get(family);
  const K = files.filter((p) => /(checker|verifier)/i.test(basename(p)) || /(checker|verifier)\.(py|mts|mjs|rs)/.test(read(p))).map((p) => relative(os, p));
  const consumeFns = files.flatMap((p) => [...read(p).matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w*[Cc]onsum\w*)/g)].map((m) => `${relative(os, p)}:${m[1]}`));
  const http = httpByFamily.get(family);
  const consumeOps = http.operations.filter((id) => /consume/.test(id));
  const F = scriptText.filter(([, t]) => t.includes(`private-equity/src/${family}/`) || t.includes(`private-equity/src/${family}'`) || t.includes(`private-equity/src/${family}"`)).map(([p]) => p);
  const Q = queryFamilies.has(family), P = objectiveFamilies.has(family);
  const W = jobs.length > 0, O = consumeFns.length > 0 || consumeOps.length > 0;
  const projectZ = family.startsWith("project-z/");
  const first = firstFamilies.has(family);
  const eligible = W && K.length > 0 && O && F.length > 0 && !projectZ && !first;
  rows.push({
    family, jobs, projectZ, first, W, K: K.length > 0, O, F: F.length > 0, Q, P, eligible, gap: eligible && !Q && !P,
    gapSize: http.gapOperations.length, httpOperations: http.operations.length, sourceLines: linesOf(family),
    evidence: { checkers: K.slice(0, 4), consumers: [...consumeFns.slice(0, 4), ...consumeOps.slice(0, 4)], fixtures: F.slice(0, 5), gapOperations: http.gapOperations },
  });
}
const candidates = rows.filter((r) => r.gap).sort((a, b) => b.gapSize - a.gapSize || a.sourceLines - b.sourceLines || a.family.localeCompare(b.family));
const selected = candidates[0] ?? null;

const sourceManifest = sha(familyDirs.flatMap((f) => filesOf.get(f).map((p) => `${relative(os, p)} ${sha(read(p))}`)).sort().join("\n"));
const head = (() => { try { return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return null; } })();
const report = {
  schema: "finnor.z0.access-gap-measurement/v1",
  sourceHead: head,
  rule: "see script header; preregistered before the first run",
  inputs, familySourceManifestSha256: sourceManifest,
  counts: { productionJobTypes: jobTypes.length, registeredJobTypes: registrations.size, unregisteredProductionJobTypes: jobTypes.filter((j) => !registrations.has(j)),
    familiesMeasured: rows.length, familiesWithWorker: rows.filter((r) => r.W).length, eligible: rows.filter((r) => r.eligible).length, accessGap: candidates.length,
    httpCapabilitiesInGapFamilies: candidates.reduce((n, r) => n + r.httpOperations, 0), gapOperationsInGapFamilies: candidates.reduce((n, r) => n + r.gapSize, 0),
    totalCoverageGapRows: gapIds.size, companyBrainOperationsAmbiguous: ambiguous.length, companyBrainOperationsUnresolved: unresolved.length },
  selected: selected && { family: selected.family, jobs: selected.jobs, gapSize: selected.gapSize, sourceLines: selected.sourceLines },
  ranking: candidates.map((r) => ({ family: r.family, gapSize: r.gapSize, sourceLines: r.sourceLines, jobs: r.jobs })),
  firstFamilies: [...firstFamilies].sort(),
  families: rows,
  ambiguous, unresolved, notAttributed,
  limits: ["Static analysis: a job registered through a handler that is not imported by name in worker index.ts is reported as unregistered.",
    "Operation-to-family resolution uses the quoted operation literal inside packages/private-equity/src; unresolved or ambiguous rows are listed, never guessed.",
    "O (consumption) is detected from exported *consum* functions and *consume* operations; a family that consumes under another name is reported as not O.",
    "Reachability by ordinary Work through the typed query plane is Q/P; a mounted panel alone does not count (research/z0-convergence-proposal.md)."],
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "access-gap-measurement.json"), JSON.stringify(report, null, 2) + "\n");
const md = [
  "# Z0-R12 access-gap measurement", "",
  `Source head: \`${head}\`. Family source manifest sha256: \`${sourceManifest}\`.`, "",
  `Rule (preregistered in \`scripts/project-z/z0/measure-access-gap.mjs\`): eligible = W and K and O and F and not Project Z; access gap = eligible and not Q and not P; selection = max gapSize, then fewer source lines.`, "",
  `Counts: ${JSON.stringify(report.counts)}`, "",
  "| rank | family | gapSize | http ops | source lines | job types |", "|---|---|---|---|---|---|",
  ...candidates.map((r, i) => `| ${i + 1} | ${r.family} | ${r.gapSize} | ${r.httpOperations} | ${r.sourceLines} | ${r.jobs.join(", ")} |`), "",
  `Selected: **${selected ? selected.family : "none"}**.`, "",
  "Excluded families (worker present):", "",
  ...rows.filter((r) => r.W && !r.gap).map((r) => `- ${r.family}: ${["W","K","O","F","Q","P"].map((k) => `${k}=${r[k] ? "y" : "n"}`).join(" ")}${r.projectZ ? " (Project Z)" : ""}${r.first ? " (first family)" : ""}`), "",
  `First families (imports of z0-convergence, excluded): ${[...firstFamilies].sort().join(", ")}`, "",
  `Routes not credited to any family (shared import or non-persistence owner): ${notAttributed.length}, of which unmounted-gap rows: ${notAttributed.filter((n) => n.unmountedGap).length}`, "",
].join("\n");
writeFileSync(join(outDir, "access-gap-measurement.md"), md + "\n");
console.log(JSON.stringify({ selected: report.selected, counts: report.counts, ranking: report.ranking }, null, 1));
