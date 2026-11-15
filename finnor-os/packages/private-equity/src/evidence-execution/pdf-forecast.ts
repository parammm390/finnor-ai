import type { SemanticIR } from "@finnor/ooxml";
import { exactBinary } from "./exact";

const forecastYears = /^(?:20\d{2}E)(?:\s+20\d{2}E){1,11}$/;
const tableRow = /^Adjusted EBITDA\s*\((?<footnote>\d{1,2})\)(?:[ \t]*\.)+[ \t]*(?<amounts>\$[^\n]+)$/gm;
const amountInMillions = /^(?:-?(?:\d{1,3}(?:,\d{3}){1,3}|\d{1,12})(?:\.\d{1,4})?|\((?:\d{1,3}(?:,\d{3}){1,3}|\d{1,12})(?:\.\d{1,4})?\))$/;

function pageLines(ir: SemanticIR, page: number) {
  const node = ir.nodes.find(item => item.kind === "page" && item.data.page === page);
  return node?.data.status === "TEXT_AVAILABLE" && typeof node.data.text === "string"
    ? node.data.text.split(/\r?\n/).map(line => line.trim())
    : [];
}

export function readPdfForecast(ir: SemanticIR, page: number, year: number) {
  const lines = pageLines(ir, page);
  const header = lines.findIndex(line => forecastYears.test(line));
  if (header < 0 || lines.slice(header + 1).some(line => forecastYears.test(line))) return null;
  const years = lines[header]!.split(/\s+/);
  const column = years.indexOf(year + "E");
  if (column < 0 || years.some((text, index) => Number(text.slice(0, 4)) !== Number(years[0]!.slice(0, 4)) + index)) return null;

  const sourceContext = [...pageLines(ir, page - 1), ...lines.slice(0, header)];
  const headings = sourceContext.flatMap((line, index) => /^[A-Za-z][A-Za-z0-9 -]{0,70} Forecasts$/.test(line)
    && sourceContext[index + 1]?.startsWith("Set forth below are prospective ") ? [index] : []);
  const heading = headings.at(-1) ?? -1;
  if (heading < 0 || sourceContext.slice(heading + 1).some(line => forecastYears.test(line))) return null;
  const introduction = sourceContext.slice(heading + 1, heading + 7).join(" ");
  if (!introduction.includes(`(in millions) for the Company for fiscal years ${years[0]!.slice(0, 4)} through ${years.at(-1)!.slice(0, 4)}`)) return null;

  const rows = [...lines.slice(header + 1, header + 9).join("\n").matchAll(tableRow)];
  const [row] = rows;
  if (rows.length !== 1 || !row?.groups?.amounts) return null;
  const amounts = row.groups.amounts.split("$").slice(1).map(value => value.trim());
  if (amounts.length !== years.length || amounts.some(value => !amountInMillions.test(value))) return null;
  const literal = amounts[column]!.replaceAll(",", "").replace(/^\((.*)\)$/, "-$1");
  const footnoteNumber = row.groups.footnote;
  const footnote = lines.findIndex((line, index) => index > header && line.startsWith(`(${footnoteNumber}) Adjusted EBITDA,`));
  if (footnote < 0) return null;
  const continuation = lines.slice(footnote + 1);
  const footnoteEnd = continuation.findIndex(line => /^\(\d{1,2}\) |^\d{1,3}$|^-- \d+ of \d+ --$/.test(line));
  const note = [lines[footnote], ...continuation.slice(0, footnoteEnd < 0 ? undefined : footnoteEnd)]
    .join(" ").replace(/\s+/g, " ").trim();
  const definition = /^\(\d{1,2}\) (Adjusted EBITDA, a non-GAAP financial measure, is defined as [^.!?]{1,600}\.(?: Adjusted EBITDA as set forth in the above table is [^.!?]{1,300}\.)?)/.exec(note);
  if (!definition?.[1]) return null;
  const remainder = note.slice(definition[0].length).trim();
  if (remainder && !remainder.startsWith("Company management also prepared a version of the ")) return null;

  return {
    vintage: sourceContext[heading]!,
    definition: definition[1],
    value: exactBinary("multiply", literal, "1000000"),
    anchor: { page, quote: row[0] },
  };
}
