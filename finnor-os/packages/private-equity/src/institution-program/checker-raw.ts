import { OfficePackage, NS, children, descendants, parseXml, textContent, withArtifactDeadline } from "@finnor/ooxml";
import { PDFParse } from "pdf-parse";

/** Format-only original-byte reader. This module has no producer inference,
 * ranking, mapping or rule-selection dependency. Unknown material structure
 * is an error, not an empty complete observation. */
type OriginalSource = {
  sourceClass: string; protocol: string; rawUtf8: string; rawBase64?: string;
};
type RecordRow = {
  id: string; kind: string; registrationId?: string; entityType?: string;
  name?: string; vehicleType?: string; baseCurrency?:string;
  effectiveFrom?: string;
  factKey?: string; value?: string; currency?: string; unit?: string; period?: string; basis?: string;
  occurredAt?: string; availableAt?: string; triggerKind?: string;
  relation?: string; relationRegistrationId?: string;
  endsAt?: string;
  narrative?: string;
  observationKind?: string; balanceRole?: string; accountingRelationId?: string;
};

// Independent original-format reader. No producer normalization/inference is
// imported: the raw token, not IEEE-754's rounded result, fixes its decimal.
const quantityTextFields = new Set([
  "factkey", "currency", "unit", "period", "basis", "occurredat", "availableat",
  "accountingbasis", "postedat", "asof",
]);
export class OriginalQuantityContextError extends Error {}

function originalJson(raw: string): unknown {
  return JSON.parse(raw, (key, parsed: unknown, context?: { source?: string }) => {
    if (typeof parsed !== "number") return parsed;
    // Nominal context must retain its original scalar type. Exact decimal
    // normalization applies to amounts/identities, never currency/unit labels.
    if (quantityTextFields.has(key.replace(/[^a-z0-9]/gi, "").toLowerCase())) return parsed;
    const token = context?.source;
    const parts = typeof token === "string"
      ? /^(-?)(\d+)(?:\.(\d+))?(?:[Ee]([+-]?\d+))?$/.exec(token) : null;
    if (!parts) throw new Error("Original JSON number token required");
    let digits = parts[2]! + (parts[3] ?? "");
    if (!/[1-9]/.test(digits)) return "0";
    const power = Number(parts[4] ?? "0");
    if (!Number.isSafeInteger(power)) throw new Error("Original numeric decimal bound");
    let decimalAt = parts[2]!.length + power;
    const leading = /^0+/.exec(digits)?.[0].length ?? 0;
    digits = digits.slice(leading).replace(/0+$/, ""); decimalAt -= leading;
    const length = parts[1]!.length + (decimalAt <= 0 ? 2 - decimalAt + digits.length
      : decimalAt < digits.length ? digits.length + 1 : decimalAt);
    if (length > 128) throw new Error("Original numeric decimal bound");
    let decimal: string;
    if (decimalAt <= 0) decimal = "0." + "0".repeat(-decimalAt) + digits;
    else if (decimalAt < digits.length) decimal = digits.slice(0, decimalAt) + "." + digits.slice(decimalAt);
    else decimal = digits + "0".repeat(decimalAt - digits.length);
    return parts[1] + decimal;
  });
}

function requireRows(value: unknown, limit: number, sourceClass: string): RecordRow[] {
  if (!Array.isArray(value) || value.length > limit
      || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("Missing, unsupported or oversized original records");
  }
  return (value as Record<string, unknown>[]).map((row) => {
    if (["entity", "quantity", "trigger"].includes(String(row.kind))) {
      if (typeof row.id !== "string" || !row.id) throw new Error("Original record identity missing");
      return row as RecordRow;
    }
    const attributes = Object.fromEntries(Object.entries(row).map(([key, val]) =>
      [key.replace(/[^a-z0-9]/gi, "").toLowerCase(), val]));
    const string = (...names: string[]): string | undefined => {
      const found = names.map((name) => attributes[name]).find((item) =>
        (typeof item === "string" && item.length > 0) || typeof item === "number");
      if (typeof found === "number") {
        if (!Number.isSafeInteger(found)) throw new Error("Non-exact original numeric token");
        return String(found);
      }
      return typeof found === "string" ? found : undefined;
    };
    const id = string("id", "recordid", "opportunityid", "transactionid", "documentid",
      "taskid", "facilityid", "employeeid", "receiptid", "uid")
      ?? /^<([^@<>]+)@/.exec(string("messageid") ?? "")?.[1];
    if (!id) throw new Error("Original native object identity missing");
    const kind = sourceClass === "crm_deals" && string("dealnumber", "opportunitynumber", "fundnumber", "vehiclenumber") ? "entity"
      : sourceClass === "personnel_benefits" && string("employeenumber") ? "entity"
      : sourceClass === "work_tracking" && /^\s*evidence[\s_-]+request[\s_-]+needed\s*[.!]?\s*$/i.test(string("activity", "subject") ?? "")
          ? "trigger" : ["financial_ledger", "expense_administration"].includes(sourceClass)
            && string("amount", "balance") ? "quantity" : sourceClass === "lender_portal"
              && string("outstanding") ? "quantity" : "unresolved";
    const result: RecordRow = {
      id,
      kind,
      registrationId: string("registrationid", "vehiclenumber", "fundnumber", "dealnumber", "opportunitynumber", "employeenumber"),
      name: string("fundname", "vehiclename"),
      vehicleType: string("vehicletype"),
      baseCurrency:string('basecurrency'),
      effectiveFrom: string("effectivefrom"),
      observationKind: string("transactionid") ? "transaction" : "assertion",
      balanceRole: string("balancerole"),
      accountingRelationId: string("accountingrelationid"),
      occurredAt: string("occurredat"),
      endsAt: string("endsat"),
      narrative: string("narrative", "body", "summary", "subject", "content", "description"),
    };
    if (kind === "entity") result.entityType = sourceClass === "crm_deals"
      ? string("vehiclenumber") ? "vehicle" : string("fundnumber") ? "fund" : "deal" : "person";
    if (sourceClass === "crm_deals" && (string("counterpartynumber") || (string("vehiclenumber") && string("fundnumber")))) {
      result.relation = string("vehiclenumber") && string("fundnumber") ? "fund_vehicle" : "counterparty";
      result.relationRegistrationId = result.relation === "fund_vehicle" ? string("fundnumber") : string("counterpartynumber");
    }
    if (kind === "trigger") {
      result.triggerKind = "evidence_request_needed";
      result.occurredAt = string("createdat", "occurredat");
      result.availableAt = string("availableat");
    }
    if (kind === "quantity") {
      if (Object.entries(attributes).some(([key, value]) => quantityTextFields.has(key)
          && value !== undefined && typeof value !== "string")) {
        throw new OriginalQuantityContextError(`Malformed original quantity context ${id}`);
      }
      result.value = string("amount", "balance", "outstanding");
      result.factKey = string("account", "description")?.toLowerCase().replace(/\s+/g, "_")
        ?? (sourceClass === "lender_portal" ? "outstanding" : undefined);
      result.currency = string("currency");
      result.unit = string("unit");
      result.period = string("period");
      result.basis = string("accountingbasis", "basis");
      result.occurredAt = string("postedat", "asof", "occurredat");
      result.availableAt = string("availableat");
    }
    return result;
  });
}

function delimited(raw: string, delimiter: string): Record<string, string>[] {
  const table: string[][] = []; let row: string[] = [], cell = "", quote = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '"') {
      if (quote && raw[i + 1] === '"') { cell += '"'; i++; }
      else if (!quote && cell === "") quote = true;
      else if (quote && (raw[i + 1] === delimiter || raw[i + 1] === "\n" || raw[i + 1] === "\r" || i + 1 === raw.length)) quote = false;
      else throw new Error("Invalid quoted cell");
    } else if (ch === delimiter && !quote) { row.push(cell); cell = ""; }
    else if ((ch === "\n" || ch === "\r") && !quote) {
      if (ch === "\r" && raw[i + 1] === "\n") i++;
      row.push(cell); table.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (quote) throw new Error("Unterminated quoted cell");
  if (cell || row.length) { row.push(cell); table.push(row); }
  const [header, ...values] = table;
  if (!header?.length || header.some((key) => !key || header.indexOf(key) !== header.lastIndexOf(key))) throw new Error("Invalid table header");
  return values.map((cells) => {
    if (cells.length !== header.length) throw new Error("Ragged row");
    return Object.fromEntries(header.map((key, i) => [key, cells[i]!]));
  });
}

function textRecords(raw: string): RecordRow[] {
  const paragraphs = raw.replace(/\r\n/g, "\n").trim().split(/\n\s*\n/);
  return paragraphs.map((paragraph) => {
    const fields = new Map<string, string>();
    const narrative: string[] = [];
    for (const line of paragraph.split("\n")) {
      const match = /^([A-Za-z][A-Za-z -]*):\s*(\S.*)$/.exec(line.trim());
      if (!match) {
        if (!fields.has("documentid") && !fields.has("recordid")) throw new Error("Unidentified document text");
        narrative.push(line);
        continue;
      }
      const name = match[1]!.toLowerCase().replace(/[\s-]/g, "");
      if (fields.has(name)) throw new Error("Repeated document field");
      fields.set(name, match[2]!);
    }
    if (narrative.length) fields.set("content", [fields.get("content"), ...narrative].filter(Boolean).join("\n"));
    return { id: fields.get("recordid") ?? fields.get("documentid") ?? "",
      kind: fields.get("kind") ?? (fields.has("entitytype") && fields.has("registrationid") ? "entity" : "unresolved"),
      registrationId: fields.get("registrationid") ?? fields.get("dealnumber"), entityType: fields.get("entitytype"),
      factKey: fields.get("factkey"), value: fields.get("value"), currency: fields.get("currency"),
      unit: fields.get("unit"), period: fields.get("period"), basis: fields.get("basis"),
      occurredAt: fields.get("occurredat"), availableAt: fields.get("availableat"),
      narrative: [fields.get("subject"), fields.get("content")].filter(Boolean).join("\n"),
      triggerKind: fields.get("triggerkind") };
  });
}

function mimeRecord(raw: string): RecordRow[] {
  const [head, ...body] = raw.replace(/\r\n/g, "\n").split("\n\n");
  if (!head || !body.length) throw new Error("Incomplete RFC822 message");
  const headers = new Map<string, string>();
  for (const line of head.split("\n")) {
    const match = /^([A-Za-z0-9-]+):\s*(.+)$/.exec(line);
    if (!match || headers.has(match[1]!.toLowerCase())) throw new Error("Invalid RFC822 header");
    headers.set(match[1]!.toLowerCase(), match[2]!.trim());
  }
  const messageId = /^<([^<>@]+)@[^<>@]+>$/.exec(headers.get("message-id") ?? "");
  if (!messageId || !headers.has("from") || !headers.has("to") || !headers.has("date")
      || !Number.isFinite(Date.parse(headers.get("date")!))) throw new Error("Unidentified RFC822 message");
  // A source header is an assertion, never an authority or approval grant.
  if (!body.join("\n\n").trim()) throw new Error("Empty message body");
  return [{ id: messageId[1]!, kind: headers.has("x-institution-trigger-kind") ? "trigger"
    : headers.has("x-institution-entity-type") ? "entity" : "unresolved",
    registrationId: headers.get("x-institution-registration-id"),
    entityType: headers.get("x-institution-entity-type"),
    triggerKind: headers.get("x-institution-trigger-kind"),
    occurredAt: new Date(headers.get("date")!).toISOString(),
    narrative: `${headers.get("subject") ?? ""}\n${body.join("\n\n")}`,
    availableAt: headers.get("x-institution-available-at") }];
}

function calendarRecords(raw: string): RecordRow[] {
  if (!raw.includes("BEGIN:VCALENDAR") || !raw.includes("END:VCALENDAR")) throw new Error("Invalid calendar");
  const blocks = [...raw.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)];
  if (!blocks.length) throw new Error("Calendar has no events");
  return blocks.map((block) => {
    const fields = new Map<string, string>();
    for (const line of block[1]!.split(/\r?\n/).filter(Boolean)) {
      const at = line.indexOf(":");
      if (at < 1) throw new Error("Invalid calendar property");
      const key = line.slice(0, at).toUpperCase();
      if (fields.has(key)) throw new Error("Repeated calendar property");
      fields.set(key, line.slice(at + 1));
    }
    const calendarInstant = (date: string): string => {
      if (!/^\d{8}T\d{6}Z$/.test(date)) throw new Error("Ambiguous calendar time");
      const instant = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}.000Z`;
      if (!Number.isFinite(Date.parse(instant)) || new Date(instant).toISOString() !== instant) throw new Error("Invalid calendar time");
      return instant;
    };
    if (!fields.get("UID") || !fields.get("DTEND")) throw new Error("Calendar identity/end absent");
    const timestamp = calendarInstant(fields.get("DTSTART") ?? "");
    const endsAt = calendarInstant(fields.get("DTEND")!);
    if (endsAt <= timestamp) throw new Error("Calendar end precedes start");
    return { id: fields.get("UID")!, kind: fields.has("X-INSTITUTION-TRIGGER-KIND") ? "trigger"
      : fields.has("X-INSTITUTION-ENTITY-TYPE") ? "entity" : "unresolved",
      registrationId: fields.get("X-INSTITUTION-REGISTRATION-ID"),
      entityType: fields.get("X-INSTITUTION-ENTITY-TYPE"),
      triggerKind: fields.get("X-INSTITUTION-TRIGGER-KIND"),
      occurredAt: timestamp, narrative: `${fields.get("SUMMARY") ?? ""}\n${fields.get("DESCRIPTION") ?? ""}`,
      endsAt: fields.has("X-INSTITUTION-ENTITY-TYPE") || fields.has("X-INSTITUTION-TRIGGER-KIND") ? undefined : endsAt,
      availableAt: fields.get("X-INSTITUTION-AVAILABLE-AT") };
  });
}

function htmlRecords(raw: string): Record<string, string>[] {
  if (/<(?:script|iframe|style)\b/i.test(raw)) throw new Error("Active or unparsed HTML");
  const tables = [...raw.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  if (tables.length > 1) throw new Error("Multiple material HTML tables require complete coverage");
  const table = tables[0]?.[1];
  if (!table) throw new Error("No source table");
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) =>
    [...match[1]!.matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)]
      .map((cell) => cell[1]!.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim()));
  const [header, ...values] = rows;
  if (!header?.length || header.some((item) => !item || header.indexOf(item) !== header.lastIndexOf(item))) throw new Error("Invalid HTML header");
  return values.map((cells) => {
    if (cells.length !== header.length) throw new Error("Ragged HTML row");
    return Object.fromEntries(header.map((item, index) => [item, cells[index]!]));
  });
}

function workbookRows(bytes: Buffer): Record<string, string>[] {
  const pkg = new OfficePackage(bytes);
  if (pkg.format !== "xlsx") throw new Error("XLSX package expected");
  const relationships = pkg.relationships(pkg.mainPart);
  const sheets = descendants(pkg.xml(pkg.mainPart), "sheet", NS.sheet);
  if (sheets.length > 1) throw new Error("Multiple material worksheets require complete coverage");
  const sheet = sheets[0];
  const part = relationships.find((rel) => rel.id === sheet?.attrs["r:id"])?.resolved;
  if (!part) throw new Error("Worksheet unavailable");
  const sharedPart = relationships.find((rel) => rel.type.endsWith("/sharedStrings"))?.resolved;
  const shared = sharedPart ? descendants(pkg.xml(sharedPart), "si", NS.sheet).map((item) =>
    descendants(item, "t", NS.sheet).map(textContent).join("")) : [];
  const rows = descendants(pkg.xml(part), "row", NS.sheet).map((row) => {
    const fields = new Map<string, string>();
    for (const cell of children(row, "c", NS.sheet)) {
      if (children(cell, "f", NS.sheet).length) throw new Error("Formula cache is not original truth");
      const column = /^([A-Z]+)\d+$/.exec(cell.attrs.r ?? "")?.[1];
      if (!column || fields.has(column)) throw new Error("Invalid workbook cell address");
      const value = cell.attrs.t === "inlineStr"
        ? descendants(cell, "t", NS.sheet).map(textContent).join("")
        : children(cell, "v", NS.sheet)[0]?.text ?? "";
      const index = Number(value);
      fields.set(column, cell.attrs.t === "s"
        ? (Number.isSafeInteger(index) && shared[index] !== undefined ? shared[index]! : (() => { throw new Error("Missing shared string"); })())
        : value);
    }
    return fields;
  });
  const [header, ...data] = rows;
  if (!header?.size) throw new Error("Empty worksheet");
  const columns = [...header.entries()];
  if (new Set(columns.map(([, value]) => value)).size !== columns.length) throw new Error("Repeated worksheet heading");
  return data.map((row) => Object.fromEntries(columns.map(([column, name]) => [name, row.get(column) ?? ""])));
}

export async function originalRawRecords(source: OriginalSource, limit: number, maxBytes: number): Promise<RecordRow[]> {
  const binary = ["pdf_text", "docx", "xlsx"].includes(source.protocol);
  if (binary !== (typeof source.rawBase64 === "string")) throw new Error("Protocol bytes are absent or mislabelled");
  const bytes = binary ? Buffer.from(source.rawBase64!, "base64") : Buffer.from(source.rawUtf8, "utf8");
  if (bytes.length > maxBytes || !bytes.length || (binary && (bytes.toString("base64") !== source.rawBase64 || source.rawUtf8 !== ""))) {
    throw new Error("Invalid or oversized original object bytes");
  }
  let value: unknown;
  switch (source.protocol) {
    case "json_records": value = originalJson(source.rawUtf8); break;
    case "paginated_json": {
      const doc = originalJson(source.rawUtf8) as { pages?: { cursor: string; nextCursor: string | null; records: unknown[] }[] };
      if (!Array.isArray(doc.pages) || !doc.pages.length || doc.pages.length > limit) throw new Error("Invalid page count");
      const seen = new Set<string>(); let next = "start";
      value = doc.pages.flatMap((page) => {
        if (page.cursor !== next || seen.has(page.cursor) || !Array.isArray(page.records)) throw new Error("Page cursor gap");
        seen.add(page.cursor); next = page.nextCursor ?? "";
        return page.records;
      });
      if (next) throw new Error("Incomplete page chain");
      break;
    }
    case "csv": case "tsv": value = delimited(source.rawUtf8, source.protocol === "csv" ? "," : "\t"); break;
    case "rfc822": case "installed_source_adapter": value = mimeRecord(source.rawUtf8); break;
    case "icalendar": value = calendarRecords(source.rawUtf8); break;
    case "html": value = htmlRecords(source.rawUtf8); break;
    case "financial_xml": {
      const root = parseXml(source.rawUtf8);
      if (!["records", "decisions", "transactions"].includes(root.local)
          || root.children.some((item) => !["entity", "quantity", "trigger", "decision", "transaction"].includes(item.local)
          || item.children.length)) throw new Error("Unsupported financial XML structure");
      value = root.children.map((item) => ({ ...item.attrs,
        kind: ["entity", "quantity", "trigger"].includes(item.local) ? item.local : "unresolved" }));
      break;
    }
    case "text": value = textRecords(source.rawUtf8); break;
    case "docx": {
      const pkg = new OfficePackage(bytes);
      if (pkg.format !== "docx") throw new Error("DOCX package expected");
      value = textRecords(descendants(pkg.xml(pkg.mainPart), "p", NS.word)
        .map((paragraph) => descendants(paragraph, "t", NS.word).map(textContent).join("")).join("\n"));
      break;
    }
    case "xlsx": value = workbookRows(bytes); break;
    case "pdf_text": {
      if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("PDF magic absent");
      const parser = new PDFParse({ data: bytes });
      try {
        const info = await withArtifactDeadline(parser.getInfo(), 25_000);
        if (info.total > 500) throw new Error("PDF page bound");
        const parsed = await withArtifactDeadline(parser.getText(), 25_000);
        if (parsed.pages.some((page) => !page.text.trim())) throw new Error("OCR or empty page unsupported");
        value = textRecords(parsed.pages.map((page) => page.text).join("\n\n"));
      } finally { await parser.destroy(); }
      break;
    }
    default: throw new Error("Unsupported original protocol");
  }
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new Error("Decoded original exceeds object bound");
  return requireRows(value, limit, source.sourceClass);
}
