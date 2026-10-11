import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DigitalInstitutionProfile } from "../../../packages/private-equity/src/institution-program/contracts";
import { independentlyCheckInstitutionModel, type InstitutionCandidate, type OriginalInstitutionEvidence } from "../../../packages/private-equity/src/institution-program/checker";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeZip } from "@finnor/ooxml";

const load = <T,>(path: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")) as T;
const profile = DigitalInstitutionProfile.parse(load<unknown>("../../../../scope-frontier5/x1-institutional-programme-compiler/profile.json"));
const baseline = load<OriginalInstitutionEvidence>("./reference/original-input.json");
const originalCandidate = load<InstitutionCandidate>("./reference/base-candidate.json");

// Frozen independent format corpus. A semantic record is expressed through
// each format's actual bytes and acquisition/state rules, not a JSON class tag.
const cases = [
  { protocol: "csv", sourceClass: "financial_ledger",
    raw: "id,kind,entityType,registrationId\nentity-A,entity,deal,FIRM-100\n" },
  { protocol: "tsv", sourceClass: "financial_ledger",
    raw: "id\tkind\tentityType\tregistrationId\nentity-A\tentity\tdeal\tFIRM-100\n" },
  { protocol: "paginated_json", sourceClass: "crm_deals",
    raw: JSON.stringify({ pages: [{ cursor: "start", nextCursor: null,
      records: [{ id: "entity-A", kind: "entity", entityType: "deal", registrationId: "FIRM-100" }] }] }) },
  { protocol: "rfc822", sourceClass: "email",
    raw: "Message-ID: <entity-A@example.test>\r\nFrom: analyst@example.test\r\nTo: desk@example.test\r\nDate: Sat, 10 Oct 2026 08:00:00 +0000\r\nSubject: Deal registration\r\nX-Institution-Entity-Type: deal\r\nX-Institution-Registration-ID: FIRM-100\r\n\r\nEvidence of registration, not approval.\r\n" },
  { protocol: "installed_source_adapter", sourceClass: "email",
    raw: "Message-ID: <entity-A@example.test>\r\nFrom: analyst@example.test\r\nTo: desk@example.test\r\nDate: Sat, 10 Oct 2026 08:00:00 +0000\r\nSubject: Deal registration\r\nX-Institution-Entity-Type: deal\r\nX-Institution-Registration-ID: FIRM-100\r\n\r\nEvidence of registration, not approval.\r\n" },
  { protocol: "icalendar", sourceClass: "calendar",
    raw: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:entity-A\r\nDTSTART:20261010T080000Z\r\nDTEND:20261010T090000Z\r\nSUMMARY:Deal meeting\r\nX-INSTITUTION-ENTITY-TYPE:deal\r\nX-INSTITUTION-REGISTRATION-ID:FIRM-100\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n" },
  { protocol: "html", sourceClass: "lender_portal",
    raw: "<!doctype html><html><body><table><thead><tr><th>id</th><th>kind</th><th>entityType</th><th>registrationId</th></tr></thead><tbody><tr><td>entity-A</td><td>entity</td><td>deal</td><td>FIRM-100</td></tr></tbody></table></body></html>" },
  { protocol: "financial_xml", sourceClass: "financial_ledger",
    raw: '<?xml version="1.0"?><records><entity id="entity-A" entityType="deal" registrationId="FIRM-100"/></records>' },
  { protocol: "text", sourceClass: "document_dms",
    raw: "Record ID: entity-A\nEntity Type: deal\nRegistration ID: FIRM-100\n" },
] as const;

const contentTypes = (kind: string, part: string) => `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${part}" ContentType="${kind}"/></Types>`;
const office = (main: string, xml: string, kind: string, extras: Record<string, string> = {}) => writeZip(new Map(Object.entries({
  "[Content_Types].xml": contentTypes(kind, main),
  "_rels/.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`,
  [main]: xml, ...extras,
}).map(([name, value]) => [name, Buffer.from(value)])));
const docx = office("word/document.xml",
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${[
    "Record ID: entity-A", "Entity Type: deal", "Registration ID: FIRM-100",
  ].map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml");
const xlsx = office("xl/workbook.xml",
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Records" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml", {
    "xl/_rels/workbook.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${["id", "kind", "entityType", "registrationId"].map((value, i) => `<c r="${"ABCD"[i]}1" t="inlineStr"><is><t>${value}</t></is></c>`).join("")}</row><row r="2">${["entity-A", "entity", "deal", "FIRM-100"].map((value, i) => `<c r="${"ABCD"[i]}2" t="inlineStr"><is><t>${value}</t></is></c>`).join("")}</row></sheetData></worksheet>`,
  });
const pdf = await PDFDocument.create();
const page = pdf.addPage([612, 792]);
const font = await pdf.embedFont(StandardFonts.Helvetica);
page.drawText("Record ID: entity-A", { x: 48, y: 720, font, size: 12 });
page.drawText("Entity Type: deal", { x: 48, y: 700, font, size: 12 });
page.drawText("Registration ID: FIRM-100", { x: 48, y: 680, font, size: 12 });
const binaryCases = [
  { protocol: "docx", sourceClass: "document_dms", bytes: docx },
  { protocol: "xlsx", sourceClass: "personnel_benefits", bytes: xlsx },
  { protocol: "pdf_text", sourceClass: "document_dms", bytes: Buffer.from(await pdf.save()) },
] as const;

for (const fixture of [...cases.map((item) => ({ ...item, bytes: undefined })),
  ...binaryCases.map((item) => ({ ...item, raw: "" }))]) {
  const source = { ...baseline.sources[0]!, id: "source-A", sourceClass: fixture.sourceClass,
    protocol: fixture.protocol, rawUtf8: fixture.raw,
    ...(fixture.bytes ? { rawBase64: fixture.bytes.toString("base64") } : {}),
    ...(fixture.sourceClass === "personnel_benefits" ? { sensitiveConsentRef: "current-consent-A" } : {}),
    coverage: { complete: true, expectedObjectIds: ["entity-A"], readObjectIds: ["entity-A"] } };
  const original: OriginalInstitutionEvidence = {
    ...baseline, sources: [source], mandate: { ...baseline.mandate, rules: [] },
    current: { ...baseline.current, sourceRevisions: { "source-A": source.revision } },
  };
  const candidate: InstitutionCandidate = {
    ...originalCandidate, coverage: ["source-A"],
    mappings: [{ sourceId: "source-A", recordId: "entity-A",
      canonicalRef: "pe_deal:deal-100@v2", registrationId: "FIRM-100" }],
    quantities: [], contradictions: [], obligations: [],
    dependencies: { ...original.current, sourceRevisions: original.current.sourceRevisions },
  };
  const result = await independentlyCheckInstitutionModel(original, candidate, profile);
  assert.equal(result.disposition, "ACCEPTED_DEVELOPMENT", `${fixture.protocol}: ${JSON.stringify(result)}`);
  const missing = structuredClone(original);
  missing.sources[0]!.coverage.readObjectIds = [];
  assert.equal((await independentlyCheckInstitutionModel(missing, candidate, profile)).disposition, "REJECTED",
    `${fixture.protocol} missing object must not count as complete`);
}
console.log(JSON.stringify({ basis: "independently authored original-format development corpus",
  protocols: [...cases, ...binaryCases].map(({ protocol }) => protocol), checked: cases.length + binaryCases.length }));
