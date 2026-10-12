import { createHash } from "node:crypto";
import { OfficePackage, NS, children, descendants, parseXml, textContent, withArtifactDeadline } from "@finnor/ooxml";
import { PDFParse } from "pdf-parse";
import type { OriginalInstitutionEvidence } from "./checker";
import type { DigitalInstitutionProfile } from "./contracts";

export interface DecodedInstitutionObservation {
  sourceId: string;
  objectId: string;
  protocol: string;
  sourceClass: string;
  sourceRevision: string;
  originalDigest: string;
  anchor: string;
  fields: Record<string, string>;
}
export interface DecodedInstitutionSource {
  observations: DecodedInstitutionObservation[];
  gaps: { sourceId: string; reason: string; affectedObjectIds: string[] }[];
  rawBytes: number;
  acquisitionCalls: number;
}

const fail = (reason: string): never => { throw new Error(`X1_SOURCE_BOUND_OR_COVERAGE: ${reason}`); };
function asFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("record must be an object");
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") return fail(`nested field ${key}`);
    if (typeof item === "number" && !Number.isSafeInteger(item)) return fail(`non-exact numeric token ${key}`);
    return [key, String(item)];
  }));
}
function lines(raw: string): Record<string, string>[] {
  return raw.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/).map((block) => {
    const fields: Record<string, string> = {};
    const narrative: string[] = [];
    for (const line of block.split("\n")) {
      const match = /^([A-Za-z][\w -]*):\s*(\S.*)$/.exec(line);
      if (!match) {
        if (!fields["Document ID"] && !fields["Record ID"]) return fail("unidentified document text");
        narrative.push(line);
        continue;
      }
      if (fields[match[1]!] !== undefined) return fail("repeated document field");
      fields[match[1]!] = match[2]!;
    }
    if (narrative.length) fields.Content = [fields.Content, ...narrative].filter(Boolean).join("\n");
    return fields;
  });
}
function table(raw: string, separator: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const character = raw[i]!;
    if (character === '"') {
      if (quoted && raw[i + 1] === '"') { cell += '"'; i++; }
      else if (!quoted && cell === "") quoted = true;
      else if (quoted && (raw[i + 1] === separator || /[\r\n]/.test(raw[i + 1] ?? "") || i + 1 === raw.length)) quoted = false;
      else fail("invalid quoted table cell");
    } else if (character === separator && !quoted) { row.push(cell); cell = ""; }
    else if (/[\r\n]/.test(character) && !quoted) {
      if (character === "\r" && raw[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += character;
  }
  if (quoted) fail("unterminated table cell");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [headers, ...data] = rows;
  if (!headers?.length || new Set(headers).size !== headers.length || headers.some((name) => !name)) return fail("missing table heading");
  return data.map((cells) => {
    if (cells.length !== headers.length) return fail("ragged table row");
    return Object.fromEntries(headers.map((name, i) => [name, cells[i]!]));
  });
}
function markup(raw: string): Record<string, string>[] {
  if (/<(?:script|style|iframe)\b/i.test(raw)) fail("active HTML is not a record");
  const tables = [...raw.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  if (tables.length > 1) fail("multiple HTML tables require separate complete material coverage");
  const fragment = tables[0]?.[1];
  if (!fragment) return fail("HTML table missing");
  const rows = [...fragment.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) =>
    [...match[1]!.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((item) =>
      item[1]!.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim()));
  const [head, ...body] = rows;
  if (!head?.length || new Set(head).size !== head.length) return fail("HTML headings missing or repeated");
  return body.map((row) => row.length === head.length
    ? Object.fromEntries(head.map((key, i) => [key, row[i]!]))
    : fail("HTML row width differs"));
}
function mail(raw: string): Record<string, string>[] {
  const [header, ...body] = raw.replace(/\r\n/g, "\n").split("\n\n");
  if (!header || !body.join("\n\n").trim()) return fail("RFC822 body absent");
  const fields = Object.fromEntries(header.split("\n").map((line) => {
    const at = line.indexOf(":");
    if (at < 1) return fail("RFC822 header malformed");
    return [line.slice(0, at), line.slice(at + 1).trim()];
  }));
  if (!fields["Message-ID"] || !fields.From || !fields.To || !fields.Date) fail("RFC822 provenance absent");
  return [{ ...fields, body: body.join("\n\n").trim() }];
}
function calendar(raw: string): Record<string, string>[] {
  if (!raw.startsWith("BEGIN:VCALENDAR") || !raw.trimEnd().endsWith("END:VCALENDAR")) fail("calendar framing absent");
  const events = [...raw.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)];
  if (!events.length) fail("calendar events absent");
  return events.map((event) => {
    const fields = Object.fromEntries(event[1]!.split(/\r?\n/).filter(Boolean).map((line) => {
      const at = line.indexOf(":");
      if (at < 1) return fail("calendar property malformed");
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    if (!fields.UID || !fields.DTSTART || !fields.DTEND) fail("calendar event identity or times absent");
    return fields;
  });
}
function workbook(bytes: Buffer): Record<string, string>[] {
  const packageFile = new OfficePackage(bytes);
  if (packageFile.format !== "xlsx") return fail("XLSX package required");
  const root = packageFile.xml(packageFile.mainPart);
  const sheets = descendants(root, "sheet", NS.sheet);
  if (sheets.length > 1) fail("multiple worksheets require separate complete material coverage");
  const sheet = sheets[0];
  const links = packageFile.relationships(packageFile.mainPart);
  const part = links.find((link) => link.id === sheet?.attrs["r:id"])?.resolved;
  if (!part) return fail("worksheet relation absent");
  const stringsPart = links.find((link) => link.type.endsWith("/sharedStrings"))?.resolved;
  const strings = stringsPart ? descendants(packageFile.xml(stringsPart), "si", NS.sheet)
    .map((node) => descendants(node, "t", NS.sheet).map(textContent).join("")) : [];
  const rows = descendants(packageFile.xml(part), "row", NS.sheet).map((node) => {
    const columns = new Map<string, string>();
    for (const cell of children(node, "c", NS.sheet)) {
      if (children(cell, "f", NS.sheet).length) fail("formula is not a verified source assertion");
      const address = /^([A-Z]+)\d+$/.exec(cell.attrs.r ?? "")?.[1];
      if (!address || columns.has(address)) return fail("worksheet cell collision");
      const value = cell.attrs.t === "inlineStr" ? descendants(cell, "t", NS.sheet).map(textContent).join("")
        : children(cell, "v", NS.sheet)[0]?.text ?? "";
      const converted = cell.attrs.t === "s" ? strings[Number(value)] : value;
      if (converted === undefined) fail("shared string unavailable");
      columns.set(address, converted!);
    }
    return columns;
  });
  const [heading, ...data] = rows;
  if (!heading?.size || new Set(heading.values()).size !== heading.size) return fail("workbook headings absent or repeated");
  return data.map((row) => Object.fromEntries([...heading].map(([column, key]) => [key, row.get(column) ?? ""])));
}
async function decode(protocol: string, raw: string, bytes: Buffer): Promise<Record<string, string>[]> {
  switch (protocol) {
    case "json_records": {
      const data: unknown = JSON.parse(raw);
      if (!Array.isArray(data)) return fail("JSON records array required");
      return data.map(asFields);
    }
    case "paginated_json": {
      const data = JSON.parse(raw) as { pages?: { cursor: string; nextCursor: string | null; records: unknown[] }[] };
      if (!Array.isArray(data.pages) || !data.pages.length) return fail("paginated JSON pages absent");
      let cursor = "start"; const seen = new Set<string>();
      const rows = data.pages.flatMap((page) => {
        if (page.cursor !== cursor || seen.has(cursor) || !Array.isArray(page.records)) return fail("page cursor gap or repetition");
        seen.add(cursor); cursor = page.nextCursor ?? "";
        return page.records.map(asFields);
      });
      if (cursor) return fail("unread continuation page");
      return rows;
    }
    case "csv": case "tsv": return table(raw, protocol === "csv" ? "," : "\t");
    case "rfc822": case "installed_source_adapter": return mail(raw);
    case "icalendar": return calendar(raw);
    case "html": return markup(raw);
    case "financial_xml": {
      const root = parseXml(raw);
      if (!["records", "decisions", "transactions"].includes(root.local)
        || root.children.some((node) => node.children.length
        || !["entity", "quantity", "trigger", "decision", "transaction"].includes(node.local))) return fail("financial XML record structure unsupported");
      return root.children.map((node) => ({ ...node.attrs,
        ...(["entity", "quantity", "trigger"].includes(node.local) ? { kind: node.local } : {}) }));
    }
    case "text": return lines(raw);
    case "docx": {
      const pkg = new OfficePackage(bytes);
      if (pkg.format !== "docx") return fail("DOCX package required");
      return lines(descendants(pkg.xml(pkg.mainPart), "p", NS.word)
        .map((paragraph) => descendants(paragraph, "t", NS.word).map(textContent).join("")).join("\n"));
    }
    case "xlsx": return workbook(bytes);
    case "pdf_text": {
      if (bytes.subarray(0, 5).toString() !== "%PDF-") return fail("PDF magic absent");
      const parser = new PDFParse({ data: bytes });
      try {
        const info = await withArtifactDeadline(parser.getInfo(), 25_000);
        if (info.total > 500) fail("PDF page count exceeded");
        const text = await withArtifactDeadline(parser.getText(), 25_000);
        if (text.pages.some((page) => !page.text.trim())) fail("OCR required for non-text page");
        return lines(text.pages.map((page) => page.text).join("\n\n"));
      } finally { await parser.destroy(); }
    }
    default: return fail(`unsupported protocol ${protocol}`);
  }
}

/** Acquisition is supplied by an already authorized file/export/adapter owner.
 * Raw bytes are never fetched from a caller URL or allowed to grant access. */
export async function decodeInstitutionSources(
  input: OriginalInstitutionEvidence, profile: DigitalInstitutionProfile,
): Promise<DecodedInstitutionSource> {
  const { bounds } = profile;
  if (input.sources.length > bounds.sourceInstances || input.sources.length > bounds.authorizedAcquisitionCalls) fail("source/acquisition count exceeded");
  const observations: DecodedInstitutionObservation[] = [], gaps: DecodedInstitutionSource["gaps"] = [];
  let total = 0;
  const ids = new Set<string>();
  for (const source of input.sources) {
    if (ids.has(source.id)) fail(`duplicate source identity ${source.id}`);
    ids.add(source.id);
    const declaration = profile.sourceClasses.find((item) => item.id === source.sourceClass);
    if (!declaration?.protocols.includes(source.protocol)) fail(`undeclared ${source.sourceClass}/${source.protocol}`);
    if(source.ownerCoverageGap){
      if(source.rawUtf8!==''||source.rawBase64!==undefined||source.coverage.readObjectIds.length
        ||source.coverage.complete||source.authorizedPrincipalIds.length)fail(`unavailable source contains private evidence ${source.id}`);
      continue;
    }
    const binary = ["pdf_text", "docx", "xlsx"].includes(source.protocol);
    const bytes = binary ? Buffer.from(source.rawBase64 ?? "", "base64") : Buffer.from(source.rawUtf8, "utf8");
    if (binary && (source.rawUtf8 !== "" || bytes.toString("base64") !== source.rawBase64)
        || !binary && source.rawBase64 !== undefined || !bytes.length) fail(`original bytes absent or format mismatch ${source.id}`);
    total += bytes.length;
    if (bytes.length > bounds.objectBytes || total > bounds.rawBytes
        || source.coverage.expectedObjectIds.length > bounds.observationReferences
        || source.coverage.readObjectIds.length > bounds.observationReferences) fail(`raw/coverage bound ${source.id}`);
    if (source.tenantId !== input.tenantId || source.institutionId !== input.institutionId
        || !source.authorizedPrincipalIds.includes(input.principalId)
        || source.rightsRevision !== input.current.rightsRevision
        || (["personnel_benefits", "expense_administration"].includes(source.sourceClass) && !source.sensitiveConsentRef)) {
      gaps.push({ sourceId: source.id, reason: "ACCESS_OR_CONSENT_NOT_ESTABLISHED", affectedObjectIds: [...source.coverage.expectedObjectIds] });
      continue;
    }
    const rows = await decode(source.protocol, source.rawUtf8, bytes);
    if (rows.length > bounds.tabularRowsPerObject || observations.length + rows.length > bounds.observationReferences
        || Buffer.byteLength(JSON.stringify(rows)) > bounds.objectBytes) fail(`row/observation/decoded bound ${source.id}`);
    const seen = new Set<string>();
    for (const [index, fields] of rows.entries()) {
      const normalized = Object.fromEntries(Object.entries(fields).map(([name, value]) =>
        [name.replace(/[^a-z0-9]/gi, "").toLowerCase(), value]));
      const id = normalized.id ?? normalized.recordid ?? normalized.opportunityid ?? normalized.transactionid
        ?? normalized.documentid ?? normalized.taskid ?? normalized.facilityid ?? normalized.employeeid
        ?? normalized.receiptid ?? normalized.uid ?? /^<([^@<>]+)@/.exec(normalized.messageid ?? "")?.[1];
      if (!id || seen.has(id)) return fail(`missing/duplicate object identity ${source.id}`);
      seen.add(id);
      observations.push({ sourceId: source.id, objectId: id, protocol: source.protocol,
        sourceClass: source.sourceClass, sourceRevision: source.revision,
        originalDigest: createHash("sha256").update(bytes).digest("hex"),
        anchor: `${source.id}/${index + 1}`, fields });
    }
    const missing = source.coverage.expectedObjectIds.filter((id) => !seen.has(id));
    if (!source.coverage.complete || missing.length
        || source.coverage.readObjectIds.length !== rows.length
        || source.coverage.readObjectIds.some((id) => !seen.has(id))) {
      gaps.push({ sourceId: source.id, reason: "SOURCE_COVERAGE_INCOMPLETE",
        affectedObjectIds: [...new Set([...missing, ...source.coverage.readObjectIds.filter((id) => !seen.has(id))])] });
    }
  }
  return { observations, gaps, rawBytes: total, acquisitionCalls: input.sources.length };
}
