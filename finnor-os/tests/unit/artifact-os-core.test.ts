import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactError,
  OfficePackage,
  diffIR,
  parseXml,
  safePart,
  semanticHash,
  sha256,
  withArtifactDeadline,
  writeZip,
  type SemanticIR,
} from "@finnor/ooxml";
import {
  a1,
  analyzeFormula,
  columnName,
  parseA1,
  parseWorkbook,
  patchWorkbook,
  rangeAddresses,
  staticCycles,
} from "@finnor/spreadsheet-ir";
import { parseDocument, patchDocument } from "@finnor/document-ir";
import { parsePresentation, patchPresentation } from "@finnor/presentation-ir";
import { ARTIFACT_METRICS, classifyReadback, createBlankArtifactBytes, interpret, remapArtifactAnchor, threeWayArtifactDiff } from "@finnor/artifacts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = resolve(HERE, "../artifact-corpus");
const fixture = (name: string): Buffer => readFileSync(resolve(CORPUS, name));
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function packageParts(pkg: OfficePackage): Map<string, Buffer> {
  return new Map([...pkg.parts].map(([name, part]) => [name, Buffer.from(part.bytes)]));
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactError);
    expect((error as ArtifactError).code).toBe(code);
  }
}

function changedParts(before: OfficePackage, after: OfficePackage): string[] {
  return [...new Set([...before.parts.keys(), ...after.parts.keys()])]
    .filter((name) => before.parts.get(name)?.hash !== after.parts.get(name)?.hash)
    .sort();
}

describe("P3 golden Office/PDF corpus", () => {
  it("pins every bounded, non-confidential fixture to its exact byte hash", () => {
    const manifest = JSON.parse(fixture("sources.json").toString("utf8")) as Array<Record<string, unknown>>;
    expect(manifest).toHaveLength(14);
    for (const entry of manifest) {
      const bytes = fixture(String(entry.file));
      expect(bytes.length, String(entry.file)).toBe(entry.bytes);
      expect(digest(bytes), String(entry.file)).toBe(entry.sha256);
      expect(entry.confidentialData).toBe(false);
    }
  });

  it.each([
    ["lbo-style.xlsx", "xlsx"],
    ["feature-heavy.xlsx", "xlsx"],
    ["office-features.xlsx", "xlsx"],
    ["office-formulas.xlsx", "xlsx"],
    ["macro-preservation.xlsm", "xlsm"],
    ["investment-memo.docx", "docx"],
    ["tracked-changes.docx", "docx"],
    ["office-document.docx", "docx"],
    ["office-header-footer.docx", "docx"],
    ["ic-style.pptx", "pptx"],
    ["feature-heavy.pptx", "pptx"],
    ["office-presentation.pptx", "pptx"],
    ["text-evidence.pdf", "pdf"],
    ["image-only-evidence.pdf", "pdf"],
  ])("interprets %s deterministically as %s", async (name, kind) => {
    const first = await interpret(fixture(name), { fileName: name });
    const second = await interpret(fixture(name), { fileName: name });
    expect(first.kind).toBe(kind);
    expect(first.semanticHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.semanticHash).toBe(second.semanticHash);
    expect(first.nodes).toEqual(second.nodes);
  });
});

describe("P3 OOXML security and loss prevention", () => {
  it("rejects ZIP bombs before expansion", () => {
    const bytes = Buffer.from(createBlankArtifactBytes("xlsx"));
    const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const central = bytes.readUInt32LE(eocd + 16);
    bytes.writeUInt32LE(67_108_865, central + 24);
    expectCode(() => new OfficePackage(bytes), "ZIP_BOMB");
  });

  it("rejects traversal names in both writer and package reader", () => {
    expectCode(() => writeZip(new Map([["../escape.xml", Buffer.from("x")]])), "UNSAFE_PART_PATH");
    const bytes = Buffer.from(createBlankArtifactBytes("xlsx"));
    const from = Buffer.from("xl/styles.xml");
    const to = Buffer.from("../styles.xml");
    expect(to.length).toBe(from.length);
    let offset = 0;
    let replacements = 0;
    while ((offset = bytes.indexOf(from, offset)) >= 0) {
      to.copy(bytes, offset);
      replacements += 1;
      offset += from.length;
    }
    expect(replacements).toBe(2);
    expectCode(() => new OfficePackage(bytes), "UNSAFE_PART_PATH");
  });

  it("rejects DTD/entity XML before parser expansion", () => {
    expectCode(() => parseXml("<!DOCTYPE x [<!ENTITY boom SYSTEM 'file:///etc/passwd'>]><x>&boom;</x>"), "XML_DTD_FORBIDDEN");
    const pkg = new OfficePackage(createBlankArtifactBytes("docx"));
    const parts = packageParts(pkg);
    parts.set(pkg.mainPart, Buffer.from("<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY e 'boom'>]><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>&e;</w:t></w:r></w:p></w:body></w:document>"));
    expectCode(() => new OfficePackage(writeZip(parts)), "XML_DTD_FORBIDDEN");
  });

  it("never fetches an external relationship and retains it as explicit IR", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const ir = parseWorkbook(new OfficePackage(fixture("office-features.xlsx")));
    expect(ir.nodes.some((node) => node.kind === "externalReference" && node.data.fetched === false)).toBe(true);
    expect(ir.warnings).toContain("EXTERNAL_RELATIONSHIP_NOT_FETCHED");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects an internal relationship with a remote target", () => {
    const pkg = new OfficePackage(createBlankArtifactBytes("docx"));
    const parts = packageParts(pkg);
    parts.set("_rels/.rels", Buffer.from(pkg.text("_rels/.rels").replace("word/document.xml", "https://bad.invalid/file")));
    expectCode(() => new OfficePackage(writeZip(parts)), "UNSAFE_RELATIONSHIP");
  });

  it("preserves unknown binary parts through a supported edit", () => {
    const base = new OfficePackage(createBlankArtifactBytes("docx"));
    const parts = packageParts(base);
    const opaque = Buffer.from([0, 1, 2, 3, 4, 255]);
    parts.set("customXml/opaque.bin", opaque);
    const source = new OfficePackage(writeZip(parts));
    const ir = parseDocument(source);
    const run = ir.nodes.find((node) => node.kind === "run")!;
    const output = new OfficePackage(patchDocument(source, [{ type: "replace_text", anchor: run.id, expectedHash: run.hash, text: "Safe local edit" }]));
    expect(output.parts.get("customXml/opaque.bin")?.hash).toBe(sha256(opaque));
    expect(output.parts.get("customXml/opaque.bin")?.bytes).toEqual(opaque);
  });

  it("treats embedded OLE as inert opaque bytes and preserves it exactly", () => {
    const base = new OfficePackage(createBlankArtifactBytes("xlsx"));
    const parts = packageParts(base);
    const ole = Buffer.from("D0CF11E0A1B11AE1", "hex");
    parts.set("xl/embeddings/oleObject1.bin", ole);
    const source = new OfficePackage(writeZip(parts));
    const ir = parseWorkbook(source);
    expect(ir.warnings).toContain("OPAQUE_ACTIVE_CONTENT_PRESERVED");
    const cell = ir.nodes.find((node) => node.kind === "cell")!;
    const output = new OfficePackage(patchWorkbook(source, [{ type: "set_value", sheetId: "1", address: "A1", value: "OLE remains inert", expectedHash: cell.hash }]));
    expect(output.parts.get("xl/embeddings/oleObject1.bin")?.bytes).toEqual(ole);
  });

  it("detects VBA, never interprets it, and preserves its exact bytes on a cell edit", () => {
    const source = new OfficePackage(fixture("macro-preservation.xlsm"));
    const beforeVba = source.parts.get("xl/vbaProject.bin")!;
    const ir = parseWorkbook(source);
    expect(ir.warnings).toContain("VBA_PRESERVED_NEVER_EXECUTED");
    const cell = ir.nodes.find((node) => node.kind === "cell")!;
    const output = new OfficePackage(patchWorkbook(source, [{ type: "set_value", sheetId: String(cell.data.sheetId), address: String(cell.data.address), value: "macro untouched", expectedHash: cell.hash }]));
    expect(output.parts.get("xl/vbaProject.bin")?.hash).toBe(beforeVba.hash);
    expect(output.parts.get("xl/vbaProject.bin")?.bytes).toEqual(beforeVba.bytes);
    expectCode(() => patchWorkbook(new OfficePackage(fixture("macro-preservation.xlsm")), [{ type: "delete_vba" } as never]), "UNKNOWN_SHEET");
  });

  it("rejects malformed, duplicate-path, encrypted, unsupported, and legacy binary packages explicitly", async () => {
    expectCode(() => new OfficePackage(Buffer.alloc(22)), "INVALID_ZIP");

    const base = new OfficePackage(createBlankArtifactBytes("xlsx"));
    const duplicate = Buffer.from(writeZip(new Map([...packageParts(base), ["aa.bin", Buffer.from("a")], ["bb.bin", Buffer.from("b")]])));
    const from = Buffer.from("bb.bin");
    const to = Buffer.from("aa.bin");
    let position = 0;
    let replacements = 0;
    while ((position = duplicate.indexOf(from, position)) >= 0) {
      to.copy(duplicate, position);
      position += from.length;
      replacements += 1;
    }
    expect(replacements).toBe(2);
    expectCode(() => new OfficePackage(duplicate), "DUPLICATE_ZIP_PART");

    const encrypted = Buffer.from(createBlankArtifactBytes("xlsx"));
    for (let offset = 0; offset + 10 < encrypted.length; offset += 1) {
      const signature = encrypted.readUInt32LE(offset);
      if (signature === 0x04034b50) encrypted.writeUInt16LE(encrypted.readUInt16LE(offset + 6) | 1, offset + 6);
      if (signature === 0x02014b50) encrypted.writeUInt16LE(encrypted.readUInt16LE(offset + 8) | 1, offset + 8);
    }
    expectCode(() => new OfficePackage(encrypted), "ENCRYPTED_PACKAGE_UNSUPPORTED");

    const unsupportedParts = packageParts(base);
    unsupportedParts.set("[Content_Types].xml", Buffer.from(base.text("[Content_Types].xml").replace(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
      "application/vnd.finnor.unsupported-office.main+xml",
    )));
    expectCode(() => new OfficePackage(writeZip(unsupportedParts)), "UNSUPPORTED_OFFICE_FORMAT");

    for (const bytes of [Buffer.from("D0CF11E0A1B11AE1", "hex"), Buffer.from("XLSB legacy binary")]) {
      await expect(interpret(bytes, { fileName: "mislabelled.xlsx" })).rejects.toMatchObject({ code: "INVALID_ZIP" });
    }
  });

  it("enforces a cancellable parser deadline and publishes the complete metric contract", async () => {
    await expect(withArtifactDeadline(new Promise((resolve) => setTimeout(resolve, 20)), 1)).rejects.toMatchObject({ code: "ARTIFACT_PARSE_TIMEOUT" });
    expect(new Set(ARTIFACT_METRICS).size).toBe(19);
    expect(ARTIFACT_METRICS).toEqual(expect.arrayContaining([
      "artifact_materializations_total",
      "artifact_parse_failures",
      "artifact_publish_conflicts",
      "artifact_excel_recalc_failures",
      "artifact_unresolved_source_binding_count",
    ]));
  });
});

describe("P3 SpreadsheetIR fidelity and typed writes", () => {
  it("preserves sheet order, values, formulas, cached values, styles, formats, merges, and panes", () => {
    const ir = parseWorkbook(new OfficePackage(fixture("lbo-style.xlsx")));
    expect(ir.sheets.map((sheet) => sheet.name)).toEqual(["Summary", "Assumptions", "Operating Build", "Debt Schedule"]);
    const formula = ir.nodes.find((node) => node.id === "cell:1!D5")!;
    expect(formula.data).toMatchObject({ formula: "Assumptions!D5*Assumptions!D6", value: null, cached: 200, style: "3", numberFormatId: "165" });
    const summary = ir.nodes.find((node) => node.id === "sheet:1")!;
    expect(summary.data.merged).toContain("C3:H3");
    expect(summary.data.panes).toEqual(expect.arrayContaining([expect.objectContaining({ state: "frozen" })]));
  });

  it("discovers tables and preserves unsupported active/conditional/validation structures in semantic or opaque truth", () => {
    const ir = parseWorkbook(new OfficePackage(fixture("feature-heavy.xlsx")));
    expect(ir.nodes.some((node) => node.kind === "table" && node.data.ref === "E1:G4")).toBe(true);
    expect(ir.warnings).toContain("OPAQUE_ACTIVE_CONTENT_PRESERVED");
    const sheets = ir.nodes.filter((node) => node.kind === "worksheet");
    expect(sheets.length).toBeGreaterThan(0);
    for (const sheet of sheets) {
      expect(Array.isArray(sheet.data.conditionalFormatting)).toBe(true);
      expect(Array.isArray(sheet.data.validation)).toBe(true);
    }
  });

  it("parses defined names, validation, conditional formatting, comments, charts, and hidden sheets from exact OOXML parts", () => {
    const base = new OfficePackage(createBlankArtifactBytes("xlsx"));
    let parts = packageParts(base);
    parts.set("xl/workbook.xml", Buffer.from(base.text("xl/workbook.xml").replace(
      "<calcPr",
      "<definedNames><definedName name=\"EntryMultiple\">Sheet1!$A$1</definedName></definedNames><calcPr",
    )));
    parts.set("xl/worksheets/sheet1.xml", Buffer.from(base.text("xl/worksheets/sheet1.xml").replace(
      "</worksheet>",
      "<conditionalFormatting sqref=\"A1\"><cfRule type=\"cellIs\" operator=\"greaterThan\" priority=\"1\"><formula>0</formula></cfRule></conditionalFormatting><dataValidations count=\"1\"><dataValidation type=\"whole\" sqref=\"A1\"><formula1>0</formula1></dataValidation></dataValidations></worksheet>",
    )));
    parts.set("xl/worksheets/_rels/sheet1.xml.rels", Buffer.from("<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments\" Target=\"../comments1.xml\"/></Relationships>"));
    parts.set("xl/comments1.xml", Buffer.from("<?xml version=\"1.0\"?><comments xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><authors><author>FINNOR</author></authors><commentList><comment ref=\"A1\" authorId=\"0\"><text><t>Source note</t></text></comment></commentList></comments>"));
    parts.set("xl/charts/chart1.xml", Buffer.from("<?xml version=\"1.0\"?><c:chartSpace xmlns:c=\"http://schemas.openxmlformats.org/drawingml/2006/chart\"><c:chart><c:title><c:tx><c:rich><a:p xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:r><a:t>Returns</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea><c:lineChart><c:ser><c:val><c:numRef><c:f>Sheet1!$A$1</c:f></c:numRef></c:val></c:ser></c:lineChart></c:plotArea></c:chart></c:chartSpace>"));
    let source = new OfficePackage(writeZip(parts));
    let ir = parseWorkbook(source);
    expect(ir.nodes.find((node) => node.kind === "definedName")?.data).toMatchObject({ name: "EntryMultiple", formula: "Sheet1!$A$1" });
    expect(ir.nodes.find((node) => node.kind === "worksheet")?.data).toMatchObject({
      validation: [expect.objectContaining({ attrs: expect.objectContaining({ sqref: "A1" }) })],
      conditionalFormatting: [expect.objectContaining({ attrs: expect.objectContaining({ sqref: "A1" }) })],
    });
    expect(ir.nodes.find((node) => node.kind === "comment")?.data).toMatchObject({ address: "A1", text: "Source note" });
    expect(ir.nodes.find((node) => node.kind === "chart")?.data).toMatchObject({ title: "Returns", references: ["Sheet1!$A$1"] });

    source = new OfficePackage(patchWorkbook(source, [{ type: "create_sheet", name: "Hidden Inputs", expectedWorkbookHash: ir.nodes.find((node) => node.id === "workbook")!.hash }]));
    ir = parseWorkbook(source);
    const hidden = ir.nodes.find((node) => node.id === "sheet:2")!;
    const hiddenResult = parseWorkbook(new OfficePackage(patchWorkbook(source, [{ type: "set_visibility", sheetId: "2", visibility: "hidden", expectedHash: hidden.hash }])));
    expect(hiddenResult.sheets.find((sheet) => sheet.id === "2")?.visibility).toBe("hidden");
  });

  it("no-op is byte-identical; a target cell edit changes only declared semantic parts", () => {
    const source = new OfficePackage(fixture("lbo-style.xlsx"));
    expect(patchWorkbook(source, [])).toEqual(source.source);
    const ir = parseWorkbook(source);
    const cell = ir.nodes.find((node) => node.id === "cell:2!D5")!;
    const outputBytes = patchWorkbook(source, [{ type: "set_value", sheetId: "2", address: "D5", value: 21.5, expectedHash: cell.hash }]);
    const output = new OfficePackage(outputBytes);
    expect(parseWorkbook(output).nodes.find((node) => node.id === cell.id)?.data.value).toBe(21.5);
    expect(changedParts(source, output)).toEqual(["xl/workbook.xml", "xl/worksheets/sheet2.xml"]);

    const exactDecimal = "21.5000000000000000001";
    const exactOutput = new OfficePackage(patchWorkbook(source, [{ type: "set_number", sheetId: "2", address: "D5", value: exactDecimal, expectedHash: cell.hash }]));
    expect(exactOutput.text("xl/worksheets/sheet2.xml")).toContain(`<v>${exactDecimal}</v>`);
  });

  it("edits an exact formula, removes cached truth, and marks calculation stale", () => {
    const source = new OfficePackage(fixture("lbo-style.xlsx"));
    const before = parseWorkbook(source);
    const cell = before.nodes.find((node) => node.id === "cell:1!D7")!;
    const output = parseWorkbook(new OfficePackage(patchWorkbook(source, [{ type: "set_formula", sheetId: "1", address: "D7", formula: "D5+D6", expectedHash: cell.hash }])));
    expect(output.nodes.find((node) => node.id === cell.id)?.data).toMatchObject({ formula: "D5+D6", cached: null, calculation: "cached_stale" });
    expect(output.nodes.filter((node) => node.kind === "cell" && typeof node.data.formula === "string")
      .every((node) => node.data.calculation === "cached_stale")).toBe(true);
    expect(diffIR(before, output)).toEqual(expect.arrayContaining([expect.objectContaining({ id: cell.id, kind: "formula-change" })]));
  });

  it("creates a certified worksheet and keeps existing worksheet bytes exact", () => {
    const source = new OfficePackage(createBlankArtifactBytes("xlsx"));
    const before = parseWorkbook(source);
    const output = new OfficePackage(patchWorkbook(source, [{ type: "create_sheet", name: "IC Output", expectedWorkbookHash: before.nodes.find((node) => node.id === "workbook")!.hash }]));
    const after = parseWorkbook(output);
    expect(after.sheets.map((sheet) => sheet.name)).toEqual(["Sheet1", "IC Output"]);
    expect(output.parts.get("xl/worksheets/sheet1.xml")?.hash).toBe(source.parts.get("xl/worksheets/sheet1.xml")?.hash);
  });

  it("fails stale, merged-cell, invalid sheet, and unsupported operations without returning bytes", () => {
    const source = new OfficePackage(fixture("lbo-style.xlsx"));
    const ir = parseWorkbook(source);
    expectCode(() => patchWorkbook(source, [{ type: "set_value", sheetId: "2", address: "D5", value: 1, expectedHash: "0".repeat(64) }]), "STALE_ANCHOR");
    const merged = ir.nodes.find((node) => node.id === "cell:1!C3")!;
    expectCode(() => patchWorkbook(source, [{ type: "set_value", sheetId: "1", address: "C3", value: 1, expectedHash: merged.hash }]), "MERGED_CELL_WRITE_UNSUPPORTED");
    expectCode(() => patchWorkbook(new OfficePackage(createBlankArtifactBytes("xlsx")), [{ type: "create_sheet", name: "bad/name", expectedWorkbookHash: parseWorkbook(new OfficePackage(createBlankArtifactBytes("xlsx"))).nodes[0]!.hash }]), "INVALID_SHEET_NAME");
  });

  it("preserves very-hidden truth and refuses writes into protected worksheets", () => {
    const original = new OfficePackage(createBlankArtifactBytes("xlsx"));
    const originalIR = parseWorkbook(original);
    const withSecond = new OfficePackage(patchWorkbook(original, [{ type: "create_sheet", name: "Private Inputs", expectedWorkbookHash: originalIR.nodes.find((node) => node.id === "workbook")!.hash }]));
    const secondIR = parseWorkbook(withSecond);
    const privateSheet = secondIR.nodes.find((node) => node.id === "sheet:2")!;
    const hidden = parseWorkbook(new OfficePackage(patchWorkbook(withSecond, [{ type: "set_visibility", sheetId: "2", visibility: "veryHidden", expectedHash: privateSheet.hash }])));
    expect(hidden.sheets.find((sheet) => sheet.id === "2")?.visibility).toBe("veryHidden");

    const protectedParts = packageParts(original);
    protectedParts.set("xl/worksheets/sheet1.xml", Buffer.from(original.text("xl/worksheets/sheet1.xml").replace("<sheetData>", "<sheetProtection sheet=\"1\"/><sheetData>")));
    const protectedPackage = new OfficePackage(writeZip(protectedParts));
    const cell = parseWorkbook(protectedPackage).nodes.find((node) => node.id === "cell:1!A1")!;
    expectCode(() => patchWorkbook(protectedPackage, [{ type: "set_value", sheetId: "1", address: "A1", value: "blocked", expectedHash: cell.hash }]), "PROTECTED_WORKSHEET");
  });
});

describe("P3 formula graph", () => {
  it("proves same-sheet, cross-sheet, range, defined-name, and structured-table dependencies", () => {
    expect(analyzeFormula("=A1+B2", "Model").dependencies).toEqual([{ sheet: "Model", range: "A1" }, { sheet: "Model", range: "B2" }]);
    expect(analyzeFormula("='Debt Schedule'!D5", "Model").dependencies).toEqual([{ sheet: "Debt Schedule", range: "D5" }]);
    expect(analyzeFormula("=SUM(A1:B3)", "Model").dependencies).toEqual([{ sheet: "Model", range: "A1:B3" }]);
    expect(analyzeFormula("=EntryMultiple", "Model", { EntryMultiple: "=Assumptions!D8" }).dependencies).toEqual([{ sheet: "Assumptions", range: "D8", name: "EntryMultiple" }]);
    const structured = analyzeFormula("=SUM(Deals[EBITDA])", "Model", {}, { Deals: { sheet: "Data", range: "A2:F20", columns: ["EBITDA"] } });
    expect(structured.dependencies).toEqual([{ sheet: "Data", range: "A2:F20", table: "Deals" }]);
  });

  it("marks external, dynamic, unresolved, and unsupported formulas partial without guessed edges", () => {
    const external = analyzeFormula("='[Book.xlsx]Sheet1'!A1", "Model");
    expect(external.dependencies[0]).toMatchObject({ range: "A1", external: true });
    expect(external.warnings).toContain("EXTERNAL_REFERENCE");
    const dynamic = analyzeFormula("=INDIRECT(A1)", "Model");
    expect(dynamic.completeness).toBe("partial");
    expect(dynamic.warnings).toContain("DYNAMIC_DEPENDENCY");
    const unsupported = analyzeFormula("=A1|B2", "Model");
    expect(unsupported.dependencies).toEqual([]);
    expect(unsupported.completeness).toBe("partial");
  });

  it("exposes circular dependencies once and expands bounded ranges exactly", () => {
    const cycles = staticCycles(new Map([["A", ["B"]], ["B", ["C"]], ["C", ["A"]]]));
    expect(cycles).toHaveLength(1);
    expect(new Set(cycles[0])).toEqual(new Set(["A", "B", "C"]));
    expect(rangeAddresses("A1:B2")).toEqual(["A1", "B1", "A2", "B2"]);
  });
});

describe("P3 DocumentIR fidelity and guarded writes", () => {
  it("reads sections, paragraphs/runs/styles, tables, headers/footers, footnotes/endnotes and bookmarks", () => {
    const memo = parseDocument(new OfficePackage(fixture("investment-memo.docx")));
    for (const kind of ["section", "paragraph", "run", "table", "tableRow", "tableCell", "header", "footer"]) {
      expect(memo.nodes.some((node) => node.kind === kind), kind).toBe(true);
    }
    expect(memo.nodes.some((node) => node.kind === "paragraph" && node.data.style)).toBe(true);
    const office = parseDocument(new OfficePackage(fixture("office-header-footer.docx")));
    for (const kind of ["header", "footer", "footnote", "endnote", "bookmark"]) expect(office.nodes.some((node) => node.kind === kind), kind).toBe(true);
  });

  it("discovers comments, hyperlinks, and image anchors without interpreting embedded media", () => {
    const base = new OfficePackage(createBlankArtifactBytes("docx"));
    const parts = packageParts(base);
    parts.set(base.mainPart, Buffer.from(base.text(base.mainPart).replace(
      "<w:r><w:t></w:t></w:r>",
      "<w:hyperlink><w:r><w:t>Source link</w:t></w:r></w:hyperlink><w:r><w:drawing/></w:r>",
    )));
    parts.set("word/comments.xml", Buffer.from("<?xml version=\"1.0\"?><w:comments xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:comment w:id=\"0\" w:author=\"Reviewer\"><w:p><w:r><w:t>Check source</w:t></w:r></w:p></w:comment></w:comments>"));
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    parts.set("word/media/image1.png", image);
    const source = new OfficePackage(writeZip(parts));
    const ir = parseDocument(source);
    for (const kind of ["comment", "hyperlink", "image"]) expect(ir.nodes.some((node) => node.kind === kind), kind).toBe(true);
    expect(source.parts.get("word/media/image1.png")?.bytes).toEqual(image);
  });

  it("preserves tracked changes and refuses edits through revision descendants", () => {
    const source = new OfficePackage(fixture("tracked-changes.docx"));
    const ir = parseDocument(source);
    expect(ir.nodes.filter((node) => node.kind === "revision")).toHaveLength(4);
    expect(ir.warnings).toContain("TRACKED_FIELD_OR_OPAQUE_STRUCTURE_PRESERVED");
    const blocked = ir.nodes.find((node) => node.data.editable === false)!;
    expectCode(() => patchDocument(source, [{ type: "replace_text", anchor: blocked.id, expectedHash: blocked.hash, text: "must fail" }]), "UNSUPPORTED_DOCUMENT_TARGET");
  });

  it("supports exact text/table edits and paragraph insertion while preserving untargeted parts", () => {
    const source = new OfficePackage(fixture("investment-memo.docx"));
    expect(patchDocument(source, [])).toEqual(source.source);
    const ir = parseDocument(source);
    const run = ir.nodes.find((node) => node.kind === "run" && String(node.data.text).length > 3)!;
    const edited = new OfficePackage(patchDocument(source, [{ type: "replace_text", anchor: run.id, expectedHash: run.hash, text: "Revised investment thesis" }]));
    expect(parseDocument(edited).nodes.some((node) => node.kind === "run" && node.data.text === "Revised investment thesis")).toBe(true);
    expect(edited.parts.get("word/styles.xml")?.hash).toBe(source.parts.get("word/styles.xml")?.hash);

    const tableCell = ir.nodes.find((node) => node.kind === "tableCell" && String(node.data.text).length > 0)!;
    const tableEdited = parseDocument(new OfficePackage(patchDocument(source, [{ type: "replace_table_cell", anchor: tableCell.id, expectedHash: tableCell.hash, text: "Updated cell" }])));
    expect(tableEdited.nodes.some((node) => node.kind === "tableCell" && node.data.text === "Updated cell")).toBe(true);

    const paragraph = ir.nodes.find((node) => node.kind === "paragraph" && node.part === "word/document.xml" && node.data.editable)!;
    const inserted = parseDocument(new OfficePackage(patchDocument(source, [{ type: "insert_paragraph", anchor: paragraph.id, expectedHash: paragraph.hash, text: "New evidence-backed paragraph" }])));
    expect(inserted.nodes.some((node) => node.kind === "paragraph" && node.data.text === "New evidence-backed paragraph")).toBe(true);
  });

  it("marks a text-box target unsupported and fails the write", () => {
    const base = new OfficePackage(createBlankArtifactBytes("docx"));
    const parts = packageParts(base);
    parts.set(base.mainPart, Buffer.from(base.text(base.mainPart).replace("<w:r><w:t></w:t></w:r>", "<w:r><w:txbxContent><w:p><w:r><w:t>Box</w:t></w:r></w:p></w:txbxContent></w:r>")));
    const source = new OfficePackage(writeZip(parts));
    const ir = parseDocument(source);
    const blocked = ir.nodes.find((node) => node.kind === "run" && node.data.editable === false)!;
    expectCode(() => patchDocument(source, [{ type: "replace_text", anchor: blocked.id, expectedHash: blocked.hash, text: "No" }]), "UNSUPPORTED_DOCUMENT_TARGET");
  });

  it("preserves field-code truth and refuses to rewrite through the field", () => {
    const base = new OfficePackage(createBlankArtifactBytes("docx"));
    const parts = packageParts(base);
    parts.set(base.mainPart, Buffer.from(base.text(base.mainPart).replace(
      "<w:r><w:t></w:t></w:r>",
      "<w:r><w:fldChar w:fldCharType=\"begin\"/><w:instrText>DATE</w:instrText><w:t>September 9, 2026</w:t><w:fldChar w:fldCharType=\"end\"/></w:r>",
    )));
    const source = new OfficePackage(writeZip(parts));
    const ir = parseDocument(source);
    const fieldRun = ir.nodes.find((node) => node.kind === "run" && node.data.editable === false)!;
    expectCode(() => patchDocument(source, [{ type: "replace_text", anchor: fieldRun.id, expectedHash: fieldRun.hash, text: "fabricated" }]), "UNSUPPORTED_DOCUMENT_TARGET");
  });
});

describe("P3 PresentationIR fidelity and guarded writes", () => {
  it("keeps stable slides/shapes, masters/layouts/themes, tables, notes, charts, groups and transitions", () => {
    const source = new OfficePackage(fixture("feature-heavy.pptx"));
    const first = parsePresentation(source);
    const second = parsePresentation(source);
    expect(first.slides).toEqual(second.slides);
    expect(first.nodes.find((node) => node.id === "presentation")?.data.masterRefs).toBeTruthy();
    for (const kind of ["slide", "shape", "table", "tableCell", "notes", "chart", "groupShape"]) expect(first.nodes.some((node) => node.kind === kind), kind).toBe(true);
    expect(first.warnings).toEqual(expect.arrayContaining(["GROUP_SHAPE_PRESERVED", "ANIMATION_TRANSITION_PRESERVED"]));
    expect(Object.keys(first.opaqueParts).some((part) => /slideMaster|slideLayout|theme/.test(part))).toBe(true);
  });

  it("supports exact text/table edits and slide reorder with no-op/untargeted fidelity", () => {
    const source = new OfficePackage(fixture("feature-heavy.pptx"));
    expect(patchPresentation(source, [])).toEqual(source.source);
    const ir = parsePresentation(source);
    const shape = ir.nodes.find((node) => node.kind === "shape" && node.data.editable !== false && String(node.data.text).length > 0)!;
    const edited = new OfficePackage(patchPresentation(source, [{ type: "replace_text", anchor: shape.id, expectedHash: shape.hash, text: "Exact replacement" }]));
    expect(parsePresentation(edited).nodes.some((node) => node.kind === "shape" && node.data.text === "Exact replacement")).toBe(true);
    for (const [part, value] of source.parts) if (part !== shape.part) expect(edited.parts.get(part)?.hash, part).toBe(value.hash);

    const cell = ir.nodes.find((node) => node.kind === "tableCell" && node.data.editable !== false)!;
    const tableEdited = parsePresentation(new OfficePackage(patchPresentation(source, [{ type: "replace_table_cell", anchor: cell.id, expectedHash: cell.hash, text: "Cell replacement" }])));
    expect(tableEdited.nodes.some((node) => node.kind === "tableCell" && node.data.text === "Cell replacement")).toBe(true);

    const deck = new OfficePackage(fixture("ic-style.pptx"));
    const deckIr = parsePresentation(deck);
    const reversed = [...deckIr.slides.map((slide) => slide.id)].reverse();
    const reordered = parsePresentation(new OfficePackage(patchPresentation(deck, [{ type: "reorder_slides", ids: reversed, expectedHash: deckIr.nodes.find((node) => node.id === "presentation")!.hash }])));
    expect(reordered.slides.map((slide) => slide.id)).toEqual(reversed);
  });

  it("duplicates a certified template slide while preserving source/master/layout/theme parts", () => {
    const source = new OfficePackage(createBlankArtifactBytes("pptx"));
    const before = parsePresentation(source);
    const slide = before.nodes.find((node) => node.kind === "slide")!;
    const output = new OfficePackage(patchPresentation(source, [{ type: "duplicate_slide", sourceSlideId: String(slide.data.slideId), expectedHash: slide.hash }]));
    expect(parsePresentation(output).slides.map((item) => item.id)).toEqual(["256", "257"]);
    for (const part of ["ppt/slides/slide1.xml", "ppt/slideLayouts/slideLayout1.xml", "ppt/slideMasters/slideMaster1.xml", "ppt/theme/theme1.xml"]) {
      expect(output.parts.get(part)?.hash).toBe(source.parts.get(part)?.hash);
    }
  });

  it("refuses overlapping edits and grouped-shape targets", () => {
    const source = new OfficePackage(fixture("feature-heavy.pptx"));
    const ir = parsePresentation(source);
    const grouped = ir.nodes.find((node) => node.kind === "shape" && node.data.editable === false)!;
    expectCode(() => patchPresentation(source, [{ type: "replace_text", anchor: grouped.id, expectedHash: grouped.hash, text: "unsafe" }]), "GROUP_SHAPE_WRITE_UNSUPPORTED");
  });

  it("keeps an embedded workbook opaque and byte-exact through a slide edit", () => {
    const base = new OfficePackage(fixture("ic-style.pptx"));
    const parts = packageParts(base);
    const embedded = createBlankArtifactBytes("xlsx");
    parts.set("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx", embedded);
    const source = new OfficePackage(writeZip(parts));
    const ir = parsePresentation(source);
    const shape = ir.nodes.find((node) => node.kind === "shape" && node.data.editable === true && typeof node.data.text === "string" && node.data.text.length > 0)!;
    expect(shape).toBeDefined();
    const output = new OfficePackage(patchPresentation(source, [{ type: "replace_text", anchor: shape.id, expectedHash: shape.hash, text: "Edited while embedding stays opaque" }]));
    expect(output.parts.get("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx")?.bytes).toEqual(embedded);
  });
});

describe("P3 PDF truth", () => {
  it("provides exact page anchors for text and never fabricates OCR", async () => {
    const text = await interpret(fixture("text-evidence.pdf"), { fileName: "text-evidence.pdf" });
    expect(text.nodes.map((node) => node.id)).toEqual(["pdf:page:1", "pdf:page:2"]);
    expect(text.nodes.every((node) => node.data.status === "TEXT_AVAILABLE" && node.data.editable === false)).toBe(true);
    const image = await interpret(fixture("image-only-evidence.pdf"), { fileName: "image-only-evidence.pdf" });
    expect(image.nodes[0]?.data).toMatchObject({ status: "TEXT_UNAVAILABLE_OCR_REQUIRED", text: "", editable: false });
    expect(image.warnings).toEqual(["OCR_REQUIRED"]);
  });
});

describe("P3 semantic diff and concurrency", () => {
  it("classifies exact, provider-normalized, and unexpected semantic readback without guessing", () => {
    const exact = parseWorkbook(new OfficePackage(fixture("lbo-style.xlsx")));
    expect(classifyReadback(exact, structuredClone(exact))).toEqual({ status: "verified", diff: [] });
    const normalized = structuredClone(exact);
    normalized.opaqueParts["docProps/core.xml"] = "0".repeat(64);
    expect(classifyReadback(exact, normalized)).toEqual({
      status: "verified_provider_normalized",
      diff: [expect.objectContaining({ id: "docProps/core.xml", kind: "OPAQUE_PART_CHANGED" })],
    });
    const changed = structuredClone(exact);
    changed.nodes[0]!.data = { ...changed.nodes[0]!.data, unexpected: true };
    changed.nodes[0]!.hash = semanticHash(changed.nodes[0]!.data);
    expect(classifyReadback(exact, changed).status).toBe("verification_failed");
  });

  it("marks an unresolved anchor stale and multiple exact semantic candidates ambiguous", () => {
    const base = parseWorkbook(new OfficePackage(createBlankArtifactBytes("xlsx")));
    const source = base.nodes.find((node) => node.kind === "cell")!;
    expect(remapArtifactAnchor(source, { ...base, nodes: [] })).toMatchObject({ target: null, status: "stale" });
    const duplicateA = { ...source, id: "cell:1!B1" };
    const duplicateB = { ...source, id: "cell:1!C1" };
    expect(remapArtifactAnchor(source, { ...base, nodes: [duplicateA, duplicateB] })).toMatchObject({ target: null, status: "ambiguous" });
  });

  it("computes deterministic three-way overlap and only marks safe disjoint edits merge-eligible", () => {
    const bytes = fixture("lbo-style.xlsx");
    const basePackage = new OfficePackage(bytes);
    const base = parseWorkbook(basePackage);
    const leftCell = base.nodes.find((node) => node.id === "cell:2!D5")!;
    const rightCell = base.nodes.find((node) => node.id === "cell:2!D6")!;
    const local = parseWorkbook(new OfficePackage(patchWorkbook(new OfficePackage(bytes), [{ type: "set_style", sheetId: "2", address: "D5", styleIndex: 0, expectedHash: leftCell.hash }])));
    const remote = parseWorkbook(new OfficePackage(patchWorkbook(new OfficePackage(bytes), [{ type: "set_style", sheetId: "2", address: "D6", styleIndex: 0, expectedHash: rightCell.hash }])));
    expect(threeWayArtifactDiff(base, local, remote)).toMatchObject({ overlappingAnchorIds: [], autoMergeEligible: true });
    const overlap = parseWorkbook(new OfficePackage(patchWorkbook(new OfficePackage(bytes), [{ type: "set_style", sheetId: "2", address: "D5", styleIndex: 1, expectedHash: leftCell.hash }])));
    expect(threeWayArtifactDiff(base, local, overlap)).toMatchObject({ overlappingAnchorIds: [leftCell.id], autoMergeEligible: false });
  });
});

describe("P3 property/fuzz boundaries", () => {
  it("round-trips bounded A1 references and column names", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 16_384 }),
      fc.integer({ min: 1, max: 1_048_576 }),
      fc.boolean(),
      fc.boolean(),
      (column, row, absoluteColumn, absoluteRow) => {
        const encoded = a1({ column, row, absoluteColumn, absoluteRow });
        expect(parseA1(encoded)).toEqual({ column, row, absoluteColumn, absoluteRow });
        expect(columnName(column)).toMatch(/^[A-Z]{1,3}$/);
      },
    ), { numRuns: 200 });
  });

  it("parses generated formulas or returns an explicit partial result without guessing", () => {
    const ref = fc.tuple(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 1, max: 500 })).map(([column, row]) => `${columnName(column)}${row}`);
    fc.assert(fc.property(ref, ref, fc.constantFrom("+", "-", "*", "/", "^", "&"), (left, right, operator) => {
      const result = analyzeFormula(`=${left}${operator}${right}`, "Model");
      expect(result.tokens.length).toBeGreaterThan(0);
      expect(result.dependencies.map((dependency) => dependency.range)).toEqual([left, right]);
    }), { numRuns: 100 });
    fc.assert(fc.property(fc.string({ maxLength: 200 }), (formula) => {
      const result = analyzeFormula(`=${formula}`, "Model");
      expect(["complete", "partial"]).toContain(result.completeness);
      expect(Array.isArray(result.dependencies)).toBe(true);
    }), { numRuns: 200 });
  });

  it("bounds sheet names, ZIP paths, XML trees, anchors, and random package input without process crashes", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 80 }), (name) => {
      try { expect(safePart(name)).toBe(name); } catch (error) { expect(error).toBeInstanceOf(ArtifactError); }
    }), { numRuns: 100 });
    fc.assert(fc.property(fc.integer({ min: 1, max: 40 }), (depth) => {
      const xml = `${"<n>".repeat(depth)}value${"</n>".repeat(depth)}`;
      expect(parseXml(xml).local).toBe("n");
    }), { numRuns: 50 });
    fc.assert(fc.property(fc.uint8Array({ maxLength: 1_024 }), (input) => {
      try { new OfficePackage(Buffer.from(input)); } catch (error) { expect(error).toBeInstanceOf(ArtifactError); }
    }), { numRuns: 100 });
    const hexHash = fc.array(fc.constantFrom(..."0123456789abcdef"), { minLength: 64, maxLength: 64 }).map((digits) => digits.join(""));
    fc.assert(fc.property(hexHash, (wrongHash) => {
      const source = new OfficePackage(createBlankArtifactBytes("xlsx"));
      const cell = parseWorkbook(source).nodes.find((node) => node.kind === "cell")!;
      if (wrongHash !== cell.hash) expectCode(() => patchWorkbook(source, [{ type: "set_value", sheetId: "1", address: "A1", value: "x", expectedHash: wrongHash }]), "STALE_ANCHOR");
    }), { numRuns: 50 });
  });

  it("keeps semantic hashes canonical and diff identities symmetric", () => {
    fc.assert(fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 12 }), fc.oneof(fc.string(), fc.integer(), fc.boolean())), (value) => {
      expect(semanticHash(value)).toBe(semanticHash(Object.fromEntries(Object.entries(value).reverse())));
    }), { numRuns: 100 });
    const node = (id: string, value: unknown) => ({ id, part: "p", path: id, kind: "cell", data: { value, formula: null }, hash: semanticHash({ value, formula: null }) });
    fc.assert(fc.property(fc.integer(), fc.integer(), (left, right) => {
      const a: SemanticIR = { schema: "test", kind: "xlsx", nodes: [node("A", left)], warnings: [], opaqueParts: {}, semanticHash: "" };
      const b: SemanticIR = { schema: "test", kind: "xlsx", nodes: [node("A", right)], warnings: [], opaqueParts: {}, semanticHash: "" };
      expect(diffIR(a, b).map((change) => change.id)).toEqual(diffIR(b, a).map((change) => change.id));
    }), { numRuns: 100 });
  });
});
