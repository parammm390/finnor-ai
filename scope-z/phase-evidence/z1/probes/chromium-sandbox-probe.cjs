// Controls: the same launch options the Z1 guarded driver uses (headless, chromiumSandbox:true), against a data: page.
const { chromium } = require("@playwright/test")
;(async () => {
  const started = Date.now()
  const out = { executable: chromium.executablePath(), chromiumSandbox: true }
  try {
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" } })
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto("data:text/html,<title>probe</title><h1>ok</h1>")
    out.title = await page.title()
    out.version = browser.version()
    await browser.close()
    out.result = "LAUNCHED_WITH_SANDBOX"
  } catch (error) {
    out.result = "LAUNCH_FAILED"
    out.error = String(error).split("\n").slice(0, 12).join("\n")
  }
  out.elapsedMs = Date.now() - started
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.result === "LAUNCHED_WITH_SANDBOX" ? 0 : 1)
})()
