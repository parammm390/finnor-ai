// Public original programmes. Variants change the family motif, not an ID seed.
export const money = { kind: "rational", unit: "money", currency: "USD" };
export const scalar = { kind: "rational", unit: "1", currency: null };
const text = { kind: "text" };
const field = name => ({ op: "field", name });
const literal = (value, type = money) => ({ op: "literal", type, value: String(value) });
const param = name => ({ op: "param", name });
const bin = (op, left, right) => ({ op, left, right });
const pred = (op, left, right) => ({ op, left, right });
const keys = n => ["company", ...Array.from({ length: n - 1 }, (_, i) => "k" + i)];
const identity = names => Object.fromEntries(names.map(name => [name, field(name)]));

export function freshStructuralRequest(family, variant, build = "public-development-build") {
  if (!Number.isInteger(family) || family < 0 || family >= 32 || !Number.isInteger(variant) || variant < 0 || variant >= 8)
    throw Error("REGISTERED_FAMILY_AND_FRESH_STRUCTURAL_CASE_REQUIRED");
  const width = variant + 2, sources = new Map();
  const partition = { tenantId: "public-structural-tenant", principalId: "public-structural-principal",
    permittedUse: "institutional-decision", rightsRevision: "rights-1", classification: "INTERNAL" };
  const columns = { company: text, amount: money, period: scalar,
    ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => ["k" + i, text])) };
  const rows = [1, 3, 2, 2, 4, 4].map((amount, i) => ({
    company: ["A", "A", "B", "B", "C", "D"][i] + variant, amount: String(amount + variant), period: String(i + 1),
    ...Object.fromEntries(Array.from({ length: 16 }, (_, k) => ["k" + k, ["A", "A", "B", "B", "C", "D"][i] + "-" + k + "-" + variant])),
  }));
  const source = (id, cols = columns, data = rows, classification = "INTERNAL", revision = "fresh-" + family + "-" + variant + "-" + id) => {
    if (!sources.has(id)) sources.set(id, { id, revision, partition: { ...partition, classification }, columns: cols,
      rows: structuredClone(data), revoked: false, evidenceClass: "partial" });
    return id;
  };
  const branchSource = i => source("branch" + i, columns, rows.slice(0, 4).concat({
    ...rows[4], company: "branch-" + i + "-" + variant, amount: String(9 + i + variant),
  }));
  const dimension = (id = "dimension", grouped = ["company"], duplicates = false) => {
    const data = [rows[0], rows[2], rows[4], rows[5]].map((row, i) => ({
      ...Object.fromEntries(grouped.map(k => [k, row[k]])), parent: "P" + i, factor: "2",
    }));
    if (duplicates) data.push({ ...data[0], parent: "OTHER" });
    return source(id, { ...Object.fromEntries(grouped.map(k => [k, text])), parent: text, factor: scalar }, data);
  };
  let count = [12, 27].includes(family) ? width : [20, 31].includes(family) ? width + 1 : family === 25 ? width : 2;
  const works = Array.from({ length: count }, (_, w) => {
    const nodes = [], parameters = { factor: { type: scalar, value: "2" }, threshold: { type: money, value: String(2 + variant + w) } };
    let end = "", terminal = false, grouping = w ? [] : ["company"];
    const add = node => { nodes.push(node); end = node.id; return node.id; };
    const s = (id, sourceId) => add({ id, op: "source", sourceId });
    const project = (id, input, fields, semantics = "bag") => add({ id, op: "project", input, fields, semantics });
    const filter = (id, input, predicate) => add({ id, op: "filter", input, predicate });
    const union = (id, inputs, semantics = "bag") => add({ id, op: "union", inputs, semantics });
    const sum = (id, input, group = [], values = { amount: field("amount") }) =>
      add({ id, op: "sum", input, keys: group, values, empty: "zero" });
    const join = (id, left, right, on = [{ left: "company", right: "company" }], rightPrefix = "r_") =>
      add({ id, op: "join", left, right, on, rightPrefix });
    const select = (id, input, order, limit) => add({ id, op: "select", input, order, limit, ties: "CANONICAL_ROW" });
    const input = () => s("s", source("ledger"));
    const amountFields = { company: field("company"), amount: field("amount") };
    switch (family) {
      case 0: {
        let current = input();
        for (let i = 0; i < width; i++) {
          const d = s("d" + i, dimension("independent" + i));
          current = join("star" + i, current, d, undefined, "d" + i + "_");
        }
        end = current; break;
      }
      case 1: case 2: {
        const depth = width;
        const fact = input();
        let current = s("h0", source("h0", { company: text, parent: text },
          [rows[0], rows[2], rows[4], rows[5]].map((r, i) => ({ company: r.company, parent: "level0-" + i }))));
        if (family === 1) current = join("chain0", fact, current);
        for (let i = 1; i < depth; i++) {
          const next = s("h" + i, source("h" + i, { company: text, parent: text },
            Array.from({ length: 4 }, (_, j) => ({ company: "level" + (i - 1) + "-" + j, parent: "level" + i + "-" + j }))));
          current = join("chain" + i, current, next,
            [{ left: i === 1 ? (family === 1 ? "r_parent" : "parent") : "h" + (i - 1) + "_parent", right: "company" }], "h" + i + "_");
        }
        if (family === 2) {
          current = join("fact", fact, current);
          current = filter("leaf", current, pred(w ? "ne" : "eq", field("r_h" + (depth - 1) + "_parent"), literal("level" + (depth - 1) + "-0", text)));
        } else current = project("terminal", current, { company: field("h" + (depth - 1) + "_parent"), amount: field("amount") });
        end = current; break;
      }
      case 3: {
        const n = width + 1;
        let current;
        for (let i = 0; i < n; i++) {
          const node = s("e" + i, source("edge" + i, { company: text, next: text, amount: money },
            ["A", "B"].map(k => ({ company: "N" + i + k, next: "N" + ((i + 1) % n) + k, amount: String(i + variant + 1) }))));
          current = i ? join("cycle" + i, current, node, [{ left: i === 1 ? "next" : "c" + (i - 1) + "_next", right: "company" }], "c" + i + "_") : node;
        }
        end = filter("close", current, pred("eq", field("c" + (n - 1) + "_next"), field("company"))); break;
      }
      case 4: {
        const alias = project("aliasSource", input(), amountFields);
        let current = alias;
        for (let i = 1; i < width; i++) current = join("alias" + i, current, alias, undefined, "a" + i + "_");
        end = filter("asymmetric", current, pred(w ? "le" : "lt", field("amount"), field("a" + (width - 1) + "_amount"))); break;
      }
      case 5: {
        const group = keys(variant + 1), fact = input(), dim = s("d", dimension("duplicate", group, true));
        const j = join("duplicateJoin", fact, dim, group.map(k => ({ left: k, right: k })));
        end = sum("grouped", j, w ? [...group, "r_parent"] : group); terminal = true; break;
      }
      case 6: case 7: {
        const branches = Array.from({ length: width }, (_, i) => s("s" + i, branchSource(i)));
        const u = union("union", branches, family === 6 ? "set" : "bag");
        end = family === 6 ? project("originalProjection", u, amountFields) : u; break;
      }
      case 8: {
        const group = keys(variant + 1), start = input();
        const p = project("collapse", start, { ...identity(group), amount: literal(1) }, "set");
        end = sum("answer", p, w ? [] : group); terminal = true; break;
      }
      case 9: {
        const group = keys(variant + 1), start = input(), g = sum("group", start, group);
        end = w ? sum("keyRemoved", g, []) : project("keyRetained", g, identity([...group, "amount"]));
        terminal = true; break;
      }
      case 10: {
        let current = input();
        for (let i = width; i >= (w ? 0 : 1); i--) current = sum("level" + i, current, i ? keys(i) : []);
        end = current; terminal = true; break;
      }
      case 11: {
        let current = input();
        for (let i = 0; i <= variant; i++) current = project("transform" + i, current,
          { company: field("company"), amount: bin("mul", field("amount"), param("factor")) });
        end = filter("threshold", current, pred(w ? "ge" : "gt", field("amount"), param("threshold"))); break;
      }
      case 12: {
        const fact = input(), data = [rows[0], rows[2], rows[4], rows[5]].flatMap(r =>
          Array.from({ length: width }, (_, i) => ({ company: r.company, parent: "P" + i })));
        const d = s("d", source("dimension", { company: text, parent: text }, data));
        const j = join("shared", fact, d);
        end = filter("branch", j, pred("eq", field("r_parent"), literal("P" + w, text))); break;
      }
      case 13: {
        parameters.threshold.value = String(2 + variant);
        const branches = Array.from({ length: width }, (_, i) => s("s" + i, branchSource(i)));
        const p = pred("gt", field("amount"), param("threshold"));
        if (w) end = union("distributed", branches.map((id, i) => filter("filter" + i, id, p)));
        else end = filter("after", union("before", branches), p);
        end = sum("answer", end, ["company"]); terminal = true; break;
      }
      case 14: {
        parameters.threshold.value = "2";
        const group = keys(variant + 1), fact = input(), d = s("d", dimension("unique", group));
        const on = group.map(k => ({ left: k, right: k }));
        if (!w) end = sum("after", join("joined", fact, d, on), group);
        else end = project("pullThrough", join("joined", sum("before", fact, group), d, on), identity([...group, "amount"]));
        terminal = true; break;
      }
      case 15: {
        let current = project("common", input(), { company: field("company"), amount: bin("mul", field("amount"), param("factor")) });
        let expression = field("amount");
        for (let i = 0; i <= variant; i++) {
          parameters["divisor" + i] = { type: scalar, value: String(i === variant ? w + 2 : 2) };
          expression = { op: "round", value: bin("div", expression, param("divisor" + i)), places: 2, mode: "HALF_EVEN" };
        }
        end = project("parameterSuffix", current, { company: field("company"), amount: expression }); break;
      }
      case 16: {
        const start = input();
        end = select("ties", start, [{ field: "amount", direction: "desc" },
          ...Array.from({ length: variant + 1 }, (_, i) => ({ field: "k" + i, direction: w ? "desc" : "asc" }))], 1); break;
      }
      case 17: {
        const first = select("first", input(), [{ field: "amount", direction: "desc" }, { field: "company", direction: "asc" }], 4);
        const projected = { ...amountFields, ...Object.fromEntries(Array.from({ length: variant + 1 }, (_, i) =>
          [(w ? "other" : "leaf") + i, field("k" + (i + (w ? 8 : 0)))])) };
        end = project("laterProjection", first, projected);
        grouping = Object.keys(projected).filter(k => k !== "amount"); break;
      }
      case 18: {
        const data = Array.from({ length: width * 2 + 3 }, (_, i) => ({ ...rows[i % rows.length], period: String(i), amount: String(i + 1) }));
        const start = s("s", source("ledger", columns, data));
        end = filter("windows", start, { op: "or", args: Array.from({ length: variant + 1 }, (_, i) => ({
          op: "and", args: [pred("ge", field("period"), literal(i * 2 + w, scalar)), pred("le", field("period"), literal(i * 2 + w + 2, scalar))],
        })) }); break;
      }
      case 19: {
        const euro = { kind: "rational", unit: "money", currency: "EUR" };
        let current = s("s", source("multiCurrency", { ...columns, euro }, rows.map(r => ({ ...r, euro: r.amount }))));
        let factor = literal(1, scalar);
        for (let i = 0; i <= variant; i++) {
          const d = s("d" + i, dimension("rate" + i));
          current = join("commonDimension" + i, current, d, undefined, "d" + i + "_");
          factor = bin("mul", factor, field("d" + i + "_factor"));
        }
        end = project("currencyBranch", current, { company: field("company"), amount: bin("mul", field(w ? "euro" : "amount"), factor) }); break;
      }
      case 20: {
        const common = project("common", input(), { company: field("company"), amount: bin("mul", field("amount"), param("factor")) });
        const leaf = filter("leaf", common, pred("ge", field("amount"), literal(w)));
        end = project("nonidentical", leaf, { company: field("company"), amount: bin("add", field("amount"), literal(w + 1)) }); break;
      }
      case 21: {
        const branches = Array.from({ length: width + 1 }, (_, i) => filter("branch" + i, s("s" + i, branchSource(i)), pred("ge", field("amount"), literal(i))));
        end = union("fanIn", branches); break;
      }
      case 22: {
        const start = input(), branches = Array.from({ length: width }, (_, i) => project("path" + i, start, amountFields));
        end = union("diamond", w ? [...branches, branches[0]] : branches); break;
      }
      case 23: {
        let current = input();
        for (let i = 0; i < width - (w ? 0 : 1); i++) {
          const a = project("left" + i, current, amountFields), b = project("right" + i, current, amountFields);
          current = union("diamond" + i, [a, b]);
        }
        end = current; break;
      }
      case 24: {
        let current = input();
        for (let i = 0; i < variant + 8; i++) current = i % 2 ?
          filter("prefix" + i, current, pred("gt", field("amount"), literal(0))) :
          project("prefix" + i, current, { company: field("company"), amount: bin("add", field("amount"), literal(1)) });
        if (!w) current = project("tail", current, { company: field("company"), amount: bin("mul", field("amount"), param("factor")) });
        end = current; break;
      }
      case 25: {
        const start = s("s", branchSource(w));
        end = filter("component", start, pred("gt", field("amount"), literal(w))); break;
      }
      case 26: {
        const cuts = Array.from({ length: width }, (_, i) => s("cut" + i,
          source("revisionCut" + i, columns, rows.slice(i % 3), "INTERNAL", "original-revision-" + i)));
        end = filter("revisionDependent", union("cuts", cuts), pred("ge", field("amount"), literal(2))); break;
      }
      case 27: {
        const classification = w % 2 ? "CONFIDENTIAL" : "INTERNAL";
        const pub = s("public", source("publicLedger", columns, rows, "PUBLIC"));
        const prefix = project("publicPrefix", pub, amountFields);
        const privateNode = s("private", source("private" + w, { company: text, privateAmount: money },
          [rows[0], rows[2], rows[4], rows[5]].map(r => ({ company: r.company, privateAmount: String(w + 1) })), classification));
        const j = join("privateJoin", prefix, privateNode);
        end = project("privateSuffix", j, { company: field("company"), amount: bin("add", field("amount"), field("r_privateAmount")) }); break;
      }
      case 28: {
        const common = project("isolated", input(), amountFields);
        end = union("tenantGraph", Array.from({ length: width }, () => common)); break;
      }
      case 29: {
        const branches = Array.from({ length: width }, (_, i) => s("s" + i, branchSource(i)));
        source("objectiveAdded", columns, rows.slice(0, 2));
        end = select("objectiveChoice", union("objectiveBranches", branches),
          [{ field: "amount", direction: "desc" }, { field: "company", direction: "asc" }], w + 2); break;
      }
      case 30: {
        const fact = input(), d = s("d", dimension()), branches = [];
        for (let i = 0; i < width; i++) branches.push(join("path" + i, fact, d));
        end = union("contributions", w ? [...branches, branches[0]] : branches); break;
      }
      case 31: {
        const start = input(), a = project("left", start, amountFields), b = project("right", start, amountFields);
        const common = union("membershipPrefix", [a, b]);
        end = project("detachable", common, { company: field("company"), amount: bin("add", field("amount"), literal(w + 1)) }); break;
      }
    }
    if (!terminal) sum("answer", end, grouping);
    const used = new Set(), byId = new Map(nodes.map(n => [n.id, n]));
    const visit = id => { if (used.has(id)) return; used.add(id); const n = byId.get(id);
      for (const dep of n.inputs ?? [n.input, n.left, n.right].filter(Boolean)) visit(dep); };
    visit(end);
    return {
      id: `public-structural-original-${family}-${variant}-${w}`, inputRef: `public-structural-input-${family}-${variant}-${w}`,
      partition: { ...partition, classification: family === 27 && w % 2 ? "CONFIDENTIAL" : "INTERNAL" },
      programmeRevision: "programme-1", objectiveRevision: "objective-1", termsRevision: "terms-1",
      modelRevision: "model-1", unitsRevision: "units-1", codeRevision: build, checkerRevision: "z1-original-fraction-v1",
      programme: { nodes: nodes.filter(n => used.has(n.id)), output: end }, parameters,
      resources: { mandateRef: `public-mandate-${family}-${variant}-${w}`, assignmentRef: `public-assignment-${family}-${variant}-${w}`,
        parentReservationRef: `public-parent-${family}-${variant}-${w}`, remainingBudgetRef: `public-budget-${family}-${variant}-${w}`,
        remainingTicks: "2000000", originalDeadline: "2030-01-01T00:00:00.000Z" },
      unresolvedObligationRefs: w ? [`public-original-S6-UNKNOWN-${family}-${variant}-${w}`] : [], withdrawn: false,
    };
  });
  return JSON.parse(JSON.stringify({
    schema: "finnor.z1.request.v1", identity: {
      productLockDigest: "61d9881ca8059d24d057d1e00d5436ef2059de7889ccd1fd2f92a630075bcebf",
      sourceCommit: "9f3edfd3b4c6758832c53139da0773218062191e", sourceTree: "2dc4d5bc13d22853cf4dc9feb5f6ac7fbf6bb9c9",
      producerBuildIdentity: build, checkerIdentity: "z1-original-fraction-v1",
      ownerConsumerContractVersion: "z1-per-original-work-v1", reconstructionReference: "public-source-structural-v2",
    }, sources: [...sources.values()], works,
    limits: { maxTicks: 2000000, maxBytes: 134217728, deadlineAt: "2030-01-01T00:00:00.000Z" },
  }));
}
