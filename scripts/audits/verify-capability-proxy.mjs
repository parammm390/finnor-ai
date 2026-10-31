import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import vm from "node:vm"

const root = realpathSync(process.cwd())
const index = process.argv.indexOf("--out")
if (index < 0 || !process.argv[index + 1]) throw new Error("--out requires an existing external directory")
const parent = realpathSync(resolve(process.argv[index + 1])), difference = relative(root, parent)
if (!(difference === ".." || difference.startsWith("../") || isAbsolute(difference))) throw new Error("Evidence must be outside the repository")
const output = mkdtempSync(join(parent, "proxy-"))
const require = createRequire(join(root, "package.json")), ts = require("typescript"), { NextRequest } = require("next/server")
const nativeFetch = globalThis.fetch, observations = [], upstreamRequests = [], sources = [], loaded = new Map(), transportGuardErrors = []
const hash = value => createHash("sha256").update(value).digest("hex")
const sourceFiles = new Set()
function load(path) {
  if (loaded.has(path)) return loaded.get(path).exports
  const bytes = readFileSync(join(root, path))
  sourceFiles.add(path)
  sources.push({ path, sha256: hash(bytes) })
  if (path.endsWith(".json")) return JSON.parse(bytes.toString())
  const compiled = ts.transpileModule(bytes.toString(), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  const imported = name => {
    if (name.startsWith("@/") || name.startsWith(".")) {
      const base = name.startsWith("@/") ? "src/" + name.slice(2) : join(dirname(path), name)
      const target = [base, base + ".ts", base + ".json"].find(candidate => existsSync(join(root, candidate)))
      assert(target, "Local import must resolve: " + name)
      return load(target)
    }
    return require(name)
  }
  const moduleValue = { exports: {} }
  loaded.set(path, moduleValue)
  vm.runInThisContext("(function(exports, require, module) {" + compiled + "\n})", { filename: join(root, path) })(moduleValue.exports, imported, moduleValue)
  return moduleValue.exports
}
const proxy = load("src/app/api/centropy/[...path]/route.ts")
const catalogue = load("src/lib/centropy/capability-manifest.ts")
const upstream = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  upstreamRequests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, cookiePresent: Boolean(request.headers.cookie), bodyBytes: body.length, bodySha256: hash(body) })
  if (request.url.startsWith("/api/connections/google/start")) {
    response.writeHead(200, { "content-type": "application/json", "set-cookie": "finnor_google_oauth=DISPOSABLE_STATE; HttpOnly; SameSite=Lax; Path=/api/connections/google/callback; Max-Age=600" })
    response.end(JSON.stringify({ authorizationUrl: "https://accounts.google.com/fixture-not-opened", expiresAt: "2099-01-01T00:00:00Z" }))
  } else if (request.url.startsWith("/api/connections/google/callback")) {
    response.writeHead(303, { location: "/settings/connections?google=failed&code=missing_cookie", "set-cookie": "finnor_google_oauth=; Max-Age=0", "content-type": "text/plain" }).end()
  } else {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ qualification: "LOOPBACK_TRANSPORT_FIXTURE", path: request.url }))
  }
})
await new Promise(done => upstream.listen(0, "127.0.0.1", done))
const upstreamBase = "http://127.0.0.1:" + upstream.address().port
const originalEnv = { NEXT_PUBLIC_OS_API_URL: process.env.NEXT_PUBLIC_OS_API_URL, JARVIS_TEST_MODE: process.env.JARVIS_TEST_MODE }
process.env.NEXT_PUBLIC_OS_API_URL = upstreamBase
process.env.JARVIS_TEST_MODE = "0"
globalThis.fetch = (input, init) => {
  const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
  if (target.origin !== upstreamBase) {
    transportGuardErrors.push("Proxy attempted an origin outside its owned fixture")
    throw new Error("Proxy proof may contact only its owned loopback fixture")
  }
  return nativeFetch(input, init)
}
const app = createServer(async (incoming, outgoing) => {
  try {
    const chunks = []
    for await (const chunk of incoming) chunks.push(chunk)
    const request = new NextRequest("http://127.0.0.1" + incoming.url, { method: incoming.method, headers: incoming.headers, ...(!["GET", "HEAD"].includes(incoming.method) ? { body: Buffer.concat(chunks) } : {}) })
    const segments = new URL(request.url).pathname.slice("/api/centropy/".length).split("/")
    const response = await proxy[incoming.method](request, { params: Promise.resolve({ path: segments }) })
    outgoing.writeHead(response.status, Object.fromEntries(response.headers))
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  } catch (error) { outgoing.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ driverError: String(error) })) }
})
await new Promise(done => app.listen(0, "127.0.0.1", done))
const base = "http://127.0.0.1:" + app.address().port
async function check(id, method, path, predicate, expected, body = "{}", headers = {}) {
  const before = upstreamRequests.length
  const guardCount = transportGuardErrors.length
  const response = await nativeFetch(base + "/api/centropy/" + path, { method, redirect: "manual", headers: { authorization: "Bearer DISPOSABLE_AUDIT_CALLER", "content-type": "application/json", cookie: "finnor_google_oauth=DISPOSABLE_STATE", ...headers }, ...(method === "POST" ? { body } : {}) })
  const observed = { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text(), upstreamRequests: upstreamRequests.slice(before) }
  let bridgeError = false
  try { bridgeError = Boolean(JSON.parse(observed.body).driverError) } catch {}
  observations.push({ id, expected, verdict: bridgeError || transportGuardErrors.length > guardCount ? "INCONCLUSIVE" : predicate(observed) ? "VERIFIED" : "NOT_WORKING", observed })
}
try {
  await check("existing-company-brain-root-operation", "POST", "company-brain/roots", row => row.status === 200 && row.upstreamRequests.length === 1 && row.upstreamRequests[0].authorization === "Bearer DISPOSABLE_AUDIT_CALLER", "Existing operation forwards exactly once with caller identity")
  const families = ['experiments', 'interventions', 'allocations', 'obligations', 'economic-outcomes', 'elicitation-protocols']
  for (const family of families) {
    const operationSource = family === 'elicitation-protocols'
      ? 'finnor-os/packages/private-equity/src/r3/api.ts'
      : `finnor-os/apps/api/app/api/${family}/[operation]/route.ts`
    const code = readFileSync(join(root, operationSource), 'utf8')
    sourceFiles.add(operationSource)
    sources.push({ path: operationSource, sha256: hash(code) })
    const parsed = ts.createSourceFile(operationSource, code, ts.ScriptTarget.Latest, true)
    const operations = new Set()
    function visit(node) {
      if (ts.isSwitchStatement(node) && /^(?:route\.)?operation$/.test(node.expression.getText(parsed))) {
        for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) operations.add(clause.expression.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    assert(operations.size > 0, `No actual operation cases found for ${family}`)
    for (const operation of operations) await check(`named-operation-${family}/${operation}`, 'POST', `${family}/${operation}`, row => row.status === 200 && row.upstreamRequests.length === 1, 'Actual declared named operation reaches upstream exactly once')
    await check(`named-operation-requires-caller-${family}`, 'POST', `${family}/${[...operations][0]}`, row => row.status === 401 && row.upstreamRequests.length === 0, 'Known operations require the caller bearer; no service-identity substitution', '{}', { authorization: '' })
    for (const operation of ['audit-unknown-operation', '11111111-1111-4111-8111-111111111111']) {
      await check(`unknown-operation-denied-${family}/${operation}`, 'POST', `${family}/${operation}`, row => row.status === 404 && row.upstreamRequests.length === 0, 'Undeclared operation is denied before upstream dispatch')
    }
  }
  for (const path of ["company-brain/belief-view", "company-brain/belief-pin", "experiments/design", "interventions/query", "allocations/resources", "obligations/read", "economic-outcomes/read", "elicitation-protocols/read"]) {
    await check("backend-operation-exposed-" + path, "POST", path, row => row.status === 200 && row.upstreamRequests.length === 1, "Implemented user-product operation reaches upstream transport; does not qualify its business result")
  }
  await check("google-start-preserves-state-cookie", "POST", "connections/google/start", row => row.status === 200 && Boolean(row.headers["set-cookie"]), "OAuth start response returns the backend state cookie")
  await check("google-callback-preserves-cookie-and-redirect", "GET", "connections/google/callback?state=fixture&code=fixture", row => row.status === 303 && Boolean(row.headers.location) && row.upstreamRequests[0]?.cookiePresent === true, "Callback forwards browser state and returns redirect headers")
  const largeMultibyteBody = JSON.stringify({ text: "☃".repeat(700000) })
  assert(Buffer.byteLength(largeMultibyteBody) > 2_000_000 && largeMultibyteBody.length < 2_000_000)
  await check("proxy-body-limit-counts-bytes", "POST", "queries", row => row.status === 413 && row.upstreamRequests.length === 0, "A 2 MB request byte limit rejects larger UTF-8 JSON before dispatch", largeMultibyteBody)
  const appRoot = join(root, "finnor-os/apps/api/app")
  function routeFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? routeFiles(join(directory, entry.name)) : /^route\.[jt]sx?$/.test(entry.name) ? [join(directory, entry.name)] : [])
  }
  const routeSources = routeFiles(appRoot).sort()
  const routePaths = routeSources.map(path => "/" + relative(appRoot, path).replace(/\/route\.[jt]sx?$/, ""))
  for (const path of routeSources) {
    const source = relative(root, path)
    sourceFiles.add(source)
    sources.push({ path: source, sha256: hash(readFileSync(path)) })
  }
  const backendRequire = createRequire(join(root, "finnor-os/package.json"))
  let routeError = null
  try { backendRequire("next/dist/shared/lib/router/utils/sorted-routes").getSortedRoutes(routePaths) } catch (error) { routeError = String(error) }
  observations.push({ id: "policy-route-tree", expected: "Installed Next accepts all current backend route paths", verdict: routeError ? routeError.includes("You cannot use different slug names") ? "NOT_WORKING" : "INCONCLUSIVE" : "VERIFIED", observed: { nextVersion: backendRequire("next/package.json").version, paths: routePaths, error: routeError } })
  const genericOperations = catalogue.PRODUCT_CAPABILITIES.filter(entry => entry.userProduct && entry.routePattern?.includes(':operation'))
  observations.push({ id: 'operation-catalogue-is-explicit', expected: 'Named operations are enumerated from their actual owner implementation', verdict: genericOperations.length === 0 ? 'VERIFIED' : 'NOT_WORKING', observed: { genericOperationPatterns: genericOperations.map(entry => entry.routePattern) } })
  const result = spawnSync(process.execPath, ["scripts/centropy/generate-capability-manifest.mjs", "--check"], { cwd: root, encoding: "utf8", timeout: 20000 })
  writeFileSync(join(output, "manifest-check.stdout.log"), result.stdout ?? "", { flag: "wx" })
  writeFileSync(join(output, "manifest-check.stderr.log"), result.stderr ?? "", { flag: "wx" })
  const staleCatalogue = result.status === 1 && result.stderr?.includes("CENTROPY capability manifest is stale")
  observations.push({ id: "catalogue-current", expected: "Saved catalogue matches current source generator", verdict: result.error || result.signal || result.status === null ? "INCONCLUSIVE" : result.status === 0 ? "VERIFIED" : staleCatalogue ? "NOT_WORKING" : "INCONCLUSIVE", observed: { command: "node scripts/centropy/generate-capability-manifest.mjs --check", exitCode: result.status, signal: result.signal, error: result.error ? String(result.error) : null } })
} finally {
  globalThis.fetch = nativeFetch
  for (const [key, value] of Object.entries(originalEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value
  app.closeAllConnections(); upstream.closeAllConnections()
  await Promise.all([new Promise(done => app.close(done)), new Promise(done => upstream.close(done))])
}
const after = [...sourceFiles].map(path => ({ path, sha256: hash(readFileSync(join(root, path))) }))
const sourcesUnchanged = sources.every(source => after.find(entry => entry.path === source.path)?.sha256 === source.sha256)
const proof = { schema: "finnor.capability-proxy-audit.v1", generatedAt: new Date().toISOString(), head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), scriptSha256: hash(readFileSync(new URL(import.meta.url))), qualification: "ACTUAL_PROXY_AND_MATCHER_WITH_INSTALLED_NEXTREQUEST_OVER_LOOPBACK_HTTP; UPSTREAM_IS_A_FIXTURE; NO_NATIVE_OWNER_OR_PROVIDER_QUALIFICATION", sources, after, sourcesUnchanged, observations, transportGuardErrors, rerun: "node scripts/audits/verify-capability-proxy.mjs --out <existing external directory>" }
writeFileSync(join(output, "proof.json"), JSON.stringify(proof, null, 2) + "\n", { flag: "wx" })
console.log(JSON.stringify({ output, sourcesUnchanged, observations: observations.map(({ id, verdict }) => ({ id, verdict })) }, null, 2))
process.exitCode = !sourcesUnchanged || observations.some(row => row.verdict !== "VERIFIED") ? 1 : 0
