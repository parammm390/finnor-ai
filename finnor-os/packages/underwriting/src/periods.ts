import { UNDERWRITING_LIMITS, type FinancialPeriod, type PeriodDefinition } from "./types";
import { fail } from "./errors";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export function parseDateOnly(value: string): CivilDate {
  const match = DATE_ONLY.exec(value);
  if (!match) fail("INVALID_PERIOD", "Financial dates must use YYYY-MM-DD", { value });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    fail("INVALID_PERIOD", "Invalid financial date", { value });
  }
  return { year, month, day };
}

export function formatDateOnly(date: CivilDate): string {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addMonths(date: CivilDate, months: number): CivilDate {
  if (!Number.isSafeInteger(months)) fail("INVALID_PERIOD", "Month offset must be an integer");
  const zeroBased = date.year * 12 + date.month - 1 + months;
  const year = Math.floor(zeroBased / 12);
  const month = ((zeroBased % 12) + 12) % 12 + 1;
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) };
}

export function addDays(date: CivilDate, days: number): CivilDate {
  if (!Number.isSafeInteger(days)) fail("INVALID_PERIOD", "Day offset must be an integer");
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export function daysBetween(start: string, end: string): number {
  const left = parseDateOnly(start);
  const right = parseDateOnly(end);
  const result = (Date.UTC(right.year, right.month - 1, right.day) - Date.UTC(left.year, left.month - 1, left.day)) / 86_400_000;
  if (!Number.isSafeInteger(result)) fail("INVALID_PERIOD", "Financial day interval is invalid", { start, end });
  return result;
}

function fiscalLabel(end: CivilDate, fiscalYearStartMonth: number, frequency: PeriodDefinition["frequency"]): string {
  const fiscalYear = end.month >= fiscalYearStartMonth ? end.year + (fiscalYearStartMonth === 1 ? 0 : 1) : end.year;
  if (frequency === "annual") return `FY${fiscalYear}`;
  if (frequency === "monthly") return `FY${fiscalYear}-M${String(((end.month - fiscalYearStartMonth + 12) % 12) + 1).padStart(2, "0")}`;
  const fiscalMonth = ((end.month - fiscalYearStartMonth + 12) % 12) + 1;
  return `FY${fiscalYear}-Q${Math.ceil(fiscalMonth / 3)}`;
}

export function buildPeriods(definition: PeriodDefinition): readonly FinancialPeriod[] {
  if (!Number.isSafeInteger(definition.count) || definition.count < 1) fail("INVALID_PERIOD", "Forecast period count must be positive");
  if (definition.count > UNDERWRITING_LIMITS.forecastPeriods) fail("PERIOD_LIMIT", "Forecast exceeds the period limit", { count: definition.count });
  const fiscalYearStartMonth = definition.fiscalYearStartMonth ?? 1;
  if (!Number.isSafeInteger(fiscalYearStartMonth) || fiscalYearStartMonth < 1 || fiscalYearStartMonth > 12) {
    fail("INVALID_PERIOD", "Fiscal year start month must be 1 through 12");
  }
  const firstStart = parseDateOnly(definition.forecastStart);
  const months = definition.frequency === "annual" ? 12 : definition.frequency === "quarterly" ? 3 : 1;
  const output: FinancialPeriod[] = [];
  for (let ordinal = 0; ordinal < definition.count; ordinal += 1) {
    const start = addMonths(firstStart, ordinal * months);
    const nextStart = addMonths(firstStart, (ordinal + 1) * months);
    const end = addDays(nextStart, -1);
    const id = `P${String(ordinal + 1).padStart(3, "0")}:${formatDateOnly(start)}:${formatDateOnly(end)}`;
    output.push(Object.freeze({
      id,
      ordinal,
      startDate: formatDateOnly(start),
      endDate: formatDateOnly(end),
      fiscalLabel: fiscalLabel(end, fiscalYearStartMonth, definition.frequency),
    }));
  }
  return Object.freeze(output);
}
