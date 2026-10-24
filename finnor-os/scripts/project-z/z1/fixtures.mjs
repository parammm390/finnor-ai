import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const money = { kind: "rational", unit: "money", currency: "USD" };
export const scalar = { kind: "rational", unit: "1", currency: null };
const text = { kind: "text" };
const field = (name) => ({ op: "field", name });
const literal = (value, type = money) => ({ op: "literal", type, value: String(value) });
const comparison = (op, left, right) => ({ op, left, right });
const sourceNode = (id, sourceId) => ({ id, op: "source", sourceId });
const project = (id, input, fields, semantics = "bag") => ({ id, op: "project", input, fields, semantics });
const sum = (id, input, keys = ["company"], expression = field("amount")) =>
  ({ id, op: "sum", input, keys, values: { amount: expression }, empty: "zero" });
const join = (id, left, right, l = "company", r = "company", rightPrefix = "r_") =>
  ({ id, op: "join", left, right, on: [{ left: l, right: r }], rightPrefix });
const union = (id, inputs, semantics = "bag") => ({ id, op: "union", inputs, semantics });
const filter = (id, input, predicate) => ({ id, op: "filter", input, predicate });
const select = (id, input, order, limit) => ({ id, op: "select", input, order, limit, ties: "CANONICAL_ROW" });
const asc = (fieldName) => ({ field: fieldName, direction: "asc" });
const desc = (fieldName) => ({ field: fieldName, direction: "desc" });
const partition = {
  tenantId: "public-dev-tenant", principalId: "public-dev-principal",
  permittedUse: "institutional-decision", rightsRevision: "rights-1", classification: "INTERNAL",
};

export const familySpecifications = JSON.parse(readFileSync(fileURLToPath(new URL(
  "../../../../scope-z/prompts/qualification-families.json", import.meta.url,
)), "utf8")).phases.Z1.families;

// Each branch changes the original relational topology, not just its random seed.
function topology(family, w) {
  const n = [sourceNode("s", "ledger"), sourceNode("d", "dimension")];
  let end = "s";
  const add = (node) => { n.push(node); end = node.id; return node.id; };
  switch (family) {
    case 0:
      add(join("j1", "s", "d"));
      n.push(sourceNode("x", "unique"));
      add(join("j2", end, "x", "company", "company", "independent_"));
      break;
    case 1:
      add(join("j1", "s", "d"));
      n.push(sourceNode("x", "hierarchy"));
      add(join("j2", end, "x", "r_parent", "company", "h_"));
      add(project("chain", end, { company: field("h_parent"), amount: field("amount") }));
      break;
    case 2:
      n.push(sourceNode("x", "hierarchy"));
      add(join("snow", "d", "x", "parent", "company", "h_"));
      add(join("fact", "s", end));
      add(filter("leaf", end, comparison("ne", field("r_h_parent"), literal(w ? "OTHER" : "NEVER", text))));
      break;
    case 3:
      add(join("cycle1", "s", "d"));
      add(join("cycle2", end, "s", "r_parent", "company", "cycle_"));
      add(filter("cycleclose", end, comparison("eq", field("cycle_company"), field("r_parent"))));
      break;
    case 4:
      add(join("self", "s", "s", "company", "company", "peer_"));
      add(filter("asymmetric", end, comparison(w ? "le" : "lt", field("amount"), field("peer_amount"))));
      break;
    case 5:
      add(join("duplicate", "s", "d"));
      add(sum("byCompany", end, w ? ["company", "r_parent"] : ["company"]));
      break;
    case 6: case 7:
      n.push(sourceNode("b", "ledger2"));
      add(union("u", ["s", "b"], family === 6 ? "set" : "bag"));
      break;
    case 8:
      add(project("collapse", "s", { company: field("company"), amount: literal(1) }, "set"));
      break;
    case 9:
      add(sum("g", "s", ["company"]));
      if (w) add(sum("portfolio", end, []));
      break;
    case 10:
      add(sum("company", "s", ["company"]));
      add(sum("portfolio", end, w ? ["company"] : []));
      break;
    case 11:
      add(project("scaled", "s", { company: field("company"), amount: { op: "mul", left: field("amount"), right: literal("3/2", scalar) } }));
      add(filter("threshold", end, comparison(w ? "ge" : "gt", field("amount"), { op: "param", name: "threshold" })));
      break;
    case 12:
      add(join("shared", "s", "d"));
      add(filter("branch", end, comparison(w ? "ne" : "eq", field("r_parent"), literal("P", text))));
      break;
    case 13: {
      n.push(sourceNode("b", "ledger2"));
      const p = comparison("gt", field("amount"), literal(1));
      if (w) {
        n.push(filter("fa", "s", p), filter("fb", "b", p));
        add(union("distributed", ["fa", "fb"]));
      } else {
        add(union("before", ["s", "b"]));
        add(filter("after", end, p));
      }
      break;
    }
    case 14:
      if (w) {
        n.push(sum("pre", "s", ["company"]));
        add(join("after", "pre", "unique"));
      } else {
        n.push(sourceNode("uniqueNode", "unique"));
        add(join("before", "s", "uniqueNode"));
        add(sum("post", end, ["company"]));
      }
      break;
    case 15:
      add(project("rational", "s", { company: field("company"), amount: { op: "round", value: { op: "div", left: field("amount"), right: literal(w ? "3" : "7", scalar) }, places: 2, mode: w ? "HALF_EVEN" : "HALF_AWAY" } }));
      break;
    case 16:
      add(select("rank", "s", [desc("amount"), w ? desc("company") : asc("company")], w + 2));
      break;
    case 17:
      add(select("first", "s", [desc("amount"), asc("company")], 4));
      add(select("second", end, [asc(w ? "company" : "amount")], 2));
      break;
    case 18:
      add(filter("window", "s", { op: "and", args: [
        comparison("ge", field("period"), literal(w ? 2 : 1, scalar)),
        comparison("le", field("period"), literal(w ? 4 : 3, scalar)),
      ] }));
      break;
    case 19:
      add(join("dimension", "s", "d"));
      add(project("units", end, { company: field("company"), amount: { op: "mul", left: field("amount"), right: literal(w ? "2" : "1/2", scalar) } }));
      break;
    case 20:
      add(project("prefix", "s", { company: field("company"), amount: field("amount") }));
      add(filter("fanout", end, comparison(w ? "lt" : "ge", field("amount"), literal(9))));
      break;
    case 21:
      n.push(sourceNode("b", "ledger2"));
      n.push(filter("left", "s", comparison("gt", field("amount"), literal(1))));
      n.push(filter("right", "b", comparison("lt", field("amount"), literal(100))));
      add(union("fanin", ["left", "right"]));
      break;
    case 22:
      n.push(project("left", "s", { company: field("company"), amount: field("amount") }));
      n.push(project("right", "s", { company: field("company"), amount: field("amount") }));
      add(union("diamond", ["left", "right"]));
      break;
    case 23:
      n.push(project("left", "s", { company: field("company"), amount: field("amount") }));
      n.push(project("right", "s", { company: field("company"), amount: field("amount") }));
      n.push(union("inner", ["left", "right"]));
      add(union("outer", w ? ["inner", "left"] : ["inner", "inner"]));
      break;
    case 24:
      add(project("p1", "s", { company: field("company"), amount: field("amount") }));
      add(filter("p2", end, comparison("gt", field("amount"), literal(0))));
      if (!w) add(project("tail", end, { company: field("company"), amount: { op: "add", left: field("amount"), right: literal(1) } }));
      break;
    case 25:
      n[0] = sourceNode("s", w ? "ledger2" : "ledger");
      add(project("independent", "s", { company: field("company"), amount: { op: "mul", left: field("amount"), right: literal(w ? "13" : "11", scalar) } }));
      break;
    case 26:
      n[0] = sourceNode("s", w ? "ledgerRevision" : "ledger");
      add(filter("cut", "s", comparison("ge", field("amount"), literal(2))));
      break;
    case 27:
      n[0] = sourceNode("s", w ? "privateLedger" : "ledger");
      add(project("privateSuffix", "s", { company: field("company"), amount: field("amount") }));
      break;
    case 28:
      add(project("isolated", "s", { company: field("company"), amount: field("amount") }));
      break;
    case 29:
      n.push(sourceNode("b", "ledger2"));
      add(union("objectiveTopology", w ? ["s", "b"] : ["s"]));
      break;
    case 30:
      n.push(join("j1", "s", "d"));
      n.push(join("j2", "s", "d"));
      add(union("multiPath", ["j1", "j2"]));
      break;
    case 31:
      add(project("detachable", "s", { company: field("company"), amount: field("amount") }));
      break;
    default: throw Error("UNREGISTERED_STRUCTURAL_FAMILY");
  }
  if (family === 14 && w) n.push(sourceNode("unique", "unique"));
  add(sum("answer", end, w || family === 10 ? [] : ["company"]));
  // Remove genuinely unused original nodes, not their required dependencies.
  const byId = new Map(n.map((node) => [node.id, node])), live = new Set();
  const visit = (id) => {
    if (live.has(id)) return;
    live.add(id);
    const node = byId.get(id);
    if (!node) throw Error(`FIXTURE_MISSING_DEPENDENCY:${id}`);
    for (const x of node.inputs ?? [node.input, node.left, node.right].filter(Boolean)) visit(x);
  };
  visit(end);
  return { nodes: n.filter((node) => live.has(node.id)), output: end };
}

export function freshRequest(family, freshCase, sourceIdentity = "public-development-build") {
  const scale = 1 + family * 9 + freshCase;
  const columns = { company: text, amount: money, period: scalar };
  const rows = [
    { company: "A", amount: `${scale}`, period: "1" },
    { company: "A", amount: `${scale * 2}`, period: "2" },
    { company: "B", amount: `${scale * 3}`, period: "3" },
    { company: "B", amount: `${scale * 3}`, period: "3" },
    { company: "C", amount: `${scale * 4}`, period: "4" },
  ];
  const source = (id, c, data, revision = `case-${family}-${freshCase}`) =>
    ({ id, revision, partition: structuredClone(partition), columns: c, rows: data, revoked: false, evidenceClass: "partial" });
  const sources = [
    source("ledger", columns, rows),
    source("ledger2", columns, rows.slice(1).concat([{ company: "D", amount: `${scale * 5}`, period: "2" }])),
    source("ledgerRevision", columns, rows.slice(0, 3), "different-original-revision"),
    source("privateLedger", columns, rows.slice(2)),
    source("dimension", { company: text, parent: text }, [
      { company: "A", parent: "P" }, { company: "A", parent: "Q" },
      { company: "B", parent: "P" }, { company: "C", parent: "Q" },
    ]),
    source("hierarchy", { company: text, parent: text }, [
      { company: "P", parent: "FUND" }, { company: "Q", parent: "FUND" },
    ]),
    source("unique", { company: text, parent: text }, [
      { company: "A", parent: "P" }, { company: "B", parent: "P" }, { company: "C", parent: "Q" },
    ]),
  ];
  const works = [0, 1].map((w) => ({
    id: `public-original-${family}-${freshCase}-${w}`,
    partition: structuredClone(partition), inputRef: `original-input-${family}-${freshCase}-${w}`,
    programmeRevision: "programme-1", objectiveRevision: `objective-${w}-1`,
    termsRevision: "terms-1", modelRevision: "declared-model-1", unitsRevision: "units-1",
    codeRevision: "z1-shared-work-v1", checkerRevision: "z1-original-fraction-v1",
    programme: topology(family, w),
    parameters: { threshold: { type: money, value: `${scale * 2}` } },
    resources: {
      mandateRef: `original-mandate-${family}-${freshCase}-${w}`,
      assignmentRef: `original-assignment-${family}-${freshCase}-${w}`,
      parentReservationRef: `original-parent-${family}-${freshCase}-${w}`,
      remainingBudgetRef: `original-budget-${family}-${freshCase}-${w}`,
      originalDeadline: "2030-01-01T00:00:00.000Z", remainingTicks: "2000000",
    },
    unresolvedObligationRefs: w ? [`original-s6-unknown-${family}-${freshCase}`] : [],
    withdrawn: false,
  }));
  if (family === 27) {
    works[1].partition.classification = "CONFIDENTIAL";
    sources.find((s) => s.id === "privateLedger").partition.classification = "CONFIDENTIAL";
  }
  if (family === 28) {
    // Independent batches, never an illegally mixed common envelope.
    for (const w of works) w.partition.tenantId += `-${freshCase % 2}`;
    for (const s of sources) s.partition.tenantId += `-${freshCase % 2}`;
  }
  // Match a real JSON intake: no shared JS object aliases between declarations.
  return JSON.parse(JSON.stringify({
    schema: "finnor.z1.request.v1",
    identity: {
      productLockDigest: "61d9881ca8059d24d057d1e00d5436ef2059de7889ccd1fd2f92a630075bcebf",
      sourceCommit: process.env.FINNOR_Z1_SOURCE_COMMIT ?? "684d805e471836a720aa6741a3128eca17d28202",
      sourceTree: process.env.FINNOR_Z1_SOURCE_TREE ?? "163f63b65c88481194d0d48e77337494b3b9f24f",
      producerBuildIdentity: sourceIdentity, checkerIdentity: "z1-original-fraction-v1",
      ownerConsumerContractVersion: "z1-per-original-work-v1", reconstructionReference: "public-development-replay",
    },
    sources, works,
    limits: { maxTicks: 2000000, maxBytes: 134217728, deadlineAt: "2030-01-01T00:00:00.000Z" },
  }));
}
