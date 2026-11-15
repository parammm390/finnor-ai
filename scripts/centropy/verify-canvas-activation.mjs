import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { createServer } from "node:http"
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"

const root = resolve(import.meta.dirname, "../.."), require = createRequire(join(root, "finnor-os/package.json"))
const output = process.argv[2]
const baseline = process.argv.find(argument => argument.startsWith("--baseline="))?.slice(11)
assert(!baseline || /^[a-f0-9]{40}$/.test(baseline), "Baseline must be an exact commit")
const overrides = new Map()
if (baseline) for (const path of ["src/components/centropy/canvas/CanvasDocument.tsx", "src/components/centropy/canvas/CanvasSectionNav.tsx"]) overrides.set(join(root, path), execFileSync("git", ["show", baseline + ":" + path], { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }))
assert(output?.startsWith("/"), "An absolute external evidence directory is required")
await mkdir(output, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), "finnor-canvas-activation-"))
const shim = join(directory, "navigation.mjs")
await writeFile(shim, "export const usePathname=()=>location.pathname;export const useSearchParams=()=>new URLSearchParams(location.search);export const useRouter=()=>({replace:()=>{}});")
await require("esbuild").build({ entryPoints: [join(root, "scripts/centropy/canvas-activation.fixture.tsx")], outdir: join(directory, "assets"), bundle: true, splitting: true, format: "esm", platform: "browser", jsx: "automatic", alias: { "@": join(root, "src"), "next/navigation": shim }, define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) }, nodePaths: [join(root, "node_modules")], logLevel: "error", plugins: [{ name: "exact-baseline-sources", setup(build) { build.onLoad({ filter: /Canvas(?:Document|SectionNav)\.tsx$/ }, args => overrides.has(args.path) ? { contents: overrides.get(args.path), loader: "tsx" } : undefined) } }] })
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname
  if (path.startsWith("/api/")) { response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":"Authored renderer fixture has no business API"}'); return }
  if (path === "/") { response.writeHead(200, { "content-type": "text/html" }); response.end('<!doctype html><html><title>Canvas activation regression</title><style>body{margin:0}.ct-canvas{height:500px;overflow:auto}.ct-canvas-nav{position:sticky;top:0;background:white}.ct-canvas-nav button{padding:12px}section{min-height:500px}</style><div id="root"></div><script type="module" src="/assets/canvas-activation.fixture.js"></script></html>'); return }
  const file = resolve(directory, path.slice(1))
  if (!file.startsWith(directory + "/")) { response.writeHead(403); response.end(); return }
  try { response.writeHead(200, { "content-type": "text/javascript" }); response.end(await readFile(file)) } catch { response.writeHead(404); response.end() }
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const { chromium } = require("playwright"), browser = await chromium.launch({ ...(process.env.FINNOR_TEST_CHROMIUM ? { executablePath: process.env.FINNOR_TEST_CHROMIUM } : {}), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
let stage = "LOAD_CANVAS"
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), rows = []
await page.addInitScript(() => { window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return [] } } })
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole("heading", { name: "Investigation 1", exact: true }).waitFor()
  assert.equal(await page.getByText("Retained first result", { exact: true }).count(), 0)
  const nav = page.getByRole("navigation", { name: "Canvas instruments" })
  stage = "EXPLICIT_SELECTION_WITHOUT_VISIBILITY"
  await nav.getByRole("button", { name: /Open first instrument$/ }).click()
  await page.getByText("Retained first result", { exact: true }).waitFor({ timeout: 3000 })
  rows.push({ id: "explicit-selection-without-visibility-delivery", status: "PASS" })
  await nav.getByRole("button", { name: /Open second instrument$/ }).click()
  await page.getByText("Retained second result", { exact: true }).waitFor()
  assert.equal(await page.getByText("Retained first result", { exact: true }).count(), 1)
  rows.push({ id: "opened-instruments-retain-their-instance", status: "PASS" })
  await page.getByRole("button", { name: "Change Investigation" }).click()
  await page.getByRole("heading", { name: "Investigation 2", exact: true }).waitFor()
  assert.equal(await page.getByText("Retained first result", { exact: true }).count(), 0)
  assert.equal(await page.getByText("Retained second result", { exact: true }).count(), 0)
  await nav.getByRole("button", { name: /Open second instrument$/ }).click()
  await page.getByText("Retained second result", { exact: true }).waitFor()
  rows.push({ id: "selection-does-not-cross-investigation-scope", status: "PASS" })
} catch (error) { rows.push({ id: "canvas-activation", status: "FAIL", stage, error: error.message }); process.exitCode = 1 }
finally {
  const paths = ["src/components/centropy/canvas/CanvasDocument.tsx", "src/components/centropy/canvas/CanvasSectionNav.tsx", "src/components/centropy/canvas/CanvasInstrument.tsx", "scripts/centropy/canvas-activation.fixture.tsx", "scripts/centropy/verify-canvas-activation.mjs"]
  const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash("sha256").update(overrides.get(join(root, path)) ?? await readFile(join(root, path))).digest("hex")])))
  await writeFile(join(output, "result.json"), JSON.stringify({ schema: "finnor.canvas-activation-e2e.v1", rows, sourceHashes, baseline: baseline ?? null, browser: await browser.version(), qualification: "Actual Chromium and production Canvas components; authored UNKNOWN data, navigation adapter, deliberate visibility-notification fault and unavailable business API. No business or native-phase acceptance.", rerun: "node scripts/centropy/verify-canvas-activation.mjs <absolute external evidence directory>" }, null, 2))
  await browser.close(); await new Promise(resolve => server.close(resolve))
}
assert(rows.length === 3 && rows.every(row => row.status === "PASS"), "Canvas activation E2E failed; inspect result.json")
