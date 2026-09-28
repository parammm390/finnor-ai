import { createRequire } from "node:module"
import { createServer } from "node:http"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { resolve, dirname, join } from "node:path"
import { createHash } from "node:crypto"

const root = resolve(import.meta.dirname, "../..")
const output = join(root, ".centropy-certification/renderer-performance")
const require = createRequire(join(root, "finnor-os/package.json"))
const { build } = require("esbuild")
await mkdir(output, { recursive: true })
const shim = join(output, "next-navigation.mjs")
await writeFile(shim, "export const usePathname=()=>location.pathname; export const useSearchParams=()=>new URLSearchParams(location.search); export const useRouter=()=>({replace:()=>{}});\n")
await build({ entryPoints: [join(root, "scripts/centropy/renderer-performance.fixture.tsx")], outdir: join(output, "assets"), bundle: true, minify: true, splitting: true, format: "esm", platform: "browser", jsx: "automatic", alias: { "@": join(root, "src"), "next/navigation": shim }, define: { "process.env": JSON.stringify({ NODE_ENV: "production" }) }, nodePaths: [join(root, "node_modules")], logLevel: "warning", metafile: true })
const css = (await readdir(join(root, ".next/static/chunks"))).filter((name) => name.endsWith(".css"))
await writeFile(join(output, "index.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authored renderer benchmark</title>${css.map((name) => `<link rel="stylesheet" href="/_next/static/chunks/${name}">`).join("")}<style>html,body{margin:0;max-width:100%;background:#080808;color:#e8e8e8}button{padding:10px;margin:4px;border:1px solid #555;border-radius:8px}.ct-app{position:relative;display:block;height:auto;min-height:100vh;overflow:visible}.ct-app>header{position:relative;z-index:10;display:block}.ct-canvas-document{position:relative;margin-top:20px}.ct-canvas{height:75vh;width:100%;overflow:auto}.ct-world__detail{max-width:100%}</style><div id="root"></div><script type="module" src="/assets/renderer-performance.fixture.js"></script></html>`)
const sources = ["scripts/centropy/renderer-performance.fixture.tsx", "src/components/centropy/canvas/CanvasDocument.tsx", "src/components/centropy/canvas/canvas-contract.ts", "src/components/centropy/world/WorldRelationships.tsx", "src/components/centropy/shell/CentropyPresence.tsx", "src/components/centropy/product/vendor/LiquidGlassOrb.tsx"]
const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async (path) => [path, createHash("sha256").update(await readFile(join(root, path))).digest("hex")])))
await writeFile(join(output, "inputs.json"), JSON.stringify({ schema: "centropy.renderer-benchmark/v1", authored: true, noBusinessAssertions: true, serverMode: "isolated_production_components_esbuild", inputs: { canvasBlocks: 20, rowsPerBlock: 5, underwritingOutputs: 1000, relationshipNodes: 10000, relationshipEdges: 20000, orbState: "WORKING", orbSize: 98 }, sourceHashes, productionCss: css, limits: ["Navigation adapter only; no business API, financial calculation or active business agent", "This bundle is an isolated benchmark; production Next.js timings are recorded separately"] }, null, 2) + "\n")
const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://127.0.0.1:3339").pathname
  if (path.startsWith("/api/")) { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "Authored UI stress harness has no business API; controls remain unavailable." })); return }
  const base = path.startsWith("/_next/static/") ? join(root, ".next/static") : output
  const relative = path.startsWith("/_next/static/") ? path.slice("/_next/static/".length) : path === "/" ? "index.html" : path.slice(1)
  const file = resolve(base, relative)
  if (!file.startsWith(base + "/")) { response.writeHead(403); response.end(); return }
  try { const body = await readFile(file); response.writeHead(200, { "content-type": file.endsWith(".js") || file.endsWith(".mjs") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : file.endsWith(".json") ? "application/json" : file.endsWith(".woff2") ? "font/woff2" : "application/octet-stream" }); response.end(body) } catch { response.writeHead(404); response.end() }
})
server.listen(3339, "127.0.0.1", () => console.log(JSON.stringify({ url: "http://127.0.0.1:3339", inputs: join(output, "inputs.json") })))
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)))
