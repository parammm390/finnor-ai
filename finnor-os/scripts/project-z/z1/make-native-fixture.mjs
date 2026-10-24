/** Materializes public original inputs from explicitly delivered EXISTING IDs.
 * This offline command has no database, Auth, grant, stack or listener code. */
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { UUID, RootSchema, RefSchema, PinSchema } from "../../../packages/private-equity/src/project-z/z1-shared-work/native-contracts.ts";

const bindingSchema = z.object({
  schema: z.literal("finnor.z1.existing-public-fixture-bindings.v1"),
  dataClass: z.literal("PUBLIC_DETERMINISTIC_FIXTURE_NO_PII"),
  episodeId: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
  tenantId: UUID, principalId: UUID, root: RootSchema, foreignRoot: RootSchema, foreignWorkId: UUID,
  rightsRevision: z.string().regex(/^(0|[1-9]\d{0,8})$/), deadlineAt: z.string().datetime(),
  resources: z.object({ logical: RefSchema, cpu: RefSchema, storage: RefSchema, memory: RefSchema }).strict(),
  sources: z.object({ ledger: PinSchema, dimension: PinSchema }).strict(),
  works: z.array(z.object({ workId: UUID, inputId: UUID, inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    declaration: PinSchema, unresolvedObligationRefs: z.array(z.string().min(1).max(256)).max(4096),
    investmentCaseId: UUID.optional() }).strict()).length(3),
}).strict();
const inputIndex = process.argv.indexOf("--bindings"), outputIndex = process.argv.indexOf("--output");
const input = process.argv[inputIndex + 1], output = process.argv[outputIndex + 1];
if (inputIndex < 0 || outputIndex < 0 || !isAbsolute(input) || !isAbsolute(output)) throw Error("ABSOLUTE_EXISTING_BINDINGS_AND_NEW_OUTPUT_REQUIRED");
const bytes = await readFile(input); if (bytes.length > 1048576) throw Error("BINDING_BYTE_BOUND");
const bindings = bindingSchema.parse(JSON.parse(bytes));
if (new Set(bindings.works.map(work => work.workId)).size !== 3 || bindings.works[0].unresolvedObligationRefs.length ||
    !bindings.works[1].investmentCaseId || !bindings.works[2].investmentCaseId ||
    !bindings.works[2].unresolvedObligationRefs.length) throw Error("THREE_DISTINCT_ORIGINALS_AND_EXISTING_OBLIGATION_REQUIRED");
const money = { kind: "rational", unit: "money", currency: "USD" }, text = { kind: "text" };
const scalar = { kind: "rational", unit: "1", currency: null };
const field = name => ({ op: "field", name });
const literal = (value, type) => ({ op: "literal", value, type });
const partition = { tenantId: bindings.tenantId, principalId: bindings.principalId,
  permittedUse: "Z1_EXACT_DERIVATION_FOR_ORIGINAL_WORK", rightsRevision: bindings.rightsRevision, classification: "INTERNAL" };
const ledger = { id: "ledger", revision: "ledger-1", partition, columns: { company: text, amount: money },
  rows: [{ company: "ALPHA", amount: "11/3" }, { company: "ALPHA", amount: "11/3" },
    { company: "BETA", amount: "-1/2" }, { company: "GAMMA", amount: "9/2" }],
  revoked: false, evidenceClass: "deterministic" };
const dimension = { id: "dimension", revision: "dimension-1", partition, columns: { company: text, parent: text },
  rows: [{ company: "ALPHA", parent: "GROUP_X" }, { company: "BETA", parent: "GROUP_Y" },
    { company: "GAMMA", parent: "GROUP_X" }], revoked: false, evidenceClass: "deterministic" };
const source = { id: "source", op: "source", sourceId: "ledger" };
const sum = (id, input, keys) => ({ id, op: "sum", input, keys, values: { amount: field("amount") }, empty: "zero" });
const select = (id, input, limit) => ({ id, op: "select", input, limit, ties: "CANONICAL_ROW",
  order: [{ field: "amount", direction: "desc" }, { field: "company", direction: "asc" }] });
const programmes = [
  { nodes: [source, { id: "scale", op: "project", input: "source", semantics: "bag",
    fields: { company: field("company"), amount: { op: "mul", left: field("amount"), right: literal("3/2", scalar) } } },
  sum("answer", "scale", [])], output: "answer" },
  { nodes: [source, sum("group", "source", ["company"]), select("answer", "group", 2)], output: "answer" },
  { nodes: [source, { id: "dimension", op: "source", sourceId: "dimension" },
    { id: "join", op: "join", left: "source", right: "dimension", on: [{ left: "company", right: "company" }], rightPrefix: "d_" },
    { id: "project", op: "project", input: "join", semantics: "bag", fields: { company: field("d_parent"), amount: field("amount") } },
    sum("group", "project", ["company"]), select("answer", "group", 2)], output: "answer" },
];
const works = bindings.works.map((binding, index) => ({
  work: { id: binding.workId, partition, inputRef: binding.inputId, programmeRevision: `original-${index}-1`,
    objectiveRevision: `objective-${index}-1`, termsRevision: "terms-1", modelRevision: "declared-exact-model-1",
    unitsRevision: "exact-usd-1", codeRevision: "z1-shared-work-v1", checkerRevision: "z1-original-fraction-v1",
    programme: programmes[index], parameters: {}, unresolvedObligationRefs: [...binding.unresolvedObligationRefs].sort(), withdrawn: false },
  consumer: index === 0 ? { owner: "S3", kind: "EXACT_FINANCIAL_RELATION", measureField: "amount" } :
    { owner: "S4", kind: "EXACT_REGISTERED_CHOICE", investmentCaseId: binding.investmentCaseId,
      decisionType: "Z1_DISPOSABLE_EXACT_CHOICE", title: `Public original exact choice ${index}`,
      actionField: "company", valueField: "amount", direction: "MAXIMIZE" },
  declarationSourceId: binding.declaration.sourceId, expectedDeclarationHead: binding.declaration, inputDigest: binding.inputDigest,
  budget: { root: bindings.root, workId: binding.workId, idempotencyKey: `${bindings.episodeId}:budget:${index}`,
    deadlineAt: bindings.deadlineAt, maximumTicks: 2000000, maximumCpuMicros: 120000000,
    maximumRetainedBytes: 134217728, maximumMemoryBytes: 2147483648, resources: bindings.resources },
}));
const editedProgramme = structuredClone(programmes[1]);
editedProgramme.nodes.splice(2, 0, { id: "objective", op: "project", input: "group", semantics: "bag",
  fields: { company: field("company"), amount: { op: "add", left: field("amount"), right: literal("1/3", money) } } });
editedProgramme.nodes.find(node => node.id === "answer").input = "objective";
const edited = { ...works[1].work, programmeRevision: "original-1-2", objectiveRevision: "objective-1-2", programme: editedProgramme };
const reactivated = { ...works[0].work, programmeRevision: "original-0-2", withdrawn: false };
const fixture = { schema: "finnor.z1.public-native-episode.v1", dataClass: bindings.dataClass, externalEffects: false,
  episodeId: bindings.episodeId, tenantId: bindings.tenantId, principalId: bindings.principalId, root: bindings.root,
  foreignRoot: bindings.foreignRoot, foreignWorkId: bindings.foreignWorkId, works,
  sources: [{ source: ledger, sourceId: bindings.sources.ledger.sourceId, expectedHead: bindings.sources.ledger },
    { source: dimension, sourceId: bindings.sources.dimension.sourceId, expectedHead: bindings.sources.dimension }],
  limits: { maxTicks: 2000000, maxBytes: 134217728 },
  stages: [
    { name: "INITIAL" },
    { name: "INSERT", sourceChanges: [{ sourceId: "ledger", fromRevision: "ledger-1", toRevision: "ledger-2",
      insert: [{ company: "DELTA", amount: "1/2" }], retract: [] }] },
    { name: "RETRACT", sourceChanges: [{ sourceId: "ledger", fromRevision: "ledger-2", toRevision: "ledger-3",
      insert: [], retract: [{ company: "ALPHA", amount: "11/3" }] }] },
    { name: "OBJECTIVE_EDIT", workEdits: [{ workId: works[1].work.id, expectedProgrammeRevision: "original-1-1", replacement: edited }] },
    { name: "WITHDRAW", withdrawWorkIds: [works[0].work.id] },
    { name: "REACTIVATE", workEdits: [{ workId: works[0].work.id, expectedProgrammeRevision: "original-0-1", replacement: reactivated }] },
    { name: "REVOKE", sourceChanges: [{ sourceId: "dimension", fromRevision: "dimension-1", toRevision: "dimension-2",
      insert: [], retract: [], revoked: true }] },
  ],
};
await writeFile(output, JSON.stringify(fixture, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ status: "OFFLINE_FIXTURE_MATERIALIZED_NOT_NATIVE_EXECUTION", originalWorks: works.length,
  phases: fixture.stages.map(stage => stage.name), databaseActions: 0, protectedAdmission: false }));
