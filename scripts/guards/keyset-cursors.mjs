#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import { addedLines, rangeFromArgs, unexpiredException } from "./added-lines.mjs"

const FIX = "A JavaScript Date keeps milliseconds and PostgreSQL keeps microseconds, so this page boundary skips rows. Select exactInstant(column) and page with olderThan()/newerThan() and encodeKeysetCursor() from finnor-os/packages/db/keyset.ts."
const SOURCES = ["finnor-os/apps", "finnor-os/packages"]
const OWNER = "finnor-os/packages/db/keyset.ts"
const CURSOR_TO_DATE = /new Date\([^)]*cursor/i
const COLUMN_AGAINST_CURSOR = /\b(?:lt|lte|gt|gte|eq)\(\s*[\w.$]*(?:At|[tT]ime|[tT]imestamp)\s*,[^)]*cursor/i
const ROW_TIME_TO_TEXT = /\w+(?:\.\w+)*(?:At|[tT]ime|[tT]imestamp)\.toISOString\(\)/
const CURSOR_ENCODER = /cursor\s*[:=(]|encode\w*Cursor|Cursor\(/i
const MILLISECOND_TRUNCATION = /date_trunc\(\s*'milliseconds'/

export function dateKeysetCursors(lines, today) {
  const sourceLines = lines.filter(({ file }) => file !== OWNER && /\.(?:[cm]?ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file))
  return [...Map.groupBy(sourceLines, ({ file }) => file).values()].flatMap(fileLines => {
    const near = (line, distance, pattern) => fileLines.some(other => other.line <= line && line - other.line <= distance && pattern.test(other.text))
    return fileLines.flatMap(({ file, line, text }) => {
      const dated = CURSOR_TO_DATE.test(text) || COLUMN_AGAINST_CURSOR.test(text)
        || (ROW_TIME_TO_TEXT.test(text) && near(line, 3, CURSOR_ENCODER))
        || (MILLISECOND_TRUNCATION.test(text) && near(line, 5, /cursor/i))
      if (!dated) return []
      const exception = unexpiredException(text, "allow-date-cursor", today)
      if (exception?.live) return []
      return [`${file}:${line}: page cursor built from a JavaScript Date. ${exception ? `Exception expired on ${exception.expires}.` : FIX}`]
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { base, head } = rangeFromArgs(process.argv)
  const failures = dateKeysetCursors(addedLines(base, head, SOURCES))
  for (const failure of failures) console.error(failure)
  if (failures.length) process.exit(1)
  console.log(`No Date-based page cursors added between ${base.slice(0, 12)} and ${head}.`)
}
