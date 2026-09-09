import {
  ArtifactError,
  NS,
  OfficePackage,
  attributeReplacement,
  children,
  descendants,
  ensure,
  finishIR,
  innerReplacement,
  node,
  parseXml,
  replaceXml,
  semanticHash,
  textContent,
  xmlEscape,
  type SemanticIR,
  type SemanticNode,
  type XmlNode,
  type XmlReplacement,
} from "@finnor/ooxml";
import { analyzeFormula, parseA1, rangeAddresses, staticCycles, translateFormula } from "./formula";

export * from "./formula";

export interface WorkbookIR extends SemanticIR {
  sheets: Array<{ id: string; name: string; part: string; visibility: string }>;
  dependencies: Record<string, string[]>;
  dependents: Record<string, string[]>;
  dependencyCompleteness: "complete" | "partial";
  cycles: string[][];
}

function scalar(cell: XmlNode, strings: string[]): unknown {
  const type = cell.attrs.t;
  const raw = children(cell, "v", NS.sheet)[0]?.text;
  if (type === "inlineStr") return descendants(cell, "t", NS.sheet).map(textContent).join("");
  if (type === "s") {
    const index = Number(raw);
    ensure(Number.isSafeInteger(index) && index >= 0 && index < strings.length, "INVALID_SHARED_STRING");
    return strings[index];
  }
  if (type === "b") return raw === "1";
  if (type === "e" || type === "str" || type === "d") return raw ?? null;
  if (raw === undefined) return null;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : raw;
}

function worksheetNodes(pkg: OfficePackage) {
  const workbook = pkg.xml(pkg.mainPart);
  ensure(workbook.uri === NS.sheet, "STRICT_OOXML_READ_UNSUPPORTED");
  const relationships = pkg.relationships(pkg.mainPart);
  const list = children(workbook, "sheets", NS.sheet)[0];
  ensure(list, "MISSING_WORKSHEETS");
  return children(list, "sheet", NS.sheet).map((source) => {
    const relationship = relationships.find((item) => item.id === source.attrs["r:id"]);
    ensure(relationship?.resolved, "MISSING_WORKSHEET");
    ensure(source.attrs.sheetId && source.attrs.name, "INVALID_WORKSHEET_IDENTITY");
    return {
      source,
      id: source.attrs.sheetId,
      name: source.attrs.name,
      part: relationship.resolved,
      visibility: source.attrs.state ?? "visible",
    };
  });
}

function relationshipPart(part: string): string {
  const slash = part.lastIndexOf("/");
  const directory = slash < 0 ? "" : part.slice(0, slash + 1);
  const name = slash < 0 ? part : part.slice(slash + 1);
  return `${directory}_rels/${name}.rels`;
}

function externalNode(part: string, id: string, data: Record<string, unknown>): SemanticNode {
  return { id, part, path: id, kind: "externalReference", data, hash: semanticHash(data) };
}

export function parseWorkbook(pkg: OfficePackage): WorkbookIR {
  ensure(pkg.format === "xlsx" || pkg.format === "xlsm", "NOT_SPREADSHEET");
  const workbook = pkg.xml(pkg.mainPart);
  const sheets = worksheetNodes(pkg);
  const workbookRelationships = pkg.relationships(pkg.mainPart);
  const sharedStringsPart = workbookRelationships.find((item) => item.type.endsWith("/sharedStrings"))?.resolved;
  const strings = sharedStringsPart
    ? children(pkg.xml(sharedStringsPart), "si", NS.sheet).map((item) => descendants(item, "t", NS.sheet).map(textContent).join(""))
    : [];

  const calculation = children(workbook, "calcPr", NS.sheet)[0];
  const cachedValuesAreStale = calculation?.attrs.fullCalcOnLoad === "1" || calculation?.attrs.forceFullCalc === "1";
  const workbookView = descendants(workbook, "workbookView", NS.sheet)[0];
  const nodes: SemanticNode[] = [node(pkg.mainPart, workbook, "workbook", {
    properties: children(workbook, "workbookPr", NS.sheet)[0]?.attrs ?? {},
    calculation: calculation?.attrs ?? {},
    sheetOrder: sheets.map((item) => item.id),
    activeSheetOrdinal: workbookView?.attrs.activeTab ?? null,
    protection: children(workbook, "workbookProtection", NS.sheet)[0]?.attrs ?? null,
  }, "workbook")];
  const names: Record<string, string> = {};
  const tables: Record<string, { sheet: string; range: string; columns: string[] }> = {};
  const interpreted = [pkg.mainPart];
  const warnings: string[] = [];

  for (const name of descendants(workbook, "definedName", NS.sheet)) {
    const localSheet = name.attrs.localSheetId === undefined ? null : sheets[Number(name.attrs.localSheetId)]?.name;
    const key = localSheet ? `${localSheet}!${name.attrs.name}` : name.attrs.name!;
    names[key] = name.text;
    nodes.push(node(pkg.mainPart, name, "definedName", { name: name.attrs.name, sheet: localSheet, formula: name.text }, `name:${key}`));
  }

  const customNumberFormats = new Map<string, string>();
  const stylePart = workbookRelationships.find((item) => item.type.endsWith("/styles"))?.resolved;
  let cellFormats: XmlNode[] = [];
  if (stylePart) {
    const styles = pkg.xml(stylePart);
    for (const format of descendants(styles, "numFmt", NS.sheet)) {
      if (format.attrs.numFmtId) customNumberFormats.set(format.attrs.numFmtId, format.attrs.formatCode ?? "");
      nodes.push(node(stylePart, format, "numberFormat", { ...format.attrs }, `numFmt:${format.attrs.numFmtId}`));
    }
    cellFormats = children(children(styles, "cellXfs", NS.sheet)[0] ?? styles, "xf", NS.sheet);
  }

  for (const sheet of sheets) {
    const worksheet = pkg.xml(sheet.part);
    interpreted.push(sheet.part);
    nodes.push(node(sheet.part, worksheet, "worksheet", {
      name: sheet.name,
      visibility: sheet.visibility,
      dimension: children(worksheet, "dimension", NS.sheet)[0]?.attrs.ref ?? null,
      panes: descendants(worksheet, "pane", NS.sheet).map((item) => item.attrs),
      merged: descendants(worksheet, "mergeCell", NS.sheet).map((item) => item.attrs.ref),
      protection: children(worksheet, "sheetProtection", NS.sheet)[0]?.attrs ?? null,
      validation: descendants(worksheet, "dataValidation", NS.sheet).map((item) => ({ attrs: item.attrs, text: textContent(item) })),
      conditionalFormatting: descendants(worksheet, "conditionalFormatting", NS.sheet).map((item) => ({ attrs: item.attrs, rules: children(item, "cfRule", NS.sheet).map((rule) => rule.attrs) })),
    }, `sheet:${sheet.id}`));

    for (const cell of descendants(worksheet, "c", NS.sheet)) {
      ensure(cell.attrs.r, "CELL_MISSING_ADDRESS");
      parseA1(cell.attrs.r);
      const formula = children(cell, "f", NS.sheet)[0];
      const value = scalar(cell, strings);
      const styleIndex = Number(cell.attrs.s ?? 0);
      const formatId = Number.isSafeInteger(styleIndex) ? cellFormats[styleIndex]?.attrs.numFmtId ?? null : null;
      nodes.push(node(sheet.part, cell, "cell", {
        sheet: sheet.name,
        sheetId: sheet.id,
        address: cell.attrs.r,
        type: cell.attrs.t ?? "n",
        value: formula ? null : value,
        formula: formula?.text ?? null,
        formulaType: formula?.attrs.t ?? null,
        formulaAttributes: formula?.attrs ?? null,
        cached: formula ? value : null,
        calculation: formula ? (cachedValuesAreStale ? "cached_stale" : value === null ? "uncalculated" : "unknown") : null,
        style: cell.attrs.s ?? null,
        numberFormatId: formatId,
        numberFormatCode: formatId ? customNumberFormats.get(formatId) ?? null : null,
      }, `cell:${sheet.id}!${cell.attrs.r}`));
    }

    for (const relationship of pkg.relationships(sheet.part)) {
      if (relationship.external) {
        warnings.push("EXTERNAL_RELATIONSHIP_NOT_FETCHED");
        nodes.push(externalNode(sheet.part, `external:${sheet.id}:${relationship.id}`, {
          relationshipType: relationship.type,
          target: relationship.target,
          fetched: false,
        }));
        continue;
      }
      if (relationship.type.endsWith("/table")) {
        const table = pkg.xml(relationship.resolved!);
        const columns = descendants(table, "tableColumn", NS.sheet).map((item) => item.attrs.name!);
        ensure(table.attrs.name && table.attrs.ref, "INVALID_TABLE");
        tables[table.attrs.name] = { sheet: sheet.name, range: table.attrs.ref, columns };
        nodes.push(node(relationship.resolved!, table, "table", { ...table.attrs, columns }, `table:${table.attrs.name}`));
      }
      if (relationship.type.endsWith("/comments")) {
        for (const comment of descendants(pkg.xml(relationship.resolved!), "comment", NS.sheet)) {
          nodes.push(node(relationship.resolved!, comment, "comment", {
            address: comment.attrs.ref,
            text: descendants(comment, "t", NS.sheet).map(textContent).join(""),
          }, `comment:${sheet.id}!${comment.attrs.ref}`));
        }
      }
    }
  }

  for (const [part] of pkg.parts) {
    if (/\/charts\/.*\.xml$/.test(part)) {
      const chart = pkg.xml(part);
      nodes.push(node(part, chart, "chart", {
        references: descendants(chart, "f").map((item) => item.text),
        title: descendants(chart, "t").map((item) => item.text).join(""),
      }, part));
    }
    if (/vbaProject\.bin$/i.test(part)) warnings.push("VBA_PRESERVED_NEVER_EXECUTED");
    if (/externalLink|connections|activeX|embeddings/i.test(part)) warnings.push("OPAQUE_ACTIVE_CONTENT_PRESERVED");
  }

  const dependencies: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  let complete = true;
  for (const cell of nodes.filter((item) => item.kind === "cell" && item.data.formula !== null)) {
    const analysis = analyzeFormula(String(cell.data.formula), String(cell.data.sheet), names, tables);
    if (cell.data.formulaType && cell.data.formulaType !== "normal") {
      analysis.completeness = "partial";
      analysis.warnings.push("SPECIAL_FORMULA_TYPE");
    }
    if (analysis.completeness === "partial") complete = false;
    cell.data.dependencyCompleteness = analysis.completeness;
    cell.data.dependencies = analysis.dependencies;
    dependencies[cell.id] = [];
    for (const dependency of analysis.dependencies) {
      if (dependency.external) continue;
      const targetSheet = sheets.find((item) => item.name === dependency.sheet);
      if (!targetSheet) {
        complete = false;
        continue;
      }
      try {
        for (const address of rangeAddresses(dependency.range)) dependencies[cell.id]!.push(`cell:${targetSheet.id}!${address}`);
      } catch {
        complete = false;
        warnings.push("LARGE_DEPENDENCY_RANGE");
      }
    }
    warnings.push(...analysis.warnings);
  }
  for (const [source, targets] of Object.entries(dependencies)) {
    for (const target of targets) dependents[target] = [...(dependents[target] ?? []), source];
  }
  for (const cell of nodes.filter((item) => item.kind === "cell")) {
    cell.data.dependents = [...new Set(dependents[cell.id] ?? [])].sort();
    cell.hash = semanticHash(cell.data);
  }

  const ir = finishIR(pkg, "spreadsheet-ir.v1", nodes, warnings, interpreted);
  return {
    ...ir,
    sheets: sheets.map(({ id, name, part, visibility }) => ({ id, name, part, visibility })),
    dependencies,
    dependents,
    dependencyCompleteness: complete ? "complete" : "partial",
    cycles: staticCycles(new Map(Object.entries(dependencies))),
  };
}

type Scalar = string | number | boolean | null;
export type SpreadsheetOperation =
  | { type: "set_value"; sheetId: string; address: string; value: Scalar; expectedHash: string }
  | { type: "set_number"; sheetId: string; address: string; value: string; expectedHash: string }
  | { type: "set_formula"; sheetId: string; address: string; formula: string; expectedHash: string }
  | { type: "set_range"; sheetId: string; range: string; values: Scalar[][]; expectedHashes: Record<string, string> }
  | { type: "set_formula_range"; sheetId: string; range: string; formulas: string[][]; expectedHashes: Record<string, string> }
  | { type: "fill_formula"; sheetId: string; source: string; range: string; expectedHashes: Record<string, string> }
  | { type: "set_style"; sheetId: string; address: string; styleIndex: number; expectedHash: string }
  | { type: "set_number_format"; sheetId: string; address: string; styleIndex: number; expectedHash: string }
  | { type: "set_visibility"; sheetId: string; visibility: "visible" | "hidden" | "veryHidden"; expectedHash: string }
  | { type: "rename_sheet"; sheetId: string; name: string; expectedHash: string }
  | { type: "create_sheet"; name: string; expectedWorkbookHash: string }
  | { type: "set_defined_name"; name: string; formula: string; expectedHash: string | null };

function nextRelationshipId(pkg: OfficePackage, part: string): string {
  const used = new Set(pkg.relationships(part).map((item) => item.id));
  for (let index = 1; index <= 100_000; index += 1) if (!used.has(`rId${index}`)) return `rId${index}`;
  throw new ArtifactError("RELATIONSHIP_ID_LIMIT");
}

function nextPartName(pkg: OfficePackage, prefix: string, suffix: string): string {
  for (let index = 1; index <= 100_000; index += 1) {
    const candidate = `${prefix}${index}${suffix}`;
    if (!pkg.parts.has(candidate)) return candidate;
  }
  throw new ArtifactError("PACKAGE_PART_ID_LIMIT");
}

export function patchWorkbook(pkg: OfficePackage, operations: SpreadsheetOperation[]): Buffer {
  const ir = parseWorkbook(pkg);
  const byId = new Map(ir.nodes.map((item) => [item.id, item]));
  const replacements = new Map<string, XmlReplacement[]>();
  const addedParts = new Map<string, Buffer>();
  const add = (part: string, replacement: XmlReplacement) => replacements.set(part, [...(replacements.get(part) ?? []), replacement]);
  let invalidateCalculation = false;

  ensure(operations.filter((item) => item.type === "create_sheet").length <= 1, "MULTIPLE_WORKSHEET_CREATION_UNSUPPORTED");
  const expanded: SpreadsheetOperation[] = [];
  for (const operation of operations) {
    if (operation.type === "set_range" || operation.type === "set_formula_range" || operation.type === "fill_formula") {
      const addresses = rangeAddresses(operation.range);
      const first = parseA1(addresses[0]!);
      const last = parseA1(addresses.at(-1)!);
      if (operation.type === "fill_formula") {
        const source = byId.get(`cell:${operation.sheetId}!${operation.source}`);
        ensure(source?.data.formula && source.data.formulaType === null, "UNSUPPORTED_FILL_SOURCE");
        const from = parseA1(operation.source);
        for (const address of addresses) {
          const to = parseA1(address);
          expanded.push({ type: "set_formula", sheetId: operation.sheetId, address, formula: translateFormula(String(source.data.formula), to.column - from.column, to.row - from.row), expectedHash: operation.expectedHashes[address]! });
        }
      } else {
        const matrix = operation.type === "set_range" ? operation.values : operation.formulas;
        ensure(matrix.length === last.row - first.row + 1 && matrix.every((row) => row.length === last.column - first.column + 1), "RANGE_SHAPE_MISMATCH");
        for (const address of addresses) {
          const position = parseA1(address);
          const value = matrix[position.row - first.row]![position.column - first.column]!;
          expanded.push(operation.type === "set_range"
            ? { type: "set_value", sheetId: operation.sheetId, address, value: value as Scalar, expectedHash: operation.expectedHashes[address]! }
            : { type: "set_formula", sheetId: operation.sheetId, address, formula: String(value), expectedHash: operation.expectedHashes[address]! });
        }
      }
    } else expanded.push(operation);
  }

  for (const operation of expanded) {
    if (operation.type === "create_sheet") {
      ensure(byId.get("workbook")?.hash === operation.expectedWorkbookHash, "STALE_ANCHOR");
      ensure(operation.name.length > 0 && operation.name.length <= 31 && !/[\\/?*\[\]:]/.test(operation.name), "INVALID_SHEET_NAME");
      ensure(!ir.sheets.some((item) => item.name.toLowerCase() === operation.name.toLowerCase()), "INVALID_SHEET_NAME");
      const workbook = pkg.xml(pkg.mainPart);
      const sheetList = children(workbook, "sheets", NS.sheet)[0];
      ensure(sheetList, "MISSING_WORKSHEETS");
      const numericIds = ir.sheets.map((item) => Number(item.id)).filter(Number.isSafeInteger);
      const sheetId = String(Math.max(0, ...numericIds) + 1);
      const relationshipId = nextRelationshipId(pkg, pkg.mainPart);
      const part = nextPartName(pkg, "xl/worksheets/sheet", ".xml");
      add(pkg.mainPart, { start: sheetList.closeStart, end: sheetList.closeStart, value: `<sheet name="${xmlEscape(operation.name)}" sheetId="${sheetId}" r:id="${relationshipId}"/>` });
      const relationshipsPart = relationshipPart(pkg.mainPart);
      const relationshipsRoot = pkg.xml(relationshipsPart);
      add(relationshipsPart, { start: relationshipsRoot.closeStart, end: relationshipsRoot.closeStart, value: `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/${part.split("/").at(-1)!}"/>` });
      const contentTypesPart = "[Content_Types].xml";
      const contentTypes = pkg.xml(contentTypesPart);
      add(contentTypesPart, { start: contentTypes.closeStart, end: contentTypes.closeStart, value: `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` });
      addedParts.set(part, Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS.sheet}"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData/></worksheet>`));
      continue;
    }

    if (operation.type === "set_defined_name") {
      ensure(/^[A-Za-z_][A-Za-z0-9_.]{0,254}$/.test(operation.name), "INVALID_DEFINED_NAME");
      const targetNode = byId.get(`name:${operation.name}`);
      ensure((targetNode?.hash ?? null) === operation.expectedHash, "STALE_ANCHOR");
      const workbook = pkg.xml(pkg.mainPart);
      const container = children(workbook, "definedNames", NS.sheet)[0];
      const source = pkg.text(pkg.mainPart);
      if (targetNode) {
        const target = descendants(workbook, "definedName", NS.sheet).find((item) => item.path === targetNode.path)!;
        add(pkg.mainPart, innerReplacement(source, target, xmlEscape(operation.formula)));
      } else if (container) {
        add(pkg.mainPart, { start: container.closeStart, end: container.closeStart, value: `<definedName name="${xmlEscape(operation.name)}">${xmlEscape(operation.formula)}</definedName>` });
      } else {
        const calculation = children(workbook, "calcPr", NS.sheet)[0];
        const position = calculation?.start ?? workbook.closeStart;
        add(pkg.mainPart, { start: position, end: position, value: `<definedNames><definedName name="${xmlEscape(operation.name)}">${xmlEscape(operation.formula)}</definedName></definedNames>` });
      }
      invalidateCalculation = true;
      continue;
    }

    if (operation.type === "set_range" || operation.type === "set_formula_range" || operation.type === "fill_formula") throw new ArtifactError("UNCOMPILED_OPERATION");
    const sheet = ir.sheets.find((item) => item.id === operation.sheetId);
    ensure(sheet, "UNKNOWN_SHEET");
    const worksheet = pkg.xml(sheet.part);
    ensure(!children(worksheet, "sheetProtection", NS.sheet).length, "PROTECTED_WORKSHEET");
    if (operation.type === "set_visibility" || operation.type === "rename_sheet") {
      const sheetNode = byId.get(`sheet:${sheet.id}`)!;
      ensure(sheetNode.hash === operation.expectedHash, "STALE_ANCHOR");
      const sourceSheet = worksheetNodes(pkg).find((item) => item.id === sheet.id)!.source;
      if (operation.type === "set_visibility") {
        ensure(operation.visibility === "visible" || ir.sheets.some((item) => item.id !== sheet.id && item.visibility === "visible"), "LAST_VISIBLE_SHEET");
        add(pkg.mainPart, attributeReplacement(pkg.text(pkg.mainPart), sourceSheet, "state", operation.visibility));
      } else {
        ensure(operation.name.length > 0 && operation.name.length <= 31 && !/[\\/?*\[\]:]/.test(operation.name), "INVALID_SHEET_NAME");
        ensure(!ir.sheets.some((item) => item.id !== sheet.id && item.name.toLowerCase() === operation.name.toLowerCase()), "INVALID_SHEET_NAME");
        ensure(!ir.nodes.some((item) => (item.kind === "cell" && item.data.formula !== null) || item.kind === "definedName") && !Object.keys(ir.opaqueParts).some((part) => /chart|pivot|externalLink/.test(part)), "RENAME_REFERENCE_REWRITE_UNSUPPORTED");
        add(pkg.mainPart, attributeReplacement(pkg.text(pkg.mainPart), sourceSheet, "name", operation.name));
      }
      continue;
    }

    const cellNode = byId.get(`cell:${sheet.id}!${operation.address}`);
    ensure(cellNode && cellNode.hash === operation.expectedHash, "STALE_ANCHOR");
    parseA1(operation.address);
    ensure(!descendants(worksheet, "mergeCell", NS.sheet).some((merge) => {
      try { return rangeAddresses(merge.attrs.ref!).includes(operation.address); } catch { return true; }
    }), "MERGED_CELL_WRITE_UNSUPPORTED");
    const sourceCell = descendants(worksheet, "c", NS.sheet).find((item) => item.attrs.r === operation.address)!;
    ensure(cellNode.data.formulaType === null || cellNode.data.formulaType === "normal", "SPECIAL_FORMULA_WRITE_UNSUPPORTED");
    const source = pkg.text(sheet.part);
    if (operation.type === "set_style" || operation.type === "set_number_format") {
      ensure(Number.isInteger(operation.styleIndex) && operation.styleIndex >= 0, "INVALID_STYLE");
      const styleRelationship = pkg.relationships(pkg.mainPart).find((item) => item.type.endsWith("/styles"));
      ensure(styleRelationship?.resolved, "MISSING_STYLES");
      const formats = children(pkg.xml(styleRelationship.resolved), "cellXfs", NS.sheet)[0];
      ensure(formats && operation.styleIndex < children(formats, "xf", NS.sheet).length, "INVALID_STYLE");
      add(sheet.part, attributeReplacement(source, sourceCell, "s", String(operation.styleIndex)));
      continue;
    }

    const attributes = Object.entries(sourceCell.attrs).filter(([key]) => key !== "t").map(([key, value]) => ` ${key}="${xmlEscape(value)}"`).join("");
    let value: string;
    if (operation.type === "set_formula") {
      const analysis = analyzeFormula(operation.formula, sheet.name);
      ensure(analysis.tokens.length > 0, "UNSUPPORTED_FORMULA_GRAMMAR");
      value = `<c${attributes}><f>${xmlEscape(operation.formula.replace(/^=/, ""))}</f></c>`;
    } else {
      if (operation.type === "set_number") {
        ensure(operation.value.length <= 256 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(operation.value), "INVALID_EXACT_NUMBER");
        value = `<c${attributes}><v>${operation.value}</v></c>`;
      } else {
        const scalarValue = operation.value;
        if (typeof scalarValue === "number") ensure(Number.isFinite(scalarValue), "NON_FINITE_NUMBER");
        value = typeof scalarValue === "string"
        ? `<c${attributes} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(scalarValue)}</t></is></c>`
        : typeof scalarValue === "boolean"
          ? `<c${attributes} t="b"><v>${scalarValue ? "1" : "0"}</v></c>`
          : `<c${attributes}>${scalarValue === null ? "" : `<v>${scalarValue}</v>`}</c>`;
      }
    }
    ensure(sourceCell.children.every((item) => ["f", "v", "is"].includes(item.local) && item.uri === NS.sheet), "OPAQUE_CELL_CHILD_WRITE_UNSUPPORTED");
    add(sheet.part, { start: sourceCell.start, end: sourceCell.end, value });
    invalidateCalculation = true;
  }

  if (invalidateCalculation) {
    const workbook = pkg.xml(pkg.mainPart);
    const calculation = children(workbook, "calcPr", NS.sheet)[0];
    const value = `<calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1"/>`;
    if (calculation) add(pkg.mainPart, { start: calculation.start, end: calculation.end, value });
    else add(pkg.mainPart, { start: workbook.closeStart, end: workbook.closeStart, value });
  }

  const parts = new Map<string, Buffer>(addedParts);
  for (const [part, changes] of replacements) {
    const updated = replaceXml(pkg.text(part), changes);
    parseXml(updated);
    parts.set(part, Buffer.from(updated));
  }
  return pkg.patch(parts, [...parts.keys()]);
}
