#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import { addedLines, rangeFromArgs, unexpiredException } from "./added-lines.mjs"

const FIX = "A test that asserts the order of internal calls fails on every refactor and catches no bug. Assert what the caller can observe instead, as finnor-os/tests/integration/intake-durability.test.ts does against PostgreSQL."

export function pinnedCallOrder(lines, today) {
  return lines.flatMap(({ file, line, text }) => {
    if (!/\.test\.[cm]?[jt]sx?$/.test(file) || !/\binvocationCallOrder\b/.test(text)) return []
    const exception = unexpiredException(text, "allow-call-order", today)
    if (exception?.live) return []
    return [`${file}:${line}: test pins the order of internal calls. ${exception ? `Exception expired on ${exception.expires}.` : FIX}`]
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { base, head } = rangeFromArgs(process.argv)
  const failures = pinnedCallOrder(addedLines(base, head))
  for (const failure of failures) console.error(failure)
  if (failures.length) process.exit(1)
  console.log(`No call-order assertions added between ${base.slice(0, 12)} and ${head}.`)
}
