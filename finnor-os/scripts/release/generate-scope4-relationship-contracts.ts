import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { COMPANY_BRAIN_RELATIONSHIP_REGISTRY } from "@finnor/private-equity";

const output = resolve("docs/release/phase4-relationship-contracts.md");
const cell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");
const rows = COMPANY_BRAIN_RELATIONSHIP_REGISTRY.map((contract) => {
  const proof = `${contract.persistedProof}; sources: ${contract.persistedSources.map((source) => `${source.table}(${source.columns.join(",")})`).join(" + ")}`;
  return `| ${cell(contract.kind)} | ${cell(contract.sourceOwner)} | ${cell(contract.mutationOwner)} | ${contract.direction} | ${cell(contract.cardinality)} | ${cell(contract.validTimeBehavior)} | ${cell(contract.historyBehavior)} | ${cell(contract.exclusivityRule)} | ${cell(contract.cycleRule)} | ${cell(contract.tenantRule)} | ${cell(proof)} |`;
});
const document = `# Phase 4 Company Brain relationship contracts

Generated from \`COMPANY_BRAIN_RELATIONSHIP_REGISTRY\`. This is a certification artifact over the existing runtime registry; it does not create another relationship subsystem.

| Kind | Canonical owner | Mutation owner | Direction | Cardinality | Valid time | Knowledge/history | Exclusivity | Cycles | Tenant boundary | Persisted proof |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
`;

if (process.argv.includes("--check")) {
  const current = readFileSync(output, "utf8");
  if (current !== document) throw new Error("Phase 4 relationship contract matrix is stale; regenerate it");
  console.log(`PASS relationship-contract-matrix ${rows.length}`);
} else {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, document);
  console.log(`WROTE ${output} (${rows.length} contracts)`);
}
