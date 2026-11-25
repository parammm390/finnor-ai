import { createBlankArtifactBytes, getArtifact, ingestArtifact } from "@finnor/artifacts";
import { OfficePackage } from "@finnor/ooxml";
import { add, cmp, compileUnderwritingModel, decimal, div, FINANCIAL_CONVENTION_VERSION, mul, UNDERWRITING_ENGINE_VERSION, type Expression, type ModelNode, type UnderwritingModelIR } from "@finnor/underwriting";
import { authorizeBeliefResources } from "./enterprise-beliefs";
import { peTransaction } from "./repository";
import { PeDomainError, type PeMutationContext } from "./types";
import { createUnderwritingRun, getUnderwritingRun, type ExplicitUnderwritingInput } from "./underwriting-repository";

export interface EntrySourceRef {
  documentId: string;
  versionId: string;
}

interface EntryCitation extends EntrySourceRef {
  exhibitId: string;
  location: string;
  anchorId: string;
  anchorHash: string;
}

interface EntryFigure extends EntryCitation {
  value: string;
}

export const CITED_ENTRY_MODEL = "cited-entry-economics";

const amount = "(\\d{1,12}(?:\\.\\d{1,6})?)";
const sentence = (pattern: string) => new RegExp(`^(?:${pattern})$`, "i");
const seller = [
  sentence(`(?:Seller reports )?(?:last twelve months|LTM) revenue(?: of| is|:) ${amount}(?: and |\\. )adjusted EBITDA(?: of| is|:) ${amount}`),
  sentence(`Asking (?:enterprise value|EV)(?: is|:) ${amount}`),
];
const earnings = [
  sentence(`(?:Starting from seller adjusted EBITDA of|Seller adjusted EBITDA:) ${amount}(?:, |\\. )(?:remove|deduct) ${amount} of unsupported add-?backs and ${amount} of non[- ]?recurring income`),
  sentence("Both adjustments reduce recurring earnings and are independent|Both independent adjustments reduce recurring EBITDA"),
];
const financing = [
  sentence(`Proposed debt(?: is|:) ${amount}`),
  sentence(`(?:Illustrative entry covenant: )?debt (?:divided by|/) lender EBITDA (?:must not exceed|<=) ${amount}x`),
  sentence("Lender EBITDA (?:for this exercise )?(?:equals|is defined as) signed (?:quality of earnings|QoE) EBITDA"),
  sentence("This is a draft, not a commitment|Draft terms only; no commitment"),
];
const committee = [
  sentence(`(?:Do not approve entry at enterprise value above|Maximum entry enterprise value:) ${amount}x verified recurring EBITDA`),
  sentence("Enterprise value cap, not equity che(?:que|ck) cap"),
  sentence("Investment committee alone can grant an exception|Only the investment committee may grant exceptions"),
];

function matchDefinition(patterns: RegExp[], text: string): string[] | undefined {
  const parts = text.replace(/\.$/, "").split(". ");
  const captures: string[] = [];
  for (const pattern of patterns) {
    const at = parts.findIndex(part => pattern.test(part));
    const joined = at < 0 ? parts.findIndex((part, index) => pattern.test(`${part}. ${parts[index + 1] ?? ""}`)) : -1;
    if (at < 0 && joined < 0) return;
    const match = at >= 0 ? parts.splice(at, 1)[0]! : parts.splice(joined, 2).join(". ");
    captures.push(...pattern.exec(match)!.slice(1));
  }
  if (!parts.length) return captures;
}

function refuse(code: string, message: string): never {
  throw new PeDomainError(code, message);
}

export async function readCitedEntryInputs(ctx: PeMutationContext, input: {
  dealId: string;
  sources: readonly EntrySourceRef[];
  monetaryUnit: { currency: string; scale: "millions" };
}) {
  if (!/^[A-Z]{3}$/.test(input.monetaryUnit.currency) || input.monetaryUnit.scale !== "millions") {
    refuse("ENTRY_UNIT_UNSUPPORTED", "The cited source set must declare one currency and a millions scale.");
  }
  if (input.sources.length < 4) refuse("ENTRY_SOURCE_MISSING", "The seller, earnings, financing and committee exhibits are required.");
  if (input.sources.length !== 4 || new Set(input.sources.map(row => row.documentId)).size !== input.sources.length) {
    refuse("ENTRY_SOURCE_CONFLICT", "Use one distinct source exhibit for each entry definition.");
  }
  await authorizeBeliefResources(ctx, [
    { type: "pe_deal", id: input.dealId },
    ...input.sources.map(row => ({ type: "document", id: row.documentId })),
  ]);
  const metadata = await peTransaction(ctx, async (_db, client) => (await client.query<{
    documentId: string; versionId: string; anchorId: string; anchorHash: string; sourceRef: string;
  }>(`
    SELECT v.document_id::text "documentId", v.id::text "versionId", b.anchor_id "anchorId",
           b.anchor_hash "anchorHash", v.source_ref "sourceRef"
    FROM finnor_os.document_versions v
    JOIN finnor_os.documents d ON d.tenant_id=v.tenant_id AND d.id=v.document_id AND d.archived_at IS NULL
    JOIN finnor_os.document_version_heads h ON h.tenant_id=v.tenant_id AND h.document_id=v.document_id
      AND h.version_id=v.id AND h.kind='current' AND h.head_key='default'
    JOIN finnor_os.artifact_bindings b ON b.tenant_id=v.tenant_id AND b.version_id=v.id
      AND b.target_kind='canonical_entity' AND b.target_entity_type='pe_deal' AND b.target_id=$2
    JOIN finnor_os.pe_document_links l ON l.tenant_id=v.tenant_id AND l.document_id=v.document_id
      AND l.deal_id=$2 AND l.entity_type='pe_deal' AND l.entity_id=$2 AND l.link_role='source' AND l.archived_at IS NULL
    WHERE v.tenant_id=$1 AND v.id = ANY($3::uuid[])
  `, [ctx.auth.tenantId, input.dealId, input.sources.map(row => row.versionId)])).rows, { readOnly: true });
  const byDefinition = new Map<RegExp[], EntryFigure[]>();
  const exhibitIds = new Set<string>();
  for (const source of input.sources) {
    const matches = metadata.filter(row => row.documentId === source.documentId && row.versionId === source.versionId);
    if (matches.length !== 1) refuse("ENTRY_SOURCE_MISSING", "A cited exhibit must have one current, exact Deal page binding.");
    const { sourceRef, ...binding } = matches[0]!;
    const [, exhibitId, location] = /^([a-z\d][a-z\d_.-]{0,63}):(p\d+|section \d+(?:\.\d+)*):[a-z\d_-]+$/i.exec(sourceRef ?? "") ?? [];
    if (!exhibitId || !location || exhibitIds.has(exhibitId.toLowerCase())) {
      refuse("ENTRY_CITATION_INVALID", "A cited exhibit needs a unique exhibit ID and page or section location.");
    }
    exhibitIds.add(exhibitId.toLowerCase());
    const artifact = await getArtifact(ctx.auth, source.documentId, source.versionId);
    const page = artifact.ir.nodes.find(node => node.kind === "page" && node.id === binding.anchorId && node.hash === binding.anchorHash);
    if (typeof page?.data.text !== "string") refuse("ENTRY_CITATION_INVALID", "The cited source does not resolve to readable page text.");
    const text = page.data.text.trim().replace(/\s+/g, " ");
    const unitDeclaration = /^([A-Z]{3}) (thousands|millions|billions)\. /.exec(text);
    if (unitDeclaration && (unitDeclaration[1] !== input.monetaryUnit.currency || unitDeclaration[2] !== input.monetaryUnit.scale)) {
      refuse("ENTRY_UNIT_UNSUPPORTED", `The monetary unit in ${exhibitId} ${location} differs from the dossier.`);
    }
    const clauses = unitDeclaration ? text.slice(unitDeclaration[0].length) : text;
    const match = [seller, earnings, financing, committee].map(definition => ({
      definition, values: matchDefinition(definition, clauses),
    })).find(candidate => candidate.values);
    if (!match?.values) refuse("ENTRY_DEFINITION_UNSUPPORTED", `Unsupported or ambiguous financial definition in ${exhibitId} ${location}.`);
    const { definition, values } = match;
    if (byDefinition.has(definition)) refuse("ENTRY_SOURCE_CONFLICT", "Two exhibits assert the same entry definition.");
    byDefinition.set(definition, values.map(value => ({ ...binding, exhibitId, location, value: decimal(value) })));
  }
  const [sellerRevenue, sellerEbitda, askingEnterpriseValue] = byDefinition.get(seller)!;
  const [qoeStartingEbitda, unsupportedAddbacks, nonrecurringIncome] = byDefinition.get(earnings)!;
  const [proposedDebt, maximumLeverage] = byDefinition.get(financing)!;
  const [maximumEntryMultiple] = byDefinition.get(committee)!;
  if (sellerEbitda!.value !== qoeStartingEbitda!.value) {
    refuse("ENTRY_SOURCE_CONFLICT", "The seller and signed quality of earnings starting EBITDA do not reconcile.");
  }
  return {
    sellerRevenue: sellerRevenue!, sellerEbitda: sellerEbitda!, askingEnterpriseValue: askingEnterpriseValue!,
    qoeStartingEbitda: qoeStartingEbitda!, unsupportedAddbacks: unsupportedAddbacks!, nonrecurringIncome: nonrecurringIncome!,
    proposedDebt: proposedDebt!, maximumLeverage: maximumLeverage!, maximumEntryMultiple: maximumEntryMultiple!,
  };
}

const inputs = {
  sellerRevenue: "money", sellerEbitda: "money", askingEnterpriseValue: "money",
  qoeStartingEbitda: "money", unsupportedAddbacks: "money", nonrecurringIncome: "money",
  proposedDebt: "money", maximumLeverage: "ratio", maximumEntryMultiple: "ratio",
} as const;

type InputKey = keyof typeof inputs;
type EntryKey = InputKey | keyof typeof formulas;
const formulas = {
  recurringEbitda: ["subtract", "qoeStartingEbitda", "unsupportedAddbacks", "nonrecurringIncome"],
  priceMultiple: ["divide", "askingEnterpriseValue", "recurringEbitda"],
  enterpriseValueCap: ["multiply", "recurringEbitda", "maximumEntryMultiple"],
  enterpriseValueGap: ["subtract", "askingEnterpriseValue", "enterpriseValueCap"],
  leverage: ["divide", "proposedDebt", "recurringEbitda"],
  debtCapacity: ["multiply", "recurringEbitda", "maximumLeverage"],
  headroom: ["subtract", "debtCapacity", "proposedDebt"],
} as const;

const inputKeys = Object.keys(inputs) as InputKey[];
const outputKeys = Object.keys(formulas) as Array<keyof typeof formulas>;
const nodeId = (key: string) => `entry.${key.replace(/[A-Z]/g, char => `_${char.toLowerCase()}`)}`;
const reference = (key: string): Expression => ({ op: "ref", nodeId: nodeId(key) });

export function citedEntryModel(currency: string, periodStart: string): UnderwritingModelIR {
  const metadata = (key: EntryKey, unit: "money" | "ratio") => ({
    id: nodeId(key), unit, valueType: "decimal" as const, shape: "scalar" as const,
    ...(unit === "money" ? { currency } : {}),
  });
  const nodes: ModelNode[] = inputKeys.map(key => ({
    ...metadata(key, inputs[key]), kind: "input", required: true, dependencies: [],
  }));
  for (const key of outputKeys) {
    const [op, a, b, ...rest] = formulas[key];
    const type = metadata(key, op === "divide" ? "ratio" : "money");
    const expression: Expression = rest.reduce<Expression>((left, right) => ({ op, args: [left, reference(right)] }),
      { op, args: [reference(a), reference(b)] });
    nodes.push({ ...type, kind: "expression", expression, dependencies: [a, b, ...rest].map(nodeId) });
    nodes.push({ ...type, id: `output.${type.id}`, kind: "output", sourceNodeId: type.id, dependencies: [type.id] });
  }
  return {
    schemaVersion: "underwriting-model-ir.v1", modelKey: CITED_ENTRY_MODEL, modelVersion: "1",
    financialConventionVersion: FINANCIAL_CONVENTION_VERSION, minimumEngineVersion: UNDERWRITING_ENGINE_VERSION,
    periodDefinition: { frequency: "annual", forecastStart: periodStart, count: 1 }, nodes, circularBlocks: [],
  };
}

const sheetPart = "xl/worksheets/sheet1.xml";
const sheetSystem = "private-equity:cited-entry-economics";
const xmlEscape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

function calculationSheet(rows: readonly string[][]) {
  const workbook = new OfficePackage(createBlankArtifactBytes("xlsx"));
  const grid = rows.map((row, index) => `<row r="${index + 1}">${row.map((cell, column) =>
    `<c r="${String.fromCharCode(65 + column)}${index + 1}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`).join("")}</row>`).join("");
  const sheet = workbook.text(sheetPart).replace('ref="A1"', `ref="A1:E${rows.length}"`)
    .replace(/<sheetData>.*<\/sheetData>/s, `<sheetData>${grid}</sheetData>`);
  return workbook.patch(new Map([[sheetPart, Buffer.from(sheet)]]), [sheetPart]);
}

async function calculationVersions(ctx: PeMutationContext, runId: string) {
  return peTransaction(ctx, async (_db, client) => (await client.query<EntrySourceRef>(`
    SELECT v.document_id::text "documentId", v.id::text "versionId" FROM finnor_os.document_versions v
    JOIN finnor_os.document_version_heads h ON h.tenant_id=v.tenant_id AND h.document_id=v.document_id
      AND h.version_id=v.id AND h.kind='current' AND h.head_key='default'
    WHERE v.tenant_id=$1 AND v.source_system=$2 AND v.source_ref=$3 AND v.origin='finnor_generated' LIMIT 2
  `, [ctx.auth.tenantId, sheetSystem, runId])).rows, { readOnly: true });
}

export async function readCitedEntryCalculation(ctx: PeMutationContext, runId: string) {
  const versions = await calculationVersions(ctx, runId);
  if (!versions.length) return null;
  if (versions.length !== 1) refuse("ENTRY_CALCULATION_CONFLICT", "More than one calculation sheet exists for the run.");
  const version = versions[0]!;
  const run = await getUnderwritingRun(ctx, runId);
  const result = run.result as Awaited<ReturnType<typeof createUnderwritingRun>>["result"];
  const sources = await peTransaction(ctx, async (_db, client) => (await client.query<{ dealId: string; definition: UnderwritingModelIR }>(`
    SELECT i.deal_id::text "dealId",v.model_definition definition FROM finnor_os.underwriting_model_versions v
    JOIN finnor_os.pe_investment_cases i ON i.tenant_id=v.tenant_id AND i.id=v.investment_case_id
    WHERE v.tenant_id=$1 AND v.id=$2 AND i.id=$3
  `, [ctx.auth.tenantId, run.modelVersionId, run.investmentCaseId])).rows[0], { readOnly: true });
  const currency = sources?.definition.nodes.find(node => node.id === nodeId("sellerEbitda"))?.currency;
  if (!sources || !currency || result.status !== "SUCCEEDED" || result.validity !== "VALID"
    || result.modelSemanticHash !== compileUnderwritingModel(citedEntryModel(currency, sources.definition.periodDefinition.forecastStart)).semanticHash) {
    refuse("ENTRY_CALCULATION_CONFLICT", "The calculation sheet must resolve to a valid run of the exact cited-entry model.");
  }
  const snapshot = run.inputSnapshot as Awaited<ReturnType<typeof createUnderwritingRun>>["inputSnapshot"];
  const provenance = [...new Map(inputKeys.flatMap(key => snapshot.values[nodeId(key)]?.provenance ?? [])
    .filter(source => source.kind === "cited_entry_exhibit" && source.versionId)
    .map(source => [source.id, { documentId: source.id, versionId: source.versionId! }])).values()];
  await readCitedEntryInputs(ctx, { dealId: sources.dealId, sources: provenance, monetaryUnit: { currency, scale: "millions" } });
  const artifact = await getArtifact(ctx.auth, version.documentId, version.versionId);
  const cells = new Map(artifact.ir.nodes.filter(node => node.kind === "cell").map(node => [node.data.address, node.data.value]));
  const figures = outputKeys.map((key, index) => {
    const row = index + inputKeys.length + 2;
    const value = cells.get(`B${row}`), unit = cells.get(`C${row}`), formula = cells.get(`D${row}`), citations = cells.get(`E${row}`);
    const output = result.outputs[`output.${nodeId(key)}`];
    if (cells.get(`A${row}`) !== key || typeof value !== "string" || typeof unit !== "string"
      || typeof formula !== "string" || typeof citations !== "string" || typeof output?.value !== "string"
      || value !== (output.unit === "money" ? div(output.value, "1000000") : output.value)) {
      refuse("ENTRY_CALCULATION_CONFLICT", "The persisted sheet does not match the exact underwriting outputs.");
    }
    return { key, value, unit, formula, citations };
  });
  return { ...version, figures };
}

export async function canReadCitedEntryCalculationDocument(ctx: PeMutationContext, documentId: string): Promise<boolean> {
  const versions = await peTransaction(ctx, async (_db, client) => (await client.query<{ runId: string }>(`
    SELECT source_ref "runId" FROM finnor_os.document_versions
    WHERE tenant_id=$1 AND document_id=$2 AND source_system=$3 AND origin='finnor_generated' LIMIT 2
  `, [ctx.auth.tenantId, documentId, sheetSystem])).rows, { readOnly: true });
  if (!versions.length) return true;
  if (versions.length !== 1) return false;
  try {
    return (await readCitedEntryCalculation(ctx, versions[0]!.runId))?.documentId === documentId;
  } catch (error) {
    if (error instanceof PeDomainError && ["PE_ENTITY_NOT_FOUND", "ENTRY_SOURCE_MISSING", "ENTRY_SOURCE_SUPERSEDED", "ENTRY_CALCULATION_CONFLICT"].includes(error.code)) return false;
    throw error;
  }
}

export async function runCitedEntryUnderwriting(ctx: PeMutationContext, input: {
  dealId: string; investmentCaseId: string; modelVersionId: string; workId: string;
  worldAt: string; idempotencyKey: string;
}) {
  const context = await peTransaction(ctx, async (_db, client) => {
    const model = (await client.query<{ definition: UnderwritingModelIR; hash: string }>(`
      SELECT v.model_definition definition,v.semantic_hash hash FROM finnor_os.underwriting_model_versions v
      JOIN finnor_os.pe_investment_cases i ON i.tenant_id=v.tenant_id AND i.id=v.investment_case_id
      WHERE v.tenant_id=$1 AND v.id=$2 AND i.id=$3 AND i.deal_id=$4 AND i.state='active'
    `, [ctx.auth.tenantId, input.modelVersionId, input.investmentCaseId, input.dealId])).rows[0];
    const sources = (await client.query<EntrySourceRef>(`
      SELECT l.document_id::text "documentId", h.version_id::text "versionId"
      FROM finnor_os.pe_document_links l
      JOIN finnor_os.document_version_heads h ON h.tenant_id=l.tenant_id AND h.document_id=l.document_id
        AND h.kind='current' AND h.head_key='default'
      JOIN finnor_os.document_versions v ON v.tenant_id=h.tenant_id AND v.id=h.version_id
      WHERE l.tenant_id=$1 AND l.deal_id=$2 AND l.entity_type='pe_deal' AND l.entity_id=$2
        AND l.link_role='source' AND l.archived_at IS NULL AND v.format='pdf' AND v.created_at<=$3
      LIMIT 5
    `, [ctx.auth.tenantId, input.dealId, input.worldAt])).rows;
    return { model, sources };
  }, { readOnly: true });
  const currency = context.model?.definition.nodes.find(node => node.id === nodeId("sellerEbitda"))?.currency;
  if (!context.model || !currency || compileUnderwritingModel(citedEntryModel(currency, context.model.definition.periodDefinition.forecastStart)).semanticHash !== context.model.hash) {
    refuse("ENTRY_MODEL_UNAVAILABLE", "The Work must use the exact cited-entry model version on its active Investment Case.");
  }
  const facts = await readCitedEntryInputs(ctx, {
    dealId: input.dealId, sources: context.sources, monetaryUnit: { currency, scale: "millions" },
  });
  const explicitInputs: Record<string, ExplicitUnderwritingInput> = Object.fromEntries(inputKeys.map(key => {
    const fact = facts[key];
    return [nodeId(key), {
      value: inputs[key] === "money" ? mul(fact.value, "1000000") : fact.value, truthClass: "OBSERVED_FACT",
      provenance: [{ kind: "cited_entry_exhibit", id: fact.documentId, versionId: fact.versionId, anchorId: fact.anchorId, semanticHash: fact.anchorHash }],
      reason: `${fact.exhibitId} ${fact.location}`,
    }];
  }));
  if (cmp(facts.maximumLeverage.value, "0") <= 0 || cmp(facts.maximumEntryMultiple.value, "0") <= 0
    || cmp(facts.qoeStartingEbitda.value, add(facts.unsupportedAddbacks.value, facts.nonrecurringIncome.value)) <= 0) {
    refuse("ENTRY_DEFINITION_UNSUPPORTED", "Entry multiples require positive limits and recurring EBITDA.");
  }
  const run = await createUnderwritingRun(ctx, { ...input, explicitInputs });
  if (run.result.status !== "SUCCEEDED" || run.result.validity !== "VALID") {
    refuse("ENTRY_UNDERWRITING_FAILED", "The underwriting engine did not produce a valid entry calculation.");
  }
  const citations = (key: EntryKey): string[] => {
    if (key in inputs) {
      const fact = facts[key as InputKey];
      return [`${fact.exhibitId} ${fact.location} (document_version:${fact.versionId})`];
    }
    return [...new Set(formulas[key as keyof typeof formulas].slice(1).flatMap(dependency => citations(dependency as EntryKey)))];
  };
  const formula = (key: keyof typeof formulas) => {
    const [op, ...args] = formulas[key];
    return args.join({ subtract: " − ", divide: " ÷ ", multiply: " × " }[op]);
  };
  const rows = [
    ["Figure", "Value", "Unit", "Formula", "Citations"],
    ...inputKeys.map(key => [key, facts[key].value, inputs[key] === "money" ? `${currency} millions` : "x", "Cited input", citations(key).join("; ")]),
    ...outputKeys.map(key => {
      const result = run.result.outputs[`output.${nodeId(key)}`]!;
      if (typeof result.value !== "string") refuse("ENTRY_UNDERWRITING_FAILED", "The calculation did not persist an exact decimal.");
      const money = result.unit === "money";
      return [key, money ? div(result.value, "1000000") : result.value, money ? `${currency} millions` : "x", formula(key), citations(key).join("; ")];
    }),
  ];
  const existing = await calculationVersions(ctx, run.id);
  if (existing.length > 1) refuse("ENTRY_CALCULATION_CONFLICT", "More than one calculation sheet exists for the run.");
  if (!existing.length) await ingestArtifact(ctx.auth, {
    title: "Cited entry calculation.xlsx", bytes: calculationSheet(rows), origin: "finnor_generated", sourceSystem: sheetSystem, sourceRef: run.id,
  });
  if (!await readCitedEntryCalculation(ctx, run.id)) refuse("ENTRY_CALCULATION_CONFLICT", "The exact calculation sheet could not be read back.");
  return run;
}
